import contextlib, hashlib, importlib.util, json, os, pathlib, subprocess, sys, tempfile, threading, time, unittest
from unittest.mock import patch

SCRIPT=pathlib.Path(__file__).with_name('maintenance-cold-stop.py')

def identity(pid):
    raw=pathlib.Path(f'/proc/{pid}/stat').read_text();return {'pid':pid,'start':raw[raw.rfind(') ')+2:].split()[19]}

def digest(path):return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()

class Fixture:
    def __init__(self, stubborn=False):
        self.temp=tempfile.TemporaryDirectory(prefix='am-cold-test-');self.root=pathlib.Path(self.temp.name);self.store=self.root/'state';self.store.mkdir();self.outbox=self.root/'outbox';self.outbox.mkdir();self.output=self.root/'evidence';self.children=[]
        (self.store/'value.bin').write_text('{"original":true}');(self.outbox/'one').write_text('retained original')
        child="import signal,sys,pathlib\n"+("signal.signal(signal.SIGTERM,signal.SIG_IGN)\n" if stubborn else '')+"print('ready',flush=True)\nsys.stdin.readline()\n"
        for role in ['worker','engine']:
            p=self.root/(role+'.py');p.write_text(child if role=='worker' else "import signal,sys,pathlib\ndef stop(*a):\n pathlib.Path(sys.argv[1]).write_text('{\\\"original\\\":true,\\\"published\\\":true}')\n raise SystemExit(0)\nsignal.signal(signal.SIGTERM,stop)\nprint('ready',flush=True)\nsys.stdin.readline()\n")
            args=[sys.executable,str(p)]+([str(self.store/'value.bin')]if role=='engine' else [])
            process=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True);self.children.append(process);assert process.stdout.readline().strip()=='ready'
        self.worker,self.engine=self.children
        self.epoch={'host':hashlib.sha256(pathlib.Path('/etc/machine-id').read_text().strip().encode()).hexdigest(),'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'endpoint':'ws://127.0.0.1:12345','pidNamespace':os.readlink('/proc/self/ns/pid'),'netNamespace':os.readlink('/proc/self/ns/net'),'workerUid':os.getuid(),'worker':identity(self.worker.pid),'engine':identity(self.engine.pid)}
        self.marker={'version':3,'store':hashlib.sha256(str(self.store.resolve()).encode()).hexdigest(),'epoch':self.epoch,'clean':False,'blockedUntilBoot':False,'unverifiedWriter':False,'uncertaintyBootId':None}
        (self.store/'.agentmemory-writer.lock').write_text(json.dumps(self.marker))
        self.control={'version':2,'paused':True,'resumePending':False,'holds':['deployment','storage_error'],'recovery':{'attempts':2,'nextAttemptAt':999999}}
        (self.store/'mem%3Abackground-control%3Av1.bin').write_text(json.dumps({'manual-pause':self.control}))
        executable=os.readlink(f'/proc/{self.worker.pid}/exe')
        self.plan={'version':1,'mode':'maintenance-cold-stop','expiresAt':time.time()+300,'store':str(self.store),'sources':{'state':str(self.store),'outbox':str(self.outbox)},'epoch':self.epoch,'codePins':{role:{'executable':executable,'executableSha256':digest(executable),'entrypoint':str(self.root/(role+'.py')),'entrypointSha256':digest(self.root/(role+'.py'))}for role in ['worker','engine']},'holds':['deployment','storage_error'],'historicalMutationFailuresObserved':1,'quarantinedObserved':114,'maxBytes':1024*1024,'maxFiles':50,'timeoutSeconds':2}
        self.planfile=self.root/'plan.json';self.save()
        for process in self.children:threading.Thread(target=process.wait,daemon=True).start()
    def save(self):self.planfile.write_text(json.dumps(self.plan));self.planfile.chmod(0o600)
    def cli(self,*flags):return subprocess.run([sys.executable,str(SCRIPT),'--maintenance-cold-stop',str(self.planfile),'--output',str(self.output),*flags],capture_output=True,text=True,timeout=10)
    def load(self):
        spec=importlib.util.spec_from_file_location('cold_stop',SCRIPT);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
    def close(self):
        for process in self.children:
            with contextlib.suppress(Exception):process.stdin.close()
        for process in self.children:process.wait(timeout=3);process.stdout.close()
        self.temp.cleanup()

class ColdStopTests(unittest.TestCase):
    def fixture(self,**kwargs):f=Fixture(**kwargs);self.addCleanup(f.close);return f
    def test_complete_cold_stop_preserves_history_and_final_publication_without_starting_writer(self):
        f=self.fixture();r=f.cli();self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        result=json.loads(r.stdout);self.assertTrue(result['readyForColdStartVerification']);self.assertFalse(result['historicalWriteRecovered']);self.assertFalse(result['writerStarted'])
        self.assertEqual(json.loads((f.output/'stable/state/value.bin').read_text()),{'original':True,'published':True})
        self.assertEqual((f.output/'live/state/value.bin').read_text(),'{"original":true}')
        self.assertEqual((f.outbox/'one').read_text(),'retained original')
        evidence=json.loads((f.output/'checkpoint.json').read_text());self.assertEqual(evidence['historicalMutationFailuresObserved'],1);self.assertEqual(evidence['quarantinedObserved'],114);self.assertEqual(evidence['liveCopyConsistency'],'non_atomic')
        self.assertEqual(json.loads((f.output/'stable/state/mem%3Abackground-control%3Av1.bin').read_text())['manual-pause'],f.control)
        self.assertNotIn(str(f.worker.pid),r.stdout);self.assertNotIn('original',r.stdout)
    def test_native_control_archive_trailer_is_not_decoded_as_payload(self):
        f=self.fixture();p=f.store/'mem%3Abackground-control%3Av1.bin'
        with p.open('ab')as stream:stream.write(bytes([255,254,0,128]))
        r=f.cli();self.assertEqual(r.returncode,0,r.stdout+r.stderr)
    def test_pid_reuse_or_changed_epoch_refuses_before_signalling(self):
        f=self.fixture();f.plan['epoch']['worker']['start']='1';f.save();r=f.cli();self.assertNotEqual(r.returncode,0);self.assertIsNone(f.worker.poll());self.assertIsNone(f.engine.poll())
    def test_partial_copy_limit_does_not_stop_either_process(self):
        f=self.fixture();f.plan['maxBytes']=4;f.save();r=f.cli();self.assertNotEqual(r.returncode,0);self.assertIsNone(f.worker.poll());self.assertIsNone(f.engine.poll());self.assertFalse((f.output/'stable').exists())
    def test_worker_timeout_never_signals_engine_or_allows_cold_start(self):
        f=self.fixture(stubborn=True);f.plan['timeoutSeconds']=0.1;f.save();r=f.cli();self.assertNotEqual(r.returncode,0);self.assertIsNone(f.engine.poll());self.assertFalse(json.loads(r.stdout)['readyForColdStartVerification'])
    def test_checkpoint_failure_before_stop_intent_sends_no_signal(self):
        f=self.fixture();module=f.load();write=module.checkpoint
        def broken(output,state):
            if state['phase']=='worker_stop_intent':raise OSError('private fixture error')
            return write(output,state)
        with patch.object(module,'checkpoint',broken):
            with self.assertRaises(module.Refused):module.run(f.planfile,f.output)
        self.assertIsNone(f.worker.poll());self.assertIsNone(f.engine.poll())
    def test_rerun_refuses_existing_acquisition_without_repeating_signals(self):
        f=self.fixture();first=f.cli();self.assertEqual(first.returncode,0,first.stdout+first.stderr);r=f.cli();self.assertNotEqual(r.returncode,0);self.assertTrue((f.output/'stable/state/value.bin').exists())
    def test_symlink_source_is_not_followed(self):
        f=self.fixture();(f.store/'escape').symlink_to(f.outbox/'one');r=f.cli();self.assertNotEqual(r.returncode,0);self.assertIsNone(f.worker.poll());self.assertIsNone(f.engine.poll())
    def test_destination_inside_source_is_refused(self):
        f=self.fixture();f.output=f.store/'evidence';r=f.cli();self.assertNotEqual(r.returncode,0);self.assertIsNone(f.worker.poll())
    def test_resume_verification_only_refuses_live_processes(self):
        f=self.fixture();r=f.cli('--verify-stopped-only');self.assertNotEqual(r.returncode,0);self.assertIsNone(f.worker.poll());self.assertIsNone(f.engine.poll())
    def test_unexpected_hold_change_is_not_cleared(self):
        f=self.fixture();f.control['holds'].append('manual');(f.store/'mem%3Abackground-control%3Av1.bin').write_text(json.dumps({'manual-pause':f.control}));r=f.cli();self.assertNotEqual(r.returncode,0);self.assertIsNone(f.worker.poll());self.assertIn('manual',json.loads((f.store/'mem%3Abackground-control%3Av1.bin').read_text())['manual-pause']['holds'])
    def test_change_to_first_source_while_copying_second_blocks_stable_proof(self):
        f=self.fixture();module=f.load();original=module.inventory;calls=0
        def changed(root,plan):
            nonlocal calls
            if root==f.outbox:
                calls+=1
                if calls==2:(f.store/'value.bin').write_text('{"unexpected_writer":true}')
            return original(root,plan)
        with patch.object(module,'inventory',changed):
            with self.assertRaises(module.Refused):module.run(f.planfile,f.output)
        self.assertFalse(json.loads((f.output/'checkpoint.json').read_text())['readyForColdStartVerification'])
    def test_duplicate_control_key_is_not_accepted(self):
        f=self.fixture();p=f.store/'mem%3Abackground-control%3Av1.bin'
        p.write_text('{"manual-pause":null,"manual-pause":'+json.dumps(f.control)+'}')
        r=f.cli();self.assertNotEqual(r.returncode,0);self.assertIsNone(f.worker.poll())
    def test_interruption_after_engine_exit_can_only_resume_verification(self):
        f=self.fixture();module=f.load();write=module.checkpoint
        def interrupted(output,state):
            if state['phase']=='engine_absent':raise OSError('interrupted checkpoint')
            return write(output,state)
        with patch.object(module,'checkpoint',interrupted):
            with self.assertRaises(module.Refused):module.run(f.planfile,f.output)
        self.assertIsNotNone(f.worker.poll());self.assertIsNotNone(f.engine.poll())
        result=module.run(f.planfile,f.output,verify_stopped=True)
        self.assertTrue(result['readyForColdStartVerification']);self.assertFalse(result['historicalWriteRecovered'])
    def test_resume_refuses_missing_or_modified_live_preservation(self):
        for mutation in ['delete','modify']:
            with self.subTest(mutation=mutation):
                f=self.fixture();module=f.load();write=module.checkpoint
                def interrupted(output,state):
                    if state['phase']=='engine_absent':raise OSError('interrupted')
                    return write(output,state)
                with patch.object(module,'checkpoint',interrupted):
                    with self.assertRaises(module.Refused):module.run(f.planfile,f.output)
                target=f.output/'live/state/value.bin'
                if mutation=='delete':target.unlink()
                else:target.write_text('changed preservation')
                with self.assertRaises(module.Refused):module.run(f.planfile,f.output,verify_stopped=True)
    def test_hidden_live_pid_is_not_treated_as_absent(self):
        f=self.fixture();module=f.load()
        with patch.object(module,'proc_identity',side_effect=FileNotFoundError()):
            with self.assertRaises(module.Refused):module.absent(f.plan,'engine')
    def test_parent_directory_swap_to_symlink_aborts_before_any_signal(self):
        f=self.fixture();folder=f.store/'folder';folder.mkdir();(folder/'retained').write_text('private fixture');module=f.load();original=module.inventory;swapped=False
        def swap(root,plan):
            nonlocal swapped
            result=original(root,plan)
            if root==f.store and not swapped:
                swapped=True;folder.rename(f.root/'moved');folder.symlink_to(f.root/'moved',target_is_directory=True)
            return result
        with patch.object(module,'inventory',swap):
            with self.assertRaises(module.Refused):module.run(f.planfile,f.output)
        self.assertIsNone(f.worker.poll());self.assertIsNone(f.engine.poll())
    def test_managed_service_without_stop_intent_sends_no_signal(self):
        f=self.fixture();f.plan['timeoutSeconds']=.05;f.save();module=f.load()
        with patch.object(module,'managed_service',return_value=True,create=True), patch.object(module,'service_state',return_value={'active':'active','mainPid':f.worker.pid,'stopJob':False,'killMode':'process','sendSigkill':'no','jobsPresent':False},create=True):
            with self.assertRaises(module.Refused):module.run(f.planfile,f.output)
        self.assertIsNone(f.worker.poll());self.assertIsNone(f.engine.poll())
    def test_managed_service_observes_normal_stop_then_stops_only_remaining_engine(self):
        f=self.fixture();module=f.load();state={'active':'active','mainPid':f.worker.pid,'stopJob':False,'killMode':'process','sendSigkill':'no','jobsPresent':False}
        def supervisor():
            until=time.monotonic()+3
            while not(f.output/'service-stop-ready').exists()and time.monotonic()<until:time.sleep(.01)
            if not(f.output/'service-stop-ready').exists():return
            state.update(active='deactivating',stopJob=True,jobsPresent=True)
            time.sleep(.04);f.worker.terminate();f.worker.wait();state.update(active='inactive',mainPid=0,stopJob=False,jobsPresent=False)
        thread=threading.Thread(target=supervisor);thread.start()
        try:
            with patch.object(module,'managed_service',return_value=True,create=True), patch.object(module,'service_state',side_effect=lambda:dict(state),create=True):result=module.run(f.planfile,f.output)
        finally:thread.join(timeout=4)
        self.assertTrue(result['readyForColdStartVerification']);self.assertTrue(json.loads((f.output/'checkpoint.json').read_text())['serviceStopIntentObserved'])
        self.assertEqual(json.loads((f.output/'stable/state/value.bin').read_text()),{'original':True,'published':True})
    def test_service_wrapper_mode_refuses_unmanaged_processes(self):
        f=self.fixture();r=f.cli('--require-service');self.assertNotEqual(r.returncode,0);self.assertIn('SUPERVISOR_SCOPE_REQUIRED',r.stdout);self.assertIsNone(f.worker.poll());self.assertIsNone(f.engine.poll())
    def test_other_worker_mainpid_is_not_accepted_as_this_plan_stop_intent(self):
        f=self.fixture();f.plan['timeoutSeconds']=.05;f.save();module=f.load();calls=0
        def manager():
            nonlocal calls
            calls+=1
            return {'active':'active'if calls==1 else'deactivating','mainPid':f.worker.pid if calls==1 else f.engine.pid,'stopJob':calls>1,'killMode':'process','sendSigkill':'no','jobsPresent':calls>1}
        with patch.object(module,'managed_service',return_value=True),patch.object(module,'service_state',side_effect=manager):
            with self.assertRaises(module.Refused):module.run(f.planfile,f.output)
        evidence=json.loads((f.output/'checkpoint.json').read_text());self.assertFalse(evidence.get('serviceStopIntentObserved',False));self.assertIsNone(f.engine.poll());self.assertIsNone(f.worker.poll())
    def test_pending_start_or_restart_job_is_not_a_stopped_service(self):
        f=self.fixture();module=f.load()
        with patch.object(module,'service_state',return_value={'active':'inactive','mainPid':0,'stopJob':False,'killMode':'process','sendSigkill':'no','jobsPresent':True}):self.assertFalse(module.service_stopped())
    def test_signal_failure_is_not_retried_and_preserves_blocked_evidence(self):
        f=self.fixture();module=f.load()
        with patch.object(module.signal,'pidfd_send_signal',side_effect=PermissionError('private')) as send:
            with self.assertRaises(module.Refused):module.run(f.planfile,f.output)
        self.assertEqual(send.call_count,1);self.assertIsNone(f.engine.poll());self.assertEqual(json.loads((f.output/'checkpoint.json').read_text())['phase'],'blocked')

if __name__=='__main__':unittest.main()
