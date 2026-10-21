#!/usr/bin/python3 -I
"""One reviewed Ubuntu .15/.16/.17 trust transition. Never a web/sudo helper."""
import contextlib
import copy
import fcntl
import gzip
import hashlib
import importlib.util
from importlib.machinery import SourceFileLoader
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid

sys.dont_write_bytecode = True
PRODUCTION = {
 'current':{'id':'daniel-15-eb3f60c4','version':'0.9.30-daniel.15','sourceCommit':'eb3f60c46199d6e065baf5019b6da6313feaa916','packageSha256':'c8cde243c68defdede637d69b4d16f13249d9ddd54da6badaf84bf732f4937cc','kitSha256':'8436f992cba4c96b239eed47d0d3c01498d4c2753001af60fd6ebb134463d885'},
 'primary':{'id':'daniel-16-ad6c423b','version':'0.9.30-daniel.16','sourceCommit':'ad6c423b0158bb355dfb539d23e2beafad8ec905','packageSha256':'27184331c77b43f67a9e0f7bd26fd653d4c1146fd4a433d43fae2f88ccc6182b','kitSha256':'12a21152b9d4176415795d635d933791ef46d0c3a3c70817df971268f31f7e6c'},
 'recovery':{'id':'recovery-17-ad6c423b','version':'0.9.30-daniel.17','sourceCommit':'ad6c423b0158bb355dfb539d23e2beafad8ec905','packageSha256':'077eeba107930b277005e2f90fd962fb59471f110ca5ecb9948f6507af5b2997','kitSha256':'67a63ef97a95ce57c1acaa19376fc17e91c2efab0229f68973c03754af842ec6'},
}
EXECUTABLES = ('/usr/local/libexec/agentmemory-update-request','/usr/local/libexec/agentmemory-update-runner','/usr/local/libexec/agentmemory-candidate-enroll')
RUNTIME = ('kit-runtime.py','kit-queues.py','kit-integrity.py')
FORMAT = 'ubuntu-admin-trust-v1'
OLD_RUNNER_SHA = '73c488d44e553f2712fdff88f06751eae32c3181311085e08f6f8ecd38a5923b'
OLD_ENROLL_SHA = '00e343569903003f0af2f7e06c60b17f4549ee410c85b6c7012f4d14066c672c'


def require(value, code):
    if not value:raise RuntimeError(code)


def digest(data):return hashlib.sha256(data).hexdigest()


def encoded(value):return (json.dumps(value,sort_keys=True,ensure_ascii=True)+'\n').encode()


class Transition:
    def __init__(self, root=Path('/'), *, owner=0, service_uid=1000, service_gid=1000, specs=None, bundle=None, executables=None, system=None, api=None, service=None):
        # Injection is library-only for temporary fixtures; CLI has no overrides.
        self.root=Path(root).absolute();self.owner=owner;self.uid=service_uid;self.gid=service_gid
        self.specs=copy.deepcopy(PRODUCTION if specs is None else specs)
        self.bundle=Path(bundle) if bundle else self.p('/usr/local/lib/agentmemory-admin-trust-transition')
        self.state=self.p('/var/lib/agentmemory-updates');self.public=self.state/'public/release-kits'
        self.library=self.p('/usr/local/lib/agentmemory-candidate-enrollment')
        self.work=self.state/'private/admin-trust-transition';self.system=system;self.api=api;self.service=service
        self.policy_path=self.p('/etc/agentmemory-candidate-enrollment/policy.json');self.marker=self.policy_path.with_name('installation.json')
        self.executables=dict(executables) if executables is not None else {p:OLD_RUNNER_SHA if p in EXECUTABLES[:2] else OLD_ENROLL_SHA for p in EXECUTABLES}
        self.catalog=self.state/'catalog.json';self.observed={};self.targets={}

    def p(self, name):return self.root/name.lstrip('/')

    def trusted(self,path, *, user=False, absent=False):
        path=Path(path);require(path.is_absolute() and path.is_relative_to(self.root) and '..' not in path.parts,'PATH_REFUSED')
        for item in (path,*path.parents):
            if absent and item==path and not item.exists() and not item.is_symlink():continue
            info=item.lstat();require(not stat.S_ISLNK(info.st_mode) and info.st_uid in ({self.owner,self.uid} if user else {self.owner}) and not info.st_mode&0o022,'PATH_REFUSED')
            if item==self.root:break

    @contextlib.contextmanager
    def directory(self,path, *, user=False):
        path=Path(path);require(path.is_relative_to(self.root),'PATH_REFUSED')
        fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            for component in path.relative_to(self.root).parts:
                child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=child
                st=os.fstat(fd);require(st.st_uid in ({self.owner,self.uid} if user else {self.owner}) and not st.st_mode&0o022,'PATH_REFUSED')
            yield fd
        finally:os.close(fd)

    def hash_observe(self,path,expected):
        path=Path(path)
        with self.directory(path.parent,user=True) as parent:
            fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
            with os.fdopen(fd,'rb') as file:
                st=os.fstat(file.fileno());require(stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_size<=512*1024*1024,'FILE_REFUSED')
                value=hashlib.sha256();remaining=512*1024*1024+1
                while remaining:
                    data=file.read(min(1024*1024,remaining))
                    if not data:break
                    remaining-=len(data);value.update(data)
                require(remaining>0 and value.hexdigest()==expected,'UNCHANGED_DEPENDENCY_CHANGED')
        self.observed[str(path)]={'sha256':expected,'mode':stat.S_IMODE(st.st_mode),'uid':st.st_uid,'gid':st.st_gid}

    def read(self,path, *, user=False, limit=64*1024*1024):
        path=Path(path);self.trusted(path,user=user)
        with self.directory(path.parent,user=user) as parent:
            fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
        with os.fdopen(fd,'rb') as stream:
            st=os.fstat(stream.fileno());require(stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_size<=limit,'FILE_REFUSED');data=stream.read(limit+1)
        require(len(data)<=limit,'FILE_REFUSED')
        self.observed[str(path)]={'sha256':digest(data),'mode':stat.S_IMODE(st.st_mode),'uid':st.st_uid,'gid':st.st_gid}
        return data

    def record(self,path, *, user=False):return json.loads(self.read(path,user=user,limit=8*1024*1024))

    def module(self,path,expected=None):
        raw=self.read(path)
        require(expected is None or digest(raw)==expected,'EXECUTABLE_CHANGED')
        name='transition_'+digest(str(path).encode())[:16]
        s=importlib.util.spec_from_loader(name,SourceFileLoader(name,str(path)))
        m=importlib.util.module_from_spec(s);exec(compile(raw,str(path),'exec'),m.__dict__);return m

    def manager(self):
        m=self.module(self.bundle/'dashboard-updates.py')
        return m.Runner(self.state,self.p('/home/daniel/.agentmemory/update-requests'),trusted_uid=self.owner,request_uid=self.uid,trust_anchor=self.root)

    def checked_runtime_module(self,kit,cid, *, original=False):
        spec=next(s for s in self.specs.values() if s['id']==cid)
        expected=spec['kitSha256']
        actual=digest(self.read(kit/'kit.json'))
        if actual!=expected and not original:
            plan,_=self.reviewed()
            expected=plan['targets'][str(kit/'kit.json')]['afterSha256']
        metadata=self.manager().checked_kit(kit,expected)
        return self.module(kit/'kit-runtime.py',metadata['files']['kit-runtime.py'])

    def enrollment_module(self, *, original=False):
        path=self.p(EXECUTABLES[2]);expected=self.executables[EXECUTABLES[2]]
        if not original and digest(self.read(path))!=expected:
            plan,_=self.reviewed();expected=plan['targets'][str(path)]['afterSha256']
        return self.module(path,expected)

    def runtime(self,cid):
        kit=self.public/cid;m=self.checked_runtime_module(kit,cid)
        paths={k:self.p(str(v)) for k,v in m.DEFAULT_PATHS.items()};paths['rootfs']=self.root
        r=m.Runtime(kit,paths=paths,owner=self.owner,anchor=self.root,service_uid=self.uid,service_gid=self.gid,system=self.system)
        if self.api:r.api=lambda path,body=None:self.api(r,path,body)
        return r

    def service_identity(self):
        if self.service:value=self.service()
        else:
            env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C.UTF-8'}
            raw=subprocess.check_output(['/usr/bin/systemctl','show','agentmemory.service','--property=MainPID,ExecMainStartTimestampMonotonic,User,Group,ActiveState,SubState'],env=env,text=True,timeout=15)
            value=dict(line.split('=',1) for line in raw.splitlines() if '=' in line)
            require(value.get('ActiveState')=='active' and value.get('SubState')=='running' and value.get('User') in ('daniel','1000') and value.get('Group') in ('daniel','1000') and int(value.get('MainPID','0'))>0,'SERVICE_UNVERIFIED')
        # Use the preserved reviewed runtime even while live kit metadata is in
        # a partially transitioned state. Its API path is read-only and bounded.
        snapshot=self.work/'original-kits'/self.specs['current']['id']
        root=snapshot if snapshot.is_dir() else self.public/self.specs['current']['id']
        m=self.checked_runtime_module(root,self.specs['current']['id'],original=True);paths={k:self.p(str(v)) for k,v in m.DEFAULT_PATHS.items()};paths['rootfs']=self.root
        r=m.Runtime(root,paths=paths,owner=self.owner,anchor=self.root,service_uid=self.uid,service_gid=self.gid,system=self.system)
        h=self.api(r,'health',None) if self.api else r.api('health')
        require(h.get('version')==self.specs['current']['version'] and h.get('status')=='healthy' and h.get('storageDurability',{}).get('mutationFailures')==0,'SERVICE_VERSION_UNVERIFIED')
        return value

    def process_exclusion(self):
        # Only known administrator entrypoints, never full arguments/environments.
        wanted={os.fsencode(str(self.p(p))) for p in EXECUTABLES}
        proc=self.p('/proc');require(proc.is_dir(),'PROCESS_STATE_UNVERIFIED')
        for path in proc.iterdir():
            if not path.name.isdigit():continue
            try:
                if path.stat().st_uid not in {self.owner,self.uid}:continue
                fd=os.open(path/'cmdline',os.O_RDONLY|os.O_NOFOLLOW)
                try:args=os.read(fd,16384).split(b'\0')
                finally:os.close(fd)
                require(not wanted.intersection(args),'ADMIN_PROCESS_ACTIVE')
            except FileNotFoundError:continue
            except PermissionError:raise RuntimeError('PROCESS_STATE_UNVERIFIED') from None

    @contextlib.contextmanager
    def locks(self):
        descriptors=[]
        try:
            for path in [self.state/'private/enrollment/enrollment.lock',self.state/'kit-bootstrap.lock',self.state/'dispatch.lock']:
                self.trusted(path.parent)
                fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600);descriptors.append(fd)
                st=os.fstat(fd);require(stat.S_ISREG(st.st_mode) and st.st_uid==self.owner and st.st_nlink==1 and not st.st_mode&0o077,'LOCK_UNVERIFIED')
                try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except BlockingIOError:raise RuntimeError('TRANSITION_BUSY') from None
            yield
        finally:
            for fd in reversed(descriptors):os.close(fd)

    def activity(self):
        # Registration/code requests are historical metadata, not memory data.
        result={}
        for folder in [self.state/'private/enrollment',self.state/'public/enrollment',self.state/'public/jobs']:
            if not folder.exists():continue
            for path in sorted(folder.rglob('*')):
                st=path.lstat();require(not stat.S_ISLNK(st.st_mode),'ACTIVITY_UNVERIFIED')
                if stat.S_ISDIR(st.st_mode):continue
                if path.name.endswith('.lock'):continue
                require(stat.S_ISREG(st.st_mode),'ACTIVITY_UNVERIFIED')
                # Detect new/changed records without copying package/input bodies.
                result[str(path)]=[st.st_ino,st.st_size,st.st_mtime_ns,st.st_uid,st.st_gid,stat.S_IMODE(st.st_mode)]
        for path in sorted((self.state/'private').glob('preflight-retry-*.json')):
            result[str(path)]=digest(self.read(path))
        require(len(result)<=20000,'ACTIVITY_TOO_LARGE')
        return result

    def inactive_updates(self):
        for path in (self.state/'public/jobs').glob('*.json'):
            value=self.record(path)
            require(value.get('status') not in ('queued','running','interrupted'),'UPDATE_ACTIVE')

    def put(self,path,data, *, uid=None,gid=None,mode=None):
        path=Path(path);self.trusted(path,user=True,absent=True)
        old=self.read(path,user=True) if path.exists() else None
        st=path.stat() if path.exists() else None
        self.targets[str(path)]={'beforeSha256':None if old is None else digest(old),'afterSha256':digest(data),'uid':st.st_uid if st else (self.owner if uid is None else uid),'gid':st.st_gid if st else (os.getgid() if gid is None else gid),'mode':stat.S_IMODE(st.st_mode) if st else (0o644 if mode is None else mode)}
        return old

    def store(self,folder,data):
        name=digest(data);path=self.work/folder/name
        if path.exists():require(self.read(path)==data,'STAGED_BYTES_CHANGED')
        else:self.atomic(path,data,self.owner,os.getgid(),0o600)
        return name

    def atomic(self,path,data,uid,gid,mode):
        path=Path(path)
        with self.directory(path.parent,user=True) as parent:
            name='.admin-trust-'+str(uuid.uuid4())
            fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode,dir_fd=parent)
            try:
                with os.fdopen(fd,'wb') as file:
                    os.fchmod(file.fileno(),mode);os.fchown(file.fileno(),uid,gid);file.write(data);file.flush();os.fsync(file.fileno())
                os.replace(name,path.name,src_dir_fd=parent,dst_dir_fd=parent);os.fsync(parent)
                st=os.fstat(parent);current=path.parent.stat(follow_symlinks=False)
                require((st.st_dev,st.st_ino)==(current.st_dev,current.st_ino),'PARENT_CHANGED')
            finally:
                try:os.unlink(name,dir_fd=parent)
                except FileNotFoundError:pass

    def mkdir(self,path):
        path=Path(path);self.trusted(path.parent)
        path.mkdir(mode=0o700)
        for parent in (path.parent,path):
            fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:os.fsync(fd)
            finally:os.close(fd)

    def save(self,name,value):self.atomic(self.work/name,encoded(value),self.owner,os.getgid(),0o600)

    def expected_kit(self,role,manager):
        spec=self.specs[role];cid=spec['id'];entry=next((c for c in manager.catalog() if c['id']==cid),None)
        require(entry and entry.get('approved') is True and entry['kitSha256']==spec['kitSha256'],'ORIGINAL_KIT_CHANGED')
        result=None
        for parent in [self.public,self.state/'vault',self.state/'incoming']:
            root=parent/cid;k=manager.checked_kit(root,spec['kitSha256'])
            require(all(k.get(key)==spec[key] for key in ('id','version','sourceCommit','packageSha256')),'ORIGINAL_KIT_CHANGED')
            data={name:self.read(root/name) for name in ('kit.json',*k['files'])}
            require(result is None or data==result,'KIT_COPIES_DIFFER');result=data
        return result

    @staticmethod
    def next_baseline(root,kit,baseline,release,receipt,manifest_sha,receipt_path):
        protected=dict(receipt['installedFileHashes'])
        protected.update({str(root/name):sha for name,sha in kit['files'].items()});protected[str(root/'kit.json')]=manifest_sha
        expected={**{'runtime/'+name:sha for name,sha in {'kit.json':manifest_sha,**kit['files']}.items()},**{'installed/'+name:sha for name,sha in release['packageFiles'].items()}}
        saved=receipt['preservationReceipt']
        return {**baseline,'compatibilityFiles':{n:h for n,h in release['packageFiles'].items() if n.startswith('plugin/scripts/codex-compat/')},'protectedFiles':protected,'receiptPath':str(receipt_path),'receiptIdentity':{name:receipt[name] for name in ('applied','candidateHash','sourceCommit','installedFileHashes')},'archives':[*baseline['archives'],{'path':saved['archive'],'sha256':saved['archiveSha256'],'files':expected}]}

    def archive(self,runtime_files,release,installed):
        raw=io.BytesIO()
        with gzip.GzipFile(fileobj=raw,mode='wb',mtime=0) as zipped:
            with tarfile.open(fileobj=zipped,mode='w') as tar:
                for name,data in sorted({**{'runtime/'+n:b for n,b in runtime_files.items()},**{'installed/'+n:self.read(installed/n,user=True) for n in release['packageFiles']}}.items()):
                    expected=release['packageFiles'].get(name[10:]) if name.startswith('installed/') else digest(data)
                    require(digest(data)==expected,'INSTALLED_CODE_CHANGED')
                    item=tarfile.TarInfo(name);item.size=len(data);item.mode=0o600;tar.addfile(item,io.BytesIO(data))
        return raw.getvalue()

    def prepare(self,failed_id='86ecf1cd-e714-4def-ad80-73b5e0b57141'):
        require(not self.work.exists(),'TRANSITION_ALREADY_PREPARED')
        self.trusted(self.state/'private')
        self.mkdir(self.work)
        for name in ('before','after','original-kits','original-failure'):self.mkdir(self.work/name)
        with self.locks():
            self.inactive_updates();self.process_exclusion()
            service=self.service_identity();activity=self.activity()
            manager=self.manager();original={role:self.expected_kit(role,manager) for role in self.specs}
            current=self.runtime(self.specs['current']['id']);current.guard()
            policy=self.record(self.policy_path);marker=self.record(self.marker)
            helper=self.enrollment_module(original=True);helper.load_policy(self.policy_path,owner=self.owner,anchor=self.root)
            for name,expected in policy['assets'].items():self.hash_observe(name,expected)
            for name,expected in current.post_files().items():self.hash_observe(name,expected)
            for row in current.baseline['archives']:self.hash_observe(row['path'],row['sha256'])
            saved_preservation=self.record(current.receipt,user=True)['preservationReceipt']
            self.hash_observe(saved_preservation['archive'],saved_preservation['archiveSha256'])
            old_baseline=helper.current_baseline(policy,owner=self.owner,anchor=self.root,runtime_paths=current.paths)
            require(all(json.loads(original[r]['baseline.json'])==old_baseline for r in ('primary','recovery')),'ORIGINAL_BASELINE_CHANGED')
            binding=manager.retry_binding(failed_id,'00000000-0000-4000-8000-000000000000')
            require(binding['candidateId']==self.specs['primary']['id'],'ORIGINAL_FAILURE_CHANGED')
            failure_snapshots={}
            for name,path in [('job.json',manager.job_path(failed_id)),('log.txt',self.state/'private'/(failed_id+'.log')),('transaction.json',self.state/'private/release-kits'/binding['candidateId']/'transaction.json')]:
                raw=self.read(path,limit=64*1024);self.atomic(self.work/'original-failure'/name,raw,self.owner,os.getgid(),0o600);failure_snapshots[name]=digest(raw)
            replacement=self.read(self.bundle/'dashboard-updates.py');enroll_code=self.read(self.bundle/'candidate-enrollment.py')
            require(all(digest(self.read(self.p(p)))==self.executables[p] for p in EXECUTABLES),'ORIGINAL_EXECUTABLE_CHANGED')
            intent={'format':FORMAT,'oldKitHashes':{role:self.specs[role]['kitSha256'] for role in self.specs},'newRunnerSha256':digest(replacement),'newEnrollmentSha256':digest(enroll_code),'failedJobId':failed_id,'failedJobSha256':binding['failedJobSha256'],'oldPolicySha256':digest(encoded(policy)),'actualOldPolicySha256':digest(self.read(self.policy_path))}
            intent_sha=digest(encoded(intent));after={}
            for path in EXECUTABLES[:2]:after[self.p(path)]=replacement
            after[self.p(EXECUTABLES[2])]=enroll_code
            # Only the already reviewed .16 runtime becomes the candidate runtime.
            for name in RUNTIME:after[self.library/name]=original['primary'][name]
            newkits={};oldreceipt=self.record(current.receipt,user=True);newreceipt=copy.deepcopy(oldreceipt)
            installed=dict(oldreceipt['installedFileHashes'])
            for path in EXECUTABLES[:2]:installed[str(self.p(path))]=digest(replacement)
            baseline=copy.deepcopy(json.loads(original['current']['baseline.json']))
            for path in EXECUTABLES[:2]:
                name=str(self.p(path));require(name in baseline['rootAssets'] and name in baseline['protectedFiles'],'ROOT_ASSET_BINDING_MISSING');baseline['rootAssets'][name]=baseline['protectedFiles'][name]=digest(replacement)
            k15=json.loads(original['current']['kit.json']);release15=json.loads(original['current']['release.json'])
            oldarchive={'path':oldreceipt['preservationReceipt']['archive'],'sha256':oldreceipt['preservationReceipt']['archiveSha256'],'files':current.archive_files()}
            require(oldarchive not in baseline['archives'],'HISTORICAL_ARCHIVE_AMBIGUOUS')
            baseline['archives'].append(oldarchive)
            evidence={'format':FORMAT,'intentSha256':intent_sha,'originalKitSha256':self.specs['current']['kitSha256'],'originalPackageSha256':k15['packageSha256'],'scope':'Explicit code/trust endorsement; no new service/data verification'}
            def revise(role,prior):
                data=dict(original[role]);meta=json.loads(data['kit.json']);data['baseline.json']=encoded(prior)
                note={**evidence,'originalKitSha256':self.specs[role]['kitSha256'],'originalPackageSha256':meta['packageSha256']}
                data['admin-transition.json']=encoded(note)
                meta['files']['baseline.json']=digest(data['baseline.json']);meta['files']['admin-transition.json']=digest(data['admin-transition.json'])
                meta['adminTrustTransition']={'intentSha256':intent_sha,'priorKitSha256':self.specs[role]['kitSha256'],'priorBaselineSha256':digest(original[role]['baseline.json'])}
                meta['reviewedBy']=meta['reviewedBy']+'; explicit administrator trust transition '+intent_sha
                data['kit.json']=encoded(meta);return data
            newkits['current']=revise('current',baseline)
            newreceipt['installedFileHashes']=installed
            archive_name=self.specs['current']['id']+'-'+str(int(intent_sha[:20],16))+'.tar.gz'
            archive_path=current.paths['archives']/archive_name
            require(not archive_path.exists(),'NEW_ARCHIVE_ALREADY_EXISTS')
            archive_data=self.archive(newkits['current'],release15,current.version)
            after[archive_path]=archive_data
            newreceipt['preservationReceipt']={'archive':str(archive_path),'archiveSha256':digest(archive_data),'readBackVerified':True}
            newreceipt['adminTrustTransition']={'intentSha256':intent_sha,'priorReceiptSha256':digest(self.read(current.receipt,user=True)),'priorPreservationReceipt':oldreceipt['preservationReceipt'],'codeOnly':True}
            after[current.receipt]=encoded(newreceipt)
            next_baseline=self.next_baseline(self.public/self.specs['current']['id'],json.loads(newkits['current']['kit.json']),baseline,release15,newreceipt,digest(newkits['current']['kit.json']),current.receipt)
            for role in ('primary','recovery'):newkits[role]=revise(role,next_baseline)
            lineage={}
            for role,data in newkits.items():
                cid=self.specs[role]['id']
                snapshot=self.work/'original-kits'/cid;self.mkdir(snapshot)
                for name,raw in original[role].items():self.atomic(snapshot/name,raw,self.owner,os.getgid(),0o600)
                for parent in [self.public,self.state/'vault',self.state/'incoming']:
                    for name in ('baseline.json','kit.json','admin-transition.json'):after[parent/cid/name]=data[name]
                lineage[cid]={'priorKitSha256':self.specs[role]['kitSha256'],'priorBaselineSha256':digest(original[role]['baseline.json']),'kitSha256':digest(data['kit.json']),'baselineSha256':digest(data['baseline.json']),'packageSha256':self.specs[role]['packageSha256'],'sourceCommit':self.specs[role]['sourceCommit']}
            catalog=self.record(self.catalog)
            for entry in catalog['candidates']:
                if entry['id'] in lineage:entry['kitSha256']=lineage[entry['id']]['kitSha256']
            after[self.catalog]=encoded(catalog)
            newpolicy=copy.deepcopy(policy)
            for path,data in after.items():
                if str(path) in newpolicy['assets']:newpolicy['assets'][str(path)]=digest(data)
            old_runtime={name:digest(original['current'][name]) for name in RUNTIME};new_runtime={name:digest(original['primary'][name]) for name in RUNTIME}
            newpolicy['runtimeHashes']=new_runtime
            newpolicy['currentRuntimeHashes']=[old_runtime] if old_runtime==new_runtime else [old_runtime,new_runtime]
            # All fixed root execution assets stay in the existing policy map.
            require(all(str(self.p(p)) in newpolicy['assets'] for p in EXECUTABLES),'POLICY_ASSET_MISSING')
            for name in RUNTIME:require(newpolicy['assets'].get(str(self.library/name))==new_runtime[name],'POLICY_ASSET_MISSING')
            after[self.policy_path]=encoded(newpolicy)
            newmarker=copy.deepcopy(marker);newmarker['policySha256']=digest(after[self.policy_path])
            for path,data in after.items():
                if str(path) in newmarker.get('assets',{}):newmarker['assets'][str(path)]['sha256']=digest(data)
            require(str(self.policy_path) in newmarker.get('assets',{}),'POLICY_MARKER_MISSING')
            newmarker['adminTrustTransition']={'intentSha256':intent_sha,'priorPolicySha256':digest(self.read(self.policy_path)),'priorInstallationSha256':digest(self.read(self.marker))}
            after[self.marker]=encoded(newmarker)
            after={p:raw for p,raw in after.items() if not p.exists() or digest(self.read(p,user=True))!=digest(raw)}
            # Entry binaries first, before any policy/trust changes; old suspended
            # entrypoints must be gone before progressing beyond that boundary.
            ordered=[self.p(p) for p in EXECUTABLES]+sorted(p for p in after if p not in {self.p(q) for q in EXECUTABLES})
            for path in ordered:
                raw=after[path];old=self.put(path,raw,uid=self.uid if path==archive_path else self.owner,gid=self.gid if path==archive_path else os.getgid(),mode=0o600 if path==archive_path else 0o644)
                if old is not None:self.store('before',old)
                self.store('after',raw)
            plan={'format':FORMAT,'intent':intent,'intentSha256':intent_sha,'service':service,'activity':activity,'failedProof':binding,'originalFailure':failure_snapshots,'lineage':lineage,'targets':self.targets,'observed':{p:v for p,v in self.observed.items() if not Path(p).is_relative_to(self.work)},'order':[str(p) for p in ordered]}
            self.save('plan.json',plan)
            self.save('review-template.json',{'format':FORMAT,'planSha256':digest(encoded(plan)),'executionClosureReviewed':False,'reviewedBy':''})
            return {'prepared':True,'planSha256':digest(encoded(plan)),'intentSha256':intent_sha,'targetCount':len(after),'operatingChanged':False}

    def reviewed(self):
        plan=self.record(self.work/'plan.json');review=self.record(self.work/'review.json')
        require(plan.get('format')==review.get('format')==FORMAT and review.get('planSha256')==digest(encoded(plan)) and review.get('executionClosureReviewed') is True and isinstance(review.get('reviewedBy'),str) and bool(review['reviewedBy'].strip()),'TRANSITION_REVIEW_REQUIRED')
        require(set(plan['lineage'])=={s['id'] for s in self.specs.values()},'TRANSITION_SCOPE_CHANGED')
        allowed={self.p(p) for p in EXECUTABLES}|{self.library/n for n in RUNTIME}|{self.catalog,self.policy_path,self.marker}
        for spec in self.specs.values():
            for parent in [self.public,self.state/'vault',self.state/'incoming']:
                allowed.update(parent/spec['id']/n for n in ('baseline.json','kit.json','admin-transition.json'))
        revision=self.specs['current']['version'].rsplit('.',1)[1]
        allowed.add(self.p('/home/daniel/.agentmemory/personal-deployment-daniel'+revision+'/activation.json'))
        allowed.add(self.p('/home/daniel/.agentmemory-code-archives')/(self.specs['current']['id']+'-'+str(int(plan['intentSha256'][:20],16))+'.tar.gz'))
        actual=set(map(Path,plan['targets']))
        require(allowed-{self.library/n for n in RUNTIME} <= actual <= allowed and set(plan['order'])==set(plan['targets']) and len(plan['order'])==len(plan['targets']),'TRANSITION_SCOPE_CHANGED')
        return plan,review

    def target_state(self,path,item):
        path=Path(path)
        if not path.exists() and not path.is_symlink():return 'before' if item['beforeSha256'] is None else 'unknown'
        raw=self.read(path,user=True);st=path.stat()
        if (st.st_uid,st.st_gid,stat.S_IMODE(st.st_mode))!=(item['uid'],item['gid'],item['mode']):return 'unknown'
        sha=digest(raw)
        if sha==item['afterSha256']:return 'after'
        if sha==item['beforeSha256']:return 'before'
        return 'unknown'

    def unchanged(self,plan):
        for path,expected in plan['observed'].items():
            if path in plan['targets']:continue
            self.hash_observe(path,expected['sha256']);st=Path(path).stat()
            require(self.observed[path]['sha256']==expected['sha256'] and (stat.S_IMODE(st.st_mode),st.st_uid,st.st_gid)==(expected['mode'],expected['uid'],expected['gid']),'UNCHANGED_DEPENDENCY_CHANGED')
        require(self.service_identity()==plan['service'] and self.activity()==plan['activity'],'TRANSITION_STATE_ADVANCED')
        self.inactive_updates()

    def verify(self,plan):
        manager=self.manager()
        for spec in self.specs.values():
            cid=spec['id'];meta=next(c for c in manager.catalog() if c['id']==cid)
            for parent in [self.public,self.state/'vault',self.state/'incoming']:manager.checked_kit(parent/cid,meta['kitSha256'])
        current=self.runtime(self.specs['current']['id']);current.guard()
        for role in ('primary','recovery'):
            runtime=self.runtime(self.specs[role]['id']);runtime.guard(before=True)
        helper=self.enrollment_module();policy=helper.load_policy(self.policy_path,owner=self.owner,anchor=self.root)
        next_base=helper.current_baseline(policy,owner=self.owner,anchor=self.root,runtime_paths=current.paths)
        require(all(self.record(self.public/self.specs[r]['id']/'baseline.json')==next_base for r in ('primary','recovery')),'NEXT_BASELINE_MISMATCH')

    def apply(self, fault=None):
        with self.locks():
            plan,review=self.reviewed()
            if (self.work/'receipt.json').exists():
                receipt=self.record(self.work/'receipt.json');require(receipt.get('committed') is True and receipt.get('planSha256')==digest(encoded(plan)),'TRANSITION_STATE_UNCERTAIN')
                require(all(self.target_state(p,v)=='after' for p,v in plan['targets'].items()),'TRANSITION_STATE_ADVANCED')
                self.verify(plan)
                self.save('receipt.json',receipt)
                self.save('journal.json',{'phase':'committed','planSha256':digest(encoded(plan))})
                return {'alreadyCommitted':True,'serviceControlled':False}
            require(not (self.work/'journal.json').exists(),'TRANSITION_INSPECTION_REQUIRED')
            self.unchanged(plan);self.process_exclusion()
            require(all(self.target_state(p,v)=='before' for p,v in plan['targets'].items()),'TRANSITION_ORIGINAL_CHANGED')
            self.runtime(self.specs['current']['id']).guard();self.save('journal.json',{'phase':'applying','planSha256':digest(encoded(plan))})
            try:
                for index,path in enumerate(plan['order']):
                    item=plan['targets'][path];raw=self.read(self.work/'after'/item['afterSha256'])
                    require(digest(raw)==item['afterSha256'],'STAGED_BYTES_CHANGED')
                    require(self.target_state(path,item)=='before','TRANSITION_TARGET_CHANGED')
                    self.atomic(Path(path),raw,item['uid'],item['gid'],item['mode'])
                    if fault:fault(index,path)
                    if index==len(EXECUTABLES)-1:self.process_exclusion()
                self.unchanged(plan);self.process_exclusion();self.verify(plan)
                require(all(self.target_state(p,v)=='after' for p,v in plan['targets'].items()),'TRANSITION_READBACK_FAILED')
                receipt={'format':FORMAT,'committed':True,'intentSha256':plan['intentSha256'],'planSha256':digest(encoded(plan)),'reviewedBy':review['reviewedBy'],'reviewSha256':digest(encoded(review)),'failedProof':plan['failedProof'],'originalFailure':plan['originalFailure'],'lineage':plan['lineage'],'serviceControlled':False,'dataChanged':False}
                self.save('receipt.json',receipt);self.save('journal.json',{'phase':'committed','planSha256':digest(encoded(plan))})
                return {'committed':True,'serviceControlled':False,'dataChanged':False}
            except BaseException:
                # A commit-marker fsync failure is uncertain. Never remove a
                # marker or roll back code that might already be committed.
                if (self.work/'receipt.json').exists():raise RuntimeError('TRANSITION_COMMIT_UNCONFIRMED') from None
                self.restore_locked(plan);raise

    def restore_locked(self,plan):
        self.unchanged(plan);self.process_exclusion()
        states={p:self.target_state(p,v) for p,v in plan['targets'].items()}
        require(all(s in ('before','after') for s in states.values()),'TRANSITION_UNKNOWN_BYTES')
        self.save('journal.json',{'phase':'restoring','planSha256':digest(encoded(plan))})
        for path in reversed(plan['order']):
            item=plan['targets'][path]
            if states[path]=='before':continue
            if item['beforeSha256'] is None:
                os.unlink(path);fd=os.open(Path(path).parent,os.O_RDONLY|os.O_DIRECTORY)
                try:os.fsync(fd)
                finally:os.close(fd)
            else:
                raw=self.read(self.work/'before'/item['beforeSha256']);require(digest(raw)==item['beforeSha256'],'SNAPSHOT_CHANGED')
                self.atomic(Path(path),raw,item['uid'],item['gid'],item['mode'])
        self.process_exclusion()
        require(all(self.target_state(p,v)=='before' for p,v in plan['targets'].items()),'TRANSITION_RESTORE_UNVERIFIED')
        self.runtime(self.specs['current']['id']).guard()
        self.save('journal.json',{'phase':'restored','planSha256':digest(encoded(plan))})
        return {'restored':True,'serviceControlled':False,'dataChanged':False}

    def restore(self):
        with self.locks():
            plan,_=self.reviewed();require(not (self.work/'receipt.json').exists(),'COMMITTED_TRANSITION_RESTORE_REFUSED')
            return self.restore_locked(plan)


def main():
    require(os.geteuid()==0,'ROOT_REQUIRED')
    require(sys.argv[1:] in (['--prepare'],['--apply'],['--restore'],['--check']),'ARGUMENTS_REFUSED')
    t=Transition();t.trusted(Path(__file__).absolute());require(Path(__file__).absolute().parent==t.bundle,'FIXED_REVIEWED_BUNDLE_REQUIRED')
    source=t.record(t.bundle/'source-review.json')
    require(source.get('executionClosureReviewed') is True and isinstance(source.get('reviewedBy'),str) and bool(source['reviewedBy'].strip()),'SOURCE_REVIEW_REQUIRED')
    names={'admin-trust-transition.py','dashboard-updates.py','candidate-enrollment.py'}
    require(set(source.get('files',{}))==names and all(digest(t.read(t.bundle/n))==source['files'][n] for n in names),'SOURCE_REVIEW_CHANGED')
    if sys.argv[1]=='--prepare':result=t.prepare()
    elif sys.argv[1]=='--apply':result=t.apply()
    elif sys.argv[1]=='--restore':result=t.restore()
    else:
        with t.locks():
            plan,_=t.reviewed();t.unchanged(plan);result={'reviewed':True,'targets':len(plan['targets']),'installed':False}
    print(json.dumps(result))

if __name__=='__main__':
    try:main()
    except BaseException as error:
        text=str(error);print(json.dumps({'errorCode':text if text.replace('_','').isalnum() and len(text)<=80 else 'TRUST_TRANSITION_FAILED','serviceControlled':False}));sys.exit(1)
