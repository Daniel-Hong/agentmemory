#!/usr/bin/python3 -I
"""One-time administrator installation; never called by a dashboard request."""
from pathlib import Path
import importlib.util,os,shutil,stat,subprocess,sys,tempfile,time
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
ASSETS={'agentmemory-update-request':('dashboard-updates.py','usr/local/libexec/agentmemory-update-request',0o755),'agentmemory-update-runner':('dashboard-updates.py','usr/local/libexec/agentmemory-update-runner',0o755),'unit':('agentmemory-update@.service','etc/systemd/system/agentmemory-update@.service',0o644),'recovery':('agentmemory-update-recovery.service','etc/systemd/system/agentmemory-update-recovery.service',0o644),'sudoers':('agentmemory-dashboard-updates.sudoers','etc/sudoers.d/agentmemory-dashboard-updates',0o440)}
def command(args):subprocess.run(args,check=True,timeout=30,stdin=subprocess.DEVNULL)
def asset_group(name,uid,gid):return 1000 if name=='sudoers' and uid==0 else gid
def install(root=Path('/'),uid=0,gid=0,run=command):
 root=Path(root).absolute()
 def directory(path):
  path.relative_to(root)
  current=root
  for component in path.relative_to(root).parts:
   current=current/component
   if current.is_symlink():raise RuntimeError('INSTALL_PATH_SYMLINK')
   current.mkdir(mode=0o755,exist_ok=True)
   info=current.stat()
   if not stat.S_ISDIR(info.st_mode) or info.st_uid!=uid or info.st_mode&0o022:raise RuntimeError('INSTALL_PATH_UNTRUSTED')
 for _,relative,_ in ASSETS.values():directory((root/relative).parent)
 state=root/'var/lib/agentmemory-updates';directory(state.parent)
 spec=importlib.util.spec_from_file_location('approved_update_runner',HERE/'dashboard-updates.py');runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
 manager=runner.Runner(state=state,spool=root/'home/daniel/.agentmemory/update-requests',trusted_uid=uid,trust_anchor=root);manager.initialize()
 backup=state/'private'/('setup-'+str(time.time_ns()));backup.mkdir(mode=0o700);os.chown(backup,uid,gid)
 with tempfile.TemporaryDirectory(prefix='setup-',dir=state/'private') as temp:
  staged=Path(temp)
  for name,(source,relative,mode) in ASSETS.items():
   origin=HERE/source
   if origin.is_symlink() or not origin.is_file():raise RuntimeError('INSTALL_ASSET_INVALID')
   data=origin.read_bytes();(staged/name).write_bytes(data);os.chmod(staged/name,mode);os.chown(staged/name,uid,asset_group(name,uid,gid))
   target=root/relative
   if target.is_symlink():raise RuntimeError('INSTALL_TARGET_SYMLINK')
   if target.exists():
    info=target.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=uid or info.st_mode&0o022:raise RuntimeError('INSTALL_TARGET_UNTRUSTED')
    shutil.copyfile(target,backup/name);os.chmod(backup/name,0o600)
  run(['/usr/sbin/visudo','-c','-f',str(staged/'sudoers')])
  for name,(_,relative,mode) in ASSETS.items():
   target=root/relative;fd,temporary=tempfile.mkstemp(prefix='.agentmemory-update-',dir=target.parent)
   try:
    with os.fdopen(fd,'wb') as output:
     os.fchmod(output.fileno(),mode);os.fchown(output.fileno(),uid,asset_group(name,uid,gid));output.write((staged/name).read_bytes());output.flush();os.fsync(output.fileno())
    os.replace(temporary,target);directory_fd=os.open(target.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(directory_fd)
    finally:os.close(directory_fd)
   finally:
    if os.path.exists(temporary):os.unlink(temporary)
 run(['/usr/bin/systemctl','daemon-reload'])
 run(['/usr/bin/systemctl','enable','--now','agentmemory-update-recovery.service'])
 return {'installed':True,'candidatesAutomaticallyEnrolled':False,'serviceRestarted':False,'dataChanged':False}
if __name__=='__main__':
 if os.geteuid()!=0 or sys.argv[1:]!=['--install']:raise SystemExit('Administrator --install required')
 import json
 print(json.dumps(install()))
