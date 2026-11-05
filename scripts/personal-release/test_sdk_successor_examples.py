"""Synthetic-only regressions for published successor examples; no live root/state."""
import importlib.util,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
D=Path(__file__).resolve().parent
def module(name,p):
 s=importlib.util.spec_from_file_location(name,p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
A=module('successor_example',D/'examples/sdk_successor_adapter.py')
class AdapterTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.env=Path(self.tmp.name)/'env'
  self.env.write_text('\n'.join(k+'='+v for k,v in A.OLLAMA.items())+'\nUNRELATED_SECRET=fixture-never-output\n')
 def test_existing_ollama_selection_accepts_without_mutation(self):
  before=self.env.read_bytes();A.verify_ollama(self.env);self.assertEqual(self.env.read_bytes(),before)
 def test_missing_changed_or_duplicate_selection_refuses(self):
  for change in ['OPENAI_MODEL=changed','OPENAI_BASE_URL=https://api.openai.com/v1','EMBEDDING_PROVIDER=local']:
   original=self.env.read_text();key=change.split('=')[0];self.env.write_text('\n'.join(change if x.startswith(key+'=')else x for x in original.splitlines()))
   with self.assertRaisesRegex(RuntimeError,'OLLAMA_SELECTION_CHANGED'):A.verify_ollama(self.env)
   self.env.write_text(original)
  with self.env.open('a')as f:f.write('OPENAI_MODEL=duplicate\n')
  with self.assertRaisesRegex(RuntimeError,'OLLAMA_DUPLICATE_SELECTION'):A.verify_ollama(self.env)
 def fake(self):
  case=self
  class Base:
   def __init__(self,root,paths,**kw):
    self.paths=paths;self.kit={'id':A.CID,'sourceCommit':A.SOURCE,'packageSha256':A.PACKAGE,'shutdownCompletion':'sdk-v1'}
    self.release={'serviceProviderSelection':{'llm':'openai'}};self.baseline={'protectedFiles':{str(A.ENGINE):A.ENGINE_SHA}}
   def guard(self,**kw):return {'verified':True}
   def predecessor_shutdown_contract(self,h):return {'completion':'sdk-v1','version':h['version']}
  return types.SimpleNamespace(Runtime=Base,DEFAULT_PATHS={'engine':'old','env':self.env,'releases':Path('/fake/releases')})
 def test_successor_forces_reviewed_engine_and_generic_predecessor_contract(self):
  calls=[];b=self.fake();k=types.SimpleNamespace(bind=lambda r,p:calls.append(p)or{'fixed':'identity'})
  c=A.runtime_class(b,kernel=k);r=c('/fake');self.assertEqual(r.paths['engine'],A.ENGINE);self.assertEqual(r.guard(),{'verified':True})
  r.predecessor_shutdown_contract({'version':'0.9.31-daniel.54'});self.assertEqual(r._component_binding,{'fixed':'identity'});self.assertEqual(str(calls[0]),'/fake/releases/0.9.31-daniel.54-27874d65')
  with self.assertRaisesRegex(RuntimeError,'PREDECESSOR_VERSION_CHANGED'):r.predecessor_shutdown_contract({'version':'0.9.31-daniel.51'})
 def test_unprotected_engine_or_different_candidate_refuses(self):
  for which in ['engine','source','provider']:
   b=self.fake();original=b.Runtime.__init__
   def init(obj,*a,**kw):
    original(obj,*a,**kw)
    if which=='engine':obj.baseline['protectedFiles']={}
    elif which=='source':obj.kit['sourceCommit']='0'*40
    else:obj.release['serviceProviderSelection']={'llm':'ollama'}
   b.Runtime.__init__=init
   with self.assertRaises(RuntimeError):A.runtime_class(b,kernel=None)('/fake')

class ExclusionTests(AdapterTests):
 def configured(self):
  import os
  b=self.fake();tmp=Path(self.tmp.name);store=tmp/'state_store.db';store.mkdir();marker=store/'.agentmemory-writer.lock';marker.write_bytes(b'{}')
  st=store.stat();mt=marker.stat();self.binding={'processes':{'worker':{'pid':123,'start':'fixed'}},'storeInode':[st.st_dev,st.st_ino],'markerInode':[mt.st_dev,mt.st_ino]}
  self.active=False;self.listener=False;self.events=[]
  k=types.SimpleNamespace(bind=lambda *a:dict(self.binding),alive=lambda row:False,listening=lambda port:self.listener,process=lambda pid:self.binding['processes']['worker'])
  b.Runtime.stop=lambda r:setattr(r,'certified_stopped',True)
  b.Runtime.backup_latest=lambda r:self.events.append('backup')
  b.Runtime.stage=lambda r:self.events.append('stage')
  b.Runtime.activate=lambda r:self.events.append('activate')
  r=A.runtime_class(b,kernel=k)('/fake');r.paths['data']=tmp;r.system=types.SimpleNamespace(inactive=lambda:not self.active,main_pid=lambda:0)
  r.record=lambda *a:self.events.append(a[0]);r._component_binding=dict(self.binding);return r,marker
 def test_stop_lock_held_through_copy_stage_activation_then_released(self):
  import os,fcntl
  r,marker=self.configured();read,write=os.pipe();os.write(write,b'x')
  try:
   with patch.object(A.os,'pidfd_open',side_effect=lambda *a:os.dup(read)):r.stop()
   self.assertTrue(r.certified_stopped)
   fd=os.open(marker,os.O_RDWR)
   try:
    with self.assertRaises(BlockingIOError):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    r.backup_latest();r.stage();r.activate();self.assertIsNone(r._writer_exclusion)
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
   finally:os.close(fd)
  finally:r.close_exclusion();os.close(read);os.close(write)
 def test_contending_writer_blocks_and_clears_certification(self):
  import os,fcntl
  r,marker=self.configured();fd=os.open(marker,os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);read,write=os.pipe();os.write(write,b'x')
  try:
   with patch.object(A.os,'pidfd_open',side_effect=lambda *a:os.dup(read)):
    with self.assertRaises(BlockingIOError):r.stop()
   self.assertFalse(r.certified_stopped);self.assertIsNone(r._writer_exclusion);self.assertNotIn('backup',self.events)
  finally:os.close(fd);os.close(read);os.close(write)
 def test_replaced_marker_or_live_endpoint_blocks_cold_work(self):
  import os,fcntl
  r,marker=self.configured();r._writer_exclusion=os.open(marker,os.O_RDWR);fcntl.flock(r._writer_exclusion,fcntl.LOCK_EX|fcntl.LOCK_NB)
  try:
   self.listener=True
   with self.assertRaisesRegex(RuntimeError,'NORMAL_ENDPOINT_REOCCUPIED'):r.backup_latest()
   self.listener=False;replacement=marker.with_name('replacement');replacement.write_bytes(b'{}');replacement.replace(marker)
   with self.assertRaisesRegex(RuntimeError,'NORMAL_WRITER_LOCK_REPLACED'):r.stage()
   self.assertNotIn('stage',self.events)
  finally:r.close_exclusion()
 def test_predecessor_rebinding_must_keep_initial_store_and_lock(self):
  r,_=self.configured();r.predecessor_shutdown_contract({'version':'0.9.31-daniel.54'});self.binding['markerInode']=[0,0]
  with self.assertRaisesRegex(RuntimeError,'NORMAL_BOUND_IDENTITY_CHANGED'):r.predecessor_shutdown_contract({'version':'0.9.31-daniel.54'})

class NaturalIdleObservationTests(unittest.TestCase):
 def setUp(self):self.policy=module('idle55',D/'examples/idle_observation.py')
 def run_observer(self,proofs):
  calls=[];pauses=[]
  def observe():
   calls.append(len(calls));return ({},{},proofs[min(len(calls)-1,len(proofs)-1)])
  value=self.policy.observe_until_idle(observe,pauses.append);return value[-1],calls,pauses
 def test_transient_write_waits_for_fresh_zero_without_changing_failures(self):
  busy={'failedPredicates':['activeMutationsZero']};safe={'failedPredicates':[]};r,c,p=self.run_observer([busy,safe]);self.assertIs(r,safe);self.assertEqual(len(c),2);self.assertEqual(p,[5]);self.assertEqual(busy['failedPredicates'],['activeMutationsZero'])
 def test_persistent_busy_has_four_sample_bound(self):
  busy={'failedPredicates':['activeMutationsZero']};r,c,p=self.run_observer([busy]);self.assertIs(r,busy);self.assertEqual(len(c),4);self.assertEqual(p,[5,5,5])
 def test_new_sdk_or_memory_failure_stops_without_wait_or_masking(self):
  for failures in [['sdkFailuresZero'],['activeMutationsZero','memoryNormal'],['mutationFailuresZero']]:
   r,c,p=self.run_observer([{'failedPredicates':failures}]);self.assertEqual(r['failedPredicates'],failures);self.assertEqual(len(c),1);self.assertEqual(p,[])
 def test_observation_exception_propagates_without_retry(self):
  with self.assertRaisesRegex(RuntimeError,'identity_changed'):
   self.policy.observe_until_idle(lambda:(_ for _ in()).throw(RuntimeError('identity_changed')),lambda _:self.fail('must not wait'))
