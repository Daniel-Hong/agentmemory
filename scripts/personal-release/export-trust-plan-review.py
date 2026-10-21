#!/usr/bin/python3 -I
"""One fixed plan: export derived comparison facts, never review/write/apply."""
import copy,hashlib,io,json,os,re,stat,sys,tarfile,types
from pathlib import Path
sys.dont_write_bytecode=True
BUNDLE=Path('/usr/local/lib/agentmemory-admin-trust-transition')
PINS={'admin-trust-transition.py':'03006669023307afcb702d5dbdb034ba0e3a2e4682e8202da604a097cf7813ae','dashboard-updates.py':'4a1ab143a97949309a1db8ab4e0d677439399c5be72176fa56b67a4c29c62a77','candidate-enrollment.py':'f87032852ad0e2a88edd9f6ac9d769f625fc831c60e2db53c777fc609727e93d'}
PLAN='dcac8099a293abe1f4ebc72ff3284bcb45ffd9f63042b529d5e273b5c196a442'
INTENT='bb8c3711a3ac16ef96c166871a35e0e240210e1c0138d77e2eefda1282016437'

def require(value):
    if not value:raise RuntimeError('PLAN_REVIEW_COMPARISON_REFUSED')
def sha(raw):return hashlib.sha256(raw).hexdigest()
def encode(value):return (json.dumps(value,sort_keys=True,ensure_ascii=True)+'\n').encode()

def inspect(t,plan_sha,intent_sha,count):
    raw=t.read(t.work/'plan.json');require(sha(raw)==plan_sha);plan=json.loads(raw);require(sha(encode(plan))==plan_sha)
    require(plan.get('intentSha256')==intent_sha==sha(encode(plan['intent'])) and len(plan['targets'])==count)
    require(plan.get('format')=='ubuntu-admin-trust-v1' and set(plan['order'])==set(plan['targets']) and len(plan['order'])==count)
    after={};before={};aliases={}
    for path,item in plan['targets'].items():
        for field in ('afterSha256','beforeSha256'):require(item[field] is None and field=='beforeSha256' or isinstance(item[field],str) and re.fullmatch('[a-f0-9]{64}',item[field]))
        value=t.read(t.work/'after'/item['afterSha256']);require(sha(value)==item['afterSha256']);after[Path(path)]=value
        value=None if item['beforeSha256'] is None else t.read(t.work/'before'/item['beforeSha256']);require(value is None or sha(value)==item['beforeSha256']);before[Path(path)]=value
    original={}
    for role,spec in t.specs.items():
        folder=t.work/'original-kits'/spec['id'];metadata=t.record(folder/'kit.json')
        require(sha(t.read(folder/'kit.json'))==spec['kitSha256'] and all(metadata.get(k)==spec[k] for k in ('id','version','sourceCommit','packageSha256')))
        original[role]={n:t.read(folder/n) for n in ('kit.json',*metadata['files'])}
        require(all(sha(original[role][n])==h for n,h in metadata['files'].items()))
    current=t.specs['current'];revision=current['version'].split('daniel.')[1]
    receipt_path=t.p('/home/daniel/.agentmemory/personal-deployment-daniel'+revision+'/activation.json')
    archive_path=t.p('/home/daniel/.agentmemory-code-archives')/(current['id']+'-'+str(int(intent_sha[:20],16))+'.tar.gz')
    executables=('/usr/local/libexec/agentmemory-update-request','/usr/local/libexec/agentmemory-update-runner','/usr/local/libexec/agentmemory-candidate-enroll')
    expected={t.p(n):t.read(t.bundle/('candidate-enrollment.py' if index==2 else 'dashboard-updates.py')) for index,n in enumerate(executables)}
    for index,name in enumerate(executables):aliases[t.p(name)]=('request','runner','enrollment')[index]
    for name in ('kit-runtime.py','kit-queues.py','kit-integrity.py'):expected[t.library/name]=original['primary'][name];aliases[t.library/name]='library/'+name
    for path,expected_hash in t.executables.items():require(sha(before[t.p(path)])==expected_hash)
    intent=plan['intent'];oldpolicy=json.loads(before[t.policy_path])
    require(intent=={'format':'ubuntu-admin-trust-v1','oldKitHashes':{r:t.specs[r]['kitSha256'] for r in t.specs},'newRunnerSha256':sha(expected[t.p(executables[0])]),'newEnrollmentSha256':sha(expected[t.p(executables[2])]),'failedJobId':plan['failedProof']['failedJobId'],'failedJobSha256':plan['failedProof']['failedJobSha256'],'oldPolicySha256':sha(encode(oldpolicy)),'actualOldPolicySha256':sha(before[t.policy_path])})
    receipt=json.loads(before[receipt_path]);newreceipt=copy.deepcopy(receipt);installed=dict(receipt['installedFileHashes'])
    for name in executables[:2]:installed[str(t.p(name))]=sha(expected[t.p(name)])
    baseline=json.loads(original['current']['baseline.json']);release=json.loads(original['current']['release.json'])
    for name in executables[:2]:baseline['rootAssets'][str(t.p(name))]=baseline['protectedFiles'][str(t.p(name))]=sha(expected[t.p(name)])
    kit15=json.loads(original['current']['kit.json']);archive_files={**{'runtime/'+n:h for n,h in {'kit.json':current['kitSha256'],**kit15['files']}.items()},**{'installed/'+n:h for n,h in release['packageFiles'].items()}}
    baseline['archives'].append({'path':receipt['preservationReceipt']['archive'],'sha256':receipt['preservationReceipt']['archiveSha256'],'files':archive_files})
    def revise(role,base):
        data=dict(original[role]);meta=json.loads(data['kit.json']);data['baseline.json']=encode(base)
        data['admin-transition.json']=encode({'format':'ubuntu-admin-trust-v1','intentSha256':intent_sha,'originalKitSha256':t.specs[role]['kitSha256'],'originalPackageSha256':meta['packageSha256'],'scope':'Explicit code/trust endorsement; no new service/data verification'})
        meta['files']['baseline.json']=sha(data['baseline.json']);meta['files']['admin-transition.json']=sha(data['admin-transition.json'])
        meta['adminTrustTransition']={'intentSha256':intent_sha,'priorKitSha256':t.specs[role]['kitSha256'],'priorBaselineSha256':sha(original[role]['baseline.json'])};meta['reviewedBy']+='; explicit administrator trust transition '+intent_sha;data['kit.json']=encode(meta);return data
    kits={'current':revise('current',baseline)}
    require(before[archive_path] is None)
    archive_raw=after[archive_path];wanted={**{'runtime/'+n:sha(value) for n,value in kits['current'].items()},**{'installed/'+n:h for n,h in release['packageFiles'].items()}}
    with tarfile.open(fileobj=io.BytesIO(archive_raw)) as archive:
        members=archive.getmembers();require(len(members)==len(wanted) and {m.name for m in members}==set(wanted) and all(m.isfile() for m in members))
        require(all(hashlib.file_digest(archive.extractfile(n),'sha256').hexdigest()==h for n,h in wanted.items()))
    expected[archive_path]=archive_raw
    newreceipt['installedFileHashes']=installed;newreceipt['preservationReceipt']={'archive':str(archive_path),'archiveSha256':sha(archive_raw),'readBackVerified':True}
    newreceipt['adminTrustTransition']={'intentSha256':intent_sha,'priorReceiptSha256':sha(before[receipt_path]),'priorPreservationReceipt':receipt['preservationReceipt'],'codeOnly':True};expected[receipt_path]=encode(newreceipt)
    nextbase=t.next_baseline(t.public/current['id'],json.loads(kits['current']['kit.json']),baseline,release,newreceipt,sha(kits['current']['kit.json']),receipt_path)
    for role in ('primary','recovery'):kits[role]=revise(role,nextbase)
    catalog=json.loads(before[t.catalog]);lineage={}
    for role,data in kits.items():
        cid=t.specs[role]['id'];lineage[cid]={'priorKitSha256':t.specs[role]['kitSha256'],'priorBaselineSha256':sha(original[role]['baseline.json']),'kitSha256':sha(data['kit.json']),'baselineSha256':sha(data['baseline.json']),'packageSha256':t.specs[role]['packageSha256'],'sourceCommit':t.specs[role]['sourceCommit']}
        for location,parent in [('public',t.public),('vault',t.state/'vault'),('incoming',t.state/'incoming')]:
            for name in ('baseline.json','kit.json','admin-transition.json'):
                path=parent/cid/name;expected[path]=data[name];aliases[path]=role+'/'+location+'/'+name
        for entry in catalog['candidates']:
            if entry['id']==cid:entry['kitSha256']=sha(data['kit.json'])
    require(plan['lineage']==lineage);expected[t.catalog]=encode(catalog)
    newpolicy=copy.deepcopy(oldpolicy)
    for path,value in expected.items():
        if str(path) in newpolicy['assets']:newpolicy['assets'][str(path)]=sha(value)
    newpolicy['runtimeHashes']={n:sha(original['primary'][n]) for n in ('kit-runtime.py','kit-queues.py','kit-integrity.py')};oldrt={n:sha(original['current'][n]) for n in newpolicy['runtimeHashes']}
    newpolicy['currentRuntimeHashes']=[oldrt] if oldrt==newpolicy['runtimeHashes'] else [oldrt,newpolicy['runtimeHashes']];expected[t.policy_path]=encode(newpolicy)
    marker=json.loads(before[t.marker]);marker['policySha256']=sha(expected[t.policy_path])
    for path,value in expected.items():
        if str(path) in marker.get('assets',{}):marker['assets'][str(path)]['sha256']=sha(value)
    marker['adminTrustTransition']={'intentSha256':intent_sha,'priorPolicySha256':sha(before[t.policy_path]),'priorInstallationSha256':sha(before[t.marker])};expected[t.marker]=encode(marker)
    required={p for p in expected if p not in {t.library/n for n in ('kit-runtime.py','kit-queues.py','kit-integrity.py')}}
    require(required<=set(after)<=set(expected) and all(after[p]==expected[p] for p in after))
    aliases.update({t.catalog:'catalog',t.policy_path:'policy',t.marker:'installation',receipt_path:'current-activation',archive_path:'new-code-archive'})
    require(plan['order']==[str(t.p(n)) for n in executables]+[str(p) for p in sorted(p for p in after if p not in {t.p(n) for n in executables})])
    require(plan['originalFailure']=={'job.json':plan['failedProof']['failedJobSha256'],'log.txt':plan['failedProof']['logSha256'],'transaction.json':plan['failedProof']['transactionSha256']})
    for name,value in plan['originalFailure'].items():
        require(name in ('job.json','log.txt','transaction.json') and sha(t.read(t.work/'original-failure'/name))==value)
    rows=[]
    for path in sorted(after):
        item=plan['targets'][str(path)];user=path in (receipt_path,archive_path)
        modes={0o755} if path in {t.p(n) for n in executables} else {0o644} if path.parent==t.library else {0o600} if user or path==t.catalog else {0o600,0o644}
        require(item['uid']==(t.uid if user else t.owner) and item['gid']==(t.gid if user else os.getgid()) and type(item['mode']) is int and item['mode'] in modes)
        t.trusted(path,user=user,absent=before[path] is None)
        if before[path] is None:require(not path.exists() and not path.is_symlink())
        else:
            info=path.lstat();require(stat.S_ISREG(info.st_mode) and (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(item['uid'],item['gid'],item['mode']))
        rows.append({'target':aliases[path],'beforeSnapshotMatches':True,'afterMatchesDerived':True,'liveMetadataMatchesPlan':True,'ownerRole':'service' if user else 'administrator','mode':oct(item['mode'])})
    return {'readOnly':True,'planSha256':plan_sha,'intentSha256':intent_sha,'targetCount':count,'derivedTargetsMatch':True,'originalFailureSnapshotsMatch':True,'policyTransformationMatches':True,'candidateBaselineLineageMatches':True,'currentActivationCodeOnly':True,'newArchiveContentMatches':True,'entrypointsFirst':True,'targets':rows,'actualAIPlanReviewCompleted':False,'reviewRecorded':False,'operatingChanged':False,'serviceControlled':False,'retryStarted':False,'limitations':['Plan reconstruction from hash-bound snapshots; current live state is rechecked only by existing check/apply guards','This export is evidence for AI review; it is not a review approval record']}

def main():
    require(os.geteuid()==0 and len(sys.argv)==1)
    # Verify root staging before compiling its already reviewed code; no user module imports.
    for path in (BUNDLE,*BUNDLE.parents):
        info=path.lstat();require(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022 and not stat.S_ISLNK(info.st_mode))
    source={}
    for name,pin in PINS.items():
        fd=os.open(BUNDLE/name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        with os.fdopen(fd,'rb') as file:
            info=os.fstat(file.fileno());require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1 and not info.st_mode&0o022 and info.st_size<=2*1024*1024);raw=file.read(2*1024*1024+1)
        require(sha(raw)==pin);source[name]=raw
    module=types.ModuleType('reviewed_plan_export_core');exec(compile(source['admin-trust-transition.py'],str(BUNDLE/'admin-trust-transition.py'),'exec'),module.__dict__)
    t=module.Transition();review=t.record(BUNDLE/'source-review.json')
    require(review.get('executionClosureReviewed') is True and review.get('files')==PINS and review.get('reviewedBy')=='Codex AI reviewer /root/preflight_retry_review')
    result=inspect(t,PLAN,INTENT,36);result['sourceReviewMatchesCodePins']=True;print(json.dumps(result,sort_keys=True))
if __name__=='__main__':
    try:main()
    except BaseException:print(json.dumps({'readOnly':True,'errorCode':'PLAN_REVIEW_COMPARISON_REFUSED','actualAIPlanReviewCompleted':False,'reviewRecorded':False,'operatingChanged':False,'serviceControlled':False,'retryStarted':False}));sys.exit(1)
