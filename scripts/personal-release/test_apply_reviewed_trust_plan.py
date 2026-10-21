"""One-plan review recording + existing check/apply, synthetic operating tree only."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import test_admin_trust_transition as whole
import test_dashboard_kit as base
class ApplyReviewTests(unittest.TestCase):
    def setUp(self):
        self.f=whole.WholeTransitionTests();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.result=self.f.transition.prepare(self.f.failed_id);self.t=self.f.transition
        path=Path(__file__).with_name('apply-reviewed-trust-plan.py');self.assertTrue(path.exists(),'fixed reviewed-plan execution wrapper missing')
        self.m=base.load('apply-reviewed-trust-plan');self.exporter=base.load('export-trust-plan-review');self.commands=[];self.count=len(self.t.record(self.t.work/'plan.json')['targets'])
    def execute(self,command):
        self.commands.append(command)
        if command[-1]=='--check':
            with self.t.locks():plan,_=self.t.reviewed();self.t.unchanged(plan)
        elif command[-1]=='--apply':self.t.apply()
        else:self.fail('unexpected command')
    def run_wrapper(self,**kw):return self.m.record_check_apply(self.t,self.exporter.inspect,self.execute,plan_sha=self.result['planSha256'],intent_sha=self.result['intentSha256'],count=self.count,**kw)
    def test_source_reader_handles_actual_service_group_write_without_permission_changes(self):
        import os,stat
        from types import SimpleNamespace
        source=Path(__file__).with_name('export-trust-plan-review.py');inode=source.stat().st_ino;real=os.fstat
        def metadata(fd):
            info=real(fd);fields={n:getattr(info,n) for n in ('st_uid','st_gid','st_mode','st_nlink','st_size','st_ino')}
            if stat.S_ISDIR(info.st_mode):
                if info.st_uid not in (0,1000):fields['st_uid']=0
                if info.st_gid not in (0,1000):fields['st_gid']=0
            if info.st_ino==inode:fields.update(st_uid=1000,st_gid=1000,st_mode=stat.S_IFREG|0o664)
            return SimpleNamespace(**fields)
        with patch.object(self.m.os,'fstat',metadata):self.assertEqual(self.m.pinned_bytes(source,self.m.EXPORTER_SHA,root_only=False),source.read_bytes())
        with patch.object(self.m.os,'fstat',metadata),self.assertRaises(RuntimeError):self.m.pinned_bytes(source,'0'*64,root_only=False)
        def wrong_group(fd):
            value=metadata(fd)
            if value.st_ino==inode:value.st_gid=1001
            return value
        with patch.object(self.m.os,'fstat',wrong_group),self.assertRaises(RuntimeError):self.m.pinned_bytes(source,self.m.EXPORTER_SHA,root_only=False)

    def test_existing_guard_lock_prevents_concurrent_recording(self):
        with self.t.locks(),self.assertRaises(Exception):self.run_wrapper()
        self.assertFalse((self.t.work/'review.json').exists());self.assertEqual(self.commands,[])

    def test_success_records_real_ai_attribution_and_only_existing_check_apply(self):
        actions=list(self.f.system.actions);failure=self.f.manager.job_path(self.f.failed_id).read_bytes()
        value=self.run_wrapper();review=self.t.record(self.t.work/'review.json')
        self.assertTrue(value['committed']);self.assertFalse(value['serviceControlled']);self.assertFalse(value['retryStarted']);self.assertEqual(review['planSha256'],self.result['planSha256']);self.assertFalse(review['userCodeReviewClaimed']);self.assertEqual(review['reviewedBy'],'Codex AI plan reviewer /root')
        self.assertEqual([c[-1] for c in self.commands],['--check','--apply']);self.assertEqual(self.f.system.actions,actions);self.assertEqual(self.f.raw.read_bytes(),self.f.original_data);self.assertEqual(self.f.manager.job_path(self.f.failed_id).read_bytes(),failure)
    def test_wrong_plan_or_changed_live_content_does_not_record_review(self):
        with self.assertRaises(RuntimeError):self.m.record_check_apply(self.t,self.exporter.inspect,self.execute,plan_sha='0'*64,intent_sha=self.result['intentSha256'],count=self.count)
        self.assertFalse((self.t.work/'review.json').exists());self.assertEqual(self.commands,[])
        self.f.paths['engine'].write_bytes(b'changed installed code')
        with self.assertRaises(Exception):self.run_wrapper()
        self.assertFalse((self.t.work/'review.json').exists());self.assertEqual(self.commands,[])
    def test_existing_different_review_is_preserved_and_duplicate_started_plan_stops(self):
        self.f.write(self.t.work/'review.json',b'{"preserve":"existing review"}')
        with self.assertRaises(RuntimeError):self.run_wrapper()
        self.assertEqual((self.t.work/'review.json').read_bytes(),b'{"preserve":"existing review"}');self.assertEqual(self.commands,[])
        (self.t.work/'review.json').unlink();self.run_wrapper();before=(self.t.work/'review.json').read_bytes()
        with self.assertRaises(RuntimeError):self.run_wrapper()
        self.assertEqual((self.t.work/'review.json').read_bytes(),before);self.assertEqual(len(self.commands),2)
    def test_check_failure_retains_review_and_never_starts_apply(self):
        def failed(command):self.commands.append(command);raise RuntimeError('SYNTHETIC_CHECK_FAILURE')
        with self.assertRaises(RuntimeError):self.m.record_check_apply(self.t,self.exporter.inspect,failed,plan_sha=self.result['planSha256'],intent_sha=self.result['intentSha256'],count=self.count)
        self.assertTrue((self.t.work/'review.json').is_file());self.assertEqual([c[-1] for c in self.commands],['--check']);self.assertFalse((self.t.work/'journal.json').exists())
    def test_review_fsync_uncertainty_never_dispatches(self):
        real=self.t.save
        def fail(name,value):
            real(name,value)
            if name=='review.json':raise OSError('synthetic review fsync uncertainty')
        with patch.object(self.t,'save',fail),self.assertRaises(OSError):self.run_wrapper()
        self.assertEqual(self.commands,[]);self.assertFalse((self.t.work/'journal.json').exists())
    def test_apply_failure_uses_core_restore_and_is_not_retried(self):
        old=(self.f.root/'usr/local/libexec/agentmemory-update-runner').read_bytes()
        def execute(command):
            self.commands.append(command)
            if command[-1]=='--apply':
                def fault(index,path):raise RuntimeError('SYNTHETIC_APPLY_FAILURE')
                self.t.apply(fault)
        with self.assertRaises(RuntimeError):self.m.record_check_apply(self.t,self.exporter.inspect,execute,plan_sha=self.result['planSha256'],intent_sha=self.result['intentSha256'],count=self.count)
        self.assertEqual(self.t.record(self.t.work/'journal.json')['phase'],'restored');self.assertEqual((self.f.root/'usr/local/libexec/agentmemory-update-runner').read_bytes(),old);self.assertEqual(len(self.commands),2)
        with self.assertRaises(RuntimeError):self.run_wrapper()
if __name__=='__main__':unittest.main()
