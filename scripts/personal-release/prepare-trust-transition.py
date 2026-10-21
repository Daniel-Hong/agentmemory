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
CORRECTED_SOURCE=Path('/home/daniel/Documents/Codex/2026-10-21/task/agentmemory-diagnostics/scripts/personal-release/admin-trust-transition.py')
BASELINE_CORE_SHA='03006669023307afcb702d5dbdb034ba0e3a2e4682e8202da604a097cf7813ae'
CORRECTED_CORE_SHA='d5e77e0d6254c4e26bcdd8c0ea5b3d5b07b578c015f444d4c91dbf490d483a39'
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


def approved_record(pins):
    pending={'executionClosureReviewed':False,'reviewedBy':'','files':dict(pins),'independentReviewEvidence':EVIDENCE}
    evidence={**EVIDENCE,'sourceFilesSha256':dict(pins),'reviewScope':'Fixed trust-transition derivation/restoration, retry lineage and enrollment-policy integration; connected .16/.17 synthetic execution paths and pre-import verification correction.'}
    return {'executionClosureReviewed':True,'reviewedBy':EVIDENCE['performedBy'],'files':dict(pins),'independentReviewEvidence':evidence,'reviewEvidenceSha256':hashlib.sha256(encoded(evidence)).hexdigest(),
      'preparationAuthorization':{'source':'Existing explicit user instruction authorizing staging and --prepare','scope':'existing staging continuation and --prepare only','userCodeReviewClaimed':False,'operatingTransitionApproved':False},'priorPendingRecordSha256':hashlib.sha256(encoded(pending)).hexdigest(),'priorPendingRecord':pending}


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
        record=approved_record(pins)
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


def write_new(path,raw,owner,gid,mode=0o600):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    with os.fdopen(fd,'wb') as f:
        os.fchmod(f.fileno(),mode);os.fchown(f.fileno(),owner,gid);f.write(raw);f.flush();os.fsync(f.fileno())


def replace_owned(path,raw,owner,gid,mode):
    temporary=path.with_name('.staging-refresh-'+str(uuid.uuid4()))
    try:
        write_new(temporary,raw,owner,gid,mode);os.replace(temporary,path);sync_dir(path.parent)
    finally:
        try:temporary.unlink()
        except FileNotFoundError:pass


def empty_failed_shell(work,owner,gid,anchor):
    checked_directory(work,owner,anchor)
    require(stat.S_IMODE(work.lstat().st_mode)==0o700 and work.lstat().st_gid==gid,'FAILED_PREPARATION_NOT_EMPTY')
    expected={'before','after','original-kits','original-failure'}
    require({p.name for p in work.iterdir()}==expected,'FAILED_PREPARATION_NOT_EMPTY')
    identities={}
    for name in sorted(expected):
        child=work/name;checked_directory(child,owner,anchor);info=child.lstat()
        require(info.st_gid==gid and stat.S_IMODE(info.st_mode)==0o700 and not any(child.iterdir()),'FAILED_PREPARATION_NOT_EMPTY')
        identities[name]=[info.st_dev,info.st_ino]
    return {'root':[work.stat().st_dev,work.stat().st_ino],'children':identities}


def user_hash_refresh_record(old_pins,new_pins,archive,original):
    evidence={'performedBy':EVIDENCE['performedBy'],'sourceCommit':'7c125e9fb5358525edcede805d1304834e627088','sourceFilesSha256':dict(new_pins),'reviewScope':'Service-identity read-only hashing, strict root code/trust guards, no-follow/identity/expected-hash checks; complete 0775 preparation and .16/.17 synthetic paths.','wholeSuite':'214 Python and 3282 application tests passed; diagnostic review findings fixed.','limitation':'Synthetic verification; actual kernel root-to-service transition and historical first failure path were not established.'}
    record={'executionClosureReviewed':True,'reviewedBy':EVIDENCE['performedBy'],'files':dict(new_pins),'independentReviewEvidence':evidence,'reviewEvidenceSha256':hashlib.sha256(encoded(evidence)).hexdigest(),'preparationAuthorization':approved_record(old_pins)['preparationAuthorization'],'priorSourceReviewSha256':hashlib.sha256(original).hexdigest(),'priorSourceReviewPath':str(archive/'source-review.before.json'),'preservedFailedPreparation':str(archive/'failed-shell'),'stagingRefreshInvocation':{'authority':'Explicit SSH execution of this fixed preparation command','scope':'corrected staging core and review evidence; preserve empty failed shell; --prepare only','operatingTransitionApproved':False}}
    return record


def refresh_failed_empty(bundle,old_pins,new_pins,source,work, *, owner=0,gid=0,anchor=Path('/'),run=None,out=sys.stdout,fault=None,previous_pins=None):
    # Two fixed epochs; fixture injection is not exposed by the CLI.
    global PREPARE_MAY_HAVE_STARTED
    name='admin-trust-transition.py';baseline=previous_pins is not None
    archive=work.with_name(work.name+('-before-baseline-selection-fix' if baseline else '-before-user-hash-fix'))
    require(set(old_pins)==set(new_pins)==set(PINS) and all(old_pins[n]==new_pins[n] for n in old_pins if n!=name) and old_pins[name]!=new_pins[name],'REFRESH_SCOPE_CHANGED')
    checked_directory(bundle,owner,anchor);checked_directory(work.parent,owner,anchor)
    fd=os.open(bundle/'.prepare-wrapper.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    with os.fdopen(fd,'r+b') as lock:
        info=os.fstat(lock.fileno());require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==owner and info.st_gid==gid and stat.S_IMODE(info.st_mode)==0o600,'STAGING_PERMISSION_REFUSED')
        try:fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('PREPARATION_BUSY') from None
        require(not archive.exists() and not archive.is_symlink(),'REFRESH_EVIDENCE_EXISTS')
        before={n:read_owned(bundle/n,owner,gid,0o644) for n in old_pins}
        require(all(hashlib.sha256(before[n]).hexdigest()==h for n,h in old_pins.items()),'STAGED_HASH_MISMATCH')
        approval=bundle/'source-review.json';original=read_owned(approval,owner,gid,0o600)
        if baseline:
            prior=work.with_name(work.name+'-before-user-hash-fix');checked_directory(prior,owner,anchor)
            pending=encoded(approved_record(previous_pins))
            require(read_owned(prior/'source-review.before.json',owner,gid,0o600)==pending,'PRIOR_REFRESH_CHANGED')
            require(hashlib.sha256(read_owned(prior/'core.before',owner,gid,0o600)).hexdigest()==previous_pins[name],'PRIOR_REFRESH_CHANGED')
            audit=json.loads(read_owned(prior/'refresh.json',owner,gid,0o600))
            prior_record=encoded(user_hash_refresh_record(previous_pins,old_pins,prior,pending))
            expected_audit={'format':'fixed-user-hash-preparation-refresh-v1','oldPins':previous_pins,'newPins':old_pins,'preservedShellIdentity':empty_failed_shell(prior/'failed-shell',owner,gid,anchor),'oldReviewSha256':hashlib.sha256(pending).hexdigest(),'newReviewSha256':hashlib.sha256(prior_record).hexdigest(),'operatingTransitionApproved':False,'serviceControlled':False,'retryStarted':False}
            require(audit==expected_audit,'PRIOR_REFRESH_CHANGED')
            require(original==prior_record,'PRIOR_REVIEW_CHANGED')
        else:require(original==encoded(approved_record(old_pins)),'PRIOR_REVIEW_CHANGED')
        identity=empty_failed_shell(work,owner,gid,anchor)
        source_fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        with os.fdopen(source_fd,'rb') as file:
            st=os.fstat(file.fileno());require(stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_size<=2*1024*1024,'CORRECTED_SOURCE_REFUSED');corrected=file.read(2*1024*1024+1)
        require(len(corrected)<=2*1024*1024 and hashlib.sha256(corrected).hexdigest()==new_pins[name],'CORRECTED_SOURCE_HASH_MISMATCH')
        record=user_hash_refresh_record(old_pins,new_pins,archive,original)
        if baseline:
            evidence={'performedBy':EVIDENCE['performedBy'],'sourceBaseCommit':'02bc501391b49a28bf286bc7e5983d4359e6a928','sourceFilesSha256':dict(new_pins),'reviewScope':'Fixed original .15 baseline derivation with complete protected-file/archive validation, exact registered .16/.17 baseline equality, historical installed helper/policy fixture and second failed-shell preservation.','limitation':'Synthetic verification and body-free host evidence; no operating transition or deployment approval.'}
            record['independentReviewEvidence']=evidence;record['reviewEvidenceSha256']=hashlib.sha256(encoded(evidence)).hexdigest()
            record['stagingRefreshInvocation']['scope']='corrected baseline selection core and AI review; preserve second empty failed shell and prior history; --prepare only'
        archive.mkdir(mode=0o700);os.chmod(archive,0o700);os.chown(archive,owner,gid);sync_dir(archive.parent)
        write_new(archive/'source-review.before.json',original,owner,gid);write_new(archive/'core.before',before[name],owner,gid)
        audit={'format':'fixed-baseline-selection-preparation-refresh-v1' if baseline else 'fixed-user-hash-preparation-refresh-v1','oldPins':old_pins,'newPins':new_pins,'preservedShellIdentity':identity,'oldReviewSha256':hashlib.sha256(original).hexdigest(),'newReviewSha256':hashlib.sha256(encoded(record)).hexdigest(),'operatingTransitionApproved':False,'serviceControlled':False,'retryStarted':False}
        write_new(archive/'refresh.json',encoded(audit),owner,gid);sync_dir(archive)
        if fault:fault('snapshots_saved')
        require(empty_failed_shell(work,owner,gid,anchor)==identity,'FAILED_PREPARATION_CHANGED')
        require(read_owned(approval,owner,gid,0o600)==original and all(read_owned(bundle/n,owner,gid,0o644)==before[n] for n in old_pins),'STAGING_CHANGED')
        os.rename(work,archive/'failed-shell');sync_dir(work.parent);sync_dir(archive)
        require(empty_failed_shell(archive/'failed-shell',owner,gid,anchor)==identity and not work.exists(),'FAILED_PREPARATION_CHANGED')
        if fault:fault('shell_preserved')
        replace_owned(bundle/name,corrected,owner,gid,0o644)
        require(read_owned(bundle/name,owner,gid,0o644)==corrected,'STAGED_HASH_MISMATCH')
        if fault:fault('core_replaced')
        require(read_owned(approval,owner,gid,0o600)==original,'PRIOR_REVIEW_CHANGED')
        replace_owned(approval,encoded(record),owner,gid,0o600)
        require(read_owned(approval,owner,gid,0o600)==encoded(record) and all(hashlib.sha256(read_owned(bundle/n,owner,gid,0o644)).hexdigest()==h for n,h in new_pins.items()),'REFRESH_READBACK_FAILED')
        if fault:fault('review_replaced')
        print(json.dumps({'stagedCoreUpdated':True,'failedPreparationPreserved':True,'reviewAttributedToAI':True,'userCodeReviewClaimed':False,'preparationOnly':True,'serviceControlled':False,'retryStarted':False}),file=out,flush=True)
        PREPARE_MAY_HAVE_STARTED=True
        command=[PYTHON,'-I',str(bundle/name),'--prepare']
        if run is None:subprocess.run(command,check=True,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C.UTF-8'})
        else:run(command)
        return 'PREPARE_COMPLETED'


def main():
    require(os.geteuid()==0,'SSH_SUDO_REQUIRED')
    require(len(sys.argv)==1,'ARGUMENTS_REFUSED')
    if WORK.exists() or WORK.is_symlink():
        if WORK.with_name(WORK.name+'-before-user-hash-fix').exists():
            result=refresh_failed_empty(BUNDLE,{**PINS,'admin-trust-transition.py':CORRECTED_CORE_SHA},{**PINS,'admin-trust-transition.py':BASELINE_CORE_SHA},CORRECTED_SOURCE,WORK,previous_pins=PINS)
        else:result=refresh_failed_empty(BUNDLE,PINS,{**PINS,'admin-trust-transition.py':CORRECTED_CORE_SHA},CORRECTED_SOURCE,WORK)
    else:result=resume_pending_staging(BUNDLE,PINS,WORK)
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
