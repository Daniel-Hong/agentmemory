#!/usr/bin/python3 -I
"""Administrator-only addon installer. Run from an exact reviewed root snapshot."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SOURCES = ('candidate-enrollment.py','install-candidate-enrollment.py','enroll-reviewed-kit.py','prepare-dashboard-kit.py','kit-runtime.py','kit-queues.py','kit-integrity.py','agentmemory-candidate-enrollment.sudoers')


def require(value, code):
    if not value:
        raise RuntimeError(code)


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


def trusted(path, owner, root):
    require(path.is_absolute() and path.is_relative_to(root) and '..' not in path.parts,'INSTALL_PATH_UNTRUSTED')
    for p in (path,*path.parents):
        info=p.lstat()
        require(info.st_uid==owner and not info.st_mode&0o022 and not stat.S_ISLNK(info.st_mode),'INSTALL_PATH_UNTRUSTED')
        if p==root:return
    raise RuntimeError('INSTALL_PATH_UNTRUSTED')


def build_policy(helper, paths, *, source, root, owner):
    approved=helper.read_record(source/'policy-input.json')
    require(set(approved)=={'referenceKit','referenceKitSha256','delegatingReview','policyId'},'INVALID_INSTALL_POLICY')
    reference=Path(approved['referenceKit'])
    require(reference.parent==paths['publicKits'],'INVALID_INSTALL_POLICY')
    helper.trusted(reference,owner,root)
    runner=helper.load_module(paths['runner'],owner=owner,anchor=root)
    manager=runner.Runner(state=paths['state'],trusted_uid=owner,trust_anchor=root)
    entry=next((c for c in manager.catalog() if c['id']==reference.name and c['approved'] is True),None)
    require(entry is not None and entry['kitSha256']==approved['referenceKitSha256'],'REFERENCE_KIT_NOT_APPROVED')
    metadata=manager.checked_kit(reference,approved['referenceKitSha256'])
    runtime_hashes={n:sha(source/n) for n in helper.RUNTIME}
    require(all(metadata['files'].get(n)==h for n,h in runtime_hashes.items()),'ROOT_EXECUTION_POLICY_CHANGED')
    release=helper.read_record(reference/'release.json')
    legacy=helper.read_record(reference/'baseline.json')
    with tarfile.open(reference/'package.tgz') as tar:
        member=tar.getmember('package/package.json')
        require(member.isfile() and member.size<=65536,'PACKAGE_MANIFEST_INVALID')
        raw=tar.extractfile(member).read()
    require(hashlib.sha256(raw).hexdigest()==release['packageFiles']['package.json'],'PACKAGE_HASH_MISMATCH')
    package=helper.parse_json(raw)
    assets={str(target):sha(source/name) for name,target in paths['targets'].items()}
    require(set(legacy['rootAssets'])==set(str(root/p.lstrip('/')) for p in helper.load_module(source/'kit-runtime.py',owner=owner,anchor=root).ROOT_ASSETS),'ROOT_ASSET_SET_CHANGED')
    for name,expected in legacy['rootAssets'].items():
        helper.trusted(name,owner,root)
        require(sha(name)==expected,'ROOT_ASSET_CHANGED')
        assets[name]=expected
    policy={'schemaVersion':1,'policyId':approved['policyId'],'validatorVersion':'1','delegatingReview':approved['delegatingReview'],
            'requestUid':1000,'requestGid':1000,'assets':assets,'runtimeHashes':runtime_hashes,
            'packageContract':{k:package.get(k,{}) for k in ('dependencies','optionalDependencies','engines')},
            'extraArtifacts':sorted(n for n in release['artifactHashes'] if not n.startswith('package/') and n!='agentmemory.tgz'),
            'legacyBaseline':legacy,**{k:str(paths[k]) for k in ('library','runner','state','dropin','publicKits','archives')}}
    staged={**policy,'library':str(source)}
    runtime_paths = None
    if root != Path('/'):
        runtime_module = helper.load_module(source/'kit-runtime.py',owner=owner,anchor=root)
        runtime_paths = {k:root/v.lstrip('/') for k,v in runtime_module.DEFAULT_PATHS.items()}
        runtime_paths['rootfs'] = root
    helper.current_baseline(staged,owner=owner,anchor=root,runtime_paths=runtime_paths)
    return policy


def install(root=Path('/'), *, owner=0, gid=0, source=HERE, run=subprocess.run, policy_builder=build_policy):
    root,source=Path(root).absolute(),Path(source).absolute()
    trusted(source,owner,root)
    manifest=json.loads((source/'install-manifest.json').read_bytes())
    require(set(manifest)=={'files'} and set(manifest['files'])==set(SOURCES)|{'policy-input.json'},'INSTALL_SOURCE_CHANGED')
    require({p.name for p in source.iterdir()}==set(manifest['files'])|{'install-manifest.json'},'INSTALL_SOURCE_CHANGED')
    for name,expected in manifest['files'].items():
        p=source/name;trusted(p,owner,root)
        require(p.is_file() and sha(p)==expected,'INSTALL_SOURCE_CHANGED')
    spec=importlib.util.spec_from_file_location('approved_enrollment',source/'candidate-enrollment.py')
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    paths={k:root/v for k,v in {
        'library':'usr/local/lib/agentmemory-candidate-enrollment','runner':'usr/local/libexec/agentmemory-update-runner',
        'state':'var/lib/agentmemory-updates','dropin':'etc/systemd/system/agentmemory.service.d/90-personal.conf',
        'publicKits':'var/lib/agentmemory-updates/public/release-kits','archives':'home/daniel/.agentmemory-code-archives'}.items()}
    targets={'candidate-enrollment.py':root/'usr/local/libexec/agentmemory-candidate-enroll',
             'agentmemory-candidate-enrollment.sudoers':root/'etc/sudoers.d/agentmemory-candidate-enrollment'}
    targets.update({n:paths['library']/n for n in SOURCES if n not in targets})
    paths['targets']=targets
    policy=policy_builder(helper,paths,source=source,root=root,owner=owner)
    contents={target:((source/name).read_bytes(),0o440 if name.endswith('.sudoers') else 0o755 if name=='candidate-enrollment.py' else 0o644) for name,target in targets.items()}
    policy_path=root/'etc/agentmemory-candidate-enrollment/policy.json'
    contents[policy_path]=(helper.json_bytes(policy),0o644)
    def directory(path):
        current=root
        for part in path.relative_to(root).parts:
            current=current/part
            current.mkdir(mode=0o755,exist_ok=True)
            trusted(current,owner,root)
            require(current.is_dir(),'INSTALL_PATH_UNTRUSTED')
    for target,(data,mode) in contents.items():
        directory(target.parent)
        if target.exists() or target.is_symlink():
            trusted(target,owner,root)
            info=target.stat()
            require(stat.S_ISREG(info.st_mode) and info.st_gid==gid and stat.S_IMODE(info.st_mode)==mode and target.read_bytes()==data,'INSTALL_CONFLICT')
    permission=targets['agentmemory-candidate-enrollment.sudoers']
    already=permission.exists()
    def visudo(args):
        run(['/usr/sbin/visudo',*args],check=True,timeout=30,env=helper.ENV,cwd='/',stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    visudo(['-c','-f',str(source/'agentmemory-candidate-enrollment.sudoers')])
    visudo(['-c'])
    try:
        for target,(data,mode) in contents.items():
            if target==permission:continue
            if not target.exists():helper.atomic(target,data,mode)
            require(target.stat().st_uid==owner and target.stat().st_gid==gid and sha(target)==hashlib.sha256(data).hexdigest(),'INSTALL_READBACK_FAILED')
        if not permission.exists():helper.atomic(permission,contents[permission][0],0o440)
        visudo(['-c'])
        integrity={str(p):{'sha256':sha(p),'mode':stat.S_IMODE(p.stat().st_mode),'uid':p.stat().st_uid,'gid':p.stat().st_gid} for p in contents}
        receipt={'installed':True,'serviceControlled':False,'applied':False,'assets':integrity,'policySha256':sha(policy_path)}
        helper.atomic(policy_path.parent/'installation.json',helper.json_bytes(receipt),0o644)
        return receipt
    except BaseException:
        if not already and permission.exists():
            permission.unlink();helper.sync_directory(permission.parent)
        raise


def main():
    require(os.geteuid()==0 and len(sys.argv)==1,'ADMINISTRATOR_INSTALL_ONLY')
    os.umask(0o077)
    trusted(Path(__file__).absolute(),0,Path('/'))
    print(json.dumps(install(),sort_keys=True))


if __name__=='__main__':main()
