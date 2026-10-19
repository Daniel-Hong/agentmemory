#!/usr/bin/env python3
"""Freeze an already built, verified npm artifact; no install, update or activation."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
from release_tools import sha, verify, preserve


def prepare(package, out, baseline_activation, source_root):
    package, out, source_root = Path(package), Path(out), Path(source_root)
    if subprocess.check_output(['git','status','--porcelain'],cwd=source_root,text=True).strip():
        raise RuntimeError('SOURCE_NOT_CLEAN')
    commit = subprocess.check_output(['git','rev-parse','HEAD'],cwd=source_root,text=True).strip()
    tree = subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=source_root,text=True).strip()
    out.mkdir(mode=0o700)  # Never modify an already issued/frozen bundle.
    shutil.copyfile(package, out / 'agentmemory.tgz')
    target = out / 'package'
    target.mkdir()
    with tarfile.open(package) as tar:
        for member in tar:
            parts = Path(member.name).parts
            if not parts or parts[0] != 'package' or '..' in parts or member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                raise RuntimeError('UNSAFE_PACKAGE')
            relative = Path(*parts[1:])
            if not relative.parts:
                continue
            if any(p in {'.env', 'state_store.db', 'hook-outbox', 'node_modules'} for p in relative.parts):
                raise RuntimeError('PRIVATE_PACKAGE_CONTENT')
            path = target / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            if member.isfile():
                path.write_bytes(tar.extractfile(member).read())
                path.chmod(0o755 if member.mode & 0o111 else 0o644)
            else:
                path.mkdir(exist_ok=True)
    for name in ['release_tools.py', 'test_release_tools.py']:
        shutil.copyfile(Path(__file__).with_name(name), out / name)
    clients = out / 'clients'
    clients.mkdir()
    for name in ['README.md', 'AI-CLIENT-UPDATE.md']:
        shutil.copyfile(source_root / 'integrations/codex-compat' / name, clients / name)
    shutil.copyfile(source_root / 'docs/customizations/DEPLOYMENT-RUNBOOK.md', out / 'RUNBOOK.md')
    baseline = json.loads(Path(baseline_activation).read_text())
    hashes = baseline.get('installedFileHashes')
    if baseline.get('applied') is not True or not isinstance(hashes, dict) or not hashes:
        raise RuntimeError('BASELINE_RECEIPT_UNVERIFIED')
    package_files = {str(p.relative_to(target)): sha(p) for p in target.rglob('*') if p.is_file()}
    artifacts = {str(p.relative_to(out)): sha(p) for p in out.rglob('*') if p.is_file()}
    manifest = {'sourceCommit': commit, 'sourceTree': tree, 'revision': 'personal-source-deployment-preparation-v1', 'packageVersion': json.loads((target / 'package.json').read_text())['version'], 'applied': False, 'deployable': False, 'blockers': ['fresh_operating_guide_and_live_preflight_required', 'existing_preservation_guard_requires_reconciliation'], 'artifactHashes': artifacts, 'verificationFiles': artifacts.copy(), 'packageFiles': package_files, 'baselineHashes': hashes, 'baselineActivationHash': sha(baseline_activation), 'memoryPolicy': 'manual_review_only', 'rollback': 'code_only_keep_latest_data'}
    (out / 'release.json').write_text(json.dumps(manifest, indent=2) + '\n')
    verify(out)
    receipt = preserve(out, out.parent / (out.name + '-archives'))
    return {'candidate': str(out), 'packageSha256': sha(package), 'preservation': receipt, 'applied': False, 'deployable': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--baseline-activation', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.package, args.out, args.baseline_activation, Path(__file__).resolve().parents[2])))
