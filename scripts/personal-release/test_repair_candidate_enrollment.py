import importlib.util,json,hashlib,os
from pathlib import Path
import tempfile,unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((HERE/'repair-candidate-enrollment-mode.py').exists(),'reviewed repair missing')
        spec=importlib.util.spec_from_file_location('repair',HERE/'repair-candidate-enrollment-mode.py')
        self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.source=self.root/'stage';self.source.mkdir(mode=0o700)
        for name in ('candidate-enrollment.py','repair-candidate-enrollment-mode.py'):
            (self.source/name).write_bytes((HERE/name).read_bytes());(self.source/name).chmod(0o600)
        digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
        self.helper=self.root/'usr/local/libexec/agentmemory-candidate-enroll';self.helper.parent.mkdir(parents=True,mode=0o755)
        self.helper.write_bytes(b'old reviewed helper');self.helper.chmod(0o755);self.old_helper_sha=digest(self.helper)
        self.policy_path=self.root/'etc/agentmemory-candidate-enrollment/policy.json';self.policy_path.parent.mkdir(parents=True,mode=0o700)
        self.old_asset=self.root/'old-updater';self.old_asset.write_bytes(b'unchanged updater');self.old_asset.chmod(0o644)
        old_policy={'policyId':'old-policy','validatorVersion':'1','delegatingReview':'fixture administrator','assets':{str(self.helper):self.old_helper_sha,str(self.old_asset):digest(self.old_asset)}}
        self.policy_path.write_text(json.dumps(old_policy));self.policy_path.chmod(0o644);self.old_policy_sha=digest(self.policy_path)
        receipt={'installed':True,'applied':False,'serviceControlled':False,'policySha256':self.old_policy_sha,'assets':{str(p):{'sha256':digest(p),'mode':p.stat().st_mode&0o777,'uid':os.getuid(),'gid':os.getgid()} for p in (self.helper,self.policy_path,self.old_asset)}}
        self.marker=self.policy_path.parent/'installation.json';self.marker.write_text(json.dumps(receipt));self.marker.chmod(0o644)
        manifest={'newHelperSha256':digest(self.source/'candidate-enrollment.py')}
        (self.source/'repair-manifest.json').write_text(json.dumps(manifest));(self.source/'repair-manifest.json').chmod(0o600)
        for p in self.root.rglob('*'):
            if p.is_dir():p.chmod(0o700 if p==self.policy_path.parent or p==self.source else 0o755)
        self.root.chmod(0o700)

    def repair(self):
        return self.m.repair(root=self.root,source=self.source,owner=os.getuid(),gid=os.getgid(),expected_policy_sha=self.old_policy_sha,expected_helper_sha=self.old_helper_sha)

    def test_repair_is_exact_and_idempotent(self):
        result=self.repair();self.assertEqual(self.repair(),result)
        self.assertEqual(self.helper.read_bytes(),(HERE/'candidate-enrollment.py').read_bytes())
        self.assertEqual(self.old_asset.read_bytes(),b'unchanged updater')
        self.assertFalse(result['serviceControlled']);self.assertFalse(result['applied'])
        marker=json.loads(self.marker.read_text());self.assertEqual(marker['policySha256'],hashlib.sha256(self.policy_path.read_bytes()).hexdigest())

    def test_partial_replacement_is_fail_closed_and_retryable(self):
        real=self.m.os.replace;count=0
        def fail(old,new):
            nonlocal count
            if Path(new)==self.marker:raise OSError('interrupted before commit')
            return real(old,new)
        with patch.object(self.m.os,'replace',fail),self.assertRaises(OSError):self.repair()
        self.assertNotEqual(json.loads(self.marker.read_text())['policySha256'],hashlib.sha256(self.policy_path.read_bytes()).hexdigest())
        self.assertTrue(self.repair()['installed'])

    def test_unknown_current_code_or_prior_policy_is_refused(self):
        self.helper.write_bytes(b'unreviewed bytes')
        with self.assertRaises(RuntimeError):self.repair()
        self.assertEqual(self.old_asset.read_bytes(),b'unchanged updater')

    def test_previous_failed_public_directory_is_repaired_only_if_root_trusted(self):
        public=self.root/'var/lib/agentmemory-updates/public/enrollment';public.mkdir(parents=True,mode=0o700)
        for p in public.parents:
            if p==self.root:break
            p.chmod(0o755)
        self.repair();self.assertEqual(public.stat().st_mode&0o777,0o755)


if __name__=='__main__':unittest.main()
