#!/usr/bin/python3 -I
"""One reviewed administrator repair for the exact v1 enrollment installation."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys

sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
OLD_POLICY='e373846fa41bac9d42f5324a14b7c755fe12d4006965eb94781f077e12a97b5f'
OLD_HELPER='58b628456015c9116803a76be1e33d30b624910c12416645a12971eccc51b611'


def require(value,code):
    if not value:raise RuntimeError(code)


def sha(raw):return hashlib.sha256(raw).hexdigest()


def trusted(path,owner,root):
    require(path.is_absolute() and path.is_relative_to(root) and '..' not in path.parts,'UNTRUSTED_REPAIR_PATH')
    for p in (path,*path.parents):
        info=p.lstat()
        require(info.st_uid==owner and not info.st_mode&0o022 and not stat.S_ISLNK(info.st_mode),'UNTRUSTED_REPAIR_PATH')
        if p==root:return
    raise RuntimeError('UNTRUSTED_REPAIR_PATH')


def repair(*,root=Path('/'),source=HERE,owner=0,gid=0,expected_policy_sha=OLD_POLICY,expected_helper_sha=OLD_HELPER):
    root,source=Path(root).absolute(),Path(source).absolute()
    trusted(source,owner,root)
    require({p.name for p in source.iterdir()}=={'repair-candidate-enrollment-mode.py','candidate-enrollment.py','repair-manifest.json'},'REPAIR_SOURCE_CHANGED')
    for p in source.iterdir():trusted(p,owner,root)
    new_helper=(source/'candidate-enrollment.py').read_bytes()
    manifest=json.loads((source/'repair-manifest.json').read_bytes())
    require(set(manifest)=={'newHelperSha256'} and sha(new_helper)==manifest['newHelperSha256'],'REPAIR_SOURCE_CHANGED')
    spec=importlib.util.spec_from_file_location('reviewed_helper',source/'candidate-enrollment.py')
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    target=root/'usr/local/libexec/agentmemory-candidate-enroll'
    policy_path=root/'etc/agentmemory-candidate-enrollment/policy.json'
    marker=policy_path.parent/'installation.json'
    backup=root/'var/lib/agentmemory-updates/private/enrollment-mode-repair-v1'
    current=root
    for part in backup.relative_to(root).parts:
        current=current/part;current.mkdir(mode=0o700,exist_ok=True);trusted(current,owner,root)
    require(stat.S_IMODE(backup.stat().st_mode)==0o700,'REPAIR_BACKUP_UNTRUSTED')
    sources={'old-policy.json':policy_path,'old-installation.json':marker,'old-helper.py':target}
    for name,p in sources.items():
        trusted(p,owner,root)
        saved=backup/name
        if not saved.exists():
            data=p.read_bytes()
            if name=='old-policy.json':require(sha(data)==expected_policy_sha,'UNEXPECTED_PRIOR_POLICY')
            elif name=='old-helper.py':require(sha(data)==expected_helper_sha,'UNEXPECTED_PRIOR_HELPER')
            else:require(json.loads(data)['policySha256']==expected_policy_sha,'UNEXPECTED_PRIOR_INSTALLATION')
            helper.atomic(saved,data)
        trusted(saved,owner,root)
    old_policy_raw=(backup/'old-policy.json').read_bytes();old_helper=(backup/'old-helper.py').read_bytes();old_marker_raw=(backup/'old-installation.json').read_bytes()
    require(sha(old_policy_raw)==expected_policy_sha and sha(old_helper)==expected_helper_sha,'REPAIR_BACKUP_CHANGED')
    policy=helper.parse_json(old_policy_raw);old_marker=helper.parse_json(old_marker_raw)
    require(old_marker['installed'] is True and old_marker['policySha256']==expected_policy_sha and old_marker['applied'] is False and old_marker['serviceControlled'] is False,'UNEXPECTED_PRIOR_INSTALLATION')
    require(old_marker['assets'][str(policy_path)]['sha256']==expected_policy_sha and old_marker['assets'][str(target)]['sha256']==expected_helper_sha,'UNEXPECTED_PRIOR_INSTALLATION')
    policy['assets'][str(target)]=sha(new_helper)
    policy['policyId']='enrollment-v1-'+sha(new_helper)[:12]
    policy['validatorVersion']='1.1'
    policy['delegatingReview']+='; administrator-reviewed umask077 public-directory repair'
    new_policy=helper.json_bytes(policy)
    new_marker=helper.parse_json(old_marker_raw)
    new_marker['assets'][str(target)]['sha256']=sha(new_helper)
    new_marker['assets'][str(policy_path)]['sha256']=sha(new_policy)
    new_marker['policySha256']=sha(new_policy)
    new_marker_raw=helper.json_bytes(new_marker)
    replacements={target:(old_helper,new_helper,0o755),policy_path:(old_policy_raw,new_policy,0o644),marker:(old_marker_raw,new_marker_raw,0o644)}
    for name,item in old_marker['assets'].items():
        p=Path(name);trusted(p,owner,root);info=p.stat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid==owner and info.st_gid==gid and stat.S_IMODE(info.st_mode)==item['mode'],'REPAIR_ASSET_CHANGED')
        if p not in replacements:require(sha(p.read_bytes())==item['sha256'],'REPAIR_ASSET_CHANGED')
    for name,expected in policy['assets'].items():
        p=Path(name);trusted(p,owner,root)
        if p!=target:require(sha(p.read_bytes())==expected,'REPAIR_ASSET_CHANGED')
    for p,(before,after,mode) in replacements.items():
        require(p.read_bytes() in (before,after),'REPAIR_ASSET_CHANGED')
    public=root/'var/lib/agentmemory-updates/public/enrollment'
    if public.exists() or public.is_symlink():
        trusted(public,owner,root)
        require(public.is_dir() and stat.S_IMODE(public.stat().st_mode) in (0o700,0o755),'REPAIR_PUBLIC_PATH_CHANGED')
        public.chmod(0o755);helper.sync_directory(public.parent)
    for p,(_,after,mode) in replacements.items():
        helper.atomic(p,after,mode)
        require(p.read_bytes()==after and p.stat().st_uid==owner and p.stat().st_gid==gid,'REPAIR_READBACK_FAILED')
    return new_marker


if __name__=='__main__':
    require(os.geteuid()==0 and len(sys.argv)==1,'ADMINISTRATOR_REPAIR_ONLY')
    os.umask(0o077)
    trusted(Path(__file__).absolute(),0,Path('/'))
    print(json.dumps(repair(),sort_keys=True))
