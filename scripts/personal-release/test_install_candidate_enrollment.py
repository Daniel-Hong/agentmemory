import importlib.util
import json
import hashlib
import os
from pathlib import Path
import tempfile
import unittest

HERE=Path(__file__).resolve().parent


def load():
    p=HERE/'install-candidate-enrollment.py'
    spec=importlib.util.spec_from_file_location('candidate_installer',p)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    return m


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((HERE/'install-candidate-enrollment.py').exists(),'installer missing')
        self.m=load()
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.source=self.root/'reviewed';self.source.mkdir(mode=0o700)
        self.calls=[]
        self.policy={'fixture':True}
        for name in self.m.SOURCES:
            origin=HERE/name
            self.assertTrue(origin.is_file(),name)
            target=self.source/name;target.write_bytes(origin.read_bytes());target.chmod(0o600)
        self.write('policy-input.json',{'fixture':'synthetic'})
        self.write('install-manifest.json',{'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in self.source.iterdir() if p.name!='install-manifest.json'}})
        self.previous=self.root/'usr/local/libexec/agentmemory-update-runner'
        self.previous.parent.mkdir(parents=True,mode=0o755);self.previous.write_bytes(b'old root asset');self.previous.chmod(0o755)
        for p in self.root.rglob('*'):
            if p.is_dir():p.chmod(0o755)
        self.root.chmod(0o700)

    def write(self,name,value):
        p=self.source/name;p.write_text(json.dumps(value));p.chmod(0o600)

    def install(self,run=None):
        return self.m.install(self.root,owner=os.getuid(),gid=os.getgid(),source=self.source,run=run or (lambda args,**kw:self.calls.append(args)),policy_builder=lambda helper,paths,**kw:self.policy)

    def test_installer_preserves_old_assets_and_reads_back_new_assets(self):
        result=self.install()
        self.assertTrue(result['installed']);self.assertFalse(result['serviceControlled'])
        self.assertEqual(self.previous.read_bytes(),b'old root asset')
        self.assertTrue((self.root/'usr/local/libexec/agentmemory-candidate-enroll').is_file())
        self.assertEqual(len(self.calls),3)
        self.assertTrue(all(call[0]=='/usr/sbin/visudo' for call in self.calls))
        self.assertEqual(self.install(),result)

    def test_individual_or_whole_sudoers_failure_leaves_no_new_permission(self):
        for fault in (1,2,3):
            with self.subTest(fault=fault):
                count=0
                def run(args,**kw):
                    nonlocal count
                    count+=1
                    if count==fault:raise OSError('visudo rejected')
                with self.assertRaises(OSError):self.install(run)
                self.assertFalse((self.root/'etc/sudoers.d/agentmemory-candidate-enrollment').exists())
                self.assertEqual(self.previous.read_bytes(),b'old root asset')

    def test_hard_interruption_cannot_create_install_commit(self):
        child=os.fork()
        if child==0:
            count=0
            def die_after_permission(args,**kw):
                nonlocal count
                count+=1
                if count==3:os._exit(137)
            self.install(die_after_permission)
            os._exit(0)
        _,status=os.waitpid(child,0)
        self.assertEqual(os.waitstatus_to_exitcode(status),137)
        self.assertTrue((self.root/'etc/sudoers.d/agentmemory-candidate-enrollment').exists())
        self.assertFalse((self.root/'etc/agentmemory-candidate-enrollment/installation.json').exists())
        self.assertEqual(self.previous.read_bytes(),b'old root asset')

    def test_target_conflict_is_rejected_without_overwrite(self):
        self.install()
        target=self.root/'usr/local/libexec/agentmemory-candidate-enroll';target.write_bytes(b'previous different helper')
        with self.assertRaisesRegex(RuntimeError,'INSTALL_CONFLICT'):self.install()
        self.assertEqual(target.read_bytes(),b'previous different helper')

    def test_source_changed_or_symlink_is_rejected_before_import(self):
        p=self.source/'candidate-enrollment.py';p.write_text('raise Exception("untrusted input executed")')
        with self.assertRaisesRegex(RuntimeError,'INSTALL_SOURCE_CHANGED'):self.install()
        self.assertFalse((self.root/'etc/sudoers.d/agentmemory-candidate-enrollment').exists())




class PolicyIntegrationTests(unittest.TestCase):
    def test_real_policy_builder_install_and_helper_reload(self):
        import shutil
        from test_dashboard_kit import TransactionTests
        from test_candidate_enrollment import load as module_load
        fixture=TransactionTests('test_next_update_baseline_is_json_only_and_preserves_all_prior_archives')
        fixture.setUp();self.addCleanup(fixture.doCleanups)
        for name,mode in fixture.runtime.ROOT_ASSETS.items():
            p=fixture.root/name.lstrip('/')
            content=(HERE/'dashboard-updates.py').read_bytes() if p.name in ('agentmemory-update-request','agentmemory-update-runner') else p.read_bytes()
            if p.read_bytes()!=content:p.write_bytes(content)
            p.chmod(mode)
            fixture.tx.baseline['rootAssets'][str(p)]=hashlib.sha256(content).hexdigest()
        public=fixture.tx.public
        (public/'baseline.json').write_text(json.dumps(fixture.tx.baseline))
        fixture.tx.kit['files']['baseline.json']=hashlib.sha256((public/'baseline.json').read_bytes()).hexdigest()
        (public/'kit.json').write_text(json.dumps(fixture.tx.kit))
        fixture.tx.apply()
        runner=module_load('dashboard-updates')
        manager=runner.Runner(state=fixture.state,trusted_uid=os.getuid(),trust_anchor=fixture.root)
        manager.initialize();manager.enroll(public)
        installer=load()
        source=fixture.root/'reviewed';source.mkdir(mode=0o700)
        for name in installer.SOURCES:
            shutil.copyfile(HERE/name,source/name);(source/name).chmod(0o600)
        policy_input={'referenceKit':str(public),'referenceKitSha256':hashlib.sha256((public/'kit.json').read_bytes()).hexdigest(),'delegatingReview':'synthetic administrator policy review','policyId':'synthetic-end-to-end'}
        (source/'policy-input.json').write_text(json.dumps(policy_input));(source/'policy-input.json').chmod(0o600)
        manifest={'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir()}}
        (source/'install-manifest.json').write_text(json.dumps(manifest));(source/'install-manifest.json').chmod(0o600)
        result=installer.install(fixture.root,owner=os.getuid(),gid=os.getgid(),source=source,run=lambda *a,**kw:None)
        self.assertTrue(result['installed'])
        helper=module_load()
        policy=helper.load_policy(fixture.root/'etc/agentmemory-candidate-enrollment/policy.json',owner=os.getuid(),anchor=fixture.root)
        self.assertEqual(policy['policyId'],'synthetic-end-to-end')
        self.assertEqual(policy['runtimeHashes']['kit-runtime.py'],hashlib.sha256((HERE/'kit-runtime.py').read_bytes()).hexdigest())
        self.assertEqual(policy['requestUid'],1000)

if __name__=='__main__':unittest.main()
