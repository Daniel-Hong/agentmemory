"""Metadata-only diagnostic tests; no operating paths or sudo."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        path=HERE/'diagnose-trust-preparation.py';self.assertTrue(path.exists(),'readonly diagnostic missing')
        spec=importlib.util.spec_from_file_location('prep_diagnostic',path);self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.bundle=self.root/self.m.BUNDLE.lstrip('/');self.bundle.mkdir(parents=True)
        self.pins={}
        for name in self.m.PINS:
            raw=b'# synthetic reviewed code\n';p=self.bundle/name;p.write_bytes(raw);p.chmod(0o644);self.pins[name]=hashlib.sha256(raw).hexdigest()
        self.work=self.root/self.m.WORK.lstrip('/');self.work.mkdir(parents=True)
        for name in ('before','after','original-kits','original-failure'):(self.work/name).mkdir(mode=0o700)
        self.base=self.root/self.m.CURRENT.lstrip('/');self.base.mkdir(parents=True)
        self.engine=self.root/'home/daniel/.agentmemory/bin/iii';self.engine.parent.mkdir(parents=True);self.engine.write_text('synthetic engine');self.engine.parent.chmod(0o775)
        for branch in (self.bundle,self.work,self.base):
            for parent in (branch,*branch.parents):
                parent.chmod(0o755)
                if parent==self.root:break
        (self.root/'home').chmod(0o755);(self.root/'home/daniel').chmod(0o750);self.engine.parent.parent.chmod(0o700)
        (self.base/'baseline.json').write_text(json.dumps({'protectedFiles':{str(self.engine):'0'*64}}));(self.base/'baseline.json').chmod(0o644)
        (self.bundle/'source-review.json').write_text(json.dumps({'executionClosureReviewed':True,'reviewedBy':'Codex AI reviewer /root/preflight_retry_review','files':self.pins,'preparationAuthorization':{'userCodeReviewClaimed':False},'privateSentinel':'NEVER_RETURN_BODY'}));(self.bundle/'source-review.json').chmod(0o600)
    def diagnose(self):return self.m.diagnose(self.root,owner=os.getuid(),service_uid=os.getuid(),service_gid=os.getgid(),pins=self.pins)
    def test_report_is_readonly_and_contains_no_private_body(self):
        real=os.open
        def readonly(path,flags,*args,**kwargs):
            self.assertFalse(flags&(os.O_CREAT|os.O_WRONLY|os.O_RDWR));return real(path,flags,*args,**kwargs)
        before=set(self.root.rglob('*'))
        with patch.object(self.m.os,'open',readonly):result=self.diagnose()
        self.assertTrue(result['readOnly']);self.assertFalse(result['actualFailurePathKnown']);self.assertNotIn('NEVER_RETURN_BODY',json.dumps(result));self.assertEqual(before,set(self.root.rglob('*')))
    def test_pending_empty_preparation_shell_is_distinguished_from_complete_plan(self):
        r=self.diagnose();self.assertTrue(r['preparation']['exists']);self.assertTrue(r['preparation']['emptyShell']);self.assertFalse(r['resumeAuthorized'])
        (self.work/'plan.json').write_text('{"secret":"NEVER_RETURN_BODY"}');(self.work/'plan.json').chmod(0o600)
        r=self.diagnose();self.assertTrue(r['preparation']['planPresent']);self.assertFalse(r['preparation']['emptyShell']);self.assertNotIn('NEVER_RETURN_BODY',json.dumps(r))
    def test_detects_actual_0775_old_guard_condition_with_metadata_only(self):
        r=self.diagnose();self.assertGreater(r['publicBaselinePaths']['oldGuardConflicts'],0)
        c=r['publicBaselinePaths']['firstConflict'];self.assertEqual(c['ancestor'],str(self.engine.parent));self.assertTrue(c['serviceGroupWriteOnly'])
    def test_new_reader_layout_summary_accepts_service_0775_but_rejects_world_write(self):
        result=self.diagnose();self.assertEqual(result['publicBaselinePaths']['newReaderMetadataConflicts'],0)
        self.engine.parent.chmod(0o777)
        result=self.diagnose();self.assertEqual(result['publicBaselinePaths']['newReaderMetadataConflicts'],1)
        self.assertEqual(result['publicBaselinePaths']['firstNewReaderConflict']['reason'],'WRITABLE_BY_UNEXPECTED_ROLE')

    def test_new_reader_layout_summary_rejects_hardlinked_artifact(self):
        os.link(self.engine,self.engine.with_name('linked'))
        result=self.diagnose();self.assertEqual(result['publicBaselinePaths']['newReaderMetadataConflicts'],1)
        self.assertEqual(result['publicBaselinePaths']['firstNewReaderConflict']['reason'],'FILE_TYPE_LINK_OR_SIZE')

    def test_service_directory_prediction_requires_read_and_execute_for_group_and_other(self):
        home=self.root/'home';home.chmod(0o711)
        for gid in (os.getgid(),os.getgid()+1):
            result=self.m.diagnose(self.root,owner=os.getuid(),service_uid=os.getuid()+1,service_gid=gid,pins=self.pins)
            first=result['publicBaselinePaths']['firstNewReaderConflict']
            self.assertIsNotNone(first);self.assertEqual(first['ancestor'],str(home));self.assertEqual(first['reason'],'SERVICE_ACCESS_NOT_SHOWN_BY_MODE')

    def test_public_archive_paths_are_included_without_reading_archive_body(self):
        archive=self.root/'home/daniel/archives/code.tgz';archive.parent.mkdir();archive.write_text('NEVER_RETURN_BODY');archive.parent.chmod(0o777)
        path=self.base/'baseline.json';value=json.loads(path.read_text());value['archives']=[{'path':str(archive),'sha256':'0'*64}];path.write_text(json.dumps(value))
        result=self.diagnose();self.assertEqual(result['publicBaselinePaths']['count'],2);self.assertEqual(result['publicBaselinePaths']['newReaderMetadataConflicts'],1);self.assertNotIn('NEVER_RETURN_BODY',json.dumps(result))

    def test_unknown_preparation_files_are_counted_without_returning_names(self):
        (self.work/'NEVER_RETURN_BODY').write_text('private')
        r=self.diagnose();self.assertEqual(r['preparation']['unknownEntryCount'],1);self.assertNotIn('NEVER_RETURN_BODY',json.dumps(r))
    def test_private_claim_field_never_passes_arbitrary_value_to_output(self):
        value=json.loads((self.bundle/'source-review.json').read_text());value['preparationAuthorization']['userCodeReviewClaimed']={'secret':'NEVER_RETURN_BODY'}
        (self.bundle/'source-review.json').write_text(json.dumps(value))
        result=self.diagnose();self.assertNotIn('NEVER_RETURN_BODY',json.dumps(result));self.assertIs(result['staging']['userCodeReviewClaimed'],False)

    def test_directory_named_plan_is_not_classified_as_empty_shell(self):
        (self.work/'plan.json').mkdir()
        with self.assertRaisesRegex(RuntimeError,'DIAGNOSTIC_PATH_REFUSED'):self.diagnose()

    def test_symlink_bundle_is_refused_without_following(self):
        alternate=self.root/'alternative';self.bundle.rename(alternate);self.bundle.symlink_to(alternate,target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError,'DIAGNOSTIC_PATH_REFUSED'):self.diagnose()
    def test_symlink_plan_is_not_misreported_as_empty_shell(self):
        outside=self.root/'outside';outside.write_text('NEVER_RETURN_BODY');(self.work/'plan.json').symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError,'DIAGNOSTIC_PATH_REFUSED'):self.diagnose()

    def test_missing_preparation_is_not_created(self):
        for p in self.work.iterdir():p.rmdir()
        self.work.rmdir();r=self.diagnose();self.assertFalse(r['preparation']['exists']);self.assertFalse(self.work.exists())
if __name__=='__main__':unittest.main()
