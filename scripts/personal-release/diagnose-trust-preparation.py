#!/usr/bin/python3 -I
"""Fixed metadata-only inspection. Never prepares, repairs, locks or executes kits."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

DIAGNOSTIC_PHASE='startup'
BUNDLE='/usr/local/lib/agentmemory-admin-trust-transition'
WORK='/var/lib/agentmemory-updates/private/admin-trust-transition'
CURRENT='/var/lib/agentmemory-updates/public/release-kits/daniel-15-eb3f60c4'
PINS={
 'admin-trust-transition.py':'0ba0062120a38dfd642f173b14eb0557bd05901ef077b232c99ba0163d3dc4fe',
 'dashboard-updates.py':'4a1ab143a97949309a1db8ab4e0d677439399c5be72176fa56b67a4c29c62a77',
 'candidate-enrollment.py':'f87032852ad0e2a88edd9f6ac9d769f625fc831c60e2db53c777fc609727e93d',
}


def require(value):
    if not value:raise RuntimeError('DIAGNOSTIC_PATH_REFUSED')


def directory(path,root,owner):
    require(path.is_absolute() and path.is_relative_to(root))
    for parent in (path,*path.parents):
        info=parent.lstat();require(stat.S_ISDIR(info.st_mode) and info.st_uid==owner and not info.st_mode&0o022 and not stat.S_ISLNK(info.st_mode))
        if parent==root:break


def read(path,root,owner):
    directory(path.parent,root,owner)
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as f:
        info=os.fstat(f.fileno());require(stat.S_ISREG(info.st_mode) and info.st_uid==owner and info.st_nlink==1 and not info.st_mode&0o022 and info.st_size<=8*1024*1024)
        raw=f.read(8*1024*1024+1)
    require(len(raw)<=8*1024*1024);return raw


def diagnose(root=Path('/'), *, owner=0,service_uid=1000,service_gid=1000,pins=None):
    global DIAGNOSTIC_PHASE
    DIAGNOSTIC_PHASE='staging'
    root=Path(root).absolute();p=lambda name:root/name.lstrip('/')
    pins=PINS if pins is None else pins;bundle=p(BUNDLE);directory(bundle,root,owner)
    actual={name:hashlib.sha256(read(bundle/name,root,owner)).hexdigest() for name in pins}
    source=json.loads(read(bundle/'source-review.json',root,owner))
    result={'readOnly':True,'actualFailurePathKnown':False,'resumeAuthorized':False,
      'staging':{'matchesPinnedBeforeFix':all(actual[n]==pins[n] for n in pins),'sourceReviewPresent':True,'reviewCompleted':source.get('executionClosureReviewed') is True,'attributedToExpectedAI':source.get('reviewedBy')=='Codex AI reviewer /root/preflight_retry_review','recordHashesMatchInstalled':source.get('files')==actual,'userCodeReviewClaimed':isinstance(source.get('preparationAuthorization'),dict) and source['preparationAuthorization'].get('userCodeReviewClaimed') is True},
      'preparation':{'exists':False,'planPresent':False,'emptyShell':False,'unknownEntryCount':0}}
    DIAGNOSTIC_PHASE='preparation_inventory'
    work=p(WORK)
    if work.exists() or work.is_symlink():
        directory(work,root,owner)
        known={'before','after','original-kits','original-failure','plan.json','review-template.json','review.json','journal.json','receipt.json'}
        entries=list(work.iterdir());require(len(entries)<=100 and all(not item.is_symlink() for item in entries))
        known_files={'plan.json','review-template.json','review.json','journal.json','receipt.json'}
        for item in entries:
            if item.name in known_files:
                info=item.lstat();require(stat.S_ISREG(info.st_mode) and info.st_uid==owner and info.st_nlink==1 and not info.st_mode&0o022)
        counts={}
        for name in ('before','after','original-kits','original-failure'):
            child=work/name
            if child.exists() or child.is_symlink():
                directory(child,root,owner);counts[name]=sum(1 for _ in child.iterdir());require(counts[name]<=20000)
            else:counts[name]=None
        files={name:(work/name).is_file() and not (work/name).is_symlink() for name in ('plan.json','review-template.json','review.json','journal.json','receipt.json')}
        # Never read a plan or snapshot body. Only journal/receipt status keys.
        phases={'prepared','applying','restored','committed'};phase=None;committed=False
        if files['journal.json']:
            value=json.loads(read(work/'journal.json',root,owner));phase=value.get('phase') if value.get('phase') in phases else 'other'
        if files['receipt.json']:committed=json.loads(read(work/'receipt.json',root,owner)).get('committed') is True
        unknown=sum(item.name not in known for item in entries)
        result['preparation']={'exists':True,'planPresent':files['plan.json'],'reviewPresent':files['review.json'],'journalPresent':files['journal.json'],'receiptPresent':files['receipt.json'],'journalPhase':phase,'committed':committed,'stagedEntryCounts':counts,'unknownEntryCount':unknown,'emptyShell':not unknown and not any(files.values()) and all(value==0 for value in counts.values())}
    DIAGNOSTIC_PHASE='public_baseline_layout'
    baseline=json.loads(read(p(CURRENT)/'baseline.json',root,owner))
    paths=baseline.get('protectedFiles',{});archives=baseline.get('archives',[])
    require(isinstance(paths,dict) and len(paths)<=20000 and isinstance(archives,list) and len(archives)<=200)
    require(all(isinstance(row,dict) and isinstance(row.get('path'),str) for row in archives))
    paths={**paths,**{row['path']:row.get('sha256') for row in archives}}
    conflicts=0;first=None;seen={}
    for raw in paths:
        path=Path(raw);require(path.is_absolute() and path.is_relative_to(root) and '..' not in path.parts)
        for ancestor in reversed((path,*path.parents)):
            if not ancestor.is_relative_to(root):continue
            if ancestor not in seen:
                try:seen[ancestor]=ancestor.lstat()
                except OSError:seen[ancestor]=None
            info=seen[ancestor]
            if info is None or stat.S_ISLNK(info.st_mode) or info.st_uid not in {owner,service_uid} or info.st_mode&0o022:
                conflicts+=1
                if first is None:
                    first={'path':raw,'ancestor':str(ancestor),'unavailable':info is None}
                    if info is not None:first.update(mode=oct(stat.S_IMODE(info.st_mode)),symlink=stat.S_ISLNK(info.st_mode),serviceGroupWriteOnly=bool(info.st_mode&0o020 and not info.st_mode&0o002 and info.st_uid==service_uid and info.st_gid==service_gid))
                break
    new_bad=0;new_first=None
    for raw in paths:
        path=Path(raw);service_path=path.is_relative_to(p('/home/daniel'));reason=None;bad_node=None
        for node in reversed((path,*path.parents)):
            if not node.is_relative_to(root):continue
            if node not in seen:
                try:seen[node]=node.lstat()
                except OSError:seen[node]=None
            info=seen[node]
            if info is None or stat.S_ISLNK(info.st_mode):reason='MISSING_OR_SYMLINK'
            elif service_path:
                if info.st_uid not in {owner,service_uid} or info.st_mode&0o002 or (info.st_mode&0o020 and not (info.st_uid==service_uid and info.st_gid==service_gid)):reason='WRITABLE_BY_UNEXPECTED_ROLE'
                else:
                    bit=(0o400 if node==path else 0o500) if info.st_uid==service_uid else (0o040 if node==path else 0o050) if info.st_gid==service_gid else (0o004 if node==path else 0o005)
                    if info.st_mode&bit!=bit:reason='SERVICE_ACCESS_NOT_SHOWN_BY_MODE'
            elif node!=path and (info.st_uid!=owner or info.st_mode&0o022):reason='ROOT_DIRECTORY_NOT_STRICT'
            if reason is None and node==path and (not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>512*1024*1024):reason='FILE_TYPE_LINK_OR_SIZE'
            if reason is not None:bad_node=node;break
        if reason is not None:
            new_bad+=1
            if new_first is None:new_first={'path':raw,'ancestor':str(bad_node),'reason':reason}
    result['publicBaselinePaths']={'count':len(paths),'oldGuardConflicts':conflicts,'firstConflict':first,'newReaderMetadataConflicts':new_bad,'firstNewReaderConflict':new_first,'metadataOnlyAccessPrediction':True}
    # Report additional private policy path conflicts only as a count, no values.
    DIAGNOSTIC_PHASE='private_policy_parents'
    policy=p('/etc/agentmemory-candidate-enrollment/policy.json')
    if policy.exists():
        value=json.loads(read(policy,root,owner));assets=value.get('assets',{});require(isinstance(assets,dict) and len(assets)<=16)
        bad=0
        for raw in assets:
            path=Path(raw);require(path.is_absolute() and path.is_relative_to(root) and '..' not in path.parts)
            try:directory(path.parent,root,owner)
            except (OSError,RuntimeError):bad+=1
        result['policyAssetParentConflicts']=bad
    return result


def main():
    require(os.geteuid()==0 and len(sys.argv)==1)
    print(json.dumps(diagnose(),sort_keys=True))

if __name__=='__main__':
    try:main()
    except BaseException:print(json.dumps({'readOnly':True,'errorCode':'DIAGNOSTIC_PATH_OR_METADATA_REFUSED','diagnosticPhase':DIAGNOSTIC_PHASE,'resumeAuthorized':False}));sys.exit(1)
