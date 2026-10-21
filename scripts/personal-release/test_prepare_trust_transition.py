"""Existing-staging continuation: synthetic fixtures only; no sudo or operating writes."""
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
class PrepareTests(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('prepare_wrapper',HERE/'prepare-trust-transition.py')
        self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
        self.assertTrue(hasattr(self.m,'resume_pending_staging'),'existing-staging continuation missing')
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.bundle=self.root/'bundle';self.bundle.mkdir(mode=0o755);self.work=self.root/'not-prepared'
        self.hashes={}
        for name in self.m.PINS:
            raw=('# synthetic '+name+'\n').encode();p=self.bundle/name;p.write_bytes(raw);p.chmod(0o644);self.hashes[name]=hashlib.sha256(raw).hexdigest()
        self.pending={'executionClosureReviewed':False,'reviewedBy':'','files':dict(self.hashes),'independentReviewEvidence':self.m.EVIDENCE}
        self.approval=self.bundle/'source-review.json';self.approval.write_text(json.dumps(self.pending,indent=2)+'\n');self.approval.chmod(0o600)
        self.original=self.approval.read_bytes();self.calls=[];self.output=io.StringIO()
    def resume(self,run=None):
        return self.m.resume_pending_staging(self.bundle,self.hashes,self.work,owner=os.getuid(),gid=os.getgid(),anchor=self.root,run=run or (lambda c:self.calls.append(c)),out=self.output)
    def test_pending_record_uses_actual_ai_reviewer_and_prior_scope_without_user_prompt(self):
        self.assertEqual(self.resume(),'PREPARE_COMPLETED')
        record=json.loads(self.approval.read_bytes());self.assertTrue(record['executionClosureReviewed'])
        self.assertEqual(record['reviewedBy'],'Codex AI reviewer /root/preflight_retry_review')
        self.assertEqual(record['independentReviewEvidence']['sourceFilesSha256'],self.hashes)
        self.assertFalse(record['preparationAuthorization']['userCodeReviewClaimed'])
        self.assertFalse(record['preparationAuthorization']['operatingTransitionApproved'])
        self.assertEqual(self.calls,[[self.m.PYTHON,'-I',str(self.bundle/'admin-trust-transition.py'),'--prepare']])
        self.assertEqual(self.approval.stat().st_mode&0o777,0o600)
    def test_changed_code_refuses_without_overwriting_pending_record(self):
        (self.bundle/'dashboard-updates.py').write_text('changed')
        with self.assertRaisesRegex(RuntimeError,'STAGED_HASH_MISMATCH'):self.resume()
        self.assertEqual(self.approval.read_bytes(),self.original);self.assertEqual(self.calls,[])
    def test_unexpected_record_is_not_overwritten(self):
        record=dict(self.pending,unexpected='preserve');self.approval.write_text(json.dumps(record));before=self.approval.read_bytes()
        with self.assertRaisesRegex(RuntimeError,'REVIEW_STATE_NOT_PENDING'):self.resume()
        self.assertEqual(self.approval.read_bytes(),before);self.assertEqual(self.calls,[])
    def test_preapproved_record_is_not_redispatched(self):
        self.resume();before=self.approval.read_bytes()
        with self.assertRaisesRegex(RuntimeError,'REVIEW_STATE_NOT_PENDING'):self.resume()
        self.assertEqual(self.approval.read_bytes(),before);self.assertEqual(len(self.calls),1)
    def test_symlink_code_refused(self):
        p=self.bundle/'dashboard-updates.py';other=self.root/'other';p.rename(other);p.symlink_to(other)
        with self.assertRaises(OSError):self.resume()
        self.assertEqual(self.approval.read_bytes(),self.original);self.assertEqual(self.calls,[])
    def test_loose_code_or_directory_permissions_refused(self):
        for p in [self.bundle,self.bundle/'dashboard-updates.py',self.approval]:
            old=p.stat().st_mode&0o777;p.chmod(old|0o020)
            try:
                with self.assertRaisesRegex(RuntimeError,'STAGING_PERMISSION_REFUSED'):self.resume()
            finally:p.chmod(old)
        self.assertEqual(self.approval.read_bytes(),self.original);self.assertEqual(self.calls,[])
    def test_wrong_owner_is_refused(self):
        with self.assertRaisesRegex(RuntimeError,'STAGING_PERMISSION_REFUSED'):
            self.m.resume_pending_staging(self.bundle,self.hashes,self.work,owner=os.getuid()+1,gid=os.getgid(),anchor=self.root,run=lambda c:self.calls.append(c),out=self.output)
        self.assertEqual(self.approval.read_bytes(),self.original);self.assertEqual(self.calls,[])
    def test_existing_preparation_blocks_before_attestation(self):
        self.work.mkdir()
        with self.assertRaisesRegex(RuntimeError,'PREPARATION_EXISTS_INSPECT_STATE'):self.resume()
        self.assertEqual(self.approval.read_bytes(),self.original);self.assertEqual(self.calls,[])
    def test_concurrent_continuation_is_refused(self):
        lock=self.bundle/'.prepare-wrapper.lock';lock.touch(mode=0o600)
        with lock.open('r+b') as f:
            fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError,'PREPARATION_BUSY'):self.resume()
        self.assertEqual(self.approval.read_bytes(),self.original);self.assertEqual(self.calls,[])
    def test_interrupt_after_launch_is_uncertain_not_unstarted_and_no_redispatch(self):
        def interrupt(command):raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt) as caught:self.resume(interrupt)
        self.assertEqual(self.m.failure_code(caught.exception),'PREPARE_INTERRUPTED_INSPECT_RESULT_NO_RETRY')
        with self.assertRaisesRegex(RuntimeError,'REVIEW_STATE_NOT_PENDING'):self.resume()
        self.assertEqual(self.calls,[])
    def test_attestation_fsync_uncertainty_never_launches_prepare(self):
        real=self.m.sync_dir
        def uncertain(path):
            if json.loads(self.approval.read_bytes())['executionClosureReviewed']:raise OSError('synthetic fsync uncertainty')
            real(path)
        with patch.object(self.m,'sync_dir',uncertain),self.assertRaises(OSError):self.resume()
        self.assertEqual(self.calls,[])
        with self.assertRaisesRegex(RuntimeError,'REVIEW_STATE_NOT_PENDING'):self.resume()

if __name__=='__main__':unittest.main()
