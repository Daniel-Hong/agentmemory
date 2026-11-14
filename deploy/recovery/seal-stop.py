#!/usr/bin/python3
"""Reviewed one-shot seal+normal stop only. Never starts, edits units, or kills."""
import os,sys,json,pathlib,hashlib,subprocess,pwd,time
P=pathlib.Path
ROOT_RECEIPT_DIR=P('/var/lib/agentmemory-updates/recovery')

def need(ok,code):
 if not ok:raise RuntimeError(code)
def sha(p):
 with open(p,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def trusted(path):
 p=P(path);s=p.lstat();need(not p.is_symlink() and s.st_uid in (0,1000) and not s.st_mode&0o022 and p.is_file(),'REVIEWED_FILE_REQUIRED')
def proc(pid):
 p=P('/proc')/str(pid);raw=(p/'stat').read_text();return {'pid':pid,'start':raw[raw.rindex(') ')+2:].split()[19],'exe':os.path.realpath(p/'exe')}
def matches(x):
 try:return proc(x['pid'])==x
 except FileNotFoundError:return False
def gone(x):
 try:return proc(x['pid'])['start']!=x['start']
 except FileNotFoundError:return True
def exclusive(path,value):
 with open(path,'x') as f:os.chmod(path,0o600);json.dump(value,f);f.write('\n');f.flush();os.fsync(f.fileno())
 d=os.open(P(path).parent,os.O_DIRECTORY);os.fsync(d);os.close(d)
def rootReceiptDirectory(path):
 path.mkdir(mode=0o700,parents=True,exist_ok=True)
 info=path.lstat();need(not path.is_symlink() and info.st_uid==0 and not info.st_mode&0o022,'ROOT_RECEIPT_DIRECTORY_UNSAFE')
def main(path,inspect=False):
 need(os.geteuid()==0,'ROOT_REQUIRED');trusted(path);c=json.loads(P(path).read_text())
 need(c['service']=='agentmemory.service' and c['user']=='daniel','FIXED_SERVICE_AND_USER_REQUIRED')
 identity=c['processes']['compose'];need(type(identity['pid']) is int and identity['pid']>1 and str(identity['start']).isdigit(),'EXPECTED_COMPOSE_REQUIRED')
 resultRoot=ROOT_RECEIPT_DIR;expectedResult=resultRoot/('sealed-for-recovery-'+str(identity['pid'])+'-'+str(identity['start'])+'.json')
 need(P(c['result'])==expectedResult,'FIXED_ROOT_RECEIPT_REQUIRED')
 for file,digest in c['reviewedFiles'].items():trusted(file);need(sha(file)==digest,'REVIEWED_CLOSURE_CHANGED')
 need(c['helper'] in c['reviewedFiles'] and c['rpcConfig'] in c['reviewedFiles'],'REVIEWED_HELPER_REQUIRED')
 rpc=json.loads(P(c['rpcConfig']).read_text());need(inspect or not P(c['result']).exists() and not P(rpc['receipt']).exists(),'PREVIOUS_ATTEMPT_INSPECT_REQUIRED')
 user=pwd.getpwnam(c['user']);need(user.pw_uid==1000,'SERVICE_UID_REQUIRED')
 need(sha(rpc['marker'])==rpc['markerSha256'],'MARKER_CHANGED')
 for x in c['processes'].values():need(matches(x),'PROCESS_IDENTITY_CHANGED')
 observed=subprocess.check_output(['/usr/bin/systemctl','show',c['service'],'-p','MainPID','--value'],text=True).strip();need(observed==str(c['processes']['compose']['pid']),'SERVICE_OWNER_CHANGED')
 # Durable attempt record blocks blindly repeating an ambiguous seal request.
 if not inspect:
  rootReceiptDirectory(resultRoot)
 if not inspect:exclusive(c['result'],{'version':1,'phase':'seal_intent','verifiedClean':False,'priorProcesses':c['processes']})
 def demote():os.initgroups(user.pw_name,user.pw_gid);os.setgid(user.pw_gid);os.setuid(user.pw_uid)
 env={'HOME':user.pw_dir,'PATH':'/usr/bin:/bin','III_TELEMETRY_ENABLED':'false'}
 p=subprocess.run(['/usr/bin/node',c['helper'],'--inspect' if inspect else '--execute-reviewed-seal',c['rpcConfig']],env=env,preexec_fn=demote,capture_output=True,text=True,timeout=150)
 need(p.returncode==0,'SEAL_HELPER_FAILED_INSPECT_RECEIPT')
 if inspect:
  print(p.stdout.strip());return
 proof=json.loads(P(rpc['receipt']).read_text());need(proof.get('kind')=='sealed-for-recovery' and proof.get('storageSealed') is True and proof.get('verifiedClean') is False and proof.get('markerSha256')==rpc['markerSha256'],'RECOVERY_RECEIPT_UNVERIFIED')
 need(sha(rpc['marker'])==rpc['markerSha256'],'MARKER_CHANGED_AFTER_SEAL')
 for x in c['processes'].values():need(matches(x),'PROCESS_CHANGED_AFTER_SEAL')
 for file,digest in c['reviewedFiles'].items():need(sha(file)==digest,'REVIEWED_CLOSURE_CHANGED')
 # A nonzero result is evidence, not permission to force or claim clean.
 stopped=subprocess.run(['/usr/bin/systemctl','stop',c['service']],capture_output=True,text=True,timeout=700)
 status=subprocess.check_output(['/usr/bin/systemctl','show',c['service'],'-p','ActiveState','-p','Result','-p','MainPID'],text=True)
 allgone=all(gone(x) for x in c['processes'].values())
 exclusive(c['result']+'.stopped',{'version':1,'phase':'stopped' if allgone else 'stop_incomplete','verifiedClean':False,'semanticOutcomeUncertain':True,'stopExit':stopped.returncode,'serviceStatus':status,'allPriorProcessesGone':allgone,'sealReceiptSha256':sha(rpc['receipt']),'history':{'before':proof['before'],'after':proof['after']}})
 need(allgone,'PRIOR_PROCESSES_REMAIN_NO_FORCE');print(json.dumps({'sealedForRecovery':True,'stopped':True,'verifiedClean':False,'next':'review offline backup and candidate separately'}))
if __name__=='__main__':
 try:
  need(len(sys.argv)==3 and sys.argv[1] in ('--execute-reviewed-seal-stop','--inspect'),'EXPLICIT_REVIEWED_ACTION_REQUIRED');main(sys.argv[2],sys.argv[1]=='--inspect')
 except Exception as e:
  print(json.dumps({'completed':False,'error':str(e) if isinstance(e,RuntimeError) else type(e).__name__,'inspectBeforeRetry':True}));sys.exit(78)
