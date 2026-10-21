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

class RefreshTests(unittest.TestCase):
    resume=PrepareTests.resume
    def setUp(self):
        PrepareTests.setUp(self)
        self.assertTrue(hasattr(self.m,'refresh_failed_empty'),'bounded empty-shell refresh missing')
        self.resume();self.calls.clear();self.m.PREPARE_MAY_HAVE_STARTED=False
        self.old_review=self.approval.read_bytes();self.old_core=(self.bundle/'admin-trust-transition.py').read_bytes()
        self.work.mkdir(mode=0o700)
        for name in ('before','after','original-kits','original-failure'):(self.work/name).mkdir(mode=0o700)
        self.old_shell_inode=self.work.stat().st_ino
        self.source=self.root/'corrected-core';self.source.write_bytes(b'# synthetic corrected core\n')
        self.new_pins={**self.hashes,'admin-trust-transition.py':hashlib.sha256(self.source.read_bytes()).hexdigest()}
        self.archive=self.work.with_name(self.work.name+'-before-user-hash-fix')
    def refresh(self,run=None,fault=None):
        return self.m.refresh_failed_empty(self.bundle,self.hashes,self.new_pins,self.source,self.work,owner=os.getuid(),gid=os.getgid(),anchor=self.root,run=run or (lambda c:self.calls.append(c)),out=self.output,fault=fault)
    def test_known_empty_failure_is_preserved_and_only_corrected_prepare_runs(self):
        self.assertEqual(self.refresh(),'PREPARE_COMPLETED')
        self.assertFalse(self.work.exists());self.assertEqual((self.archive/'failed-shell').stat().st_ino,self.old_shell_inode)
        self.assertEqual((self.archive/'source-review.before.json').read_bytes(),self.old_review)
        self.assertEqual((self.archive/'core.before').read_bytes(),self.old_core)
        self.assertEqual((self.bundle/'admin-trust-transition.py').read_bytes(),self.source.read_bytes())
        record=json.loads(self.approval.read_bytes());self.assertEqual(record['files'],self.new_pins)
        self.assertEqual(record['reviewedBy'],'Codex AI reviewer /root/preflight_retry_review')
        self.assertFalse(record['preparationAuthorization']['userCodeReviewClaimed']);self.assertFalse(record['preparationAuthorization']['operatingTransitionApproved'])
        self.assertEqual(self.calls,[[self.m.PYTHON,'-I',str(self.bundle/'admin-trust-transition.py'),'--prepare']])
    def test_nonempty_shell_and_extra_plan_are_refused_without_modification(self):
        for path in (self.work/'before/keep',self.work/'plan.json'):
            path.write_text('preserve')
            with self.assertRaisesRegex(RuntimeError,'FAILED_PREPARATION_NOT_EMPTY'):self.refresh()
            self.assertEqual(self.approval.read_bytes(),self.old_review);self.assertEqual(path.read_text(),'preserve');self.assertFalse(self.archive.exists());path.unlink()
        self.assertEqual(self.calls,[])
    def test_wrong_source_or_unexpected_review_is_refused_before_preservation(self):
        self.source.write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError,'CORRECTED_SOURCE_HASH_MISMATCH'):self.refresh()
        self.assertFalse(self.archive.exists());self.assertTrue(self.work.exists())
        self.source.write_bytes(b'# synthetic corrected core\n');value=json.loads(self.old_review);value['unexpected']=True;self.approval.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError,'PRIOR_REVIEW_CHANGED'):self.refresh()
        self.assertFalse(self.archive.exists());self.assertEqual(self.calls,[])
    def test_duplicate_or_existing_archive_never_overwrites_or_redispatches(self):
        self.archive.mkdir()
        with self.assertRaisesRegex(RuntimeError,'REFRESH_EVIDENCE_EXISTS'):self.refresh()
        self.assertEqual(self.approval.read_bytes(),self.old_review);self.assertEqual(self.calls,[])
        self.archive.rmdir();self.refresh();before=self.approval.read_bytes()
        with self.assertRaises(RuntimeError):self.refresh()
        self.assertEqual(self.approval.read_bytes(),before);self.assertEqual(len(self.calls),1)
    def test_partial_stage_failures_preserve_proof_and_never_dispatch(self):
        for stop in ('snapshots_saved','shell_preserved','core_replaced','review_replaced'):
            with self.subTest(stage=stop):
                f=RefreshTests();f.setUp()
                try:
                    def fail(stage):
                        if stage==stop:raise OSError('synthetic interruption')
                    with self.assertRaises(OSError):f.refresh(fault=fail)
                    self.assertEqual((f.archive/'source-review.before.json').read_bytes(),f.old_review)
                    self.assertEqual((f.archive/'core.before').read_bytes(),f.old_core)
                    self.assertEqual(f.calls,[])
                    with self.assertRaises(RuntimeError):f.refresh()
                finally:f.doCleanups()
    def test_refresh_uses_same_lock_as_old_wrapper(self):
        lock=self.bundle/'.prepare-wrapper.lock'
        with lock.open('r+b') as file:
            fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError,'PREPARATION_BUSY'):self.refresh()
        self.assertFalse(self.archive.exists());self.assertEqual(self.calls,[])

class BaselineRefreshTests(unittest.TestCase):
    resume=PrepareTests.resume
    def setUp(self):
        RefreshTests.setUp(self)
        self.m.refresh_failed_empty(self.bundle,self.hashes,self.new_pins,self.source,self.work,owner=os.getuid(),gid=os.getgid(),anchor=self.root,run=lambda c:None,out=self.output)
        self.prior_files={p:p.read_bytes() for p in self.archive.rglob('*') if p.is_file()}
        self.prior_inode=(self.archive/'failed-shell').stat().st_ino
        self.work.mkdir(mode=0o700)
        for name in ('before','after','original-kits','original-failure'):(self.work/name).mkdir(mode=0o700)
        self.second_inode=self.work.stat().st_ino;self.before_review=self.approval.read_bytes()
        self.source.write_bytes(b'# synthetic baseline correction\n');self.final_pins={**self.new_pins,'admin-trust-transition.py':hashlib.sha256(self.source.read_bytes()).hexdigest()};self.calls=[]
        self.second_archive=self.work.with_name(self.work.name+'-before-baseline-selection-fix')
    def refresh(self,run=None,fault=None):
        return self.m.refresh_failed_empty(self.bundle,self.new_pins,self.final_pins,self.source,self.work,owner=os.getuid(),gid=os.getgid(),anchor=self.root,run=run or (lambda c:self.calls.append(c)),out=self.output,fault=fault,previous_pins=self.hashes)
    def test_second_refresh_preserves_both_failed_shells_and_exact_ai_history(self):
        self.assertEqual(self.refresh(),'PREPARE_COMPLETED')
        self.assertEqual(self.prior_files,{p:p.read_bytes() for p in self.archive.rglob('*') if p.is_file()})
        self.assertEqual((self.archive/'failed-shell').stat().st_ino,self.prior_inode)
        self.assertEqual((self.second_archive/'failed-shell').stat().st_ino,self.second_inode)
        self.assertEqual((self.second_archive/'source-review.before.json').read_bytes(),self.before_review)
        record=json.loads(self.approval.read_bytes());self.assertEqual(record['files'],self.final_pins);self.assertFalse(record['preparationAuthorization']['userCodeReviewClaimed']);self.assertFalse(record['stagingRefreshInvocation']['operatingTransitionApproved'])
        self.assertEqual(self.calls,[[self.m.PYTHON,'-I',str(self.bundle/'admin-trust-transition.py'),'--prepare']])
    def test_nonempty_second_shell_or_missing_prior_history_never_overwrites(self):
        p=self.work/'before/retain';p.write_bytes(b'evidence')
        with self.assertRaisesRegex(RuntimeError,'FAILED_PREPARATION_NOT_EMPTY'):self.refresh()
        self.assertEqual(p.read_bytes(),b'evidence');self.assertEqual(self.approval.read_bytes(),self.before_review);self.assertFalse(self.second_archive.exists())
        p.unlink();(self.archive/'core.before').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError,'PRIOR_REFRESH_CHANGED'):self.refresh()
        self.assertFalse(self.second_archive.exists());self.assertEqual(self.calls,[])
    def test_second_stage_partial_failures_cannot_be_repeated(self):
        for stop in ('snapshots_saved','shell_preserved','core_replaced','review_replaced'):
            f=BaselineRefreshTests();f.setUp()
            try:
                def fail(stage):
                    if stage==stop:raise OSError('synthetic interruption')
                with self.assertRaises(OSError):f.refresh(fault=fail)
                self.assertEqual(f.prior_files,{p:p.read_bytes() for p in f.archive.rglob('*') if p.is_file()})
                with self.assertRaises(RuntimeError):f.refresh()
                self.assertEqual(f.calls,[])
            finally:f.doCleanups()
    def test_duplicate_second_refresh_never_dispatches_twice(self):
        self.refresh();before=self.approval.read_bytes()
        with self.assertRaises(RuntimeError):self.refresh()
        self.assertEqual(self.approval.read_bytes(),before);self.assertEqual(len(self.calls),1)

if __name__=='__main__':unittest.main()
