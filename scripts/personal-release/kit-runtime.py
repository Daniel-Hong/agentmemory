#!/usr/bin/python3 -I
"""Closed dashboard transaction. Root never imports installed or outputs code."""
import datetime
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
USER_ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/home/daniel', 'LANG': 'C.UTF-8'}
HELPERS = ('kit-queues.py', 'kit-integrity.py')
WRAPPERS = ('agentmemory-update-check', 'agentmemory-verify-patches', 'agentmemory-verify-viewer', 'agentmemory-preserve-customizations')
DEFAULT_PATHS = {
    'runtime': '/home/daniel/.agentmemory', 'data': '/srv/agentmemory/data',
    'backup': '/var/lib/agentmemory-updates/private/backups', 'env': '/home/daniel/.agentmemory/.env',
    'engine': '/home/daniel/.agentmemory/bin/iii',
    'legacy': '/home/daniel/.npm-global/lib/node_modules/@agentmemory/agentmemory',
    'releases': '/home/daniel/.local/share/agentmemory-personal-releases',
    'bin': '/home/daniel/bin', 'feedback': '/srv/agentmemory/feedback',
    'dropin': '/etc/systemd/system/agentmemory.service.d/90-personal.conf',
    'public': '/var/lib/agentmemory-updates/public/release-kits',
    'private': '/var/lib/agentmemory-updates/private/release-kits',
    'public_state': '/var/lib/agentmemory-updates/public/release-kit-state', 'rootfs': '/',
    'archives': '/home/daniel/.agentmemory-code-archives',
}
ROOT_ASSETS = {
    '/usr/local/libexec/agentmemory-update-request': 0o755,
    '/usr/local/libexec/agentmemory-update-runner': 0o755,
    '/etc/systemd/system/agentmemory-update@.service': 0o644,
    '/etc/systemd/system/agentmemory-update-recovery.service': 0o644,
    '/etc/sudoers.d/agentmemory-dashboard-updates': 0o440,
}


def require(value, code):
    if not value:
        raise RuntimeError(code)


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def trusted(path, owner=0, anchor=Path('/')):
    path, anchor = Path(path), Path(anchor)
    require(path.is_absolute() and path.is_relative_to(anchor) and '..' not in path.parts, 'ROOT_OWNED_PATH_REQUIRED')
    chain = list(reversed((path, *path.parents)))
    for current in chain[chain.index(anchor):]:
        info = current.lstat()
        require(info.st_uid == owner and not info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode), 'ROOT_OWNED_PATH_REQUIRED')


def load_helper(root, name, owner=0, anchor=Path('/')):
    require(name in HELPERS, 'UNSUPPORTED_HELPER')
    trusted(root, owner, anchor)
    trusted(Path(root) / name, owner, anchor)
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(root) / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size <= 8 * 1024 * 1024, 'INVALID_RECORD')
        return json.load(stream)


def verify_map(table):
    require(isinstance(table, dict) and bool(table), 'EMPTY_FILE_TABLE')
    for name, digest in table.items():
        path = Path(name)
        require(path.is_absolute() and path.is_file() and not path.is_symlink() and not any(p.is_symlink() for p in path.parents), 'PROTECTED_PATH_CHANGED')
        require(sha(path) == digest, 'PROTECTED_FILE_CHANGED')


def verify_archive(path, expected_sha, files):
    require(not Path(path).is_symlink() and sha(path) == expected_sha, 'ARCHIVE_CHANGED')
    with tarfile.open(path) as archive:
        members = archive.getmembers()
        require(len(members) == len(files) and {m.name for m in members} == set(files) and all(m.isfile() for m in members), 'ARCHIVE_SET_CHANGED')
        for name, digest in files.items():
            require(hashlib.file_digest(archive.extractfile(name), 'sha256').hexdigest() == digest, 'ARCHIVE_READBACK_FAILED')


def atomic(path, data, mode=0o600):
    path = Path(path)
    require(not path.is_symlink() and not any(p.is_symlink() for p in path.parents), 'TARGET_SYMLINK_REFUSED')
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.release-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            os.fchmod(output.fileno(), mode)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def emit(path, value):
    atomic(path, (json.dumps(value, sort_keys=True) + '\n').encode())


def run_as_user(function, uid=1000, gid=1000):
    """Fork already reviewed code; no user-owned Python is loaded by root."""
    require(os.geteuid() in (0, uid), 'USER_TRANSITION_REFUSED')
    reader, writer = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(reader)
        try:
            if os.geteuid() == 0:
                os.setgroups([])
                os.setgid(gid)
                os.setuid(uid)
            require(os.geteuid() == uid and os.getegid() == gid, 'USER_TRANSITION_REFUSED')
            for name in os.listdir('/proc/self/fd'):
                fd = int(name)
                if fd > 2 and fd != writer:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            os.environ.clear()
            os.environ.update(USER_ENV)
            os.umask(0o077)
            result = {'success': True, 'value': function()}
            code = 0
        except BaseException as error:
            text = str(error)
            result = {'success': False, 'errorCode': text if re.fullmatch('[A-Z0-9_]{1,80}', text) else 'USER_PHASE_FAILED'}
            code = 1
        with os.fdopen(writer, 'w') as stream:
            json.dump(result, stream)
        os._exit(code)
    os.close(writer)
    with os.fdopen(reader, 'rb') as stream:
        raw = stream.read(1024 * 1024 + 1)
    _, status = os.waitpid(child, 0)
    require(len(raw) <= 1024 * 1024, 'USER_PHASE_RESPONSE_TOO_LARGE')
    result = json.loads(raw)
    require(os.waitstatus_to_exitcode(status) == 0 and result.get('success') is True, result.get('errorCode', 'USER_PHASE_FAILED'))
    return result['value']


class System:
    def verify_identity(self):
        for field in ('User', 'Group'):
            value = subprocess.check_output(['/usr/bin/systemctl', 'show', 'agentmemory.service', '-p', field, '--value'], text=True, timeout=15, env=ENV).strip()
            require(value in ('daniel', '1000'), 'SERVICE_USER_CHANGED')

    def service(self, action):
        require(action in ('start', 'stop'), 'UNSUPPORTED_SERVICE_ACTION')
        subprocess.run(['/usr/bin/systemctl', action, 'agentmemory.service'], check=True, timeout=720, env=ENV, stdin=subprocess.DEVNULL)

    def main_pid(self):
        return int(subprocess.check_output(['/usr/bin/systemctl', 'show', 'agentmemory.service', '-p', 'MainPID', '--value'], text=True, timeout=15, env=ENV).strip())

    def alive(self, pid):
        try:
            value = Path('/proc/' + str(pid) + '/stat').read_text()
            return value[value.rindex(')') + 2:].split()[0] != 'Z'
        except FileNotFoundError:
            return False

    def reload(self):
        subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True, timeout=30, env=ENV, stdin=subprocess.DEVNULL)


class Runtime:
    def __init__(self, root, *, paths=None, owner=0, anchor=Path('/'), service_uid=1000, service_gid=1000, system=None):
        self.root = Path(root)
        self.owner, self.anchor = owner, Path(anchor)
        self.uid, self.gid = service_uid, service_gid
        self.paths = {key: Path(value) for key, value in (paths or DEFAULT_PATHS).items()}
        self.system = system or System()
        trusted(self.root, owner, self.anchor)
        self.kit = read_json(self.root / 'kit.json')
        require(self.kit.get('executionClosureReviewed') is True and bool(self.kit.get('reviewedBy', '').strip()), 'ADMINISTRATOR_REVIEW_REQUIRED')
        require(re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,79}', self.kit['id']) is not None, 'INVALID_CANDIDATE')
        require(re.fullmatch(r'0\.9\.30-daniel\.[1-9][0-9]*', self.kit['version']) is not None and re.fullmatch('[a-f0-9]{40}', self.kit['sourceCommit']) is not None, 'INVALID_VERSION')
        for name, digest in self.kit['files'].items():
            require(Path(name).name == name and not name.startswith('.'), 'UNSAFE_KIT_PATH')
            trusted(self.root / name, owner, self.anchor)
            require(sha(self.root / name) == digest, 'KIT_CHANGED')
        require({p.name for p in self.root.iterdir()} == set(self.kit['files']) | {'kit.json'}, 'KIT_FILE_SET_CHANGED')
        self.release = read_json(self.root / 'release.json')
        self.baseline = read_json(self.root / 'baseline.json')
        require(self.release['sourceCommit'] == self.kit['sourceCommit'] and self.release['packageVersion'] == self.kit['version'] and sha(self.root / 'package.tgz') == self.kit['packageSha256'], 'CANDIDATE_IDENTITY_MISMATCH')
        require(self.release['artifactHashes'] == self.release['verificationFiles'], 'ARTIFACT_TABLE_MISMATCH')
        compatibility = {name: digest for name, digest in self.release['packageFiles'].items() if name.startswith('plugin/scripts/codex-compat/')}
        require(len(compatibility) == 13 and compatibility == self.baseline['compatibilityFiles'], 'CLIENT_COMPATIBILITY_CHANGED')
        self.queues = load_helper(self.root, 'kit-queues.py', owner, self.anchor)
        self.integrity = load_helper(self.root, 'kit-integrity.py', owner, self.anchor)
        self.version = self.paths['releases'] / (self.kit['version'] + '-' + self.kit['sourceCommit'][:8])
        revision = self.kit['version'].split('daniel.')[1]
        self.receipt = self.paths['runtime'] / ('personal-deployment-daniel' + revision) / 'activation.json'
        self.public = self.paths['public'] / self.kit['id']
        self.work = self.paths['private'] / self.kit['id']
        self.phase = 'constructed'
        self.backup = None
        self.stage_attempted = False
        self.activation_attempted = False
        self.start_attempted = False
        self.stop_requested = False
        self.certified_stopped = False
        self.candidate_background_control_version = 1
        self.previous_recovery_compatible = False
        self.previous_recovery_files = {}
        self.previous_recovery_directory = None

    def record(self, phase, **extra):
        self.phase = phase
        at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        emit(self.work / 'transaction.json', {'phase': phase, 'at': at, 'dataRewound': False, **extra})
        directory = self.paths['public_state']
        directory.mkdir(mode=0o755, parents=True, exist_ok=True)
        trusted(directory, self.owner, self.anchor)
        directory.chmod(0o755)
        public = {'phase': phase, 'at': at, 'sourceCommit': self.kit['sourceCommit']}
        public.update({key: extra[key] for key in ('failedPhase', 'errorCode', 'recoveryStatus') if key in extra})
        atomic(directory / (self.kit['id'] + '.json'), (json.dumps(public) + '\n').encode(), 0o644)
        print('PHASE: ' + phase, flush=True)

    def api(self, path, body=None):
        values = {}
        for line in self.paths['env'].read_text().splitlines():
            key, separator, value = line.partition('=')
            if separator and key.strip() in ('AGENTMEMORY_SECRET', 'AGENTMEMORY_URL'):
                values[key.strip()] = value.strip().strip('\"\'')
        origin = values.get('AGENTMEMORY_URL', 'http://127.0.0.1:3111')
        from urllib.parse import urlsplit
        parsed = urlsplit(origin)
        require(parsed.scheme in ('http', 'https') and parsed.hostname and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and parsed.path in ('', '/'), 'API_ORIGIN_INVALID')
        headers = {'Authorization': 'Bearer ' + values.get('AGENTMEMORY_SECRET', '')}
        if body is not None:
            headers.update({'Content-Type': 'application/json', 'x-agentmemory-background': '1'})
        request = urllib.request.Request(origin.rstrip('/') + '/agentmemory/' + path, headers=headers, data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if path == 'health' and error.code == 503:
                with error:
                    return json.load(error)
            raise

    def wrapper_bytes(self, preserve=False):
        return ('#!/bin/sh\nexec /usr/bin/python3 -I -B ' + str(self.public / 'kit-runtime.py') + (' --preserve\n' if preserve else ' --guard\n')).encode()

    def dropin_bytes(self):
        return ('[Service]\nExecStart=\nExecStart=/usr/bin/node ' + str(self.version / 'dist/cli.mjs') + ' --data-dir ' + str(self.paths['data']) + '\nExecStop=\nExecStop=/usr/bin/node ' + str(self.version / 'dist/cli.mjs') + ' stop\nExecStartPre=\nExecStartPre=/usr/bin/python3 -I -B ' + str(self.public / 'kit-runtime.py') + ' --guard\nEnvironment="AGENTMEMORY_FEEDBACK_DIR=' + str(self.paths['feedback']) + '"\nEnvironment="AGENTMEMORY_RECEIPT_DIR=' + str(self.receipt.parent) + '"\n').encode()

    def post_files(self):
        result = dict(self.baseline['protectedFiles'])
        for name in WRAPPERS:
            result[str(self.paths['bin'] / name)] = hashlib.sha256(self.wrapper_bytes(name.endswith('preserve-customizations'))).hexdigest()
        result[str(self.paths['dropin'])] = hashlib.sha256(self.dropin_bytes()).hexdigest()
        result.update({str(self.version / name): digest for name, digest in self.release['packageFiles'].items()})
        return result

    def guard(self, *, before=False, allow_staged=False):
        verify_map(self.baseline['protectedFiles'] if before else self.post_files())
        expected_assets = {str(self.paths['rootfs'] / name.lstrip('/')): mode for name, mode in ROOT_ASSETS.items()}
        require(set(self.baseline['rootAssets']) == set(expected_assets), 'ROOT_ASSET_SET_CHANGED')
        for name, mode in expected_assets.items():
            trusted(name, self.owner, self.anchor)
            info = Path(name).stat()
            expected_group = self.gid if mode == 0o440 or self.owner != 0 else 0
            require(stat.S_IMODE(info.st_mode) == mode and info.st_gid == expected_group and sha(name) == self.baseline['rootAssets'][name], 'ROOT_ASSET_CHANGED')
        for archive in self.baseline['archives']:
            verify_archive(archive['path'], archive['sha256'], archive['files'])
        if before:
            previous = read_json(self.baseline['receiptPath'])
            require(all(previous.get(key) == value for key, value in self.baseline['receiptIdentity'].items()), 'BASELINE_RECEIPT_CHANGED')
        else:
            dependency = self.version / 'node_modules'
            require(dependency.is_symlink() and dependency.resolve() == (self.paths['legacy'] / 'node_modules').resolve(), 'DEPENDENCY_LINK_CHANGED')
            if self.receipt.exists():
                receipt = read_json(self.receipt)
                require(receipt.get('applied') is True and receipt.get('candidateHash') == self.kit['packageSha256'] and receipt.get('sourceCommit') == self.kit['sourceCommit'] and receipt.get('installedFileHashes') == self.post_files(), 'ACTIVE_RECEIPT_CHANGED')
                saved = receipt['preservationReceipt']
                verify_archive(saved['archive'], saved['archiveSha256'], self.archive_files())
            elif not allow_staged:
                state_path = self.paths['public_state'] / (self.kit['id'] + '.json')
                trusted(state_path, self.owner, self.anchor)
                state = read_json(state_path)
                require(state.get('sourceCommit') == self.kit['sourceCommit'] and state.get('phase') in ('ready_to_start', 'new_version_started', 'runtime_and_data_verified', 'code_archives_readback_verified'), 'ACTIVE_RECEIPT_MISSING')
        return {'verified': True, 'version': self.kit['version']}

    def verify_dependency_reuse(self):
        current = read_json(self.paths['legacy'] / 'package.json')
        with tarfile.open(self.root / 'package.tgz') as archive:
            members = [member for member in archive if member.name == 'package/package.json']
            require(len(members) == 1 and members[0].isfile() and members[0].size <= 65536, 'PACKAGE_MANIFEST_INVALID')
            content = archive.extractfile(members[0]).read()
        require(hashlib.sha256(content).hexdigest() == self.release['packageFiles']['package.json'], 'PACKAGE_HASH_MISMATCH')
        proposed = json.loads(content)
        profile = proposed.get('agentmemoryCompatibility')
        if 'agentmemoryCompatibility' in proposed:
            require(isinstance(profile, dict) and set(profile) == {'backgroundControlVersion', 'automaticMemoryRecovery'} and type(profile['backgroundControlVersion']) is int and profile['backgroundControlVersion'] == 2 and type(profile['automaticMemoryRecovery']) is bool, 'BACKGROUND_CONTROL_PROFILE_INVALID')
        self.candidate_background_control_version = 1 if profile is None else profile['backgroundControlVersion']
        require(all(proposed.get(field, {}) == current.get(field, {}) for field in ('dependencies', 'optionalDependencies', 'engines')), 'DEPENDENCY_REUSE_NOT_COMPATIBLE')

    def previous_release_paths(self, directory):
        found, pending = set(), [directory]
        while pending:
            for path in pending.pop().iterdir():
                if path == directory / 'node_modules':
                    require(path.is_symlink() and path.resolve() == (self.paths['legacy'] / 'node_modules').resolve(), 'DEPENDENCY_LINK_CHANGED')
                    continue
                require(not path.is_symlink(), 'PROTECTED_PATH_CHANGED')
                if path.is_dir():
                    pending.append(path)
                else:
                    require(path.is_file(), 'PROTECTED_PATH_CHANGED')
                    found.add(str(path))
        return found

    def verify_previous_recovery_files(self):
        require(self.previous_release_paths(self.previous_recovery_directory) == set(self.previous_recovery_files), 'PREVIOUS_RELEASE_FILE_SET_CHANGED')
        verify_map(self.previous_recovery_files)

    def previous_recovery_proven(self, control):
        if type(control.get('formatVersion')) is not int or control['formatVersion'] != 2:
            return False
        lines = self.paths['dropin'].read_text().splitlines()
        starts = [line for line in lines if line.startswith('ExecStart=') and line != 'ExecStart=']
        if len(starts) != 1:
            return False
        match = re.fullmatch(r'ExecStart=/usr/bin/node (/.+)/dist/cli\.mjs --data-dir ' + re.escape(str(self.paths['data'])), starts[0])
        if not match:
            return False
        directory = Path(match[1])
        manifest = directory / 'package.json'
        allowed = any(directory.is_relative_to(self.paths[name]) for name in ('releases', 'legacy'))
        if not allowed or manifest.is_symlink() or manifest.resolve() != manifest or any(str(path) not in self.baseline['protectedFiles'] for path in (manifest, directory / 'dist/cli.mjs', directory / 'dist/index.mjs')):
            return False
        require(sha(manifest) == self.baseline['protectedFiles'][str(manifest)], 'PROTECTED_FILE_CHANGED')
        value = read_json(manifest)
        profile = value.get('agentmemoryCompatibility', {})
        proven = value.get('version') == self.previous_version and isinstance(profile, dict) and set(profile) == {'backgroundControlVersion', 'automaticMemoryRecovery'} and type(profile['backgroundControlVersion']) is int and profile['backgroundControlVersion'] == 2 and profile['automaticMemoryRecovery'] is False
        if not proven:
            return False
        ledger = self.baseline['receiptIdentity'].get('installedFileHashes')
        if not isinstance(ledger, dict) or read_json(self.baseline['receiptPath']).get('installedFileHashes') != ledger:
            return False
        files = {name: digest for name, digest in ledger.items() if Path(name).is_relative_to(directory)}
        if self.previous_release_paths(directory) != set(files) or any(self.baseline['protectedFiles'].get(name) != digest for name, digest in files.items()):
            return False
        self.previous_recovery_directory, self.previous_recovery_files = directory, files
        self.verify_previous_recovery_files()
        return True

    def user_install_access(self):
        require(os.geteuid() == self.uid and os.getegid() == self.gid, 'USER_TRANSITION_REFUSED')
        for target in (self.version.parent, self.receipt.parent, self.paths['bin'], self.paths['archives']):
            require(not target.is_symlink() and not any(p.is_symlink() for p in target.parents), 'TARGET_SYMLINK_REFUSED')
            directory = target
            while not directory.exists():
                directory = directory.parent
            try:
                descriptor, probe = tempfile.mkstemp(prefix='.agentmemory-access-', dir=directory)
                os.close(descriptor)
                os.unlink(probe)
            except OSError:
                raise RuntimeError('INSTALL_PATH_NOT_WRITABLE') from None
        with (self.public / 'package.tgz').open('rb') as stream:
            stream.read(1)
        return {'uid': os.geteuid(), 'gid': os.getegid(), 'installAccessVerified': True}

    def preflight(self):
        self.guard(before=True)
        self.verify_dependency_reuse()
        require(not self.version.exists() and not self.receipt.exists(), 'RELEASE_ALREADY_PRESENT')
        trusted(self.public, self.owner, self.anchor)
        for name in self.kit['files']:
            require(sha(self.public / name) == sha(self.root / name), 'PUBLIC_KIT_CHANGED')
        run_as_user(self.user_install_access, self.uid, self.gid)
        require(self.system.main_pid() > 0, 'CURRENT_SERVICE_REQUIRED')
        self.system.verify_identity()
        health = self.api('health')
        require(health.get('storageDurability', {}).get('mutationFailures') == 0, 'STORAGE_FAILURE_PRESENT')
        self.previous_version = health.get('version')
        require(isinstance(self.previous_version, str) and bool(self.previous_version), 'CURRENT_VERSION_REQUIRED')
        guides = [row for row in self.api('memories?latest=true').get('memories', []) if row.get('title') == 'AgentMemory 운영 및 유지보수 가이드']
        require(len(guides) == 1, 'LATEST_GUIDE_NOT_UNIQUE')
        control = self.api('background/control')['control']
        current_format = control.get('formatVersion', 1)
        require(type(current_format) is int and current_format in (1, 2), 'BACKGROUND_CONTROL_FORMAT_UNSUPPORTED')
        require(self.candidate_background_control_version >= current_format, 'BACKGROUND_CONTROL_DOWNGRADE_REFUSED')
        self.previous_recovery_compatible = self.previous_recovery_proven(control)
        if control.get('status') == 'running' and control.get('error') is None:
            control = self.api('background/control', {'action': 'pause'})['control']
        safe_error = control.get('error') is None if control.get('status') != 'error' else control.get('error') == 'background_storage_unavailable' and (control.get('diagnostics') or {}).get('rollbackVerified') is True
        require(control.get('pausedRequested') is True and control.get('status') in ('pausing', 'paused', 'error') and safe_error, 'DURABLE_PAUSE_REQUIRED')
        self.record('preflight_verified')

    def stop(self):
        self.stop_requested = True
        self.certified_stopped = False
        worker = int((self.paths['runtime'] / 'worker.pid').read_text())
        engine = int((self.paths['runtime'] / 'iii.pid').read_text())
        main = self.system.main_pid()
        require(min(worker, engine, main) > 0 and worker != engine and self.system.alive(worker) and self.system.alive(engine), 'CURRENT_PROCESSES_REQUIRED')
        self.record('normal_shutdown_requested')
        started = time.time()
        self.system.service('stop')
        ended = time.time()
        receipt = read_json(self.paths['runtime'] / 'shutdown-receipt.json')
        timestamp = datetime.datetime.fromisoformat(receipt['at'].replace('Z', '+00:00')).timestamp()
        require(math.isfinite(timestamp) and started <= timestamp <= ended, 'SHUTDOWN_RECEIPT_STALE')
        require(receipt.get('pid') == worker and receipt.get('verified') is True and receipt.get('durability', {}).get('synced') is True and receipt['durability'].get('mutationFailures') == 0, 'SHUTDOWN_NOT_VERIFIED')
        require(all(not self.system.alive(pid) for pid in {worker, engine, main}), 'SHUTDOWN_PROCESS_REMAINS')
        self.stop_receipt = receipt
        self.certified_stopped = True
        self.record('normal_shutdown_verified')

    def copy_private(self, source, destination, *, allowed_root=None):
        source, destination = Path(source), Path(destination)
        if source.is_symlink():
            # npm .bin links are code metadata, never traversed by the root copy.
            require(allowed_root is not None, 'BACKUP_SYMLINK_REFUSED')
            link = os.readlink(source)
            resolved = source.resolve(strict=True)
            require(not Path(link).is_absolute() and resolved.is_relative_to(Path(allowed_root).resolve()) and (resolved.is_file() or resolved.is_dir()), 'BACKUP_SYMLINK_REFUSED')
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            destination.symlink_to(link)
            require(os.readlink(destination) == link == os.readlink(source), 'BACKUP_READBACK_FAILED')
            return
        if source.is_dir():
            destination.mkdir(mode=0o700, parents=True)
            for child in source.iterdir():
                self.copy_private(child, destination / child.name, allowed_root=allowed_root)
        else:
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as stream:
                require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'BACKUP_FILE_INVALID')
                temporary_fd, temporary = tempfile.mkstemp(prefix='.backup-', dir=destination.parent)
                try:
                    with os.fdopen(temporary_fd, 'wb') as output:
                        os.fchmod(output.fileno(), 0o600)
                        shutil.copyfileobj(stream, output, 1024 * 1024)
                        output.flush()
                        os.fsync(output.fileno())
                    os.replace(temporary, destination)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
            require(sha(destination) == sha(source), 'BACKUP_READBACK_FAILED')

    def backup_latest(self):
        self.paths['backup'].mkdir(mode=0o700, parents=True, exist_ok=True)
        trusted(self.paths['backup'], self.owner, self.anchor)
        self.backup = self.paths['backup'] / ('dashboard-' + self.kit['id'] + '-' + str(time.time_ns()))
        self.backup.mkdir(mode=0o700, parents=True)
        self.before_data = self.queues.stopped_hashes(self.paths['data'], self)
        snapshots = [self.queues.backup_tree(self.paths['data'], self.backup / 'data', 'capture-spool', self, self.copy_private),
                     self.queues.backup_tree(self.paths['runtime'], self.backup / 'runtime', 'hook-outbox', self, self.copy_private)]
        self.copy_private(self.paths['legacy'], self.backup / 'retained-package', allowed_root=self.paths['legacy'])
        for name in ('env', 'engine', 'feedback'):
            if self.paths[name].exists():
                self.copy_private(self.paths[name], self.backup / name)
        for index, name in enumerate(self.baseline['protectedFiles']):
            self.copy_private(Path(name), self.backup / 'protected' / str(index))
        require(self.queues.stopped_hashes(self.paths['data'], self) == self.before_data, 'COLD_DATA_CHANGED')
        emit(self.backup / 'backup.json', {'normalShutdown': self.stop_receipt, 'dataHashes': self.before_data, 'activeQueueSnapshots': snapshots, 'liveDataRewound': False})
        self.record('latest_private_backup_verified')

    sha = staticmethod(sha)

    @staticmethod
    def file_hashes(root):
        root = Path(root)
        result = {}
        for path in root.rglob('*'):
            require(not path.is_symlink(), 'TREE_SYMLINK_REFUSED')
            if path.is_file():
                result[str(path.relative_to(root))] = sha(path)
        return result

    def user_stage(self):
        require(os.geteuid() == self.uid, 'USER_PHASE_REQUIRED')
        self.version.parent.mkdir(parents=True, exist_ok=True)
        self.version.mkdir(mode=0o755)
        expected = self.release['packageFiles']
        seen = set()
        with tarfile.open(self.public / 'package.tgz') as package:
            for member in package:
                parts = Path(member.name).parts
                require(parts and parts[0] == 'package' and '..' not in parts and not member.issym() and not member.islnk() and (member.isfile() or member.isdir()), 'UNSAFE_PACKAGE')
                relative = Path(*parts[1:])
                if not relative.parts:
                    continue
                require(not any(part in ('.env', 'state_store.db', 'hook-outbox', 'node_modules') for part in relative.parts), 'PRIVATE_PACKAGE_CONTENT')
                target = self.version / relative
                if member.isdir():
                    target.mkdir(mode=0o755, parents=True, exist_ok=True)
                    continue
                require(relative.as_posix() in expected and relative.as_posix() not in seen, 'PACKAGE_FILE_SET_CHANGED')
                content = package.extractfile(member).read()
                require(hashlib.sha256(content).hexdigest() == expected[relative.as_posix()], 'PACKAGE_HASH_MISMATCH')
                atomic(target, content, 0o755 if member.mode & 0o111 else 0o644)
                seen.add(relative.as_posix())
        require(seen == set(expected), 'PACKAGE_FILE_SET_CHANGED')
        (self.version / 'node_modules').symlink_to(self.paths['legacy'] / 'node_modules', target_is_directory=True)
        self.paths['bin'].mkdir(parents=True, exist_ok=True)
        for name in WRAPPERS:
            atomic(self.paths['bin'] / name, self.wrapper_bytes(name.endswith('preserve-customizations')), 0o755)
        self.receipt.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        return {'staged': True}

    def stage(self):
        self.rollback_code = {name: (self.paths['bin'] / name).read_bytes() for name in WRAPPERS}
        self.rollback_dropin = self.paths['dropin'].read_bytes()
        require(all(hashlib.sha256(data).hexdigest() == self.baseline['protectedFiles'][str(self.paths['bin'] / name)] for name, data in self.rollback_code.items()), 'ROLLBACK_CODE_CHANGED')
        require(hashlib.sha256(self.rollback_dropin).hexdigest() == self.baseline['protectedFiles'][str(self.paths['dropin'])], 'ROLLBACK_CODE_CHANGED')
        self.stage_attempted = True
        run_as_user(self.user_stage, self.uid, self.gid)
        self.record('versioned_package_verified')

    def activate(self):
        require(self.queues.stopped_hashes(self.paths['data'], self) == self.before_data, 'COLD_DATA_CHANGED')
        # Only this fixed root-owned drop-in is changed by the root transaction.
        trusted(self.paths['dropin'].parent, self.owner, self.anchor)
        self.activation_attempted = True
        atomic(self.paths['dropin'], self.dropin_bytes(), 0o644)
        self.guard(allow_staged=True)
        self.system.reload()
        self.record('ready_to_start')

    def verify_data(self):
        before = self.backup / 'data/state_store.db'
        current = self.paths['data'] / 'state_store.db'
        for path in before.glob('*.bin'):
            target = current / path.name
            require(target.is_file(), 'ORIGINAL_NAMESPACE_REMOVED')
            if sha(path) == sha(target):
                continue
            from urllib.parse import unquote
            scope = unquote(path.stem)
            if scope in ('mem:health', 'mem:access', 'mem:access-logs', 'mem:viewer-stream', 'mem:capture:inbox', 'mem:sessions') or scope.startswith('mem:index:bm25'):
                continue
            old, new = self.integrity.namespace(path), self.integrity.namespace(target)
            if scope in ('mem:capture:prompts', 'mem:audit:months'):
                fields = {'updatedAt'} if scope == 'mem:capture:prompts' else {'checkedAt'}
                for key, row in old.items():
                    require(key in new and self.integrity.retained({k: v for k, v in row.items() if k not in fields}, {k: v for k, v in new[key].items() if k not in fields}), 'ORIGINAL_STATE_CHANGED')
            elif scope.startswith('mem:obs:'):
                for key, row in old.items():
                    require(key in new and all(new[key].get(field) == row[field] for field in ('source', 'sourceRaw') if field in row), 'ORIGINAL_SOURCE_CHANGED')
            else:
                require(self.integrity.retained(old, new), 'ORIGINAL_STATE_CHANGED')
        with tempfile.TemporaryDirectory(prefix='integrity-', dir=self.backup) as temporary:
            selected = Path(temporary) / 'state_store.db'
            selected.mkdir()
            for path in current.glob('*.bin'):
                source = before / path.name if path.name in ('mem%3Acapture%3Aprompts.bin', 'mem%3Aaudit%3Amonths.bin') and (before / path.name).exists() else path
                (selected / path.name).symlink_to(source)
            self.integrity_result = self.integrity.verify(self.backup / 'data', Path(temporary), allow_background_hold=True)

    def verify_runtime(self):
        deadline = time.monotonic() + 120
        while True:
            try:
                health = self.api('health')
                control = self.api('background/control')['control']
                require(health.get('version') == self.kit['version'] and health.get('status') in ('healthy', 'degraded') and health.get('storageDurability', {}).get('mutationFailures') == 0, 'NEW_RUNTIME_NOT_READY')
                require(control.get('status') == 'paused' and control.get('pausedRequested') is True and control.get('activeOperations') == 0 and control.get('error') is None, 'PAUSE_NOT_PRESERVED')
                require(isinstance(self.api('sessions?includeSummary=false').get('sessions'), list), 'SESSION_API_FAILED')
                require(isinstance(self.api('config/flags').get('flags'), list), 'FLAGS_API_FAILED')
                require(self.api('feedback/settings').get('scheduleEnabled') is False, 'SCHEDULE_MUST_REMAIN_OFF')
                break
            except Exception:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(1)
        self.verify_data()
        self.guard()
        self.record('runtime_and_data_verified')

    def archive_files(self):
        return {**{'runtime/' + name: sha(self.public / name) for name in ('kit.json', *self.kit['files'])},
                **{'installed/' + name: digest for name, digest in self.release['packageFiles'].items()}}

    def user_preserve(self):
        require(os.geteuid() == self.uid, 'USER_PHASE_REQUIRED')
        self.guard()
        destination = self.paths['archives']
        destination.mkdir(parents=True, mode=0o700, exist_ok=True)
        archive = destination / (self.kit['id'] + '-' + str(time.time_ns()) + '.tar.gz')
        expected = self.archive_files()
        with tarfile.open(archive, 'x:gz') as saved:
            for name, digest in expected.items():
                path = self.public / name[8:] if name.startswith('runtime/') else self.version / name[10:]
                require(sha(path) == digest, 'PRESERVATION_SOURCE_CHANGED')
                saved.add(path, arcname=name, recursive=False)
        archive.chmod(0o600)
        verify_archive(archive, sha(archive), expected)
        self.guard()
        return {'archive': str(archive), 'archiveSha256': sha(archive), 'readBackVerified': True}

    def user_finish(self):
        value = {'receiptId': 'personal-deployment', 'applied': True, 'appliedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'version': self.kit['version'],
                 'sourceCommit': self.kit['sourceCommit'], 'candidateHash': self.kit['packageSha256'],
                 'installedFileHashes': self.post_files(), 'preservationReceipt': self.preservation,
                 'runtimeVerified': True, 'verificationComplete': False, 'dataRewound': False,
                 'backgroundHeld': True, 'remoteClientsVerified': False, 'memorySaved': False,
                 'privateBackup': str(self.backup), 'dataIntegrity': self.integrity_result}
        emit(self.receipt, value)
        return {'finished': True}

    def rollback_code_only(self):
        # A partially started new worker must certify its own latest storage first.
        if self.start_attempted and not self.certified_stopped:
            self.stop()
        self.verify_data()
        require(not self.start_attempted or self.candidate_background_control_version < 2 or self.previous_recovery_compatible, 'BACKGROUND_CONTROL_ROLLBACK_INCOMPATIBLE')
        if self.start_attempted and self.candidate_background_control_version >= 2:
            self.verify_previous_recovery_files()
        def restore_user_code():
            require(os.geteuid() == self.uid, 'USER_PHASE_REQUIRED')
            for name, content in self.rollback_code.items():
                atomic(self.paths['bin'] / name, content, 0o755)
            if self.receipt.exists():
                receipt = read_json(self.receipt)
                receipt.update(applied=False, codeRollbackVerified=True, inspectionRequired=True)
                emit(self.receipt, receipt)
            return {'restored': True}
        run_as_user(restore_user_code, self.uid, self.gid)
        if self.activation_attempted:
            trusted(self.paths['dropin'].parent, self.owner, self.anchor)
            atomic(self.paths['dropin'], self.rollback_dropin, 0o644)
            self.system.reload()
        self.guard(before=True)
        # New package and all latest data remain intact; nothing is rewound.

    def restore_previous_service(self):
        require(self.certified_stopped, 'SHUTDOWN_NOT_VERIFIED')
        require(not self.start_attempted or self.candidate_background_control_version < 2 or self.previous_recovery_compatible, 'BACKGROUND_CONTROL_ROLLBACK_INCOMPATIBLE')
        if self.start_attempted and self.candidate_background_control_version >= 2:
            self.verify_previous_recovery_files()
        self.guard(before=True)
        if not self.start_attempted and hasattr(self, 'before_data'):
            require(self.queues.stopped_hashes(self.paths['data'], self) == self.before_data, 'COLD_DATA_CHANGED')
        self.system.service('start')
        self.certified_stopped = False
        deadline = time.monotonic() + 120
        while True:
            try:
                health = self.api('health')
                control = self.api('background/control')['control']
                require(health.get('version') == self.previous_version and health.get('status') in ('healthy', 'degraded') and health.get('storageDurability', {}).get('mutationFailures') == 0, 'PREVIOUS_RUNTIME_NOT_READY')
                require(control.get('status') == 'paused' and control.get('pausedRequested') is True and control.get('activeOperations') == 0 and control.get('error') is None, 'PAUSE_NOT_PRESERVED')
                self.guard(before=True)
                return
            except Exception:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(1)

    def apply(self):
        try:
            self.preflight()
            self.stop()
            self.backup_latest()
            self.stage()
            self.activate()
            self.start_attempted = True
            self.certified_stopped = False
            self.system.service('start')
            self.record('new_version_started')
            self.verify_runtime()
            self.preservation = run_as_user(self.user_preserve, self.uid, self.gid)
            self.record('code_archives_readback_verified')
            run_as_user(self.user_finish, self.uid, self.gid)
            self.guard()
            self.record('applied_pending_live_acceptance')
        except BaseException as error:
            failed_phase = self.phase
            rollback_verified = False
            rollback_error = None
            recovery = 'not_needed' if not self.stop_requested else 'manual_required'
            if self.stage_attempted:
                try:
                    self.rollback_code_only()
                    rollback_verified = True
                except BaseException as rollback_failure:
                    rollback_error = str(rollback_failure) if str(rollback_failure) in ('BACKGROUND_CONTROL_ROLLBACK_INCOMPATIBLE', 'SHUTDOWN_NOT_VERIFIED', 'PROTECTED_FILE_CHANGED', 'PROTECTED_PATH_CHANGED', 'PREVIOUS_RELEASE_FILE_SET_CHANGED') else 'ROLLBACK_UNVERIFIED'
            if self.certified_stopped and (not self.stage_attempted or rollback_verified):
                try:
                    self.restore_previous_service()
                    recovery = 'restored'
                except BaseException:
                    recovery = 'restore_failed'
            safe_errors = {'BACKGROUND_CONTROL_FORMAT_UNSUPPORTED', 'BACKGROUND_CONTROL_PROFILE_INVALID', 'BACKGROUND_CONTROL_DOWNGRADE_REFUSED', 'INSTALL_PATH_NOT_WRITABLE', 'USER_TRANSITION_REFUSED', 'DEPENDENCY_REUSE_NOT_COMPATIBLE', 'BACKUP_READBACK_FAILED', 'PACKAGE_HASH_MISMATCH', 'SHUTDOWN_NOT_VERIFIED', 'COLD_DATA_CHANGED', 'USER_PHASE_FAILED', 'ROOT_ASSET_CHANGED', 'PROTECTED_FILE_CHANGED'}
            code = str(error) if str(error) in safe_errors else 'UPDATE_FAILED'
            self.record('failed', failedPhase=failed_phase, errorCode=code, recoveryStatus=recovery, codeRollbackVerified=rollback_verified, rollbackErrorCode=rollback_error, inspectionRequired=recovery not in ('not_needed', 'restored'))
            raise


def main():
    require(sys.argv[1:] in (['--apply'], ['--guard'], ['--preserve'], ['--check-install-access']), 'UNSUPPORTED_ARGUMENT')
    if sys.argv[1] in ('--apply', '--check-install-access'):
        require(os.geteuid() == 0, 'ROOT_REQUIRED')
    runtime = Runtime(Path(__file__).absolute().parent)
    if sys.argv[1] == '--apply':
        os.umask(0o077)
        runtime.apply()
    elif sys.argv[1] == '--guard':
        print(json.dumps(runtime.guard()))
    elif sys.argv[1] == '--check-install-access':
        print(json.dumps(run_as_user(runtime.user_install_access, runtime.uid, runtime.gid)))
    else:
        print(json.dumps(runtime.user_preserve()))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        text = str(error)
        print(json.dumps({'errorCode': text if re.fullmatch('[A-Z0-9_]{1,80}', text) else 'UPDATE_FAILED', 'dataRewound': False}))
        sys.exit(1)
