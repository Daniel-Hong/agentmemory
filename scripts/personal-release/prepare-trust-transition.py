#!/usr/bin/python3 -I
"""Resume exact pending staging with real AI-review evidence; --prepare only."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid

PREPARE_MAY_HAVE_STARTED=False
PYTHON='/usr/bin/python3'
WORK=Path('/var/lib/agentmemory-updates/private/admin-trust-transition')
BUNDLE=Path('/usr/local/lib/agentmemory-admin-trust-transition')
PINS={
 'admin-trust-transition.py':'0ba0062120a38dfd642f173b14eb0557bd05901ef077b232c99ba0163d3dc4fe',
 'dashboard-updates.py':'4a1ab143a97949309a1db8ab4e0d677439399c5be72176fa56b67a4c29c62a77',
 'candidate-enrollment.py':'f87032852ad0e2a88edd9f6ac9d769f625fc831c60e2db53c777fc609727e93d',
}
EVIDENCE={
 'performedBy':'Codex AI reviewer /root/preflight_retry_review',
 'sourceCommit':'e05744b0baddb692136caac1b45715d0497b750a',
 'result':'Pre-import verification issue fixed; independent 16 synthetic transition tests passed; no remaining important finding reported.',
 'wholeSuite':'182 Python tests and 3282 application tests passed; 4 existing application skips.',
 'limitation':'AI review and synthetic results; not a human administrator attestation or actual-host readiness proof.',
}


def require(value,code):
    if not value:raise RuntimeError(code)


def checked_directory(path,owner,anchor):
    require(path.is_absolute() and path.is_relative_to(anchor),'STAGING_PERMISSION_REFUSED')
    for item in (path,*path.parents):
        info=item.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_uid==owner and not info.st_mode&0o022,'STAGING_PERMISSION_REFUSED')
        if item==anchor:break


def read_owned(path,owner,gid,mode):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as f:
        info=os.fstat(f.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==owner and info.st_gid==gid and stat.S_IMODE(info.st_mode)==mode and info.st_size<=2*1024*1024,'STAGING_PERMISSION_REFUSED')
        raw=f.read(2*1024*1024+1)
    require(len(raw)<=2*1024*1024,'STAGING_PERMISSION_REFUSED');return raw


def sync_dir(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)


def encoded(record):return (json.dumps(record,indent=2)+'\n').encode()


def resume_pending_staging(bundle,pins,work, *, owner=0,gid=0,anchor=Path('/'),run=None,out=sys.stdout):
    # Library-only fixture injection; CLI has no path, owner or digest overrides.
    global PREPARE_MAY_HAVE_STARTED
    checked_directory(bundle,owner,anchor)
    lock_fd=os.open(bundle/'.prepare-wrapper.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    with os.fdopen(lock_fd,'r+b') as lock:
        info=os.fstat(lock.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==owner and info.st_gid==gid and stat.S_IMODE(info.st_mode)==0o600,'STAGING_PERMISSION_REFUSED')
        try:fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('PREPARATION_BUSY') from None
        require(not work.exists() and not work.is_symlink(),'PREPARATION_EXISTS_INSPECT_STATE')
        for name,expected in pins.items():
            require(hashlib.sha256(read_owned(bundle/name,owner,gid,0o644)).hexdigest()==expected,'STAGED_HASH_MISMATCH')
        approval=bundle/'source-review.json'
        pending={'executionClosureReviewed':False,'reviewedBy':'','files':dict(pins),'independentReviewEvidence':EVIDENCE}
        original=read_owned(approval,owner,gid,0o600)
        require(original==encoded(pending),'REVIEW_STATE_NOT_PENDING')
        evidence={**EVIDENCE,'sourceFilesSha256':dict(pins),'reviewScope':'Fixed trust-transition derivation/restoration, retry lineage and enrollment-policy integration; connected .16/.17 synthetic execution paths and pre-import verification correction.'}
        evidence_sha=hashlib.sha256(encoded(evidence)).hexdigest()
        record={'executionClosureReviewed':True,'reviewedBy':EVIDENCE['performedBy'],'files':dict(pins),'independentReviewEvidence':evidence,'reviewEvidenceSha256':evidence_sha,
          'preparationAuthorization':{'source':'Existing explicit user instruction authorizing staging and --prepare','scope':'existing staging continuation and --prepare only','userCodeReviewClaimed':False,'operatingTransitionApproved':False},'priorPendingRecordSha256':hashlib.sha256(original).hexdigest()}
        # Preserve the exact pending evidence in the new root-protected record.
        record['priorPendingRecord']=pending
        require(read_owned(approval,owner,gid,0o600)==original,'REVIEW_STATE_CHANGED')
        temporary=bundle/('.source-review-'+str(uuid.uuid4()))
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            with os.fdopen(fd,'wb') as f:
                os.fchmod(f.fileno(),0o600);os.fchown(f.fileno(),owner,gid);f.write(encoded(record));f.flush();os.fsync(f.fileno())
            os.replace(temporary,approval);sync_dir(bundle)
        finally:
            try:temporary.unlink()
            except FileNotFoundError:pass
        require(read_owned(approval,owner,gid,0o600)==encoded(record),'REVIEW_RECORD_CHANGED')
        print(json.dumps({'stagingVerified':True,'reviewAttributedToAI':True,'userCodeReviewClaimed':False,'preparationOnly':True}),file=out,flush=True)
        PREPARE_MAY_HAVE_STARTED=True
        command=[PYTHON,'-I',str(bundle/'admin-trust-transition.py'),'--prepare']
        if run is None:subprocess.run(command,check=True,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C.UTF-8'})
        else:run(command)
        return 'PREPARE_COMPLETED'


def main():
    require(os.geteuid()==0,'SSH_SUDO_REQUIRED')
    require(len(sys.argv)==1,'ARGUMENTS_REFUSED')
    result=resume_pending_staging(BUNDLE,PINS,WORK)
    print(json.dumps({'status':result,'serviceControlled':False,'retryStarted':False}))


def failure_code(error):
    if isinstance(error,(EOFError,KeyboardInterrupt)):return 'PREPARE_INTERRUPTED_INSPECT_RESULT_NO_RETRY' if PREPARE_MAY_HAVE_STARTED else 'RESUME_INTERRUPTED_INSPECT_STATE_NO_PREPARE'
    if isinstance(error,subprocess.CalledProcessError):return 'PREPARE_FAILED_INSPECT_RESULT_NO_RETRY'
    if isinstance(error,RuntimeError) and str(error).replace('_','').isalnum():return str(error)
    return 'PREPARATION_RESUME_FAILED_INSPECT_STATE'


if __name__=='__main__':
    try:main()
    except BaseException as error:
        print(json.dumps({'errorCode':failure_code(error),'serviceControlled':False,'retryStarted':False}));sys.exit(1)
