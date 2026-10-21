#!/usr/bin/python3 -I
"""Build an unapproved kit as the service user; never installs or enrolls it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil

HERE = Path(__file__).resolve().parent
RUNTIME_FILES = ('kit-runtime.py', 'kit-queues.py', 'kit-integrity.py')


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def emit(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=True) + '\n')


def prepare(package, release, baseline, metadata, out):
    if sha(package) != metadata['packageSha256']:
        raise RuntimeError('PACKAGE_HASH_MISMATCH')
    out = Path(out)
    out.mkdir(mode=0o700)  # Existing drafts and issued candidates are immutable.
    for name in RUNTIME_FILES:
        shutil.copyfile(HERE / name, out / name)
    shutil.copyfile(package, out / 'package.tgz')
    emit(out / 'release.json', release)
    emit(out / 'baseline.json', baseline)
    files = {path.name: sha(path) for path in out.iterdir()}
    kit = {**metadata, 'entrypoint': 'kit-runtime.py', 'files': files,
           'executionClosureReviewed': False, 'reviewedBy': ''}
    emit(out / 'kit.json', kit)
    emit(out / 'review-template.json', {
        'executionClosureReviewed': False, 'reviewedBy': '',
        'draftManifestSha256': sha(out / 'kit.json'),
        'reviewInstructions': 'Review every runtime/import/command and baseline, then place this evidence in a root-owned path. Approval is never inferred.'})
    return {'draft': str(out), 'approved': False, 'installed': False, 'enrolled': False}


def baseline(config_path, release_path, receipt_path):
    config_path, release_path, receipt_path = map(Path, (config_path, release_path, receipt_path))
    config = json.loads(config_path.read_text())
    release = json.loads(release_path.read_text())
    receipt = json.loads(receipt_path.read_text())
    if config['artifactHashes'] != config['verificationFiles'] or receipt.get('applied') is not True or receipt.get('installedFileHashes') != config['postHashes']:
        raise RuntimeError('BASELINE_NOT_VERIFIED')
    protected = {**config['postHashes'], **config['dependencies']}
    for name, digest in config['artifactHashes'].items():
        path = config_path.parent / name
        if path.name != name or sha(path) != digest:
            raise RuntimeError('BASELINE_ARTIFACT_CHANGED')
        protected[str(path)] = digest
    protected[str(config_path)] = sha(config_path)
    for name, digest in release['artifactHashes'].items():
        path = release_path.parent / name
        if path.is_symlink() or not path.resolve().is_relative_to(release_path.parent.resolve()) or sha(path) != digest:
            raise RuntimeError('BASELINE_ARTIFACT_CHANGED')
        protected[str(path)] = digest
    protected[str(release_path)] = sha(release_path)
    preservation = receipt['preservationReceipt']
    expected = {**release['artifactHashes'], 'release.json': sha(release_path),
                **{'installed/' + name: digest for name, digest in release['packageFiles'].items()}}
    names = [*config['artifactHashes'], 'deployment.json', 'proof.json']
    archives = [
        {'path': preservation['candidate']['archive'], 'sha256': preservation['candidate']['archiveSha256'], 'files': expected},
        {'path': preservation['operationsArchive'], 'sha256': preservation['operationsArchiveSha256'],
         'files': {name: sha(config_path.parent / name) for name in names}},
    ]
    return {'installed': config['installed'], 'protectedFiles': protected,
            'archives': archives, 'receiptPath': str(receipt_path),
            'receiptIdentity': {name: receipt[name] for name in ('applied', 'candidateHash', 'sourceCommit', 'installedFileHashes')},
            'clientsRetainedAt': config.get('clientsRetainedAt', config['installed']),
            'compatibilityFiles': {name: digest for name, digest in release['packageFiles'].items() if name.startswith('plugin/scripts/codex-compat/')},
            'rootAssets': {name: config['postHashes'][name] for name in (
                '/usr/local/libexec/agentmemory-update-request', '/usr/local/libexec/agentmemory-update-runner',
                '/etc/systemd/system/agentmemory-update@.service', '/etc/systemd/system/agentmemory-update-recovery.service',
                '/etc/sudoers.d/agentmemory-dashboard-updates')}}


def baseline_from_kit(kit_path, receipt_path):
    """Subsequent updates consume only JSON and hashes, never old Python."""
    kit_path, receipt_path = Path(kit_path), Path(receipt_path)
    kit = json.loads((kit_path / 'kit.json').read_text())
    prior = json.loads((kit_path / 'baseline.json').read_text())
    release = json.loads((kit_path / 'release.json').read_text())
    receipt = json.loads(receipt_path.read_text())
    if receipt.get('applied') is not True or receipt.get('candidateHash') != kit['packageSha256'] or receipt.get('sourceCommit') != kit['sourceCommit']:
        raise RuntimeError('BASELINE_NOT_VERIFIED')
    protected = dict(receipt['installedFileHashes'])
    protected.update({str(kit_path / name): digest for name, digest in kit['files'].items()})
    protected[str(kit_path / 'kit.json')] = sha(kit_path / 'kit.json')
    for name, digest in protected.items():
        if Path(name).is_symlink() or sha(name) != digest:
            raise RuntimeError('BASELINE_ARTIFACT_CHANGED')
    preservation = receipt['preservationReceipt']
    expected = {**{'runtime/' + name: sha(kit_path / name) for name in ('kit.json', *kit['files'])},
                **{'installed/' + name: digest for name, digest in release['packageFiles'].items()}}
    compatibility = {name:digest for name,digest in release['packageFiles'].items() if name.startswith('plugin/scripts/codex-compat/')}
    return {**prior, 'compatibilityFiles': compatibility, 'protectedFiles': protected, 'receiptPath': str(receipt_path),
            'receiptIdentity': {name: receipt[name] for name in ('applied', 'candidateHash', 'sourceCommit', 'installedFileHashes')},
            'archives': [*prior['archives'], {'path': preservation['archive'], 'sha256': preservation['archiveSha256'], 'files': expected}]}


def main():
    if os.geteuid() == 0:
        raise RuntimeError('PREPARATION_MUST_NOT_RUN_AS_ROOT')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--baseline-config', type=Path)
    group.add_argument('--baseline-kit', type=Path)
    parser.add_argument('--baseline-release', type=Path)
    parser.add_argument('--baseline-receipt', type=Path, required=True)
    parser.add_argument('--metadata', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    release = json.loads((args.candidate / 'release.json').read_text())
    if release['artifactHashes'] != release['verificationFiles']:
        raise RuntimeError('ARTIFACT_TABLE_MISMATCH')
    for name, digest in release['artifactHashes'].items():
        path = args.candidate / name
        if path.is_symlink() or not path.resolve().is_relative_to(args.candidate.resolve()) or sha(path) != digest:
            raise RuntimeError('ARTIFACT_HASH_MISMATCH')
    metadata = json.loads(args.metadata.read_text())
    if metadata['version'] != release['packageVersion'] or metadata['sourceCommit'] != release['sourceCommit']:
        raise RuntimeError('CANDIDATE_IDENTITY_MISMATCH')
    if args.baseline_config and not args.baseline_release:
        parser.error('--baseline-config requires --baseline-release')
    prior = baseline_from_kit(args.baseline_kit, args.baseline_receipt) if args.baseline_kit else baseline(args.baseline_config, args.baseline_release, args.baseline_receipt)
    print(json.dumps(prepare(args.candidate / 'agentmemory.tgz', release, prior, metadata, args.out)))


if __name__ == '__main__':
    main()
