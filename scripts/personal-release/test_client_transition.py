import copy
import io
import json
import os
from pathlib import Path
import tarfile
import unittest
import test_dashboard_kit as base


class ClientTransitionTests(base.TransactionTests):
    def setUp(self):
        super().setUp()
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

    def issue(self, transition=True, replacement=None, revision=8, automatic=None):
        manifest={'version':f'0.9.30-daniel.{revision}'}
        if automatic is not None:manifest['agentmemoryCompatibility']={'backgroundControlVersion':2,'automaticMemoryRecovery':automatic}
        files={'package.json':json.dumps(manifest).encode(), 'dist/cli.mjs':b'// fixture', **(replacement or self.new)}
        package=self.root/'client-package.tgz'
        with tarfile.open(package,'w:gz') as saved:
            for name,data in files.items():
                info=tarfile.TarInfo('package/'+name);info.size=len(data);saved.addfile(info,io.BytesIO(data))
        release={'sourceCommit':'c'*40,'packageVersion':manifest['version'],'packageFiles':{n:self.runtime.hashlib.sha256(v).hexdigest() for n,v in files.items()},'artifactHashes':{},'verificationFiles':{}}
        metadata={'id':f'client-release-{revision}','version':release['packageVersion'],'sourceCommit':release['sourceCommit'],'packageSha256':self.runtime.sha(package),'changeSummary':'synthetic two-file client transition','tests':['synthetic']}
        if transition:metadata['clientTransition']=copy.deepcopy(self.transition)
        draft=self.root/('client-draft-'+str(len(list(self.root.glob('client-draft-*')))))
        self.prepare.prepare(package,release,self.baseline,metadata,draft)
        review=self.root/('client-review-'+draft.name+'.json')
        self.write(review,json.dumps({'executionClosureReviewed':True,'reviewedBy':'synthetic reviewer','draftManifestSha256':self.runtime.sha(draft/'kit.json')}).encode())
        self.enroll.install(draft,review,state=self.state,runner=self.runner,owner=os.getuid(),anchor=self.root,run=lambda *args,**kw:None)
        tx=self.runtime.Runtime(self.paths['public']/f'client-release-{revision}',paths=self.paths,owner=os.getuid(),anchor=self.root,service_uid=os.getuid(),service_gid=os.getgid(),system=self.system)
        tx.api=lambda path,body=None:{'version':manifest['version'],'status':'healthy','storageDurability':{'mutationFailures':0}} if path=='health' else self.api(path,body)
        return tx

    def test_explicit_two_file_transition_applies_and_guard_certifies_exact_hashes(self):
        tx=self.issue();before=self.raw.read_bytes();tx.apply();tx.guard()
        for name,data in self.new.items():self.assertEqual((self.client_root/name).read_bytes(),data)
        self.assertEqual(self.raw.read_bytes(),before)
        receipt=self.runtime.read_json(tx.receipt)
        self.assertTrue(receipt['applied']);self.assertFalse(receipt['verificationComplete'])
        self.assertEqual(receipt['clientTransition'],self.transition)

    def test_changed_client_without_explicit_review_remains_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'CLIENT_COMPATIBILITY_CHANGED'):self.issue(False)

    def test_third_file_is_never_authorized_by_the_two_file_manifest(self):
        extra={**self.new,'plugin/scripts/codex-compat/long-session-hook-client.mjs':b'not allowed'}
        with self.assertRaisesRegex(RuntimeError,'CLIENT_COMPATIBILITY_CHANGED'):self.issue(replacement=extra)

    def test_wrong_before_hash_and_outside_client_root_are_refused(self):
        self.transition['files'][next(iter(self.transition['files']))]['before']='0'*64
        with self.assertRaisesRegex(RuntimeError,'CLIENT_TRANSITION_INVALID'):self.issue()

    def test_partial_client_write_failure_restores_both_files_and_preserves_original(self):
        tx=self.issue();self.system.fault='stage-client';original_atomic=self.runtime.atomic
        def fail(path,*args,**kwargs):
            if Path(path)==self.client_root/'plugin/scripts/codex-compat/manifest.json' and args[0]==self.new['plugin/scripts/codex-compat/manifest.json']:raise RuntimeError('synthetic client failure')
            return original_atomic(path,*args,**kwargs)
        from unittest.mock import patch
        with patch.object(self.runtime,'atomic',side_effect=fail):
            with self.assertRaises(RuntimeError):tx.apply()
        for name,data in self.old.items():self.assertEqual((self.client_root/name).read_bytes(),data)
        self.assertIn('original',self.raw.read_text());self.assertFalse(tx.receipt.exists())

    def test_active_matching_client_process_blocks_before_shutdown(self):
        tx=self.issue();process=self.root/'proc/999';process.mkdir();self.write(process/'cmdline',b'node\0'+str(self.client_root/'plugin/scripts/codex-compat/long-session-hook-client.mjs').encode()+b'\0--drain\0')
        with self.assertRaisesRegex(RuntimeError,'CLIENT_PROCESS_ACTIVE'):tx.preflight()
        self.assertNotIn('stop',self.system.actions)

    def test_same_fd_snapshot_rejects_a_symlink_swapped_after_hash_check(self):
        from unittest.mock import patch
        tx=self.issue();target=Path(next(iter(tx.client_changes)));old=target.read_bytes();secret=self.root/'synthetic-secret';self.write(secret,b'NOT CODE AND NEVER EXPORTED')
        real=self.runtime.verify_map
        def swap(table):
            real(table)
            if str(target) in table:target.unlink();target.symlink_to(secret)
        try:
            with patch.object(self.runtime,'verify_map',side_effect=swap):
                with self.assertRaises(OSError):tx.user_capture_clients()
        finally:target.unlink();self.write(target,old)

    def test_real_existing_client_flush_and_worker_respect_transition_tickets(self):
        import subprocess
        tx=self.issue();client=Path(__file__).resolve().parents[2]/'integrations/codex-compat/long-session-hook-client.mjs'
        queue=self.paths['runtime']/'hook-outbox'
        js="import {HookClient} from "+json.dumps(client.as_uri())+"; let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected network')};const client=new HookClient({dir:"+json.dumps(str(queue))+",url:'http://127.0.0.1:1'});await client.enqueue('/agentmemory/observe',{eventId:'synthetic-lock',sessionId:'fixture',project:'fixture',hookType:'post_tool_use',timestamp:'2026-10-21T00:00:00Z',data:{synthetic:true}});console.log(JSON.stringify({flushed:await client.flush(),calls}));"
        with tx.client_exclusion():
            result=subprocess.run(['/usr/bin/node','--input-type=module','-e',js],capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(json.loads(result.stdout),{'flushed':False,'calls':0})
            result=subprocess.run(['/usr/bin/node',str(client),'--drain',str(queue),'http://127.0.0.1:1'],capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(len(list(queue.glob('*.json'))),1)

    def test_stopped_recovery_preserves_new_client_pair_and_hold_budget_then_duplicate_is_readonly(self):
        tx=self.issue(automatic=True);self.system.inactive=lambda:self.system.stopped;self.system.main_pid=lambda:0 if self.system.stopped else 103
        control=self.paths['data']/'state_store.db/mem%3Abackground-control%3Av1.bin'
        saved={'manual-pause':{'version':2,'paused':True,'resumePending':False,'holds':['manual','deployment','memory'],'recovery':{'attempts':2,'nextAttemptAt':98765}}}
        def fail():self.write(control,json.dumps(saved,sort_keys=True).encode());raise RuntimeError('SYNTHETIC_FAILURE')
        tx.verify_runtime=fail
        with self.assertRaisesRegex(RuntimeError,'SYNTHETIC_FAILURE'):tx.apply()
        self.assertEqual(self.runtime.read_json(tx.work/'transaction.json')['recoveryStatus'],'manual_required')
        recovery=self.issue(revision=9,automatic=False)
        def api(path,body=None):
            if path=='health':return {'version':recovery.kit['version'],'status':'healthy','storageDurability':{'mutationFailures':0},'memoryPressure':{'automaticMemoryRecovery':False}}
            if path=='background/control':return {'control':{'formatVersion':2,'status':'paused','pausedRequested':True,'activeOperations':0,'error':None,**{k:saved['manual-pause'][k] for k in ['holds','recovery']}}}
            return {'sessions':[],'flags':[],'scheduleEnabled':False}
        recovery.api=api;plan=recovery.work/'stopped-recovery-plan.json';digest=recovery.prepare_stopped_recovery(tx.root,plan)['planSha256'];before=control.read_bytes()
        self.assertTrue(recovery.recover_stopped(plan,digest)['recovered']);starts=self.system.actions.count('start')
        self.assertTrue(recovery.recover_stopped(plan,digest)['alreadyRecovered']);self.assertEqual(self.system.actions.count('start'),starts)
        self.assertEqual(control.read_bytes(),before)
        for name,data in self.new.items():self.assertEqual((self.client_root/name).read_bytes(),data)

    def test_outside_client_root_is_refused(self):
        self.baseline['clientsRetainedAt']=str(self.root/'outside')
        with self.assertRaisesRegex(RuntimeError,'CLIENT_TRANSITION_PATH_INVALID'):self.issue()

    def test_unknown_transition_field_is_refused(self):
        self.transition['allowArbitraryFiles']=True
        with self.assertRaisesRegex(RuntimeError,'CLIENT_TRANSITION_INVALID'):self.issue()

    def test_already_updated_client_does_not_authorize_a_duplicate_apply(self):
        tx=self.issue()
        for name,data in self.new.items():self.write(self.client_root/name,data)
        with self.assertRaisesRegex(RuntimeError,'PROTECTED_FILE_CHANGED'):tx.preflight()
        self.assertNotIn('stop',self.system.actions)

    def test_transition_receipt_issues_a_normal_followup_baseline_without_new_client_authorization(self):
        tx=self.issue();tx.apply()
        prior=self.prepare.baseline_from_kit(tx.public,tx.receipt)
        expected={name:tx.release['packageFiles'][name] for name in self.new}
        self.assertEqual(prior['compatibilityFiles'],expected)
        self.baseline=prior
        followup=self.issue(transition=False,revision=9)
        self.assertEqual(followup.client_changes,{})
        self.assertTrue(followup.guard(before=True)['verified'])
