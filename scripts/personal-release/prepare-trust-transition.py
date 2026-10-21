#!/usr/bin/python3 -I
"""Interactive staging and --prepare only. Never changes operating entrypoints."""
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
SOURCE=Path('/home/daniel/Documents/Codex/2026-10-21/task/agentmemory-diagnostics/scripts/personal-release')
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


def read(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as f:
        st=os.fstat(f.fileno());require(stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_size<=2*1024*1024,'SOURCE_FILE_REFUSED')
        raw=f.read(2*1024*1024+1)
    require(len(raw)<=2*1024*1024,'SOURCE_FILE_REFUSED');return raw


def sync_dir(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)


def write(path,raw,owner,gid,mode):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    with os.fdopen(fd,'wb') as f:
        os.fchmod(f.fileno(),mode);os.fchown(f.fileno(),owner,gid);f.write(raw);f.flush();os.fsync(f.fileno())


def prepare(source,bundle,pins, *, owner=0,gid=0,ask=input,run=None,out=sys.stdout):
    global PREPARE_MAY_HAVE_STARTED
    # Parameters are for synthetic library tests. CLI exposes no path/hash override.
    require(not bundle.exists() and not bundle.is_symlink(),'BUNDLE_EXISTS')
    blobs={n:read(source/n) for n in pins}
    require(all(hashlib.sha256(blobs[n]).hexdigest()==h for n,h in pins.items()),'SOURCE_HASH_MISMATCH')
    for parent in [bundle.parent,*bundle.parent.parents]:
        info=parent.lstat();require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_uid==owner and not info.st_mode&0o022,'STAGING_PARENT_REFUSED')
        # Synthetic fixtures anchor at their parent; production checks through /.
        if owner!=0:break
    try:bundle.mkdir(mode=0o755)
    except FileExistsError:raise RuntimeError('BUNDLE_EXISTS') from None
    os.chmod(bundle,0o755);os.chown(bundle,owner,gid);sync_dir(bundle.parent)
    for n,raw in blobs.items():write(bundle/n,raw,owner,gid,0o644)
    record={'executionClosureReviewed':False,'reviewedBy':'','files':dict(pins),'independentReviewEvidence':EVIDENCE}
    approval=bundle/'source-review.json'
    write(approval,(json.dumps(record,indent=2)+'\n').encode(),owner,gid,0o600);sync_dir(bundle)
    print('STAGED: 고정 코드 3개와 미승인 검토 기록만 설치했습니다. 운영 실행 파일·서비스·재시도 변경 없음.',file=out)
    print(json.dumps({'frozenSourceHashes':pins,'independentReviewEvidence':EVIDENCE},ensure_ascii=False),file=out)
    print('위 AI 리뷰는 사람의 검토를 대신하지 않습니다. 미검토라면 Enter로 설치만 마치세요. 실제 설치 코드 검토 명령:',file=out)
    for n in pins:print('less '+str(bundle/n),file=out)
    name=ask('설치 코드 전체를 실제로 검토한 검토자 이름 (미완료면 Enter): ').strip()
    if not name:return 'STAGED_REVIEW_REQUIRED'
    require(len(name)<=120 and all(ord(c)>=32 and ord(c)!=127 for c in name),'REVIEWER_IDENTITY_REFUSED')
    print('검토하지 않았다면 확인 문구를 입력하지 마세요. AI 리뷰를 본 것만으로 직접 코드 검토를 주장하지 마세요.',file=out)
    if ask('실제 검토를 완료했고 준비만 승인한다면 SOURCE REVIEW COMPLETE; PREPARE ONLY 입력: ')!='SOURCE REVIEW COMPLETE; PREPARE ONLY':return 'STAGED_REVIEW_REQUIRED'
    require(all(hashlib.sha256(read(bundle/n)).hexdigest()==h for n,h in pins.items()),'STAGED_HASH_MISMATCH')
    require(json.loads(read(approval))==record,'REVIEW_RECORD_CHANGED')
    record.update(executionClosureReviewed=True,reviewedBy=name)
    record['preparationApproval']={'scope':'staging and --prepare only','confirmedBy':name,'operatingTransitionApproved':False}
    temporary=bundle/('.source-review-'+str(uuid.uuid4()))
    write(temporary,(json.dumps(record,indent=2)+'\n').encode(),owner,gid,0o600)
    os.replace(temporary,approval);sync_dir(bundle)
    command=[PYTHON,'-I',str(bundle/'admin-trust-transition.py'),'--prepare']
    PREPARE_MAY_HAVE_STARTED=True
    if run is None:subprocess.run(command,check=True,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C.UTF-8'})
    else:run(command)
    return 'PREPARE_COMPLETED'


def main():
    require(os.geteuid()==0,'SSH_SUDO_REQUIRED')
    require(len(sys.argv)==1,'ARGUMENTS_REFUSED')
    require(sys.stdin.isatty(),'INTERACTIVE_REVIEW_REQUIRED')
    result=prepare(SOURCE,BUNDLE,PINS)
    print(json.dumps({'status':result,'serviceControlled':False,'retryStarted':False}))

def failure_code(error):
    if isinstance(error,(EOFError,KeyboardInterrupt)):return 'PREPARE_INTERRUPTED_INSPECT_RESULT_NO_RETRY' if PREPARE_MAY_HAVE_STARTED else 'REVIEW_INTERRUPTED_NO_PREPARE'
    if isinstance(error,subprocess.CalledProcessError):return 'PREPARE_FAILED_INSPECT_RESULT_NO_RETRY'
    if isinstance(error,RuntimeError) and str(error).replace('_','').isalnum():return str(error)
    return 'PREPARATION_WRAPPER_FAILED'


if __name__=='__main__':
    try:main()
    except BaseException as error:
        print(json.dumps({'errorCode':failure_code(error),'serviceControlled':False,'retryStarted':False}));sys.exit(1)
