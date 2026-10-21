"""Preparation wrapper tests use temporary synthetic code, never sudo or operating paths."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

HERE=Path(__file__).resolve().parent
class PrepareTests(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('prepare_wrapper',HERE/'prepare-trust-transition.py')
        self.assertIsNotNone(spec,'preparation wrapper missing')
        self.assertTrue(Path(spec.origin).exists(),'preparation wrapper missing')
        self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.source=self.root/'source';self.source.mkdir();self.bundle=self.root/'bundle'
        self.hashes={}
        for name in self.m.PINS:
            raw=('# synthetic '+name+'\n').encode();(self.source/name).write_bytes(raw);self.hashes[name]=hashlib.sha256(raw).hexdigest()
        self.calls=[];self.output=io.StringIO()
    def run_prepare(self,answers):
        inputs=iter(answers)
        return self.m.prepare(self.source,self.bundle,self.hashes,owner=os.getuid(),gid=os.getgid(),ask=lambda _:next(inputs),run=lambda command:self.calls.append(command),out=self.output)
    def test_no_review_stages_only_without_attestation_or_execution(self):
        self.assertEqual(self.run_prepare(['']), 'STAGED_REVIEW_REQUIRED')
        record=json.loads((self.bundle/'source-review.json').read_text())
        self.assertFalse(record['executionClosureReviewed']);self.assertEqual(record['reviewedBy'],'');self.assertEqual(self.calls,[])
        self.assertTrue(all((self.bundle/n).read_bytes()==(self.source/n).read_bytes() for n in self.hashes))
    def test_real_review_records_identity_and_runs_prepare_only(self):
        self.assertEqual(self.run_prepare(['Actual Reviewer','SOURCE REVIEW COMPLETE; PREPARE ONLY']), 'PREPARE_COMPLETED')
        record=json.loads((self.bundle/'source-review.json').read_text())
        self.assertEqual(record['reviewedBy'],'Actual Reviewer');self.assertTrue(record['executionClosureReviewed'])
        self.assertEqual(record['independentReviewEvidence']['performedBy'],'Codex AI reviewer /root/preflight_retry_review')
        self.assertEqual(self.calls,[[self.m.PYTHON,'-I',str(self.bundle/'admin-trust-transition.py'),'--prepare']])
    def test_wrong_confirmation_does_not_claim_review_or_execute(self):
        self.assertEqual(self.run_prepare(['Actual Reviewer','yes']), 'STAGED_REVIEW_REQUIRED')
        self.assertFalse(json.loads((self.bundle/'source-review.json').read_text())['executionClosureReviewed']);self.assertEqual(self.calls,[])
    def test_interrupt_after_launch_is_uncertain_and_never_reported_unstarted(self):
        inputs=iter(['Actual Reviewer','SOURCE REVIEW COMPLETE; PREPARE ONLY'])
        def interrupt(command):raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt) as caught:
            self.m.prepare(self.source,self.bundle,self.hashes,owner=os.getuid(),gid=os.getgid(),ask=lambda _:next(inputs),run=interrupt,out=self.output)
        self.assertEqual(self.m.failure_code(caught.exception),'PREPARE_INTERRUPTED_INSPECT_RESULT_NO_RETRY')
    def test_interrupt_before_review_does_not_claim_prepare_started(self):
        def interrupt(prompt):raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt) as caught:
            self.m.prepare(self.source,self.bundle,self.hashes,owner=os.getuid(),gid=os.getgid(),ask=interrupt,run=lambda c:self.calls.append(c),out=self.output)
        self.assertEqual(self.m.failure_code(caught.exception),'REVIEW_INTERRUPTED_NO_PREPARE');self.assertEqual(self.calls,[])

    def test_existing_bundle_stops_without_overwrite(self):
        self.bundle.mkdir();sentinel=self.bundle/'keep';sentinel.write_text('preserved')
        with self.assertRaisesRegex(RuntimeError,'BUNDLE_EXISTS'):self.run_prepare([])
        self.assertEqual(list(self.bundle.iterdir()),[sentinel]);self.assertEqual(self.calls,[])
    def test_wrong_hash_stops_before_root_staging(self):
        (self.source/next(iter(self.hashes))).write_text('changed')
        with self.assertRaisesRegex(RuntimeError,'SOURCE_HASH_MISMATCH'):self.run_prepare([])
        self.assertFalse(self.bundle.exists());self.assertEqual(self.calls,[])
    def test_symlink_source_refused_before_staging(self):
        name=next(iter(self.hashes));raw=(self.source/name).read_bytes();(self.source/name).unlink();other=self.root/'other';other.write_bytes(raw);(self.source/name).symlink_to(other)
        with self.assertRaises(OSError):self.run_prepare([])
        self.assertFalse(self.bundle.exists())
    def test_staged_tamper_during_review_refuses_execution(self):
        def ask(prompt):
            (self.bundle/'dashboard-updates.py').write_text('changed')
            return 'Actual Reviewer' if '이름' in prompt else 'SOURCE REVIEW COMPLETE; PREPARE ONLY'
        with self.assertRaisesRegex(RuntimeError,'STAGED_HASH_MISMATCH'):
            self.m.prepare(self.source,self.bundle,self.hashes,owner=os.getuid(),gid=os.getgid(),ask=ask,run=lambda c:self.calls.append(c),out=self.output)
        self.assertFalse(json.loads((self.bundle/'source-review.json').read_text())['executionClosureReviewed']);self.assertEqual(self.calls,[])

if __name__=='__main__':unittest.main()
