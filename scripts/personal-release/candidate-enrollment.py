#!/usr/bin/python3 -I
"""Fixed-policy candidate enrollment; never controls a service or executes input code."""
import contextlib
import datetime
import fcntl
import gzip
import hashlib
import importlib.util
from importlib.machinery import SourceFileLoader
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid

sys.dont_write_bytecode = True
POLICY = Path('/etc/agentmemory-candidate-enrollment/policy.json')
STATE = Path('/var/lib/agentmemory-updates')
SPOOL = Path('/home/daniel/.agentmemory/candidate-enrollment')
HELPER = Path('/usr/local/libexec/agentmemory-candidate-enroll')
LIBRARY = Path('/usr/local/lib/agentmemory-candidate-enrollment')
RUNNER = Path('/usr/local/libexec/agentmemory-update-runner')
RUNTIME = ('kit-runtime.py', 'kit-queues.py', 'kit-integrity.py')
DRAFT = frozenset((*RUNTIME, 'kit.json', 'release.json', 'baseline.json', 'package.tgz', 'review-template.json'))
MIB = 1024 * 1024
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}


def require(value, code):
    if not value:
        raise RuntimeError(code)


def request_id(value):
    require(isinstance(value, str), 'INVALID_REQUEST')
    try:
        require(str(uuid.UUID(value)) == value, 'INVALID_REQUEST')
    except ValueError:
        raise RuntimeError('INVALID_REQUEST') from None
    return value


def digest(data):
    return hashlib.sha256(data).hexdigest()


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False) + '\n').encode()


def parse_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'INVALID_JSON')
            result[key] = value
        return result
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: require(False, 'INVALID_JSON'))
        require(isinstance(value, dict), 'INVALID_JSON')
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise RuntimeError('INVALID_JSON') from None


def trusted(path, owner=0, anchor=Path('/')):
    path, anchor = Path(path), Path(anchor)
    require(path.is_absolute() and path.is_relative_to(anchor) and '..' not in path.parts, 'UNTRUSTED_PATH')
    for current in (path, *path.parents):
        info = current.lstat()
        require(info.st_uid == owner and not info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode), 'UNTRUSTED_PATH')
        if current == anchor:
            return
    raise RuntimeError('UNTRUSTED_PATH')


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(path, data, mode=0o600):
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix='.enrollment-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextlib.contextmanager
def open_directory(path):
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts, 'UNSAFE_INPUT')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_uid, info.st_mode, info.st_nlink)


def copy_input(directory, name, target, limit, request_uid):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == request_uid and before.st_nlink == 1 and not before.st_mode & 0o077, 'UNSAFE_INPUT')
        require(before.st_size <= limit, 'INPUT_TOO_LARGE')
        count = 0
        with Path(target).open('xb') as output:
            os.fchmod(output.fileno(), 0o600)
            while True:
                data = os.read(fd, min(MIB, limit - count + 1))
                if not data:
                    break
                count += len(data)
                require(count <= limit, 'INPUT_TOO_LARGE')
                output.write(data)
            output.flush()
            os.fsync(output.fileno())
        require(count == before.st_size and signature(before) == signature(os.fstat(fd)), 'INPUT_CHANGED')
        require(signature(before) == signature(os.stat(name, dir_fd=directory, follow_symlinks=False)), 'INPUT_CHANGED')
        return count
    finally:
        os.close(fd)


def snapshot_request(spool, request_id_value, destination, *, request_uid=1000):
    request_id(request_id_value)
    destination = Path(destination)
    destination.mkdir(mode=0o700, exist_ok=True)
    with open_directory(Path(spool)) as parent:
        info = os.fstat(parent)
        require(info.st_uid == request_uid and not info.st_mode & 0o077, 'UNSAFE_INPUT')
        with contextlib.ExitStack() as stack:
            req = os.open(request_id_value, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            stack.callback(os.close, req)
            draft = os.open('draft', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=req)
            stack.callback(os.close, draft)
            initial = [os.fstat(fd) for fd in (req, draft)]
            require(all(i.st_uid == request_uid and not i.st_mode & 0o077 for i in initial), 'UNSAFE_INPUT')
            require(set(os.listdir(req)) == {'request.json', 'draft'} and set(os.listdir(draft)) == DRAFT, 'INPUT_FILE_SET_CHANGED')
            copy_input(req, 'request.json', destination / 'request.json', 16 * 1024, request_uid)
            request = parse_json((destination / 'request.json').read_bytes())
            require(set(request) == {'requestId', 'candidateId', 'draftManifestSha256'} and request['requestId'] == request_id_value, 'INVALID_REQUEST')
            require(isinstance(request['candidateId'], str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,79}', request['candidateId']), 'INVALID_REQUEST')
            require(is_hash(request['draftManifestSha256']), 'INVALID_REQUEST')
            out = destination / 'draft'
            out.mkdir(mode=0o700)
            total = (destination / 'request.json').stat().st_size
            for name in sorted(DRAFT):
                limit = 128 * MIB if name == 'package.tgz' else 4 * MIB
                total += copy_input(draft, name, out / name, min(limit, 144 * MIB - total), request_uid)
            require(all(signature(before) == signature(os.fstat(fd)) for before, fd in zip(initial, (req, draft))), 'INPUT_CHANGED')
            require(signature(initial[0]) == signature(os.stat(request_id_value, dir_fd=parent, follow_symlinks=False)), 'INPUT_CHANGED')
            require(signature(initial[1]) == signature(os.stat('draft', dir_fd=req, follow_symlinks=False)), 'INPUT_CHANGED')
            sync_directory(out)
            sync_directory(destination)
            return request


def is_hash(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def read_record(path, limit=4 * MIB):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, 'INVALID_RECORD')
        raw = stream.read(limit + 1)
        require(len(raw) <= limit, 'INPUT_TOO_LARGE')
        return parse_json(raw)


def safe_relative(name):
    require(isinstance(name, str) and 0 < len(name.encode()) <= 1024 and '\\' not in name and ':' not in name, 'UNSAFE_PACKAGE')
    path = PurePosixPath(name)
    require(not path.is_absolute() and name == path.as_posix(), 'UNSAFE_PACKAGE')
    forbidden = {'data', 'private', 'queues', 'outbox', 'spool', 'node_modules', '__pycache__', 'state_store.db', 'hook-outbox'}
    require(all(p not in forbidden and p not in ('.', '..') and not p.endswith('.env') for p in path.parts), 'UNSAFE_PACKAGE')
    require(not any(p.startswith('.') and p not in ('.claude-plugin', '.codex-plugin', '.devin-plugin', '.env.example', '.mcp.json', '.mcp.codex.json', '.mcp.copilot.json') for p in path.parts), 'UNSAFE_PACKAGE')


def hash_table(value):
    require(isinstance(value, dict) and 0 < len(value) <= 10000, 'INVALID_MANIFEST')
    for name, expected in value.items():
        safe_relative(name)
        require(is_hash(expected), 'INVALID_MANIFEST')
    return value


class BoundedReader:
    def __init__(self, stream, limit):
        self.stream, self.remaining = stream, limit

    def read(self, size=-1):
        require(size >= 0, 'INPUT_TOO_LARGE')
        data = self.stream.read(min(size, self.remaining + 1))
        self.remaining -= len(data)
        require(self.remaining >= 0, 'INPUT_TOO_LARGE')
        return data


def validate_candidate(snapshot, policy, current):
    snapshot = Path(snapshot)
    require({p.name for p in snapshot.iterdir()} == DRAFT, 'INPUT_FILE_SET_CHANGED')
    kit = read_record(snapshot / 'kit.json')
    fields = {'id','version','sourceCommit','packageSha256','changeSummary','tests','entrypoint','executionClosureReviewed','reviewedBy','files'}
    require(set(kit) == fields and kit['entrypoint'] == 'kit-runtime.py' and kit['executionClosureReviewed'] is False and kit['reviewedBy'] == '', 'INVALID_DRAFT')
    require(isinstance(kit['id'], str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,79}', kit['id']), 'INVALID_METADATA')
    require(isinstance(kit['version'], str) and len(kit['version']) <= 100 and re.fullmatch(r'0\.9\.30-daniel\.[1-9][0-9]*', kit['version']), 'INVALID_VERSION')
    require(isinstance(kit['sourceCommit'], str) and re.fullmatch('[a-f0-9]{40}', kit['sourceCommit']) and is_hash(kit['packageSha256']), 'INVALID_METADATA')
    require(isinstance(kit['changeSummary'], str) and 0 < len(kit['changeSummary'].encode()) <= 8192, 'INVALID_METADATA')
    require(isinstance(kit['tests'], list) and 0 < len(kit['tests']) <= 50 and all(isinstance(t, str) and 0 < len(t.encode()) <= 1000 for t in kit['tests']), 'INVALID_METADATA')
    require(isinstance(kit['files'], dict) and set(kit['files']) == DRAFT - {'kit.json', 'review-template.json'}, 'INVALID_MANIFEST')
    for name, expected in kit['files'].items():
        require(is_hash(expected) and sha(snapshot / name) == expected, 'SNAPSHOT_CHANGED')
    require(all(sha(snapshot / name) == policy['runtimeHashes'][name] for name in RUNTIME), 'ROOT_EXECUTION_POLICY_CHANGED')
    require(read_record(snapshot / 'baseline.json') == current, 'CURRENT_BASELINE_UNVERIFIED')
    read_record(snapshot / 'review-template.json')
    release = read_record(snapshot / 'release.json')
    require(release.get('packageVersion') == kit['version'] and release.get('sourceCommit') == kit['sourceCommit'] and sha(snapshot / 'package.tgz') == kit['packageSha256'], 'CANDIDATE_IDENTITY_MISMATCH')
    require(release.get('artifactHashes') == release.get('verificationFiles'), 'ARTIFACT_TABLE_MISMATCH')
    files = hash_table(release.get('packageFiles'))
    artifacts = hash_table(release.get('artifactHashes'))
    expected = {'package/' + name: h for name,h in files.items()}
    expected['agentmemory.tgz'] = kit['packageSha256']
    require(set(artifacts) == set(expected) | set(policy['extraArtifacts']) and all(artifacts[n] == h for n,h in expected.items()), 'ARTIFACT_TABLE_MISMATCH')
    compat = {n:h for n,h in files.items() if n.startswith('plugin/scripts/codex-compat/')}
    require(len(compat) == 13 and compat == current['compatibilityFiles'], 'CLIENT_COMPATIBILITY_CHANGED')
    count = total = 0
    seen = set()
    proposed = None
    try:
        with gzip.open(snapshot / 'package.tgz', 'rb') as compressed:
            bounded = BoundedReader(compressed, 512 * MIB + 10000 * 1024 + MIB)
            with tarfile.open(fileobj=bounded, mode='r|') as package:
                for member in package:
                    count += 1
                    require(count <= 10000 and not member.pax_headers and not member.issparse(), 'UNSAFE_PACKAGE')
                    require(member.name.startswith('package/'), 'UNSAFE_PACKAGE')
                    name = member.name[8:]
                    safe_relative(name)
                    require(name not in seen and (member.isfile() or member.isdir()), 'UNSAFE_PACKAGE')
                    seen.add(name)
                    if member.isdir():
                        require(name not in files and member.size == 0, 'UNSAFE_PACKAGE')
                        continue
                    total += member.size
                    require(0 <= member.size and total <= 512 * MIB and name in files, 'INPUT_TOO_LARGE')
                    stream = package.extractfile(member)
                    h = hashlib.sha256()
                    content = bytearray() if name == 'package.json' else None
                    require(content is None or member.size <= 65536, 'PACKAGE_MANIFEST_INVALID')
                    while chunk := stream.read(MIB):
                        h.update(chunk)
                        if content is not None:
                            content.extend(chunk)
                    require(h.hexdigest() == files[name], 'PACKAGE_HASH_MISMATCH')
                    if content is not None:
                        proposed = parse_json(content)
                while bounded.read(MIB):
                    pass
        require(set(files) <= seen and proposed is not None, 'PACKAGE_FILE_SET_CHANGED')
    except (tarfile.TarError, OSError, EOFError):
        raise RuntimeError('INVALID_PACKAGE') from None
    require(proposed.get('version') == kit['version'], 'CANDIDATE_IDENTITY_MISMATCH')
    require(all(proposed.get(k, {}) == policy['packageContract'].get(k, {}) for k in ('dependencies','optionalDependencies','engines')), 'DEPENDENCY_REUSE_NOT_COMPATIBLE')
    return kit


def load_module(path, *, owner=0, anchor=Path('/')):
    trusted(path, owner, anchor)
    name = 'fixed_' + Path(path).stem.replace('-', '_')
    spec = importlib.util.spec_from_loader(name, SourceFileLoader(name, str(path)))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_policy(path, *, owner=0, anchor=Path('/')):
    trusted(path, owner, anchor)
    value = read_record(path)
    require(set(value) == {'schemaVersion','policyId','validatorVersion','delegatingReview','requestUid','requestGid','assets','runtimeHashes','packageContract','extraArtifacts','legacyBaseline','library','runner','state','dropin','publicKits','archives'}, 'INVALID_POLICY')
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and type(value['requestUid']) is int and value['requestUid'] == 1000 and type(value['requestGid']) is int and value['requestGid'] == 1000, 'INVALID_POLICY')
    require(all(isinstance(value[k], str) and 0 < len(value[k]) <= 1024 for k in ('policyId','validatorVersion','delegatingReview')), 'INVALID_POLICY')
    require(isinstance(value['assets'], dict) and 6 <= len(value['assets']) <= 16 and set(value['runtimeHashes']) == set(RUNTIME), 'INVALID_POLICY')
    for name, expected in value['assets'].items():
        trusted(name, owner, anchor)
        require(is_hash(expected) and sha(name) == expected, 'ROOT_EXECUTION_POLICY_CHANGED')
    library = Path(value['library'])
    require(all(value['assets'].get(str(library / n)) == value['runtimeHashes'][n] for n in RUNTIME), 'INVALID_POLICY')
    require(all(str(library / n) in value['assets'] for n in ('enroll-reviewed-kit.py','prepare-dashboard-kit.py')) and value['runner'] in value['assets'], 'INVALID_POLICY')
    try:
        marker = Path(path).parent / 'installation.json'
        trusted(marker, owner, anchor)
        installation = read_record(marker)
        require(installation.get('installed') is True and installation.get('policySha256') == sha(path), 'INSTALLATION_NOT_COMMITTED')
    except OSError:
        raise RuntimeError('INSTALLATION_NOT_COMMITTED') from None
    return value


def current_baseline(policy, *, owner=0, anchor=Path('/'), runtime_paths=None):
    """Select through a root drop-in and checked root catalog, never user activation alone."""
    dropin = Path(policy['dropin'])
    trusted(dropin, owner, anchor)
    legacy = policy['legacyBaseline']
    if sha(dropin) == legacy['protectedFiles'].get(str(dropin)):
        rt = load_module(Path(policy['library']) / 'kit-runtime.py', owner=owner, anchor=anchor)
        rt.verify_map(legacy['protectedFiles'])
        receipt = read_record(legacy['receiptPath'])
        require(all(receipt.get(k) == v for k,v in legacy['receiptIdentity'].items()), 'CURRENT_BASELINE_UNVERIFIED')
        for archive in legacy['archives']:
            rt.verify_archive(archive['path'], archive['sha256'], archive['files'])
        return legacy
    runner = load_module(policy['runner'], owner=owner, anchor=anchor)
    manager = runner.Runner(state=Path(policy['state']), trusted_uid=owner, trust_anchor=anchor)
    for entry in manager.catalog():
        kit_path = Path(policy['publicKits']) / entry['id']
        metadata = manager.checked_kit(kit_path, entry['kitSha256'])
        if not all(metadata['files'].get(n) == policy['runtimeHashes'][n] for n in RUNTIME):
            continue
        rt = load_module(Path(policy['library']) / 'kit-runtime.py', owner=owner, anchor=anchor)
        runtime = rt.Runtime(kit_path, paths=runtime_paths, owner=owner, anchor=anchor)
        if runtime.dropin_bytes() != dropin.read_bytes():
            continue
        require(runtime.receipt.is_file(), 'CURRENT_BASELINE_UNVERIFIED')
        receipt = read_record(runtime.receipt)
        archive = Path(receipt['preservationReceipt']['archive'])
        require(archive.parent == Path(policy['archives']) and re.fullmatch(re.escape(metadata['id']) + r'-[0-9]+\.tar\.gz', archive.name), 'CURRENT_BASELINE_UNVERIFIED')
        post = runtime.post_files()
        identity = {'applied':True, 'candidateHash':metadata['packageSha256'], 'sourceCommit':metadata['sourceCommit'], 'installedFileHashes':post}
        require(all(receipt.get(k) == v for k,v in identity.items()), 'CURRENT_BASELINE_UNVERIFIED')
        saved = receipt['preservationReceipt']
        require(is_hash(saved.get('archiveSha256')), 'CURRENT_BASELINE_UNVERIFIED')
        archive_files = runtime.archive_files()
        rt.verify_archive(archive, saved['archiveSha256'], archive_files)
        runtime.guard()
        protected = {**post, **{str(kit_path / n):h for n,h in metadata['files'].items()}, str(kit_path / 'kit.json'):sha(kit_path / 'kit.json')}
        return {**runtime.baseline, 'protectedFiles':protected, 'receiptPath':str(runtime.receipt), 'receiptIdentity':identity,
                'archives':[*runtime.baseline['archives'], {'path':str(archive),'sha256':saved['archiveSha256'],'files':archive_files}]}
    raise RuntimeError('CURRENT_BASELINE_UNVERIFIED')


def check_caller(argv, *, euid, sudo_uid):
    require(euid == 0 and sudo_uid == '1000', 'CALLER_NOT_ALLOWED')
    require(len(argv) == 2, 'INVALID_REQUEST')
    return request_id(argv[1])


def protected_directory(path, mode, owner, anchor):
    trusted(path.parent, owner, anchor)
    path.mkdir(mode=mode, exist_ok=True)
    trusted(path, owner, anchor)
    require(stat.S_ISDIR(path.stat().st_mode) and stat.S_IMODE(path.stat().st_mode) == mode, 'UNTRUSTED_PATH')
    return path


@contextlib.contextmanager
def enrollment_lock(path, owner):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == owner and info.st_nlink == 1 and not info.st_mode & 0o077, 'UNSAFE_LOCK')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('BUSY') from None
        yield
    finally:
        os.close(fd)


def failed_package(policy, package_hash, owner, anchor):
    runner = load_module(policy['runner'], owner=owner, anchor=anchor)
    manager = runner.Runner(state=Path(policy['state']), trusted_uid=owner, trust_anchor=anchor)
    failed = {c['id'] for c in manager.catalog() if c['packageSha256'] == package_hash}
    for path in (Path(policy['state']) / 'public/jobs').glob('*.json'):
        trusted(path, owner, anchor)
        job = read_record(path)
        if job.get('candidateId') in failed:
            require(job.get('status') not in ('failed','interrupted') and not any(e.get('status') in ('failed','interrupted') for e in job.get('events', [])), 'FAILED_PACKAGE_REQUIRES_ADMINISTRATOR')


def enroll(identifier, *, policy_path=POLICY, state=STATE, spool=SPOOL, owner=0, anchor=Path('/'), request_uid=1000):
    request_id(identifier)
    policy = load_policy(policy_path, owner=owner, anchor=anchor)
    policy_hash = sha(policy_path)
    state = Path(state)
    require(str(state) == policy['state'], 'INVALID_POLICY')
    private = protected_directory(state / 'private/enrollment', 0o700, owner, anchor)
    public = protected_directory(state / 'public/enrollment', 0o755, owner, anchor)
    candidates = protected_directory(private / 'candidates', 0o700, owner, anchor)
    requests = protected_directory(private / 'requests', 0o700, owner, anchor)
    with enrollment_lock(private / 'enrollment.lock', owner):
        require((requests / identifier).exists() or len(list(requests.iterdir())) < 100, 'ENROLLMENT_LIMIT')
        with tempfile.TemporaryDirectory(prefix='.input-', dir=private) as temporary:
            snapshot = Path(temporary)
            request = snapshot_request(Path(spool), identifier, snapshot, request_uid=request_uid)
            identity = {'candidateId':request['candidateId'], 'draftManifestSha256':request['draftManifestSha256'], 'policySha256':policy_hash,
                        'files':{n:sha(snapshot / 'draft' / n) for n in sorted(DRAFT)}}
            root = requests / identifier
            record_path = root / 'record.json'
            if root.exists():
                trusted(record_path, owner, anchor)
                record = read_record(record_path)
                require(record['identity'] == identity, 'REQUEST_CONFLICT')
            else:
                staged_root = protected_directory(snapshot / 'journal', 0o700, owner, anchor)
                record_path = staged_root / 'record.json'
                receipt = {'requestId':identifier,'candidateId':request['candidateId'],'draftManifestSha256':request['draftManifestSha256'],
                           'policySha256':policy_hash,'applied':False,'serviceControlled':False,
                           'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
                record = {'identity':identity, 'receipt':receipt, 'verified':False}
                try:
                    require(identity['files']['kit.json'] == request['draftManifestSha256'], 'SNAPSHOT_CHANGED')
                    try:
                        current = current_baseline(policy, owner=owner, anchor=anchor)
                    except (RuntimeError, OSError, ValueError, KeyError, TypeError):
                        raise RuntimeError('CURRENT_BASELINE_UNVERIFIED') from None
                    kit = validate_candidate(snapshot / 'draft', policy, current)
                    require(kit['id'] == request['candidateId'], 'CANDIDATE_IDENTITY_MISMATCH')
                    failed_package(policy, kit['packageSha256'], owner, anchor)
                    receipt.update(version=kit['version'],sourceCommit=kit['sourceCommit'],packageSha256=kit['packageSha256'])
                    mapping = candidates / (kit['id'] + '.json')
                    if mapping.exists():
                        trusted(mapping, owner, anchor)
                        prior = read_record(mapping)
                        require(prior['identity'] == identity, 'CANDIDATE_EXISTS')
                        origin = request_id(prior['requestId'])
                    else:
                        origin = identifier
                        (snapshot / 'draft').rename(staged_root / 'draft')
                        sync_directory(staged_root)
                    record.update(verified=True, origin=origin)
                    atomic(record_path, json_bytes(record))
                except RuntimeError as error:
                    code = str(error)
                    allowed = {'SNAPSHOT_CHANGED','CURRENT_BASELINE_UNVERIFIED','INVALID_DRAFT','INVALID_METADATA','INVALID_VERSION','INVALID_MANIFEST','ROOT_EXECUTION_POLICY_CHANGED','ARTIFACT_TABLE_MISMATCH','CANDIDATE_IDENTITY_MISMATCH','CLIENT_COMPATIBILITY_CHANGED','UNSAFE_PACKAGE','INPUT_TOO_LARGE','PACKAGE_MANIFEST_INVALID','PACKAGE_HASH_MISMATCH','PACKAGE_FILE_SET_CHANGED','INVALID_PACKAGE','DEPENDENCY_REUSE_NOT_COMPATIBLE','FAILED_PACKAGE_REQUIRES_ADMINISTRATOR','CANDIDATE_EXISTS','INVALID_JSON','INPUT_FILE_SET_CHANGED'}
                    require(code in allowed, 'VALIDATION_FAILED')
                    record['receipt'].update(status='rejected',errorCode=code)
                    atomic(record_path, json_bytes(record))
                staged_root.rename(root)
                sync_directory(requests)
                record_path = root / 'record.json'
            if record['verified']:
                mapping = candidates / (identity['candidateId'] + '.json')
                if not mapping.exists():
                    atomic(mapping, json_bytes({'requestId':record['origin'],'identity':identity}))
            receipt = record['receipt']
            if receipt.get('status') is None:
                require(record['verified'] is True, 'REGISTRATION_UNCERTAIN')
                origin = requests / request_id(record['origin'])
                trusted(origin, owner, anchor)
                review_path = origin / 'review.json'
                if not review_path.exists():
                    evidence = {'executionClosureReviewed':True,'reviewedBy':'delegated-policy:' + policy['policyId'],
                                'draftManifestSha256':identity['draftManifestSha256'],'policyId':policy['policyId'],'policySha256':policy_hash,
                                'delegatingReview':policy['delegatingReview'],'validatorVersion':policy['validatorVersion'],
                                'requestId':record['origin'],'applied':False,'serviceControlled':False,
                                'scope':'Exact root execution bytes only; package quality and operational application are separate.'}
                    atomic(review_path, json_bytes(evidence))
                bootstrap = load_module(Path(policy['library']) / 'enroll-reviewed-kit.py', owner=owner, anchor=anchor)
                runner = load_module(policy['runner'], owner=owner, anchor=anchor)
                manager = runner.Runner(state=state, trusted_uid=owner, trust_anchor=anchor)
                def register_locked(args, **kwargs):
                    require(args == ['/usr/bin/python3','-I','-B',policy['runner'],'--enroll',str(state / 'incoming' / identity['candidateId'])], 'INVALID_DISPATCH')
                    with manager.lock():
                        failed_package(policy, read_record(origin / 'draft/kit.json')['packageSha256'], owner, anchor)
                        # The outer dispatch flock covers the failure check and existing enroll transaction.
                        original_lock = manager.lock
                        manager.lock = contextlib.nullcontext
                        try:
                            return manager.enroll(Path(args[5]))
                        finally:
                            manager.lock = original_lock
                try:
                    bootstrap.install(origin / 'draft', review_path, state=state, runner=Path(policy['runner']),owner=owner,anchor=anchor,run=register_locked)
                    receipt.update(status='registered',errorCode=None)
                except RuntimeError as error:
                    if str(error) != 'FAILED_PACKAGE_REQUIRES_ADMINISTRATOR':
                        raise
                    receipt.update(status='rejected',errorCode=str(error))
                atomic(record_path, json_bytes(record))
            atomic(public / (identifier + '.json'), json_bytes(receipt), 0o644)
            return receipt


def main():
    identifier = check_caller(sys.argv, euid=os.geteuid(), sudo_uid=os.environ.get('SUDO_UID'))
    require(os.environ.get('SUDO_GID') == '1000', 'CALLER_NOT_ALLOWED')
    trusted(Path(__file__).absolute())
    policy = load_policy(POLICY)
    require(policy['assets'].get(str(Path(__file__).absolute())) == sha(Path(__file__)), 'ROOT_EXECUTION_POLICY_CHANGED')
    require(policy['library'] == str(LIBRARY) and policy['runner'] == str(RUNNER) and policy['state'] == str(STATE), 'INVALID_POLICY')
    os.environ.clear()
    os.environ.update(ENV)
    os.umask(0o077)
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (60,60))
    resource.setrlimit(resource.RLIMIT_AS, (768 * MIB,768 * MIB))
    result = enroll(identifier)
    print(json.dumps(result,sort_keys=True))
    return 0 if result['status'] == 'registered' else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('{"status":"unconfirmed","errorCode":"ENROLLMENT_NOT_CONFIRMED","applied":false,"serviceControlled":false}')
        sys.exit(1)
