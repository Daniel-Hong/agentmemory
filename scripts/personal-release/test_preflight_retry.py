"""Synthetic-only administrator retry regression tests; no host service/API."""
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid
import test_dashboard_updates as base
m = base.m

class PreflightRetryTests(unittest.TestCase):
    setUp = base.DashboardUpdatesTest.setUp
    save_kit = base.DashboardUpdatesTest.save_kit
    enroll = base.DashboardUpdatesTest.enroll
    request = base.DashboardUpdatesTest.request

    def failure(self):
        self.enroll()
        old = str(uuid.uuid4())
        self.runner.save_job({'jobId':old,'candidateId':'release-1','createdAt':m.now(),'bootId':m.boot_id()}, 'failed','failed','PROGRAM_FAILED')
        work = self.runner.state/'private/release-kits/release-1'
        work.mkdir(parents=True);work.chmod(0o700);work.parent.chmod(0o700)
        self.tx = {'phase':'failed','at':m.now(),'dataRewound':False,'failedPhase':'constructed','errorCode':'UPDATE_FAILED','recoveryStatus':'not_needed','codeRollbackVerified':False,'rollbackErrorCode':None,'shutdownCertified':False,'shutdownReceiptSha256':None,'inspectionRequired':False}
        (work/'transaction.json').write_text(json.dumps(self.tx));(work/'transaction.json').chmod(0o600)
        self.transaction = work/'transaction.json'
        failed=self.runner.job(old);failed['updatedAt']=m.now();self.runner.write(self.runner.job_path(old),failed)
        self.log = self.runner.state/'private'/(old+'.log')
        self.log.write_text('PHASE: failed\n'+json.dumps({'errorCode':'CLIENT_PROCESS_ACTIVE','dataRewound':False})+'\n')
        self.log.chmod(0o600)
        # Explicit immutable baseline file is part of the reviewed kit.
        for root in [self.kit,self.runner.state/'vault/release-1']:
            (root/'baseline.json').write_text('{"synthetic":true}\n');(root/'baseline.json').chmod(0o600)
            meta=json.loads((root/'kit.json').read_text());meta['files']['baseline.json']=m.sha(root/'baseline.json');(root/'kit.json').write_text(json.dumps(meta))
        entries=self.runner.catalog();entries[0]['kitSha256']=m.sha(self.runner.state/'vault/release-1/kit.json');self.runner.write(self.runner.state/'catalog.json',{'candidates':entries},0o600)
        return old

    def retry(self, old, new=None):
        new = new or str(uuid.uuid4())
        with patch.object(self.runner,'verify_retry_current',return_value={'verified':True}), patch.object(m.subprocess,'run') as start:
            result=self.runner.retry_preflight(old,new)
        return result,start

    def test_normal_root_request_cannot_retry_failed_candidate(self):
        self.failure()
        with patch.object(m.subprocess,'run') as start, self.assertRaisesRegex(m.Rejected,'CANDIDATE_PREVIOUSLY_FAILED'):
            self.runner.request(self.request())
        start.assert_not_called()

    def test_admin_retry_preserves_failure_and_binds_new_job_once(self):
        old=self.failure();before=self.runner.job_path(old).read_bytes();new=str(uuid.uuid4())
        result,start=self.retry(old,new)
        self.assertEqual(result['status'],'queued');self.assertEqual(result['retryOf'],old)
        self.assertEqual(self.runner.job_path(old).read_bytes(),before);start.assert_called_once()
        again,dispatch=self.retry(old,new);self.assertEqual(again['jobId'],new);dispatch.assert_not_called()
        with self.assertRaisesRegex(m.Rejected,'RETRY_ALREADY_CLAIMED'):self.retry(old)
        self.assertFalse(self.marker.exists())

    def test_non_preflight_unknown_and_partial_failures_refused(self):
        old=self.failure()
        for key,value in [('phase','ready_to_start'),('failedPhase','normal_shutdown_verified'),('recoveryStatus','restored'),('shutdownCertified',True),('inspectionRequired',True),('dataRewound',True)]:
            with self.subTest(key=key):
                tx={**self.tx,key:value};self.transaction.write_text(json.dumps(tx))
                with self.assertRaisesRegex(m.Rejected,'RETRY_FAILURE_UNVERIFIED'):self.retry(old)
        self.transaction.write_text(json.dumps(self.tx))
        for text in ['{"errorCode":"UPDATE_FAILED","dataRewound":false}\n','PHASE: preflight_verified\n'+self.log.read_text(),'{"errorCode":"CLIENT_PROCESS_ACTIVE","dataRewound":true}\n']:
            self.log.write_text(text)
            with self.assertRaisesRegex(m.Rejected,'RETRY_FAILURE_UNVERIFIED'):self.retry(old)

    def test_interrupted_or_changed_kit_or_existing_uuid_refused(self):
        old=self.failure();original=self.runner.job(old)
        self.runner.save_job(dict(original),'interrupted','inspection_required')
        with self.assertRaisesRegex(m.Rejected,'RETRY_FAILURE_UNVERIFIED'):self.retry(old)
        self.runner.write(self.runner.job_path(old),original)
        with self.assertRaisesRegex(m.Rejected,'RETRY_REQUEST_EXISTS'):self.retry(old,old)
        (self.runner.state/'vault/release-1/baseline.json').write_text('{}')
        with self.assertRaises(m.Rejected):self.retry(old)

    def test_live_guard_failure_creates_no_claim_or_job(self):
        old=self.failure();new=str(uuid.uuid4())
        with patch.object(self.runner,'verify_retry_current',side_effect=m.Rejected('RETRY_CURRENT_UNVERIFIED')),self.assertRaisesRegex(m.Rejected,'RETRY_CURRENT_UNVERIFIED'):
            self.runner.retry_preflight(old,new)
        self.assertFalse(self.runner.job_path(new).exists())
        self.assertFalse((self.runner.state/'private'/('preflight-retry-'+old+'.json')).exists())

    def test_busy_global_lock_refuses_admin_retry(self):
        old=self.failure()
        with self.runner.lock(),self.assertRaisesRegex(m.Rejected,'BUSY'):self.retry(old)

    def test_changed_failed_job_or_baseline_after_claim_refused_at_execution(self):
        old=self.failure();result,_=self.retry(old);new=result['jobId']
        value=self.runner.job(old);value['updatedAt']=m.now();self.runner.write(self.runner.job_path(old),value)
        result=self.runner.run_job(new)
        self.assertEqual(result['status'],'failed');self.assertFalse(self.marker.exists())

    def test_job_creation_failure_consumes_retry_and_fails_closed(self):
        old=self.failure();new=str(uuid.uuid4());write=self.runner.write
        def fail(path,*args,**kwargs):
            if path==self.runner.job_path(new):raise OSError('synthetic write failure')
            return write(path,*args,**kwargs)
        with patch.object(self.runner,'write',side_effect=fail),patch.object(self.runner,'verify_retry_current',return_value={'verified':True}),self.assertRaises(OSError):self.runner.retry_preflight(old,new)
        with self.assertRaisesRegex(m.Rejected,'RETRY_STATE_UNCERTAIN'):self.retry(old,new)

    def test_ordinary_request_cannot_redispatch_admin_retry_uuid(self):
        old=self.failure();result,_=self.retry(old);identifier=result['jobId']
        self.request(identifier)
        with patch.object(m.subprocess,'run') as start:
            saved=self.runner.request(identifier)
        self.assertEqual(saved['jobId'],identifier);start.assert_not_called()

    def test_actual_readonly_checker_runs_only_reviewed_vault_runtime(self):
        old=self.failure();root=self.runner.state/'vault/release-1'
        runtime="""from pathlib import Path
import json
class Runtime:
 def __init__(self,root):
  self.root=root;self.version=root/'not-installed';self.receipt=root/'no-receipt';self.system=self
 def require_client_idle(self):
  if (self.root/'busy').exists():raise RuntimeError('CLIENT_PROCESS_ACTIVE')
 def guard(self,*,before):
  assert before
  if (self.root/'bad-baseline').exists():raise RuntimeError('ROOT_ASSET_CHANGED')
 def verify_dependency_reuse(self):pass
 def main_pid(self):return 10
 def verify_identity(self):pass
 def api(self,path):
  if path=='health':return {'status':'healthy','storageDurability':{'mutationFailures':0},'memoryPressure':{'level':'normal'}}
  assert path=='background/control'
  return {'control':{'status':'running','error':None}}
def require(value,code):
 if not value:raise RuntimeError(code)
"""
        meta=json.loads((root/'kit.json').read_text());meta['entrypoint']='kit-runtime.py'
        for name,data in [('kit-runtime.py',runtime),('kit-queues.py',''),('kit-integrity.py','')]:
            (root/name).write_text(data);(root/name).chmod(0o600);meta['files'][name]=m.sha(root/name)
        (root/'kit.json').write_text(json.dumps(meta))
        self.assertEqual(self.runner.verify_retry_current(root),{'verified':True})
        # Flags are fixture files, explicitly part of the reviewed closure.
        for flag in ['busy','bad-baseline']:
            (root/flag).write_text('fixture');(root/flag).chmod(0o600);meta['files'][flag]=m.sha(root/flag);(root/'kit.json').write_text(json.dumps(meta))
            with self.assertRaisesRegex(m.Rejected,'RETRY_CURRENT_UNVERIFIED'):self.runner.verify_retry_current(root)
            (root/flag).unlink();del meta['files'][flag];(root/'kit.json').write_text(json.dumps(meta))
        self.assertFalse(list(root.glob('__pycache__')))
        self.assertFalse(self.marker.exists())

    def test_successful_retry_executes_exactly_once_and_keeps_original_failure(self):
        old=self.failure();before=self.runner.job_path(old).read_bytes();result,_=self.retry(old)
        with patch.object(self.runner,'verify_retry_current',return_value={'verified':True}) as current:
            applied=self.runner.run_job(result['jobId'])
            again=self.runner.run_job(result['jobId'])
        self.assertEqual(applied['status'],'applied_pending_acceptance');self.assertEqual(again,applied)
        current.assert_called_once();self.assertEqual(self.marker.read_text(),'applied\n')
        self.assertEqual(self.runner.job_path(old).read_bytes(),before)
        duplicate,dispatch=self.retry(old,result['jobId']);self.assertEqual(duplicate['status'],'applied_pending_acceptance');dispatch.assert_not_called()

    def test_current_guards_rechecked_before_actual_execution(self):
        old=self.failure();result,_=self.retry(old)
        with patch.object(self.runner,'verify_retry_current',side_effect=m.Rejected('RETRY_CURRENT_UNVERIFIED')) as current:
            result=self.runner.run_job(result['jobId'])
        current.assert_called_once();self.assertEqual(result['status'],'failed');self.assertFalse(self.marker.exists())

    def test_new_retry_cannot_be_retried_after_failure(self):
        old=self.failure();result,_=self.retry(old)
        self.runner.save_job(result,'failed','failed','PROGRAM_FAILED')
        with self.assertRaisesRegex(m.Rejected,'RETRY_FAILURE_UNVERIFIED'):self.retry(result['jobId'])

    def test_failure_log_symlink_is_rejected(self):
        old=self.failure();saved=self.root/'saved-log';self.log.rename(saved);self.log.symlink_to(saved)
        with self.assertRaises(m.Rejected):self.retry(old)

    def test_dispatch_failure_preserves_consumed_claim_without_redispatch(self):
        old=self.failure();new=str(uuid.uuid4())
        with patch.object(self.runner,'verify_retry_current',return_value={'verified':True}),patch.object(m.subprocess,'run',side_effect=OSError('synthetic dispatch')),self.assertRaisesRegex(m.Rejected,'RETRY_DISPATCH_UNCONFIRMED'):
            self.runner.retry_preflight(old,new)
        result,start=self.retry(old,new);self.assertEqual(result['status'],'queued');start.assert_not_called()

    def test_second_failure_and_active_job_block_admin_retry(self):
        old=self.failure();other=str(uuid.uuid4())
        self.runner.save_job({'jobId':other,'candidateId':'other','createdAt':m.now()},'running','applying')
        with self.assertRaisesRegex(m.Rejected,'BUSY'):self.retry(old)
        self.runner.save_job({'jobId':other,'candidateId':'release-1','createdAt':m.now()},'failed','failed','PROGRAM_FAILED')
        with self.assertRaisesRegex(m.Rejected,'RETRY_FAILURE_UNVERIFIED'):self.retry(old)

if __name__=='__main__':unittest.main()
