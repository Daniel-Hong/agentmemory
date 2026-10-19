#!/usr/bin/python3 -I
"""Root-owned bootstrap: freeze an explicitly reviewed snapshot, then enroll only."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

STATE = Path('/var/lib/agentmemory-updates')
RUNNER = Path('/usr/local/libexec/agentmemory-update-runner')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}


def require(value, code):
    if not value:
        raise RuntimeError(code)


def trusted(path, owner=0, anchor=Path('/')):
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts and path.is_relative_to(anchor), 'ROOT_OWNED_PATH_REQUIRED')
    for current in (path, *path.parents):
        info = current.lstat()
        require(info.st_uid == owner and not info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode), 'ROOT_OWNED_PATH_REQUIRED')
        if current == anchor:
            return
    raise RuntimeError('ROOT_OWNED_PATH_REQUIRED')


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read_review(path, owner=0, anchor=Path('/')):
    trusted(path, owner, anchor)
    value = json.loads(Path(path).read_text())
    require(value.get('executionClosureReviewed') is True and isinstance(value.get('reviewedBy'), str) and bool(value['reviewedBy'].strip()), 'ADMINISTRATOR_REVIEW_REQUIRED')
    require(re.fullmatch('[a-f0-9]{64}', value.get('draftManifestSha256', '')) is not None, 'ADMINISTRATOR_REVIEW_REQUIRED')
    return value


def read_file(path, digest):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'DRAFT_FILE_INVALID')
        data = stream.read()
    require(hashlib.sha256(data).hexdigest() == digest, 'REVIEWED_SNAPSHOT_CHANGED')
    return data


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish(parent, name, contents, mode, owner, anchor):
    destination = parent / name
    if destination.exists() or destination.is_symlink():
        trusted(destination, owner, anchor)
        require({p.name for p in destination.iterdir()} == set(contents), 'SNAPSHOT_CHANGED')
        for filename, data in contents.items():
            trusted(destination / filename, owner, anchor)
            require(sha(destination / filename) == hashlib.sha256(data).hexdigest(), 'SNAPSHOT_CHANGED')
        return destination
    with tempfile.TemporaryDirectory(prefix='.snapshot-', dir=parent) as temporary:
        staged = Path(temporary)
        staged.chmod(0o755 if mode == 0o644 else 0o700)
        for filename, data in contents.items():
            with (staged / filename).open('xb') as output:
                os.fchmod(output.fileno(), mode)
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
        sync_directory(staged)
        staged.rename(destination)
        sync_directory(parent)
    return destination


def install(draft, review_path, *, state=STATE, runner=RUNNER, owner=0, anchor=Path('/'), run=subprocess.run):
    draft = Path(draft)
    review = read_review(review_path, owner, anchor)
    raw = read_file(draft / 'kit.json', review['draftManifestSha256'])
    kit = json.loads(raw)
    require(re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,79}', kit.get('id', '')) is not None, 'INVALID_CANDIDATE')
    require(kit.get('entrypoint') == 'kit-runtime.py' and kit.get('executionClosureReviewed') is False, 'INVALID_DRAFT')
    trusted(state, owner, anchor)
    trusted(runner, owner, anchor)
    contents = {}
    for name, digest in kit['files'].items():
        relative = Path(name)
        require(relative.name == name and not name.startswith('.') and name not in ('kit.json', 'review-evidence.json'), 'UNSAFE_KIT_PATH')
        contents[name] = read_file(draft / name, digest)
    evidence = (json.dumps(review, sort_keys=True) + '\n').encode()
    contents['review-evidence.json'] = evidence
    kit['files']['review-evidence.json'] = hashlib.sha256(evidence).hexdigest()
    kit.update(executionClosureReviewed=review['executionClosureReviewed'], reviewedBy=review['reviewedBy'])
    contents['kit.json'] = (json.dumps(kit, sort_keys=True) + '\n').encode()
    lock = os.open(state / 'kit-bootstrap.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(lock)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == owner and not info.st_mode & 0o077, 'UNSAFE_LOCK')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        incoming = state / 'incoming'
        incoming.mkdir(mode=0o700, exist_ok=True)
        trusted(incoming, owner, anchor)
        destination = publish(incoming, kit['id'], contents, 0o600, owner, anchor)
        public_parent = state / 'public'
        trusted(public_parent, owner, anchor)
        public = public_parent / 'release-kits'
        public.mkdir(mode=0o755, exist_ok=True)
        trusted(public, owner, anchor)
        public.chmod(0o755)
        publish(public, kit['id'], contents, 0o644, owner, anchor)
        run(['/usr/bin/python3', '-I', '-B', str(runner), '--enroll', str(destination)], check=True,
            env=ENV, cwd='/', stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    finally:
        os.close(lock)
    return {'enrolled': True, 'applied': False, 'serviceControlled': False, 'candidateId': kit['id']}


def main():
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    trusted(Path(__file__).absolute())  # Refuse root execution of a user-owned bootstrap.
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--draft', type=Path, required=True)
    parser.add_argument('--review', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(install(args.draft, args.review)))


if __name__ == '__main__':
    main()
