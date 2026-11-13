"""Non-operating SDK successor example; selectors are synthetic, not host settings."""
import hashlib,json,os,stat,fcntl,select
from pathlib import Path
ENGINE=Path('/usr/local/lib/agentmemory-engines/0.22.1-cow-safe1-cc4ff876/iii')
ENGINE_SHA='cc4ff876e7e5dcd4ea9313404542b6f0105b6544f2708259743f4beaf0c07f01'
CID='daniel-55-enroll1-4605974f'
SOURCE='4605974f337a50ed7e0ef74e3bb635b6e5d5a805'
PACKAGE='266e8243e883eabeb99348673bbe666d2408bd69726174474a2dc8b9b8fd2293'
OLLAMA={'OPENAI_BASE_URL':'http://127.0.0.1:11434/v1','OPENAI_MODEL':'synthetic-summary-model','AGENTMEMORY_OLLAMA_NATIVE_CHAT':'true','OPENAI_EMBEDDING_BASE_URL':'http://127.0.0.1:11434/v1','OPENAI_EMBEDDING_MODEL':'synthetic-embedding-model','EMBEDDING_PROVIDER':'openai'}
def require(v,c):
 if not v:raise RuntimeError(c)
def verify_ollama(path):
 values={}
 with Path(path).open() as f:
  for line in f:
   k,sep,v=line.strip().partition('=');k=k.removeprefix('export ').strip()
   if sep and k in OLLAMA:
    require(k not in values,'OLLAMA_DUPLICATE_SELECTION');values[k]=v.strip().strip('"\'')
 require(values==OLLAMA,'OLLAMA_SELECTION_CHANGED')
def runtime_class(base,*,kernel,verify_guard=None):
 class Successor(base.Runtime):
  def __init__(self,root,**kwargs):
   paths=dict(kwargs.pop('paths',base.DEFAULT_PATHS));paths['engine']=ENGINE
   super().__init__(root,paths=paths,**kwargs);self._kernel=kernel;self._component_binding=None;self._writer_exclusion=None
   require(self.kit.get('id')==CID and self.kit.get('sourceCommit')==SOURCE and self.kit.get('packageSha256')==PACKAGE and self.kit.get('shutdownCompletion')=='sdk-v1','CANDIDATE_IDENTITY_CHANGED')
   require(self.release.get('serviceProviderSelection')=={'llm':'openai'},'OLLAMA_ADAPTER_SELECTION_REQUIRED')
   require(self.baseline['protectedFiles'].get(str(ENGINE))==ENGINE_SHA,'ENGINE_UNPROTECTED')
  def guard(self,*args,**kwargs):
   result=super().guard(*args,**kwargs);verify_ollama(self.paths['env']);return result
  def predecessor_shutdown_contract(self,health):
   require(health.get('version')=='0.9.31-daniel.54','PREDECESSOR_VERSION_CHANGED')
   result=super().predecessor_shutdown_contract(health)
   require(result.get('completion')=='sdk-v1','SDK_PREDECESSOR_REQUIRED')
   fresh=kernel.bind(self,self.paths['releases']/'0.9.31-daniel.54-27874d65')
   require(self._component_binding is None or self._component_binding==fresh,'NORMAL_BOUND_IDENTITY_CHANGED')
   self._component_binding=fresh
   return result

  def stopped_exclusion(self):
   require(self.system.inactive() and self.system.main_pid()==0,'NORMAL_SERVICE_NOT_STOPPED')
   bound=self._component_binding;require(bound is not None,'NORMAL_IDENTITY_MISSING')
   require(all(not kernel.alive(row)for row in bound['processes'].values()),'NORMAL_OLD_PROCESS_REMAINS')
   require(not any(kernel.listening(port)for port in (3111,49134)),'NORMAL_ENDPOINT_REOCCUPIED')
   store=self.paths['data']/'state_store.db';marker=store/'.agentmemory-writer.lock'
   current=store.lstat();require(stat.S_ISDIR(current.st_mode)and[current.st_dev,current.st_ino]==bound['storeInode'],'NORMAL_STORE_REPLACED')
   current=marker.lstat();require(stat.S_ISREG(current.st_mode)and[current.st_dev,current.st_ino]==bound['markerInode'],'NORMAL_WRITER_LOCK_REPLACED')
   require(self._writer_exclusion is not None,'NORMAL_WRITER_LOCK_NOT_HELD')
   locked=os.fstat(self._writer_exclusion);require([locked.st_dev,locked.st_ino]==bound['markerInode'],'NORMAL_WRITER_LOCK_REPLACED')
  def close_exclusion(self):
   if self._writer_exclusion is not None:os.close(self._writer_exclusion);self._writer_exclusion=None
  def stop(self):
   require(self._component_binding is not None,'NORMAL_IDENTITY_MISSING');handles=[]
   try:
    for row in self._component_binding['processes'].values():
     fd=os.pidfd_open(row['pid'],0);handles.append(fd);require(kernel.process(row['pid'])==row,'NORMAL_PID_CHANGED')
    super().stop();self.certified_stopped=False
    require(all(select.select([fd],[],[],0)[0]for fd in handles),'NORMAL_PROCESS_EXIT_UNPROVEN')
    marker=self.paths['data']/'state_store.db/.agentmemory-writer.lock'
    self._writer_exclusion=os.open(marker,os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC)
    fcntl.flock(self._writer_exclusion,fcntl.LOCK_EX|fcntl.LOCK_NB)
    self.stopped_exclusion();self.certified_stopped=True
    self.record('normal_writer_absence_verified')
   except BaseException:
    self.certified_stopped=False;self.close_exclusion();raise
   finally:
    for fd in handles:os.close(fd)
  def backup_latest(self):
   self.stopped_exclusion();result=super().backup_latest();self.stopped_exclusion();return result
  def stage(self):
   self.stopped_exclusion();result=super().stage();self.stopped_exclusion();return result
  def activate(self):
   self.stopped_exclusion();result=super().activate();self.stopped_exclusion()
   # The new worker must acquire the same exclusive lease; any contender makes
   # its startup fail closed. Never hold the parent's lease across startup.
   self.close_exclusion();return result
  def restore_previous_service(self):
   self.stopped_exclusion();self.close_exclusion();return super().restore_previous_service()
  def apply(self):
   try:return super().apply()
   finally:self.close_exclusion()
 return Successor
