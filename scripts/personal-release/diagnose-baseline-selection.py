#!/usr/bin/python3 -I
"""Fixed body-free baseline comparisons. No kit imports, locks, writes or execution."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
sys.dont_write_bytecode=True
POLICY='/etc/agentmemory-candidate-enrollment/policy.json'
CATALOG='/var/lib/agentmemory-updates/catalog.json'
PUBLIC='/var/lib/agentmemory-updates/public/release-kits'
LIBRARY='/usr/local/lib/agentmemory-candidate-enrollment'
DROPIN='/etc/systemd/system/agentmemory.service.d/90-personal.conf'
RECEIPT='/home/daniel/.agentmemory/personal-deployment-daniel15/activation.json'
RUNTIME=('kit-runtime.py','kit-queues.py','kit-integrity.py')
IDS={'current':'daniel-15-eb3f60c4','primary':'daniel-16-ad6c423b','recovery':'recovery-17-ad6c423b'}
PHASE='startup'

def require(ok):
    if not ok:raise RuntimeError('DIAGNOSTIC_COMPARISON_REFUSED')

def diagnose(root=Path('/'), *, owner=0,service_uid=1000,service_gid=1000):
    global PHASE
    root=Path(root).absolute();p=lambda name:root/name.lstrip('/')
    def read(path, *, user=False):
        path=Path(path);require(path.is_absolute() and path.is_relative_to(root) and '..' not in path.parts)
        directory_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            for component in (None,*path.parent.relative_to(root).parts):
                if component is not None:
                    child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory_fd);os.close(directory_fd);directory_fd=child
                info=os.fstat(directory_fd);require(stat.S_ISDIR(info.st_mode))
                require(info.st_uid in ({owner,service_uid} if user else {owner}) and not info.st_mode&(0o002 if user else 0o022))
                if user and info.st_mode&0o020:require(info.st_uid==service_uid and info.st_gid==service_gid)
            fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory_fd)
        finally:os.close(directory_fd)
        with os.fdopen(fd,'rb') as file:
            before=os.fstat(file.fileno());require(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_uid in ({owner,service_uid} if user else {owner}) and not before.st_mode&(0o002 if user else 0o022) and before.st_size<=8*1024*1024)
            if user and before.st_mode&0o020:require(before.st_uid==service_uid and before.st_gid==service_gid)
            raw=file.read(8*1024*1024+1);after=os.fstat(file.fileno());named=path.lstat()
        sig=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_mode,s.st_uid,s.st_gid,s.st_nlink)
        require(len(raw)<=8*1024*1024 and sig(before)==sig(after)==sig(named));return raw
    sha=lambda raw:hashlib.sha256(raw).hexdigest()
    record=lambda path,**kwargs:json.loads(read(path,**kwargs))
    PHASE='policy_and_catalog'
    policy=record(p(POLICY));catalog=record(p(CATALOG))
    require(policy.get('dropin')==str(p(DROPIN)))
    require(isinstance(policy.get('runtimeHashes'),dict) and set(policy['runtimeHashes'])==set(RUNTIME))
    entries=catalog.get('candidates');require(isinstance(entries,list) and len(entries)<=100)
    require(all(isinstance(e,dict) and isinstance(e.get('id'),str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,79}',e['id']) for e in entries))
    PHASE='runtime_admission'
    rows={};admitted=0
    for entry in entries:
        raw=read(p(PUBLIC)/entry['id']/'kit.json');kit=json.loads(raw);files=kit.get('files',{});require(isinstance(files,dict))
        match=all(files.get(n)==policy['runtimeHashes'][n] for n in RUNTIME);admitted+=int(match)
        role=next((r for r,cid in IDS.items() if cid==entry['id']),None)
        if role:
            rows[role]={'presentInCatalog':True,'catalogManifestMatches':sha(raw)==entry.get('kitSha256'),'admittedByOldRuntimePolicy':match,'runtimeMismatchNames':[n for n in RUNTIME if files.get(n)!=policy['runtimeHashes'][n]]}
    for role in IDS:rows.setdefault(role,{'presentInCatalog':False})
    library={n:sha(read(p(LIBRARY)/n))==policy['runtimeHashes'][n] for n in RUNTIME}
    PHASE='dropin_and_activation_identity'
    dropin_sha=sha(read(p(DROPIN)));legacy=policy.get('legacyBaseline',{});legacy_match=legacy.get('protectedFiles',{}).get(str(p(DROPIN)))==dropin_sha
    baseline=record(p(PUBLIC)/IDS['primary']/'baseline.json');expected=baseline.get('receiptIdentity',{})
    require(baseline.get('receiptPath')==str(p(RECEIPT)) and isinstance(expected,dict))
    activation={'exists':p(RECEIPT).is_file(),'registeredReceiptPathMatchesFixedCurrent':True}
    if activation['exists']:
        receipt=record(p(RECEIPT),user=True);fields=('applied','candidateHash','sourceCommit','installedFileHashes')
        activation['mismatchedIdentityFields']=[n for n in fields if receipt.get(n)!=expected.get(n)]
        wanted=expected.get('installedFileHashes',{});actual=receipt.get('installedFileHashes',{})
        require(isinstance(wanted,dict) and isinstance(actual,dict) and len(wanted)<=20000 and len(actual)<=20000)
        activation['installedMapDifferenceCounts']={'missing':len(wanted.keys()-actual.keys()),'unexpected':len(actual.keys()-wanted.keys()),'changed':sum(actual[n]!=wanted[n] for n in wanted.keys()&actual.keys())}
        activation['dropinMatchesRegisteredIdentity']=wanted.get(str(p(DROPIN)))==dropin_sha
        saved=receipt.get('preservationReceipt',{});archive=saved.get('archive') if isinstance(saved,dict) else None
        activation['preservation']={'present':isinstance(archive,str),'archiveParentMatchesPolicy':isinstance(archive,str) and str(Path(archive).parent)==policy.get('archives'),'archiveNameMatchesCurrent':isinstance(archive,str) and re.fullmatch(re.escape(IDS['current'])+r'-[0-9]+\.tar\.gz',Path(archive).name) is not None,'archiveHashWellFormed':isinstance(saved,dict) and isinstance(saved.get('archiveSha256'),str) and re.fullmatch('[0-9a-f]{64}',saved['archiveSha256']) is not None}
    PHASE='registered_baseline_and_preparation'
    recovery=record(p(PUBLIC)/IDS['recovery']/'baseline.json')
    work=p('/var/lib/agentmemory-updates/private/admin-trust-transition')
    preparation={'exists':work.is_dir(),'planPresent':(work/'plan.json').is_file(),'journalPresent':(work/'journal.json').is_file(),'priorEmptyShellPreserved':work.with_name(work.name+'-before-user-hash-fix').joinpath('failed-shell').is_dir()}
    PHASE='done'
    return {'readOnly':True,'operatingChangeAuthorized':False,'fullBaselineVerified':False,'legacyDropinMatches':legacy_match,'catalogCandidateCount':len(entries),'oldPolicyAdmittedCandidateCount':admitted,'libraryMatchesPolicy':library,'registeredPrimaryRecoveryBaselinesEqual':baseline==recovery,'preparation':preparation,**rows,'activation':activation,'limitations':['No kit execution, archive-content validation or full protected-file verification','Comparison uses registered primary baseline as expected current activation identity','This observes current metadata, not a historical failure trace']}

def main():
    require(os.geteuid()==0 and len(sys.argv)==1)
    print(json.dumps(diagnose(),sort_keys=True))
if __name__=='__main__':
    try:main()
    except BaseException:print(json.dumps({'readOnly':True,'errorCode':'DIAGNOSTIC_COMPARISON_REFUSED','phase':PHASE,'operatingChangeAuthorized':False}));sys.exit(1)
