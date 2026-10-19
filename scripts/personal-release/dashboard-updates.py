#!/usr/bin/python3 -I
"""Independent root update dispatcher. Install only after administrator review.

Trust boundary: enrollment is an administrator action, never a dashboard action.
kit.json must declare executionClosureReviewed=true: the administrator has reviewed
ALL program/import/subprocess paths, including the existing normal-stop, backup,
guard and preservation workflow, and guarantees no executable code is loaded from
user-writable paths. A file manifest proves snapshot integrity, NOT code safety or
Python dependency closure. Do not enroll old output directories automatically.
"""
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

STATE = Path('/var/lib/agentmemory-updates')
SPOOL = Path('/home/daniel/.agentmemory/update-requests')
PUBLIC_FIELDS = ('id', 'version', 'sourceCommit', 'packageSha256', 'changeSummary', 'tests')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
PHASES = frozenset((
    'preflight_verified', 'normal_shutdown_requested', 'normal_shutdown_verified',
    'latest_private_backup_verified', 'versioned_package_verified',
    'activating_code_and_hooks', 'ready_to_start', 'new_version_started',
    'runtime_and_data_verified', 'code_archives_readback_verified',
    'applied_pending_live_acceptance',
))



class Rejected(RuntimeError):
    pass


def sha(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def job_id(value):
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError()
    except (ValueError, AttributeError):
        raise Rejected('INVALID_JOB_ID') from None
    return value


def candidate_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}', value):
        raise Rejected('INVALID_CANDIDATE')
    return value


def boot_id():
    return job_id(Path('/proc/sys/kernel/random/boot_id').read_text().strip())


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def read_json(path, owner, limit=1024 * 1024, private=False):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022:
                raise Rejected('UNSAFE_FILE')
            if private and stat.S_IMODE(info.st_mode) != 0o600:
                raise Rejected('UNSAFE_FILE')
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise Rejected('REQUEST_TOO_LARGE')
        return json.loads(raw)
    except (OSError, ValueError, UnicodeError):
        raise Rejected('INVALID_FILE') from None


class Runner:
    def __init__(self, state=STATE, spool=SPOOL, *, trusted_uid=0, request_uid=1000, trust_anchor=Path('/')):
        # Test injection is library-only; the privileged CLI accepts no path/env overrides.
        self.state = Path(state)
        self.spool = Path(spool)
        self.trusted_uid = trusted_uid
        self.request_uid = request_uid
        self.trust_anchor = Path(trust_anchor)

    def trusted(self, path):
        path = Path(path)
        if not path.is_absolute() or '..' in path.parts:
            raise Rejected('UNTRUSTED_PATH')
        try:
            path.relative_to(self.trust_anchor)
            current = path
            while True:
                info = current.lstat()
                if info.st_uid != self.trusted_uid or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
                    raise Rejected('UNTRUSTED_PATH')
                if current == self.trust_anchor:
                    break
                current = current.parent
        except (OSError, ValueError):
            raise Rejected('UNTRUSTED_PATH') from None

    def initialize(self):
        self.trusted(self.state.parent)
        for path, mode in [(self.state, 0o755), (self.state / 'vault', 0o700), (self.state / 'private', 0o700), (self.state / 'public', 0o755), (self.state / 'public/jobs', 0o755)]:
            path.mkdir(mode=mode, exist_ok=True)
            self.trusted(path)
            path.chmod(mode)
        with self.lock():
            if not (self.state / 'catalog.json').exists():
                self.write(self.state / 'catalog.json', {'candidates': []}, 0o600)
                self.write(self.state / 'public/catalog.json', {'candidates': []})

    def write(self, path, value, mode=0o644):
        self.trusted(path.parent)
        fd, temporary = tempfile.mkstemp(prefix='.update-', dir=path.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                os.fchmod(stream.fileno(), mode)
                json.dump(value, stream, ensure_ascii=True)
                stream.write('\n')
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @contextlib.contextmanager
    def lock(self):
        self.trusted(self.state)
        fd = os.open(self.state / 'dispatch.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != self.trusted_uid or info.st_mode & 0o077:
                raise Rejected('UNSAFE_LOCK')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Rejected('BUSY') from None
            yield
        finally:
            os.close(fd)

    def catalog(self):
        self.trusted(self.state / 'catalog.json')
        return read_json(self.state / 'catalog.json', self.trusted_uid)['candidates']

    def checked_kit(self, root, manifest_sha=None):
        self.trusted(root)
        if manifest_sha is not None and sha(root / 'kit.json') != manifest_sha:
            raise Rejected('UNTRUSTED_KIT')
        metadata = read_json(root / 'kit.json', self.trusted_uid)
        if not isinstance(metadata, dict) or metadata.get('executionClosureReviewed') is not True or not isinstance(metadata.get('reviewedBy'), str) or not metadata['reviewedBy'].strip():
            raise Rejected('CLOSURE_NOT_REVIEWED')
        candidate_id(metadata.get('id'))
        for field, maximum in [('version', 100), ('changeSummary', 8192)]:
            if not isinstance(metadata.get(field), str) or not 1 <= len(metadata[field].encode('utf-8')) <= maximum:
                raise Rejected('INVALID_METADATA')
        for field, length in [('sourceCommit', 40), ('packageSha256', 64)]:
            if not re.fullmatch('[a-f0-9]{%d}' % length, str(metadata.get(field, ''))):
                raise Rejected('INVALID_METADATA')
        tests = metadata.get('tests')
        if not isinstance(tests, list) or not tests or len(tests) > 50 or any(not isinstance(t, str) or not 1 <= len(t.encode('utf-8')) <= 1000 for t in tests):
            raise Rejected('INVALID_METADATA')
        files = metadata.get('files')
        if not isinstance(files, dict) or not files or len(files) > 10000:
            raise Rejected('INVALID_MANIFEST')
        for relative, expected in files.items():
            pieces = PurePosixPath(relative).parts
            if not pieces or relative != '/'.join(pieces) or any(p in ('.', '..', 'data', 'queues', 'outbox', 'spool', 'node_modules', '__pycache__') or p.startswith('.') or p.endswith('.env') for p in pieces) or PurePosixPath(relative).is_absolute() or relative == 'kit.json' or '\\' in relative:
                raise Rejected('UNSAFE_KIT_PATH')
            path = root / relative
            self.trusted(path)
            if not stat.S_ISREG(path.lstat().st_mode) or not re.fullmatch('[a-f0-9]{64}', str(expected)) or sha(path) != expected:
                raise Rejected('UNTRUSTED_KIT')
        actual = set()
        for path in root.rglob('*'):
            self.trusted(path)
            if path.is_dir():
                continue
            if not stat.S_ISREG(path.lstat().st_mode):
                raise Rejected('UNTRUSTED_KIT')
            actual.add(path.relative_to(root).as_posix())
        if actual != set(files) | {'kit.json'} or metadata.get('entrypoint') not in files or not metadata['entrypoint'].endswith('.py'):
            raise Rejected('INVALID_MANIFEST')
        return metadata

    def public_catalog(self, entries):
        payload = {'candidates': [{k: c[k] for k in (*PUBLIC_FIELDS, 'approved')} for c in entries]}
        if len(entries) > 100 or len((json.dumps(payload, ensure_ascii=True) + '\n').encode('utf-8')) > 65536:
            raise Rejected('CATALOG_LIMIT')
        return payload

    def publish_catalog(self, entries):
        payload = self.public_catalog(entries)
        for entry in entries:
            metadata = self.checked_kit(self.state / 'vault' / candidate_id(entry['id']), entry['kitSha256'])
            if entry.get('approved') is not True or any(entry[k] != metadata[k] for k in PUBLIC_FIELDS):
                raise Rejected('UNTRUSTED_KIT')
        self.write(self.state / 'public/catalog.json', payload)
        return payload

    def refresh_catalog(self):
        with self.lock():
            return self.publish_catalog(self.catalog())

    def enroll(self, source):
        source = Path(source)
        with self.lock():
            metadata = self.checked_kit(source)
            entries = self.catalog()
            incoming = {**{k: metadata[k] for k in PUBLIC_FIELDS}, 'approved': True, 'kitSha256': sha(source / 'kit.json')}
            existing = next((c for c in entries if c['id'] == metadata['id']), None)
            destination = self.state / 'vault' / metadata['id']
            if existing is not None:
                if existing != incoming:
                    raise Rejected('CANDIDATE_EXISTS')
                self.publish_catalog(entries)
                return {k: existing[k] for k in (*PUBLIC_FIELDS, 'approved')}
            planned = [*entries, incoming]
            self.public_catalog(planned)  # Reject over-budget candidates before copying or committing.
            if destination.exists():
                if self.checked_kit(destination, incoming['kitSha256']) != metadata:
                    raise Rejected('CANDIDATE_EXISTS')
                temporary = None  # A previous crash may have left a complete, unpublished snapshot.
            else:
                temporary = Path(tempfile.mkdtemp(prefix='.enroll-', dir=self.state / 'vault'))
            new_vault = False
            try:
                if temporary is not None:
                    for relative in ['kit.json', *metadata['files']]:
                        target = temporary / relative
                        target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
                        for parent in target.parents:
                            if parent == temporary.parent:
                                break
                            parent.chmod(0o700)
                        shutil.copyfile(source / relative, target, follow_symlinks=False)
                        target.chmod(0o600)
                    if self.checked_kit(temporary, incoming['kitSha256']) != metadata:
                        raise Rejected('SOURCE_CHANGED')
                    temporary.rename(destination)
                    new_vault = True
                self.write(self.state / 'catalog.json', {'candidates': planned}, 0o600)
                self.publish_catalog(planned)
            except Exception:
                # An atomic write can commit before directory fsync fails: inspect the durable catalog.
                if new_vault:
                    try:
                        committed = any(c == incoming for c in self.catalog())
                    except (Rejected, OSError):
                        committed = True  # Preserve an uncertain snapshot for explicit administrator review.
                    if not committed:
                        shutil.rmtree(destination)
                raise
            finally:
                if temporary is not None and temporary.exists():
                    shutil.rmtree(temporary)
            return {k: incoming[k] for k in (*PUBLIC_FIELDS, 'approved')}

    def job_path(self, identifier):
        return self.state / 'public/jobs' / (job_id(identifier) + '.json')

    def job(self, identifier):
        return read_json(self.job_path(identifier), self.trusted_uid)

    def save_job(self, value, status, phase, error=None):
        value.update(status=status, phase=phase, updatedAt=now(), verificationComplete=False)
        if error:
            value['errorCode'] = error
        event = {'status': status, 'phase': phase, 'at': value['updatedAt']}
        if value.get('errorCode'):
            event['errorCode'] = value['errorCode']
        value.setdefault('events', []).append(event)
        self.write(self.job_path(value['jobId']), value)
        return value

    def request(self, identifier):
        job_id(identifier)
        request = read_json(self.spool / (identifier + '.json'), self.request_uid, 4096, private=True)
        if not isinstance(request, dict) or set(request) != {'jobId', 'candidateId'} or request['jobId'] != identifier:
            raise Rejected('INVALID_REQUEST')
        selected = candidate_id(request['candidateId'])
        with self.lock():
            path = self.job_path(identifier)
            if path.exists():
                result = self.job(identifier)
                if result['candidateId'] != selected:
                    raise Rejected('JOB_CONFLICT')
                if result['status'] != 'queued':
                    return result
                if result.get('bootId') != boot_id():
                    return self.save_job(result, 'interrupted', 'inspection_required', 'UPDATE_INTERRUPTED')
            else:
                approved = next((c for c in self.catalog() if c['id'] == selected and c.get('approved') is True), None)
                if approved is None:
                    raise Rejected('UNKNOWN_CANDIDATE')
                self.checked_kit(self.state / 'vault' / selected, approved['kitSha256'])
                for existing in (self.state / 'public/jobs').glob('*.json'):
                    if read_json(existing, self.trusted_uid)['status'] in ('queued', 'running', 'interrupted'):
                        raise Rejected('BUSY')
                result = self.save_job({'jobId': identifier, 'candidateId': selected, 'createdAt': now(), 'bootId': boot_id()}, 'queued', 'queued')
        try:
            subprocess.run(['/usr/bin/systemctl', 'start', '--no-block', 'agentmemory-update@' + identifier + '.service'], check=True, env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd='/')
        except (OSError, subprocess.CalledProcessError):
            return self.save_job(result, 'failed', 'failed', 'DISPATCH_FAILED')
        return result

    def run_job(self, identifier):
        job_id(identifier)
        with self.lock():
            result = self.job(identifier)
            if result['status'] != 'queued':
                return result
            if result.get('bootId') != boot_id():
                return self.save_job(result, 'interrupted', 'inspection_required', 'UPDATE_INTERRUPTED')
            self.save_job(result, 'running', 'applying')
            try:
                selected = candidate_id(result['candidateId'])
                approved = next((c for c in self.catalog() if c['id'] == selected and c.get('approved') is True), None)
                if approved is None:
                    raise Rejected('UNKNOWN_CANDIDATE')
                root = self.state / 'vault' / selected
                metadata = self.checked_kit(root, approved['kitSha256'])
                self.trusted(self.state / 'private')
                fd = os.open(self.state / 'private' / (identifier + '.log'), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as log:
                    with subprocess.Popen(['/usr/bin/python3', '-I', '-B', str(root / metadata['entrypoint']), '--apply'], cwd=root, env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as process:
                        fragmented = False
                        seen = {event['phase'] for event in result.get('events', [])}
                        while True:
                            chunk = process.stdout.readline(8192)
                            if not chunk:
                                break
                            log.write(chunk)
                            complete = chunk.endswith(b'\n') or len(chunk) < 8192
                            if not fragmented and complete:
                                line = chunk.rstrip(b'\r\n')
                                phase = next((p for p in PHASES if line == b'PHASE: ' + p.encode('ascii')), None)
                                if phase is not None and phase not in seen:
                                    seen.add(phase)  # Bound public history even if a program repeats a phase.
                                    log.flush()
                                    os.fsync(log.fileno())
                                    self.save_job(result, 'running', phase)
                            fragmented = not complete
                        returncode = process.wait()
                if returncode:
                    raise Rejected('PROGRAM_FAILED')
            except (Rejected, OSError) as error:
                # No raw exception, subprocess output, paths or receipt is public.
                return self.save_job(result, 'failed', 'failed', 'PROGRAM_FAILED' if isinstance(error, Rejected) and str(error) == 'PROGRAM_FAILED' else 'UNTRUSTED_KIT')
            return self.save_job(result, 'applied_pending_acceptance', 'awaiting_acceptance')

    def recover_incomplete(self):
        interrupted = []
        with self.lock():
            self.publish_catalog(self.catalog())
            current_boot = boot_id()
            for path in (self.state / 'public/jobs').glob('*.json'):
                value = read_json(path, self.trusted_uid)
                if value['status'] not in ('queued', 'running'):
                    continue
                job_id(value['jobId'])
                if value.get('bootId') == current_boot:
                    if value['status'] == 'queued':
                        created = datetime.datetime.fromisoformat(value['createdAt'])
                        if (datetime.datetime.now(datetime.timezone.utc) - created).total_seconds() < 30:
                            continue  # A request releases the queue lock before systemctl dispatch.
                    try:
                        unit = subprocess.run(['/usr/bin/systemctl', 'show', '--property=ActiveState', '--value', 'agentmemory-update@' + value['jobId'] + '.service'], check=True, env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd='/', text=True)
                    except (OSError, subprocess.CalledProcessError):
                        continue  # Uncertain unit state requires administrator inspection, never guessing.
                    if unit.stdout.strip() not in ('inactive', 'failed'):
                        continue
                self.save_job(value, 'interrupted', 'inspection_required', 'UPDATE_INTERRUPTED')
                interrupted.append(value['jobId'])
        return {'interrupted': interrupted}

    def acknowledge_recovery(self, identifier):
        with self.lock():
            try:
                value = self.job(identifier)
            except Rejected:
                raise Rejected('NOT_INTERRUPTED') from None
            if value['status'] != 'interrupted':
                raise Rejected('NOT_INTERRUPTED')
            value['recoveryAcknowledged'] = True
            value['recoveryAcknowledgedAt'] = now()
            return self.save_job(value, 'failed', 'failed')


def main():
    if os.geteuid() != 0:
        raise Rejected('ROOT_REQUIRED')
    os.umask(0o077)
    runner = Runner()
    if Path(sys.argv[0]).name == 'agentmemory-update-request':
        if len(sys.argv) != 2:
            raise Rejected('INVALID_ARGUMENTS')
        result = runner.request(sys.argv[1])
    elif len(sys.argv) == 3 and sys.argv[1] in ('--run-job', '--enroll', '--acknowledge-recovery'):
        if sys.argv[1] == '--run-job':
            result = runner.run_job(sys.argv[2])
        elif sys.argv[1] == '--acknowledge-recovery':
            result = runner.acknowledge_recovery(sys.argv[2])
        else:
            result = runner.enroll(Path(sys.argv[2]))
    elif sys.argv[1:] == ['--recover-incomplete']:
        result = runner.recover_incomplete()
    elif sys.argv[1:] == ['--refresh-catalog']:
        result = runner.refresh_catalog()
    elif sys.argv[1:] == ['--initialize']:
        runner.initialize()
        result = {'initialized': True}
    else:
        raise Rejected('INVALID_ARGUMENTS')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except (Rejected, OSError) as error:
        print(json.dumps({'errorCode': str(error) if isinstance(error, Rejected) else 'SYSTEM_ERROR'}))
        sys.exit(1)
