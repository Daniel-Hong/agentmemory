"""Read-only review evidence on synthetic prepared plans, never operating state."""
import io,json,os
from pathlib import Path
import unittest
from unittest.mock import patch
import test_admin_trust_transition as whole
import test_dashboard_kit as base
class PlanReviewTests(unittest.TestCase):
    def setUp(self):
        self.f=whole.WholeTransitionTests();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.result=self.f.transition.prepare(self.f.failed_id)
        path=Path(__file__).with_name('export-trust-plan-review.py')
        self.assertTrue(path.exists(),'body-free exact plan review exporter missing')
        self.m=base.load('export-trust-plan-review');self.plan=json.loads((self.f.transition.work/'plan.json').read_text())
    def inspect(self):return self.m.inspect(self.f.transition,self.result['planSha256'],self.result['intentSha256'],len(self.plan['targets']))
    def test_complete_prepared_plan_is_reconstructable_without_private_output_or_writes(self):
        files={p:p.read_bytes() for p in self.f.root.rglob('*') if p.is_file()};real=os.open
        def readonly(path,flags,*args,**kwargs):
            self.assertFalse(flags&(os.O_CREAT|os.O_WRONLY|os.O_RDWR));return real(path,flags,*args,**kwargs)
        with patch.object(os,'open',readonly):result=self.inspect()
        self.assertTrue(result['derivedTargetsMatch']);self.assertEqual(result['targetCount'],len(self.plan['targets']));self.assertFalse(result['reviewRecorded']);self.assertFalse(result['operatingChanged'])
        self.assertEqual(files,{p:p.read_bytes() for p in self.f.root.rglob('*') if p.is_file()});self.assertNotIn(str(self.f.root),json.dumps(result))
    def test_supplied_plan_hash_and_intent_and_count_are_all_required(self):
        for args in [('0'*64,self.result['intentSha256'],len(self.plan['targets'])),(self.result['planSha256'],'0'*64,len(self.plan['targets'])),(self.result['planSha256'],self.result['intentSha256'],999)]:
            with self.assertRaises(RuntimeError):self.m.inspect(self.f.transition,*args)
    def test_tampered_staged_metadata_or_original_snapshot_is_refused(self):
        path=next(p for p in self.plan['targets'] if p.endswith('policy.json'))
        blob=self.f.transition.work/'after'/self.plan['targets'][path]['afterSha256'];blob.write_bytes(b'{"private":"DO_NOT_PRINT"}')
        with self.assertRaises(RuntimeError):self.inspect()
    def test_unsafe_mode_or_remaining_order_is_not_reviewable(self):
        original=json.loads((self.f.transition.work/'plan.json').read_bytes())
        for mutate in ('mode','order'):
            value=json.loads(json.dumps(original))
            if mutate=='mode':next(iter(value['targets'].values()))['mode']=0o4755
            else:value['order'][-1],value['order'][-2]=value['order'][-2],value['order'][-1]
            raw=self.m.encode(value);self.f.write(self.f.transition.work/'plan.json',raw)
            with self.assertRaises(RuntimeError):self.m.inspect(self.f.transition,self.m.sha(raw),self.result['intentSha256'],len(value['targets']))

    def test_record_body_never_appears_in_success_output(self):
        result=self.inspect();raw=json.dumps(result)
        self.assertNotIn('failedJobId',raw);self.assertNotIn('delegatingReview',raw);self.assertTrue(all('beforeSnapshotMatches' in row for row in result['targets']))
if __name__=='__main__':unittest.main()
