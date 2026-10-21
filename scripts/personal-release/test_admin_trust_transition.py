"""All paths are temporary synthetic code/trust fixtures, never operating state."""
import importlib.util
import json
import os
from pathlib import Path
import unittest
HERE=Path(__file__).resolve().parent

class TransitionTests(unittest.TestCase):
    def test_transition_module_has_fixed_production_scope_and_no_web_or_sudo_asset(self):
        path=HERE/'admin-trust-transition.py'
        self.assertTrue(path.exists(),'fixed administrator transition missing')
        spec=importlib.util.spec_from_file_location('admin_transition',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        self.assertEqual(set(m.PRODUCTION),{'current','primary','recovery'})
        self.assertEqual(m.PRODUCTION['primary']['id'],'daniel-16-ad6c423b')
        self.assertEqual(m.PRODUCTION['recovery']['id'],'recovery-17-ad6c423b')
        self.assertFalse(any('sudoers' in p or '.service' in p for p in m.EXECUTABLES))

if __name__=='__main__':unittest.main()

# Reuse real transaction code with synthetic service/API adapters.
import contextlib
import copy
import io
import shutil
import uuid
from unittest.mock import patch
import test_client_transition as client
import test_dashboard_kit as base

class WholeTransitionTests(unittest.TestCase):
    write=base.TransactionTests.write
    api=base.TransactionTests.api
    issue=client.ClientTransitionTests.issue

    def setUp(self):
        base.TransactionTests.setUp(self)
        self.client_root = self.root / 'home/daniel/.local/share/agentmemory-personal/releases/client-fixture'
        self.names = ['_capture.mjs', 'manifest.json', 'long-session-hook-client.mjs', *[f'hook{i}.mjs' for i in range(10)]]
        self.old = {f'plugin/scripts/codex-compat/{name}': ('old-' + name).encode() for name in self.names}
        self.new = {**self.old, **{f'plugin/scripts/codex-compat/{name}': ('new-' + name).encode() for name in self.names[:2]}}
        for name, data in self.old.items(): self.write(self.client_root / name, data)
        (self.root / 'proc').mkdir()
        self.baseline = copy.deepcopy(self.tx.baseline)
        self.baseline['clientsRetainedAt'] = str(self.client_root)
        self.baseline['compatibilityFiles'] = {name:self.runtime.hashlib.sha256(data).hexdigest() for name,data in self.old.items()}
        self.baseline['protectedFiles'].update({str(self.client_root/name):digest for name,digest in self.baseline['compatibilityFiles'].items()})
        self.transition = {'version':1,'files':{name:{'before':self.baseline['compatibilityFiles'][name],'after':self.runtime.hashlib.sha256(self.new[name]).hexdigest()} for name in self.new if self.new[name]!=self.old[name]}}

        self.system.inactive=lambda:self.system.stopped
        self.system.main_pid=lambda:0 if self.system.stopped else 103
        self.initial_legacy=copy.deepcopy(self.baseline)
        old_runner=(HERE/'dashboard-updates.py').read_bytes()+b'\n# synthetic old runner epoch\n'
        for name in ('agentmemory-update-request','agentmemory-update-runner'):
            p=self.root/'usr/local/libexec'/name;self.write(p,old_runner,0o755)
            self.baseline['rootAssets'][str(p)]=self.runtime.sha(p);self.baseline['protectedFiles'][str(p)]=self.runtime.sha(p)
        self.current=self.issue(False,replacement=self.old,revision=15,automatic=True)
        # Same runtime interfaces, distinct immutable .15 runtime bytes.
        for parent in [self.paths['public'],self.state/'incoming']:
            d=parent/'client-release-15';self.write(d/'kit-runtime.py',(d/'kit-runtime.py').read_bytes()+b'\n# synthetic .15 runtime epoch\n',0o644 if parent==self.paths['public'] else 0o600)
            meta=json.loads((d/'kit.json').read_text());meta['files']['kit-runtime.py']=self.runtime.sha(d/'kit-runtime.py');self.write(d/'kit.json',json.dumps(meta).encode(),0o644 if parent==self.paths['public'] else 0o600)
        self.current=self.new_runtime('client-release-15')
        self.current.apply()
        self.baseline=self.prepare.baseline_from_kit(self.current.public,self.current.receipt)
        self.primary=self.issue(revision=16,automatic=True)
        self.recovery=self.issue(revision=17,automatic=False)
        runner=base.load('dashboard-updates');self.manager=runner.Runner(self.state,self.root/'requests',trusted_uid=os.getuid(),request_uid=os.getuid(),trust_anchor=self.root);self.manager.spool.mkdir(mode=0o700);self.manager.initialize()
        for cid in ('client-release-15','client-release-16','client-release-17'):self.manager.enroll(self.state/'incoming'/cid)
        self.failed_id=str(uuid.uuid4());self.manager.save_job({'jobId':self.failed_id,'candidateId':'client-release-16','createdAt':runner.now(),'bootId':runner.boot_id()},'queued','queued')
        process=self.root/'proc/999';process.mkdir();self.write(process/'cmdline',b'node\0'+str(self.client_root/'plugin/scripts/codex-compat/long-session-hook-client.mjs').encode()+b'\0--drain\0')
        output=io.StringIO()
        with contextlib.redirect_stdout(output),self.assertRaisesRegex(RuntimeError,'CLIENT_PROCESS_ACTIVE'):self.primary.apply()
        shutil.rmtree(process)
        self.write(self.state/'private'/(self.failed_id+'.log'),output.getvalue().encode()+b'{"errorCode":"CLIENT_PROCESS_ACTIVE","dataRewound":false}\n')
        self.manager.save_job(self.manager.job(self.failed_id),'failed','failed','PROGRAM_FAILED')
        (self.state/'private/enrollment').mkdir(mode=0o700);(self.state/'public/enrollment').mkdir(mode=0o755)
        self.library=self.root/'usr/local/lib/agentmemory-candidate-enrollment';self.library.mkdir(parents=True,mode=0o755)
        assets={}
        for name in ('kit-runtime.py','kit-queues.py','kit-integrity.py','prepare-dashboard-kit.py','enroll-reviewed-kit.py'):
            raw=(self.current.public/name).read_bytes() if name in ('kit-runtime.py','kit-queues.py','kit-integrity.py') else (HERE/name).read_bytes()
            self.write(self.library/name,raw,0o644);assets[str(self.library/name)]=self.runtime.sha(self.library/name)
        helper=self.root/'usr/local/libexec/agentmemory-candidate-enroll';self.write(helper,(HERE/'candidate-enrollment.py').read_bytes()+b'\n# synthetic old policy epoch\n',0o755)
        for p in [helper,*(self.root/'usr/local/libexec'/n for n in ('agentmemory-update-request','agentmemory-update-runner'))]:assets[str(p)]=self.runtime.sha(p)
        policy={'schemaVersion':1,'policyId':'synthetic-fixed-policy','validatorVersion':'1','delegatingReview':'synthetic administrator','requestUid':1000,'requestGid':1000,'assets':assets,'runtimeHashes':{n:self.runtime.sha(self.library/n) for n in ('kit-runtime.py','kit-queues.py','kit-integrity.py')},'packageContract':{},'extraArtifacts':[],'legacyBaseline':self.initial_legacy,'library':str(self.library),'runner':str(self.root/'usr/local/libexec/agentmemory-update-runner'),'state':str(self.state),'dropin':str(self.paths['dropin']),'publicKits':str(self.paths['public']),'archives':str(self.paths['archives'])}
        self.policy=self.root/'etc/agentmemory-candidate-enrollment/policy.json';self.write(self.policy,json.dumps(policy).encode(),0o644)
        self.marker=self.policy.with_name('installation.json');self.write(self.marker,json.dumps({'installed':True,'policySha256':self.runtime.sha(self.policy),'assets':{str(p):{'sha256':self.runtime.sha(p),'mode':p.stat().st_mode&0o777,'uid':os.getuid(),'gid':os.getgid()} for p in [*map(Path,assets),self.policy]}}).encode(),0o644)
        self.bundle=self.root/'usr/local/lib/agentmemory-admin-trust-transition';self.bundle.mkdir(mode=0o755)
        for name in ('admin-trust-transition.py','dashboard-updates.py','candidate-enrollment.py'):self.write(self.bundle/name,(HERE/name).read_bytes(),0o644)
        self.specs={role:{k:json.loads((tx.root/'kit.json').read_text())[k] for k in ('id','version','sourceCommit','packageSha256')}|{'kitSha256':self.runtime.sha(tx.root/'kit.json')} for role,tx in [('current',self.current),('primary',self.primary),('recovery',self.recovery)]}
        # Root-managed paths are strict. User paths model observed ownership
        # roles/permissions instead of stripping group-write from every path.
        home=self.root/'home/daniel'
        for path in self.root.rglob('*'):
            if path.is_dir():
                path.chmod(0o700 if path.is_relative_to(home) else path.stat().st_mode&0o777&~0o022)
        home.chmod(0o750)
        self.apply_user_directory_layout()
        self.executable_hashes={str(p):self.runtime.sha(self.root/str(p).lstrip('/')) for p in ('/usr/local/libexec/agentmemory-update-request','/usr/local/libexec/agentmemory-update-runner','/usr/local/libexec/agentmemory-candidate-enroll')}
        self.module=base.load('admin-trust-transition');self.transition=self.new_transition()
        self.original_data=self.raw.read_bytes();self.original_failure=self.manager.job_path(self.failed_id).read_bytes()

    def new_runtime(self,cid):
        r=self.runtime.Runtime(self.paths['public']/cid,paths=self.paths,owner=os.getuid(),anchor=self.root,service_uid=os.getuid(),service_gid=os.getgid(),system=self.system)
        r.api=lambda path,body=None: {'version':r.kit['version'],'status':'healthy','storageDurability':{'mutationFailures':0},'memoryPressure':{'level':'normal','automaticMemoryRecovery':False}} if path=='health' else self.api(path,body)
        return r

    def new_transition(self):
        return self.module.Transition(self.root,owner=os.getuid(),service_uid=os.getuid(),service_gid=os.getgid(),specs=self.specs,bundle=self.bundle,executables=self.executable_hashes,system=self.system,api=lambda r,p,b: {'version':r.kit['version'],'status':'healthy','storageDurability':{'mutationFailures':0},'memoryPressure':{'level':'normal','automaticMemoryRecovery':False}} if p=='health' else self.api(p,b),service=lambda:{'pid':self.system.main_pid(),'starts':self.system.actions.count('start')})

    def prepare_review(self):
        t=self.transition;result=t.prepare(self.failed_id);plan=json.loads((t.work/'plan.json').read_text());self.write(t.work/'review.json',json.dumps({'format':self.module.FORMAT,'planSha256':self.module.digest(self.module.encoded(plan)),'executionClosureReviewed':True,'reviewedBy':'synthetic administrator'}).encode());return result,plan

    def test_modified_runtime_is_rejected_before_import_execution(self):
        marker=self.root/'untrusted-import-marker'
        path=self.current.public/'kit-runtime.py'
        self.write(path,('from pathlib import Path\nPath('+repr(str(marker))+').touch()\n').encode()+path.read_bytes(),0o644)
        with self.assertRaises(Exception):self.transition.prepare(self.failed_id)
        self.assertFalse(marker.exists())

    def test_modified_helper_is_rejected_before_import_execution(self):
        marker=self.root/'untrusted-helper-marker'
        path=self.root/'usr/local/libexec/agentmemory-candidate-enroll'
        self.write(path,('from pathlib import Path\nPath('+repr(str(marker))+').touch()\n').encode()+path.read_bytes(),0o755)
        with self.assertRaises(Exception):self.transition.prepare(self.failed_id)
        self.assertFalse(marker.exists())

    def apply_user_directory_layout(self):
        # Preserve actual 0775 user-owned code ancestors; do not normalize them.
        for path in (self.paths['engine'].parent,self.paths['bin'],self.client_root,self.paths['legacy']):
            path.chmod(0o775)

    def test_prepare_and_apply_accept_readonly_hashes_under_0775_user_directories(self):
        self.apply_user_directory_layout();self.prepare_review();self.transition.apply()
        self.assertEqual(self.paths['engine'].parent.stat().st_mode&0o777,0o775)
        self.assertEqual(self.paths['bin'].stat().st_mode&0o777,0o775)
        self.new_runtime('client-release-16').guard(before=True)

    def test_service_hash_does_not_return_file_body_and_rejects_wrong_expectation(self):
        self.paths['engine'].parent.chmod(0o775)
        expected=self.runtime.sha(self.paths['engine']);self.transition.hash_observe(self.paths['engine'],expected)
        self.assertEqual(set(self.transition.observed[str(self.paths['engine'])]),{'sha256','mode','uid','gid'})
        with self.assertRaisesRegex(RuntimeError,'UNCHANGED_DEPENDENCY_CHANGED'):self.transition.hash_observe(self.paths['engine'],'0'*64)

    def test_service_hash_rejects_symlink_and_world_writable_parent(self):
        path=self.paths['engine'];raw=path.read_bytes();path.unlink();other=path.with_name('other');self.write(other,raw);path.symlink_to(other)
        with self.assertRaises(RuntimeError):self.transition.hash_observe(path,self.runtime.sha(other))
        path.unlink();self.write(path,raw);path.parent.chmod(0o777)
        with self.assertRaises(RuntimeError):self.transition.hash_observe(path,self.runtime.sha(path))

    def test_service_hash_rejects_file_replacement_during_read(self):
        path=self.paths['engine'];expected=self.runtime.sha(path);raw=path.read_bytes();real=self.module.hashlib.sha256
        class Exchange:
            def __init__(inner):inner.value=real();inner.changed=False
            def update(inner,data):
                inner.value.update(data)
                if not inner.changed:
                    inner.changed=True;replacement=path.with_name('replacement');replacement.write_bytes(raw);os.replace(replacement,path)
            def hexdigest(inner):return inner.value.hexdigest()
        with patch.object(self.module.hashlib,'sha256',Exchange),self.assertRaisesRegex(RuntimeError,'USER_HASH_FILE_CHANGED'):
            self.transition.user_hash_metadata(path,expected)

    def test_service_hash_rejects_directory_replacement_during_read(self):
        path=self.paths['engine'];expected=self.runtime.sha(path);raw=path.read_bytes();real=self.module.hashlib.sha256
        class Exchange:
            def __init__(inner):inner.value=real();inner.changed=False
            def update(inner,data):
                inner.value.update(data)
                if not inner.changed:
                    inner.changed=True;path.parent.rename(path.parent.with_name('old-bin'));path.parent.mkdir();path.write_bytes(raw)
            def hexdigest(inner):return inner.value.hexdigest()
        with patch.object(self.module.hashlib,'sha256',Exchange),self.assertRaisesRegex(RuntimeError,'USER_HASH_PATH_CHANGED'):
            self.transition.user_hash_metadata(path,expected)

    def test_service_hash_group_write_is_limited_to_expected_service_uid_gid(self):
        from types import SimpleNamespace
        path=self.paths['engine'];path.parent.chmod(0o775);expected=self.runtime.sha(path);real=self.module.os.fstat
        original_owner=self.transition.owner;self.transition.owner=os.getuid()+10
        for field,value in [('st_gid',os.getgid()+1),('st_uid',self.transition.owner)]:
            def metadata(fd):
                info=real(fd)
                if info.st_ino==path.parent.stat().st_ino:
                    keys=['st_dev','st_ino','st_uid','st_gid','st_mode'];row={key:getattr(info,key) for key in keys};row[field]=value
                    return SimpleNamespace(**row)
                return info
            with self.subTest(field=field),patch.object(self.module.os,'fstat',metadata),self.assertRaisesRegex(RuntimeError,'USER_HASH_PATH_REFUSED'):
                self.transition.user_hash_metadata(path,expected)
        self.transition.owner=original_owner

    def test_failed_preparation_shell_is_preserved_and_reuse_refused(self):
        self.paths['engine'].parent.chmod(0o777)
        with self.assertRaisesRegex(RuntimeError,'USER_HASH_PATH_REFUSED'):self.transition.prepare(self.failed_id)
        before={str(p.relative_to(self.transition.work)) for p in self.transition.work.rglob('*')}
        self.assertEqual(before,{'before','after','original-kits','original-failure'})
        with self.assertRaisesRegex(RuntimeError,'TRANSITION_ALREADY_PREPARED'):self.new_transition().prepare(self.failed_id)
        self.assertEqual(before,{str(p.relative_to(self.transition.work)) for p in self.transition.work.rglob('*')})

    def test_root_execution_directory_keeps_strict_group_write_rejection(self):
        self.bundle.chmod(0o775)
        with self.assertRaisesRegex(RuntimeError,'PATH_REFUSED'):self.transition.module(self.bundle/'dashboard-updates.py')

    def test_fixed_refresh_preserves_failed_shell_then_runs_complete_corrected_prepare(self):
        wrapper=base.load('prepare-trust-transition');core=self.bundle/'admin-trust-transition.py'
        corrected=core.read_bytes();source=self.root/'corrected-core.source';self.write(source,corrected,0o644)
        self.write(core,corrected+b'\n# synthetic old coordination epoch\n',0o644)
        old_pins={n:self.runtime.sha(self.bundle/n) for n in wrapper.PINS};new_pins={**old_pins,'admin-trust-transition.py':wrapper.hashlib.sha256(corrected).hexdigest()}
        prior=wrapper.encoded(wrapper.approved_record(old_pins));self.write(self.bundle/'source-review.json',prior,0o600)
        work=self.transition.work;work.mkdir(mode=0o700)
        for n in ('before','after','original-kits','original-failure'):(work/n).mkdir(mode=0o700)
        original_inode=work.stat().st_ino;actions=list(self.system.actions);receipt=self.current.receipt.read_bytes();commands=[]
        def run(command):
            commands.append(command);self.assertEqual(command[-1],'--prepare');self.new_transition().prepare(self.failed_id)
        result=wrapper.refresh_failed_empty(self.bundle,old_pins,new_pins,source,work,owner=os.getuid(),gid=os.getgid(),anchor=self.root,run=run,out=io.StringIO())
        self.assertEqual(result,'PREPARE_COMPLETED');self.assertEqual(len(commands),1);self.assertTrue((work/'plan.json').is_file())
        archive=work.with_name(work.name+'-before-user-hash-fix')
        self.assertEqual((archive/'failed-shell').stat().st_ino,original_inode);self.assertEqual((archive/'source-review.before.json').read_bytes(),prior)
        self.assertEqual(self.system.actions,actions);self.assertEqual(self.current.receipt.read_bytes(),receipt);self.assertEqual(self.raw.read_bytes(),self.original_data)
        self.assertEqual(self.manager.job_path(self.failed_id).read_bytes(),self.original_failure)
        self.assertFalse((work/'review.json').exists());self.assertFalse((work/'receipt.json').exists())

    def test_prepare_does_not_modify_operating_targets(self):
        before=self.current.receipt.read_bytes();old_runner=(self.root/'usr/local/libexec/agentmemory-update-runner').read_bytes()
        result,plan=self.prepare_review()
        self.assertFalse(result['operatingChanged']);self.assertEqual(self.current.receipt.read_bytes(),before);self.assertEqual((self.root/'usr/local/libexec/agentmemory-update-runner').read_bytes(),old_runner)
        self.assertTrue(all(t['beforeSha256']!=t['afterSha256'] for t in plan['targets'].values()))

    def test_transition_validates_all_guards_policy_and_original_evidence(self):
        _,plan=self.prepare_review();result=self.transition.apply()
        self.assertTrue(result['committed']);self.assertEqual(self.raw.read_bytes(),self.original_data);self.assertEqual(self.manager.job_path(self.failed_id).read_bytes(),self.original_failure)
        self.transition.verify(plan);self.assertTrue(self.new_transition().apply()['alreadyCommitted'])
        for tx in [self.primary,self.recovery]:
            fresh=self.new_runtime(tx.kit['id']);fresh.guard(before=True)
        self.assertEqual(json.loads((self.transition.work/'original-kits/client-release-16/kit.json').read_text())['packageSha256'],self.specs['primary']['packageSha256'])

    def test_revised_retry_requires_committed_exact_original_lineage(self):
        _,plan=self.prepare_review();self.transition.apply();new=str(uuid.uuid4())
        manager=self.transition.manager();binding=manager.retry_binding(self.failed_id,new)
        self.assertIn('adminTrustTransitionSha256',binding)
        self.assertEqual(binding['originalKitSha256'],self.specs['primary']['kitSha256'])
        receipt=self.transition.work/'receipt.json';data=receipt.read_bytes();receipt.unlink()
        try:
            with self.assertRaisesRegex(RuntimeError,'RETRY_TRUST_LINEAGE_UNVERIFIED'):manager.retry_binding(self.failed_id,new)
        finally:self.write(receipt,data)

    def test_revised_retry_refuses_changed_receipt_journal_or_original_proof(self):
        self.prepare_review();self.transition.apply();manager=self.transition.manager()
        paths=[self.transition.work/'receipt.json',self.transition.work/'journal.json',self.transition.work/'original-failure/log.txt',self.transition.work/'original-kits/client-release-16/kit-runtime.py']
        for path in paths:
            with self.subTest(proof=path.name):
                raw=path.read_bytes()
                if path.suffix=='.json':
                    value=json.loads(raw);value['planSha256']='0'*64;changed=json.dumps(value).encode()
                else:changed=raw+b'\n# synthetic changed evidence\n'
                self.write(path,changed)
                try:
                    with self.assertRaisesRegex(RuntimeError,'RETRY_TRUST_LINEAGE_UNVERIFIED'):manager.retry_binding(self.failed_id,str(uuid.uuid4()))
                finally:self.write(path,raw)

    def test_failure_after_every_target_restores_exact_old_state(self):
        _,initial=self.prepare_review();count=len(initial['order'])
        for stop in range(count):
            with self.subTest(target=stop):
                f=WholeTransitionTests();f.setUp()
                try:
                    f.apply_user_directory_layout();_,plan=f.prepare_review()
                    def fail(index,path):
                        if index==stop:raise RuntimeError('SYNTHETIC_TARGET_FAILURE')
                    with self.assertRaisesRegex(RuntimeError,'SYNTHETIC_TARGET_FAILURE'):f.transition.apply(fail)
                    self.assertTrue(all(f.transition.target_state(p,v)=='before' for p,v in plan['targets'].items()))
                    self.assertEqual(json.loads((f.transition.work/'journal.json').read_text())['phase'],'restored')
                    self.assertEqual(f.raw.read_bytes(),f.original_data);self.assertEqual(f.manager.job_path(f.failed_id).read_bytes(),f.original_failure)
                    f.new_runtime('client-release-15').guard()
                finally:f.doCleanups()

    def test_fresh_process_can_restore_known_partial_state(self):
        _,plan=self.prepare_review()
        def fail(index,path):
            if index==8:raise RuntimeError('SYNTHETIC_CRASH')
        with patch.object(self.transition,'restore_locked',side_effect=RuntimeError('RESTORE_PROCESS_INTERRUPTED')),self.assertRaisesRegex(RuntimeError,'RESTORE_PROCESS_INTERRUPTED'):self.transition.apply(fail)
        fresh=self.new_transition();self.assertTrue(fresh.restore()['restored'])
        self.assertTrue(all(fresh.target_state(p,v)=='before' for p,v in plan['targets'].items()))
        self.assertTrue(fresh.restore()['restored'])

    def test_unknown_target_and_changed_baseline_are_not_overwritten(self):
        _,plan=self.prepare_review();path=self.current.public/'baseline.json';self.write(path,b'unknown administrator edit',0o644)
        with self.assertRaisesRegex(RuntimeError,'TRANSITION_ORIGINAL_CHANGED'):self.transition.apply()
        self.assertEqual(path.read_bytes(),b'unknown administrator edit')
        with self.assertRaisesRegex(RuntimeError,'TRANSITION_UNKNOWN_BYTES'):self.transition.restore()

    def test_lock_and_changed_registration_or_service_block_restore(self):
        _,plan=self.prepare_review()
        with self.transition.locks(),self.assertRaisesRegex(RuntimeError,'TRANSITION_BUSY'):self.new_transition().apply()
        self.write(self.state/'public/enrollment/new.json',b'{"status":"registered"}',0o644)
        with self.assertRaisesRegex(RuntimeError,'TRANSITION_STATE_ADVANCED'):self.transition.restore()
        (self.state/'public/enrollment/new.json').unlink();self.system.actions.append('start')
        with self.assertRaisesRegex(RuntimeError,'TRANSITION_STATE_ADVANCED'):self.transition.apply()

    def test_fsync_uncertainty_after_replacement_restores_from_readback(self):
        _,plan=self.prepare_review();original=self.transition.atomic;path=plan['order'][4];once=[False]
        def uncertain(p,*args):
            original(p,*args)
            if str(p)==path and not once[0]:once[0]=True;raise OSError('SYNTHETIC_AFTER_RENAME_FSYNC')
        with patch.object(self.transition,'atomic',uncertain),self.assertRaises(OSError):self.transition.apply()
        self.assertTrue(all(self.transition.target_state(p,v)=='before' for p,v in plan['targets'].items()))

    def test_committed_transition_cannot_be_restored_or_renamed_to_escape_history(self):
        self.prepare_review();self.transition.apply()
        with self.assertRaisesRegex(RuntimeError,'COMMITTED_TRANSITION_RESTORE_REFUSED'):self.transition.restore()
        self.assertEqual(self.manager.job_path(self.failed_id).read_bytes(),self.original_failure)

    def test_running_version_mismatch_rejects_before_targets_change(self):
        self.prepare_review();self.transition.api=lambda r,p,b:{'version':'0.9.30-daniel.99','status':'healthy','storageDurability':{'mutationFailures':0}}
        with self.assertRaisesRegex(RuntimeError,'SERVICE_VERSION_UNVERIFIED'):self.transition.apply()
        self.assertFalse((self.transition.work/'journal.json').exists())

    def test_commit_marker_uncertainty_requires_reconfirmation_before_retry(self):
        _,plan=self.prepare_review();original=self.transition.atomic
        def uncertain(path,*args):
            original(path,*args)
            if Path(path)==self.transition.work/'receipt.json':raise OSError('SYNTHETIC_COMMIT_FSYNC_UNCERTAIN')
        with patch.object(self.transition,'atomic',uncertain),self.assertRaisesRegex(RuntimeError,'TRANSITION_COMMIT_UNCONFIRMED'):self.transition.apply()
        manager=self.transition.manager()
        with self.assertRaisesRegex(RuntimeError,'RETRY_TRUST_LINEAGE_UNVERIFIED'):manager.retry_binding(self.failed_id,str(uuid.uuid4()))
        self.assertTrue(self.new_transition().apply()['alreadyCommitted'])
        self.assertIn('adminTrustTransitionSha256',manager.retry_binding(self.failed_id,str(uuid.uuid4())))

    def admit_retry(self):
        manager=self.transition.manager();new=str(uuid.uuid4())
        def current(root):
            runtime=self.new_runtime(root.name);runtime.require_client_idle();runtime.guard(before=True);return {'verified':True}
        with patch.object(manager,'verify_retry_current',side_effect=current),patch.object(__import__('subprocess'),'run') as dispatch:
            job=manager.retry_preflight(self.failed_id,new)
        dispatch.assert_called_once()
        manager.save_job(job,'running','applying')
        return manager,job

    def assert_next_baseline(self,runtime):
        helper=self.transition.module(self.root/'usr/local/libexec/agentmemory-candidate-enroll')
        policy=helper.load_policy(self.policy,owner=os.getuid(),anchor=self.root)
        found=helper.current_baseline(policy,owner=os.getuid(),anchor=self.root,runtime_paths=self.paths)
        self.assertEqual(found,self.prepare.baseline_from_kit(runtime.public,runtime.receipt))

    def test_whole_path_transition_then_16_retry_and_next_baseline(self):
        self.apply_user_directory_layout();self.prepare_review();self.transition.apply();manager,job=self.admit_retry()
        primary=self.new_runtime('client-release-16');primary.apply();primary.guard()
        manager.save_job(job,'applied_pending_acceptance','awaiting_acceptance')
        self.assertEqual(self.raw.read_bytes(),self.original_data);self.assertEqual(manager.job_path(self.failed_id).read_bytes(),self.original_failure)
        self.assert_next_baseline(primary)
        with self.assertRaisesRegex(RuntimeError,'COMMITTED_TRANSITION_RESTORE_REFUSED'):self.transition.restore()

    def test_whole_path_16_failure_then_17_compatible_recovery_preserves_holds(self):
        self.apply_user_directory_layout();self.prepare_review();self.transition.apply();manager,job=self.admit_retry()
        primary=self.new_runtime('client-release-16')
        control_path=self.paths['data']/'state_store.db/mem%3Abackground-control%3Av1.bin'
        control={'manual-pause':{'version':2,'paused':True,'resumePending':False,'holds':['manual','deployment','memory'],'recovery':{'attempts':2,'nextAttemptAt':987654}}}
        def failure():
            self.write(control_path,json.dumps(control,sort_keys=True).encode());raise RuntimeError('SYNTHETIC_16_POSTSTART_FAILURE')
        primary.verify_runtime=failure
        with self.assertRaisesRegex(RuntimeError,'SYNTHETIC_16_POSTSTART_FAILURE'):primary.apply()
        manager.save_job(job,'failed','failed','PROGRAM_FAILED');self.assertTrue(self.system.stopped)
        saved=control_path.read_bytes();recovery=self.new_runtime('client-release-17')
        def api(path,body=None):
            if path=='health':return {'version':recovery.kit['version'],'status':'healthy','storageDurability':{'mutationFailures':0},'memoryPressure':{'automaticMemoryRecovery':False}}
            if path=='background/control':return {'control':{'formatVersion':2,'status':'paused','pausedRequested':True,'activeOperations':0,'error':None,'holds':control['manual-pause']['holds'],'recovery':control['manual-pause']['recovery']}}
            return self.api(path,body)
        recovery.api=api;plan=recovery.work/'stopped-recovery-plan.json'
        sha=recovery.prepare_stopped_recovery(primary.root,plan)['planSha256'];self.assertTrue(recovery.recover_stopped(plan,sha)['recovered'])
        starts=self.system.actions.count('start');self.assertTrue(recovery.recover_stopped(plan,sha)['alreadyRecovered']);self.assertEqual(self.system.actions.count('start'),starts)
        self.assertEqual(control_path.read_bytes(),saved);self.assertEqual(self.raw.read_bytes(),self.original_data)
        self.assertEqual((self.transition.work/'original-failure/job.json').read_bytes(),self.original_failure)
        self.assert_next_baseline(recovery)
