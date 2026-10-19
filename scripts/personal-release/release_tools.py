#!/usr/bin/env python3
"""Read-only guards and code-only preservation. Never controls a service or restores data."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import uuid


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def safe(base, name):
    relative = Path(name)
    if not name or relative.is_absolute() or '..' in relative.parts:
        raise RuntimeError('UNSAFE_PATH')
    base = Path(base).resolve()
    path = base / relative
    if path.is_symlink() or not path.resolve().is_relative_to(base) or not path.is_file():
        raise RuntimeError('UNSAFE_PATH')
    return path


def verify(root, installed=None, baseline=False):
    root = Path(root)
    manifest = json.loads((root / 'release.json').read_text())
    hashes = manifest['artifactHashes']
    if not hashes or hashes != manifest['verificationFiles']:
        raise RuntimeError('ARTIFACT_TABLE_MISMATCH')
    for name, expected in hashes.items():
        if sha(safe(root, name)) != expected:
            raise RuntimeError('ARTIFACT_HASH_MISMATCH')
    if installed:
        for name, expected in manifest['packageFiles'].items():
            if sha(safe(installed, name)) != expected:
                raise RuntimeError('INSTALLED_HASH_MISMATCH')
        actual = {str(p.relative_to(installed)) for p in Path(installed).rglob('*') if p.is_file() and 'node_modules' not in p.relative_to(installed).parts}
        if actual != set(manifest['packageFiles']):
            raise RuntimeError('INSTALLED_FILE_SET_MISMATCH')
    if baseline:
        for path, expected in manifest['baselineHashes'].items():
            if Path(path).is_symlink() or sha(path) != expected:
                raise RuntimeError('BASELINE_CHANGED')
    return {'verified': True, 'artifacts': len(hashes), 'applied': False, 'deployable': manifest.get('deployable', False)}


def preserve(root, destination, installed=None, baseline=False):
    verify(root, installed, baseline)
    root = Path(root)
    manifest = json.loads((root / 'release.json').read_text())
    files = {name: safe(root, name) for name in manifest['artifactHashes']}
    files['release.json'] = root / 'release.json'
    if installed:
        files.update({'installed/' + name: safe(installed, name) for name in manifest['packageFiles']})
    for name in files:
        if any(part in {'.env', 'state_store.db', 'hook-outbox', 'feedback', 'node_modules'} for part in Path(name).parts):
            raise RuntimeError('PRIVATE_PATH_REFUSED')
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    archive = destination / ('code-' + uuid.uuid4().hex + '.tar.gz')
    expected = {}
    with archive.open('xb') as output:
        os.chmod(archive, 0o600)
        with tarfile.open(fileobj=output, mode='w:gz') as tar:
            for name, path in files.items():
                data = path.read_bytes()
                expected[name] = hashlib.sha256(data).hexdigest()
                entry = tarfile.TarInfo(name)
                entry.mode = 0o600
                entry.size = len(data)
                tar.addfile(entry, io.BytesIO(data))
        output.flush()
        os.fsync(output.fileno())
    with tarfile.open(archive) as tar:
        if set(tar.getnames()) != set(files):
            raise RuntimeError('ARCHIVE_SET_MISMATCH')
        for name, expected_hash in expected.items():
            if hashlib.sha256(tar.extractfile(name).read()).hexdigest() != expected_hash:
                raise RuntimeError('ARCHIVE_READBACK_MISMATCH')
    verify(root, installed, baseline)
    return {'archive': str(archive), 'archiveSha256': sha(archive), 'entries': len(files), 'readBackVerified': True, 'dataIncluded': False, 'applied': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'preserve'])
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--installed', type=Path)
    parser.add_argument('--baseline', action='store_true')
    parser.add_argument('--destination', type=Path)
    args = parser.parse_args()
    if args.action == 'preserve' and not args.destination:
        parser.error('--destination is required')
    result = verify(args.root, args.installed, args.baseline) if args.action == 'check' else preserve(args.root, args.destination, args.installed, args.baseline)
    print(json.dumps(result))
