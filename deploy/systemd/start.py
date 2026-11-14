#!/usr/bin/python3
"""Deployment-only Type=forking starter. No stop, kill, or data rewriting."""
import hashlib,json,os,pathlib,subprocess,sys,tempfile
P=pathlib.Path

def digest(path):
    with open(path,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def identity(pid):
    root=P('/proc')/str(pid)
    raw=(root/'stat').read_text(); fields=raw[raw.rindex(') ')+2:].split()
    if fields[0]=='Z':raise RuntimeError('COMPOSE_ZOMBIE')
    return (fields[19],os.readlink(root/'exe'),(root/'cmdline').read_bytes().split(b'\0')[:-1],(root/'cgroup').read_bytes(),root.stat().st_uid)
def validate(cfg,state,own_start):
    if state.get('kind')!='compose':raise RuntimeError('COMPOSE_METADATA_REQUIRED')
    pid=state.get('composePid')
    if not isinstance(pid,int) or isinstance(pid,bool) or pid<=1:raise RuntimeError('COMPOSE_PID_INVALID')
    if state.get('namespace')!=cfg['namespace'] or os.path.realpath(state.get('file',''))!=cfg['composeFile'] or os.path.realpath(state.get('binPath',''))!=cfg['engine']:raise RuntimeError('COMPOSE_METADATA_MISMATCH')
    proof=identity(pid)
    expected=[proof[2][0] if proof[2] else b'',b'compose',b'--namespace',os.fsencode(cfg['namespace']),b'--up',b'--file',os.fsencode(cfg['composeFile'])]
    if expected[0] not in (os.fsencode(cfg['engine']),os.fsencode('iii:c:'+cfg['namespace'])) or int(proof[0])<int(own_start) or os.path.realpath(proof[1])!=cfg['engine'] or proof[2]!=expected or proof[3]!=(P('/proc/self/cgroup')).read_bytes() or proof[4]!=os.getuid():raise RuntimeError('COMPOSE_IDENTITY_MISMATCH')
    return pid,proof

def main(cfg):
    for name in ('cli','engine'):
        if os.path.realpath(cfg[name])!=cfg[name] or digest(cfg[name])!=cfg[name+'Sha256']:raise RuntimeError('RELEASE_DIGEST_MISMATCH')
    meta=P(cfg['metadata']); target=P(cfg['pidFile'])
    # Never adopt a previously running daemon or replace another service PIDFile.
    if meta.exists() or target.exists():raise RuntimeError('EXISTING_LIFECYCLE_INSPECT_REQUIRED')
    own_start=identity(os.getpid())[0]
    result=subprocess.run([cfg['node'],cfg['cli'],'--data-dir',cfg['dataDir']],check=False)
    if result.returncode:raise RuntimeError('CLI_START_FAILED')
    raw=meta.read_bytes();state=json.loads(raw);pid,proof=validate(cfg,state,own_start)
    fd,tmp=tempfile.mkstemp(prefix='.compose-pid-',dir=target.parent)
    try:
        with os.fdopen(fd,'w') as f:f.write(str(pid)+'\n');f.flush();os.fsync(f.fileno())
        if meta.read_bytes()!=raw or identity(pid)!=proof:raise RuntimeError('COMPOSE_CHANGED_BEFORE_PUBLICATION')
        os.link(tmp,target) # Exclusive atomic publish; do not overwrite.
        d=os.open(target.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(d)
        finally:os.close(d)
    finally:os.unlink(tmp)
    print(json.dumps({'started':True,'composePid':pid,'systemdPidFilePublished':True}))
if __name__=='__main__':
    try:
        if len(sys.argv)!=2:raise RuntimeError('CONFIG_REQUIRED')
        main(json.loads(P(sys.argv[1]).read_text()))
    except Exception as e:
        print(json.dumps({'started':False,'error':str(e) if isinstance(e,RuntimeError) else type(e).__name__,'inspectBeforeRetry':True}),file=sys.stderr)
        sys.exit(78)
