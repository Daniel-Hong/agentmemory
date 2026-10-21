#!/usr/bin/python3 -I
"""One approved plan only: record the actual AI review, existing check/apply. No retry."""
import hashlib,json,os,re,stat,subprocess,sys,types
from pathlib import Path
sys.dont_write_bytecode=True
BUNDLE=Path('/usr/local/lib/agentmemory-admin-trust-transition')
EXPORTER=Path('/home/daniel/Documents/Codex/2026-10-21/task/agentmemory-diagnostics/scripts/personal-release/export-trust-plan-review.py')
EXPORTER_SHA='1c56728ab784e781464280108874a6a86ebf76a9e4ba4b5e4ea459374d0e547b'
PINS={'admin-trust-transition.py':'03006669023307afcb702d5dbdb034ba0e3a2e4682e8202da604a097cf7813ae','dashboard-updates.py':'4a1ab143a97949309a1db8ab4e0d677439399c5be72176fa56b67a4c29c62a77','candidate-enrollment.py':'f87032852ad0e2a88edd9f6ac9d769f625fc831c60e2db53c777fc609727e93d'}
PLAN='dcac8099a293abe1f4ebc72ff3284bcb45ffd9f63042b529d5e273b5c196a442'
INTENT='bb8c3711a3ac16ef96c166871a35e0e240210e1c0138d77e2eefda1282016437'
PHASE='validation'
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C.UTF-8'}

def require(ok,code):
    if not ok:raise RuntimeError(code)
def encode(value):return (json.dumps(value,sort_keys=True,ensure_ascii=True)+'\n').encode()

def record_check_apply(t,inspect_plan,execute, *, plan_sha=PLAN,intent_sha=INTENT,count=36):
    global PHASE
    PHASE='validation'
    with t.locks():
        require(not any((t.work/name).exists() or (t.work/name).is_symlink() for name in ('journal.json','receipt.json')),'TRANSITION_ALREADY_STARTED_INSPECT_STATE')
        evidence=inspect_plan(t,plan_sha,intent_sha,count)
        require(evidence.get('derivedTargetsMatch') is True and evidence.get('sourceReviewMatchesCodePins',True) is True,'PLAN_REVIEW_REVALIDATION_FAILED')
        plan=t.record(t.work/'plan.json');t.unchanged(plan);t.process_exclusion()
        require(all(t.target_state(path,item)=='before' for path,item in plan['targets'].items()),'TRANSITION_ORIGINAL_CHANGED')
        review={'format':'ubuntu-admin-trust-v1','planSha256':plan_sha,'intentSha256':intent_sha,'targetCount':count,'executionClosureReviewed':True,'reviewedBy':'Codex AI plan reviewer /root','userCodeReviewClaimed':False,
          'reviewEvidence':{'sourceMessage':'Sentinel_e7e81ae49f508191b63231d3fb57d7d8','exporterSha256':EXPORTER_SHA,'outcome':'Actual fixed-plan AI review completed; no important finding','scope':'All 36 derived targets, original snapshots, code archive contents, metadata owners/modes, lineage and ordering','limitation':'Live state must still satisfy the unchanged existing check/apply guards'},
          'executionAuthority':{'source':'Explicit SSH invocation of this exact-plan operating command after user operating approval','scope':'AI review record and existing trust check/apply only; no service control or .16 retry'}}
        raw=encode(review);path=t.work/'review.json'
        if path.exists() or path.is_symlink():require(t.read(path)==raw,'EXISTING_REVIEW_DIFFERENT_INSPECT_STATE')
        else:
            PHASE='recording_review';t.save('review.json',review)
        require(t.read(path)==raw,'REVIEW_RECORD_READBACK_FAILED')
        _,record=t.reviewed();require(record==review,'REVIEW_RECORD_READBACK_FAILED')
    for phase in ('check','apply'):
        PHASE=phase;execute(['/usr/bin/python3','-I',str(t.bundle/'admin-trust-transition.py'),'--'+phase])
    PHASE='verify_commit';receipt=t.record(t.work/'receipt.json');journal=t.record(t.work/'journal.json')
    require(receipt.get('committed') is True and receipt.get('planSha256')==plan_sha and receipt.get('intentSha256')==intent_sha and receipt.get('dataChanged') is False and journal.get('phase')=='committed' and journal.get('planSha256')==plan_sha,'TRANSITION_COMMIT_UNCONFIRMED')
    return {'committed':True,'reviewRecorded':True,'planSha256':plan_sha,'intentSha256':intent_sha,'targetCount':count,'userCodeReviewClaimed':False,'serviceControlled':False,'retryStarted':False,'dataChanged':False}

def pinned_bytes(path,pin, *, root_only):
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in path.parent.parts[1:]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=child;info=os.fstat(fd)
            require(info.st_uid in ({0} if root_only else {0,1000}) and not info.st_mode&(0o022 if root_only else 0o002),'REVIEWED_SOURCE_PATH_REFUSED')
            if not root_only and info.st_mode&0o020:require(info.st_uid==1000 and info.st_gid==1000,'REVIEWED_SOURCE_PATH_REFUSED')
        filefd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        with os.fdopen(filefd,'rb') as file:
            info=os.fstat(file.fileno());require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size<=2*1024*1024 and info.st_uid in ({0} if root_only else {0,1000}) and not info.st_mode&(0o022 if root_only else 0o002),'REVIEWED_SOURCE_PATH_REFUSED')
            if not root_only and info.st_mode&0o020:require(info.st_uid==1000 and info.st_gid==1000,'REVIEWED_SOURCE_PATH_REFUSED')
            raw=file.read(2*1024*1024+1)
        require(hashlib.sha256(raw).hexdigest()==pin,'REVIEWED_SOURCE_HASH_CHANGED');return raw
    finally:os.close(fd)

def main():
    require(os.geteuid()==0 and len(sys.argv)==1,'SSH_ROOT_FIXED_COMMAND_REQUIRED')
    source={name:pinned_bytes(BUNDLE/name,pin,root_only=True) for name,pin in PINS.items()}
    exporter=types.ModuleType('fixed_review_evidence');exec(compile(pinned_bytes(EXPORTER,EXPORTER_SHA,root_only=False),str(EXPORTER),'exec'),exporter.__dict__)
    core=types.ModuleType('fixed_reviewed_transition');exec(compile(source['admin-trust-transition.py'],str(BUNDLE/'admin-trust-transition.py'),'exec'),core.__dict__)
    t=core.Transition();review=t.record(BUNDLE/'source-review.json')
    require(review.get('executionClosureReviewed') is True and review.get('files')==PINS and review.get('reviewedBy')=='Codex AI reviewer /root/preflight_retry_review','SOURCE_REVIEW_CHANGED')
    def execute(command):
        for name,pin in PINS.items():pinned_bytes(BUNDLE/name,pin,root_only=True)
        result=subprocess.run(command,env=ENV,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:body=json.loads(result.stdout)
        except (ValueError,UnicodeError):raise RuntimeError('TRANSITION_COMMAND_RESULT_UNCONFIRMED') from None
        if result.returncode:
            code=body.get('errorCode');raise RuntimeError(code if isinstance(code,str) and re.fullmatch('[A-Z0-9_]{1,80}',code) else 'TRANSITION_COMMAND_FAILED')
        ok=(body.get('reviewed') is True and body.get('targets')==36) if command[-1]=='--check' else (body.get('committed') is True or body.get('alreadyCommitted') is True)
        require(ok,'TRANSITION_COMMAND_RESULT_UNCONFIRMED')
    print(json.dumps(record_check_apply(t,exporter.inspect,execute),sort_keys=True))
if __name__=='__main__':
    try:main()
    except BaseException as error:
        code=str(error);print(json.dumps({'errorCode':code if re.fullmatch('[A-Z0-9_]{1,80}',code) else 'REVIEWED_TRANSITION_STOPPED_INSPECT_STATE','stage':PHASE,'serviceControlled':False,'retryStarted':False,'automaticRetry':False,'inspectBeforeRepeating':True}));sys.exit(1)
