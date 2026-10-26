"""Explicit same-user maintenance acquisition; never starts or certifies a writer."""
import argparse
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import select
import signal
import stat
import sys
import subprocess
import time
import uuid


class Refused(Exception):
    pass


def require(value, code):
    if not value:
        raise Refused(code)


def signature(s):
    return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)


def sha(path):
    h = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def private_json(path, maximum=65536):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as f:
        s = os.fstat(f.fileno())
        require(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and s.st_mode & 0o077 == 0 and s.st_size <= maximum, 'PRIVATE_PLAN_REQUIRED')
        return json.loads(f.read(maximum + 1))


def local_path(path):
    p = Path(path)
    require(p.is_absolute() and os.path.normpath(str(p)) == str(p), 'PATH_REFUSED')
    # Mount table inspection does not contact or trigger an automounted share.
    mounts = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left, right = line.split(' - ', 1)
        target = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), left.split()[4])
        if str(p) == target or str(p).startswith(target.rstrip('/') + '/'):
            mounts.append((len(target), right.split()[0]))
    require(mounts and max(mounts)[1] in ('ext4', 'xfs', 'btrfs', 'tmpfs'), 'LOCAL_FILESYSTEM_REQUIRED')
    for parent in [*reversed(p.parents), p]:
        try: require(not parent.is_symlink(), 'PATH_REFUSED')
        except FileNotFoundError: pass
    return p


def proc_identity(pid):
    raw = Path(f'/proc/{pid}/stat').read_text()
    at = raw.rfind(') ')
    require(at > 0 and int(raw.split(' ', 1)[0]) == pid, 'PROCESS_UNVERIFIED')
    fields = raw[at + 2:].split()
    return {'pid': pid, 'start': fields[19]}


def plan_digest(plan):
    return hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def validate(plan, verify_stopped=False):
    require(os.name == 'posix' and sys.platform == 'linux' and os.geteuid() == os.getuid() != 0, 'SAME_USER_LINUX_REQUIRED')
    require(hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'PIDFD_REQUIRED')
    require(set(plan) == {'version', 'mode', 'expiresAt', 'store', 'sources', 'epoch', 'codePins', 'holds', 'historicalMutationFailuresObserved', 'quarantinedObserved', 'maxBytes', 'maxFiles', 'timeoutSeconds'}, 'PLAN_INVALID')
    require(plan['version'] == 1 and plan['mode'] == 'maintenance-cold-stop', 'EXPLICIT_MODE_REQUIRED')
    require(isinstance(plan['expiresAt'], (int, float)) and plan['expiresAt'] > 0 and (verify_stopped or time.time() < plan['expiresAt'] <= time.time() + 900), 'PLAN_EXPIRED')
    require(type(plan['historicalMutationFailuresObserved']) is int and plan['historicalMutationFailuresObserved'] > 0 and type(plan['quarantinedObserved']) is int and plan['quarantinedObserved'] >= 0, 'UNCERTAINTY_REQUIRED')
    require(type(plan['maxBytes']) is int and 0 < plan['maxBytes'] <= 16 * 1024**3 and type(plan['maxFiles']) is int and 0 < plan['maxFiles'] <= 10000, 'COPY_LIMIT_INVALID')
    require(isinstance(plan['timeoutSeconds'], (int, float)) and 0 < plan['timeoutSeconds'] <= 600, 'STOP_WINDOW_INVALID')
    require(set(plan['sources']) in ({'state'}, {'state', 'outbox'}) and plan['sources']['state'] == plan['store'], 'SOURCE_SCOPE_INVALID')
    sources = [local_path(v) for v in plan['sources'].values()]
    require(all(p.is_dir() for p in sources), 'SOURCE_DIRECTORY_REQUIRED')
    require(len(set(sources)) == len(sources) and not any(a in b.parents for a in sources for b in sources if a != b), 'SOURCE_SCOPE_INVALID')
    e = plan['epoch']
    require(set(e) == {'host', 'bootId', 'endpoint', 'pidNamespace', 'netNamespace', 'workerUid', 'worker', 'engine'}, 'EPOCH_INVALID')
    require(e['host'] == hashlib.sha256(Path('/etc/machine-id').read_text().strip().encode()).hexdigest() and e['bootId'] == Path('/proc/sys/kernel/random/boot_id').read_text().strip() and e['workerUid'] == os.getuid(), 'HOST_EPOCH_CHANGED')
    require(e['pidNamespace'] == os.readlink('/proc/self/ns/pid') and e['netNamespace'] == os.readlink('/proc/self/ns/net'), 'NAMESPACE_CHANGED')
    require(set(plan['codePins']) == {'worker', 'engine'}, 'CODE_PINS_REQUIRED')
    require(e['worker']['pid'] != e['engine']['pid'] and all(type(e[r]['pid']) is int and e[r]['pid'] > 1 and e[r]['pid'] != os.getpid() and str(e[r]['start']).isdigit() for r in ['worker', 'engine']), 'PROCESS_PLAN_INVALID')
    require(isinstance(plan['holds'], list) and len(set(plan['holds'])) == len(plan['holds']) and set(plan['holds']) <= {'deployment', 'storage_error', 'manual', 'memory', 'legacy_unknown'} and {'deployment', 'storage_error'} <= set(plan['holds']), 'PROTECTIVE_HOLDS_REQUIRED')


def read_control(plan):
    path = Path(plan['store']) / 'mem%3Abackground-control%3Av1.bin'
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as f:
        require(os.fstat(f.fileno()).st_size <= 65536, 'CONTROL_UNAVAILABLE')
        raw = f.read(65537)
        quoted = escaped = False; depth = 0; end = None
        for index, byte in enumerate(raw):
            if quoted:
                if escaped: escaped = False
                elif byte == 92: escaped = True
                elif byte == 34: quoted = False
            elif byte == 34: quoted = True
            elif byte in (123, 91): depth += 1
            elif byte in (125, 93):
                depth -= 1
                if depth == 0: end = index + 1; break
        require(end is not None, 'CONTROL_UNAVAILABLE')
        def unique(pairs):
            result = {}
            for key, value in pairs:
                require(key not in result, 'DUPLICATE_CONTROL_KEY'); result[key] = value
            return result
        rows = json.loads(raw[:end].decode('utf8', errors='strict'), object_pairs_hook=unique)
    control = rows.get('manual-pause')
    require(isinstance(control, dict) and control.get('version') == 2 and control.get('paused') is True and sorted(control.get('holds', [])) == sorted(plan['holds']), 'HOLD_STATE_CHANGED')


def check_marker(plan):
    path = Path(plan['store']) / '.agentmemory-writer.lock'
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as f:
        require(os.fstat(f.fileno()).st_size <= 4096, 'WRITER_MARKER_INVALID')
        marker = json.load(f)
    require(marker.get('version') == 3 and marker.get('store') == hashlib.sha256(plan['store'].encode()).hexdigest() and marker.get('epoch') == plan['epoch'], 'WRITER_EPOCH_CHANGED')
    require(marker.get('unverifiedWriter') is not True and marker.get('blockedUntilBoot') is not True, 'WRITER_MARKER_BLOCKED')


def check_process(plan, role):
    p = plan['epoch'][role]
    require(proc_identity(p['pid']) == p, 'PROCESS_ID_CHANGED')
    root = Path(f'/proc/{p["pid"]}')
    require(root.stat().st_uid == os.getuid(), 'FOREIGN_PROCESS')
    require(os.readlink(root / 'ns/pid') == plan['epoch']['pidNamespace'] and os.readlink(root / 'ns/net') == plan['epoch']['netNamespace'], 'PROCESS_NAMESPACE_CHANGED')
    pin = plan['codePins'][role]
    require(set(pin) == {'executable', 'executableSha256', 'entrypoint', 'entrypointSha256'}, 'CODE_PIN_INVALID')
    local_path(pin['executable']); local_path(pin['entrypoint'])
    require(os.readlink(root / 'exe') == pin['executable'] and sha(pin['executable']) == pin['executableSha256'], 'EXECUTABLE_CHANGED')
    require(pin['entrypoint'] in (root / 'cmdline').read_bytes().decode().split('\0') and sha(pin['entrypoint']) == pin['entrypointSha256'], 'ENTRYPOINT_CHANGED')
    require(proc_identity(p['pid']) == p, 'PROCESS_ID_CHANGED')


def checkpoint(output, state):
    temp = output / ('checkpoint.' + uuid.uuid4().hex + '.new')
    payload = json.dumps(state, sort_keys=True) + '\n'
    require(len(payload.encode()) <= 4*1024*1024, 'CHECKPOINT_LIMIT')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(payload); f.flush(); os.fsync(f.fileno())
        os.replace(temp, output / 'checkpoint.json')
        fd = os.open(output, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if temp.exists(): temp.unlink()


def inventory(root, plan):
    rows = {}; stack = [(root, 0)]; entries = 0
    while stack:
        directory, depth = stack.pop()
        for path in sorted(directory.iterdir()):
            entries += 1; require(entries <= plan['maxFiles'] and depth < 64, 'COPY_LIMIT')
            s = path.lstat(); require(not stat.S_ISLNK(s.st_mode), 'SYMLINK_REFUSED')
            require(path.resolve() == path and s.st_dev == root.stat().st_dev, 'SOURCE_BOUNDARY_CHANGED')
            if stat.S_ISDIR(s.st_mode):
                require(len(stack) + len(rows) < plan['maxFiles'], 'COPY_LIMIT'); stack.append((path, depth + 1))
            else:
                require(stat.S_ISREG(s.st_mode), 'NONREGULAR_SOURCE')
                name = str(path.relative_to(root)); require(len(name.encode()) <= 512, 'SOURCE_NAME_LIMIT')
                rows[name] = signature(s)
                require(len(rows) <= plan['maxFiles'] and sum(v[2] for v in rows.values()) <= plan['maxBytes'], 'COPY_LIMIT')
    return rows



def open_source(root, name):
    parts = [*root.parts[1:], *Path(name).parts]
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = next_fd
        return os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    finally: os.close(fd)


def copy_sources(plan, destination, stable=False):
    manifests = {}; total_bytes = total_files = 0
    inventories = {label: inventory(Path(value), plan) for label, value in plan['sources'].items()}
    require(sum(len(v) for v in inventories.values()) <= plan['maxFiles'] and sum(item[2] for rows in inventories.values() for item in rows.values()) <= plan['maxBytes'], 'COPY_LIMIT')
    for label, value in plan['sources'].items():
        root = Path(value); before = inventories[label]; target = destination / label; target.mkdir(parents=True, mode=0o700)
        manifest = {}
        for name, expected in before.items():
            src = root / name; dst = target / name; dst.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            source_fd = open_source(root, name)
            with os.fdopen(source_fd, 'rb') as source:
                require(signature(os.fstat(source.fileno())) == expected, 'SOURCE_CHANGED')
                fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600); h = hashlib.sha256(); size = 0
                with os.fdopen(fd, 'wb') as copied:
                    for block in iter(lambda: source.read(1024 * 1024), b''):
                        size += len(block); require(total_bytes + size <= plan['maxBytes'], 'COPY_LIMIT'); h.update(block); copied.write(block)
                    copied.flush(); os.fsync(copied.fileno())
                if stable: os.fsync(source.fileno())
                after_fd = open_source(root, name)
                try: require(signature(os.fstat(source.fileno())) == expected and signature(os.fstat(after_fd)) == expected and size == expected[2], 'SOURCE_CHANGED')
                finally: os.close(after_fd)
            require(sha(dst) == h.hexdigest(), 'COPY_MISMATCH')
            total_bytes += size; total_files += 1; require(total_files <= plan['maxFiles'], 'COPY_LIMIT')
            manifest[name] = {'sha256': h.hexdigest(), 'bytes': size}
        for directory, _, _ in os.walk(target, topdown=False):
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try: os.fsync(fd)
            finally: os.close(fd)
        manifests[label] = manifest
    if stable:
        for label, value in plan['sources'].items():
            directories = {Path(value)} | {(Path(value) / name).parent for name in inventories[label]}
            for directory in directories:
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try: os.fsync(fd)
                finally: os.close(fd)
        require(all(inventory(Path(value), plan) == inventories[label] for label, value in plan['sources'].items()), 'STABLE_SOURCE_CHANGED')
    fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)
    return {'files': total_files, 'bytes': total_bytes, 'manifest': manifests}



def verify_acquisition(plan, root, evidence):
    require(isinstance(evidence, dict) and isinstance(evidence.get('manifest'), dict) and set(evidence['manifest']) == set(plan['sources']), 'LIVE_EVIDENCE_INVALID')
    files = size = 0
    for label, manifest in evidence['manifest'].items():
        require(isinstance(manifest, dict), 'LIVE_EVIDENCE_INVALID')
        actual = inventory(root / label, plan)
        require(set(actual) == set(manifest), 'LIVE_COPY_CHANGED')
        for name, item in manifest.items():
            require(isinstance(name, str) and not Path(name).is_absolute() and '..' not in Path(name).parts and isinstance(item, dict) and set(item) == {'sha256', 'bytes'}, 'LIVE_EVIDENCE_INVALID')
            require(type(item['bytes']) is int and item['bytes'] == actual[name][2] and isinstance(item['sha256'], str) and re.fullmatch('[0-9a-f]{64}', item['sha256']), 'LIVE_EVIDENCE_INVALID')
            files += 1; size += item['bytes']; require(files <= plan['maxFiles'] and size <= plan['maxBytes'], 'COPY_LIMIT')
            require(sha(root / label / name) == item['sha256'], 'LIVE_COPY_CHANGED')
    require(files == evidence.get('files') and size == evidence.get('bytes'), 'LIVE_EVIDENCE_INVALID')


def absent(plan, role):
    try:
        current = proc_identity(plan['epoch'][role]['pid'])
    except (FileNotFoundError, ProcessLookupError):
        try: os.kill(plan['epoch'][role]['pid'], 0)
        except ProcessLookupError: return True
        except PermissionError: pass
        raise Refused('PROCESS_VISIBILITY_UNCERTAIN')
    require(current == plan['epoch'][role], 'PID_REUSED')
    return False


def wait_gone(plan, role, pidfd):
    end = time.monotonic() + plan['timeoutSeconds']
    poller = select.poll(); poller.register(pidfd, select.POLLIN)
    while time.monotonic() < end:
        if poller.poll(20) and absent(plan, role): return
    raise Refused('PROCESS_STOP_UNCERTAIN')



def managed_service(plan):
    memberships = {role: any('agentmemory.service' in line.split(':', 2)[-1].strip().split('/') for line in Path(f'/proc/{plan["epoch"][role]["pid"]}/cgroup').read_text().splitlines()) for role in ['worker', 'engine']}
    require(not memberships['engine'] or memberships['worker'], 'WORKER_SUPERVISOR_CHANGED')
    return memberships['worker']


def service_state():
    command = ['/usr/bin/systemctl', 'show', 'agentmemory.service', '-p', 'ActiveState', '-p', 'MainPID', '-p', 'KillMode', '-p', 'SendSIGKILL']
    result = subprocess.run(command, capture_output=True, text=True, timeout=5)
    require(result.returncode == 0, 'SUPERVISOR_UNAVAILABLE')
    values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    jobs = subprocess.run(['/usr/bin/systemctl', 'list-jobs', '--no-legend', '--plain', '--no-pager'], capture_output=True, text=True, timeout=5)
    require(jobs.returncode == 0, 'SUPERVISOR_UNAVAILABLE')
    unit_jobs = [v for v in (line.split() for line in jobs.stdout.splitlines()) if len(v) >= 4 and v[1] == 'agentmemory.service']
    stop = any(v[2] == 'stop' for v in unit_jobs)
    return {'active': values.get('ActiveState'), 'mainPid': int(values.get('MainPID', '-1')), 'killMode': values.get('KillMode'), 'sendSigkill': values.get('SendSIGKILL'), 'stopJob': stop, 'jobsPresent': bool(unit_jobs)}


def service_stopped():
    value = service_state()
    require(value['killMode'] == 'process' and value['sendSigkill'] == 'no', 'SUPERVISOR_POLICY_CHANGED')
    return value['active'] in ('inactive', 'failed') and value['mainPid'] == 0 and not value['jobsPresent']


def await_service_stop(plan, output, state, handles):
    state['phase'] = 'awaiting_service_stop'; checkpoint(output, state)
    with (output / 'service-stop-ready').open('x') as ready:
        os.chmod(ready.name, 0o600); ready.write('normal-systemctl-stop-only\n'); ready.flush(); os.fsync(ready.fileno())
    end = time.monotonic() + plan['timeoutSeconds']
    while time.monotonic() < end:
        current = service_state()
        require(current['killMode'] == 'process' and current['sendSigkill'] == 'no', 'SUPERVISOR_POLICY_CHANGED')
        require(current['mainPid'] in (0, plan['epoch']['worker']['pid']), 'SUPERVISOR_IDENTITY_CHANGED')
        if current['active'] == 'deactivating' and current['stopJob'] and not state.get('serviceStopIntentObserved'):
            state['serviceStopIntentObserved'] = True; checkpoint(output, state)
        if state.get('serviceStopIntentObserved') and current['active'] in ('inactive', 'failed') and current['mainPid'] == 0 and not current['jobsPresent']:
            require(select.select([handles['worker']], [], [], 0)[0] and absent(plan, 'worker'), 'WORKER_STOP_UNCERTAIN')
            state['phase'] = 'worker_absent'; checkpoint(output, state); return
        time.sleep(.02)
    raise Refused('SUPERVISOR_STOP_NOT_PROVEN')


def run(planfile, output, verify_stopped=False, require_service=False):
    local_path(str(planfile))
    plan = private_json(planfile); validate(plan, verify_stopped); output = local_path(str(output))
    require(all(output != Path(p) and Path(p) not in output.parents and output not in Path(p).parents for p in plan['sources'].values()), 'DESTINATION_OVERLAP')
    state = {'version': 1, 'planSha256': plan_digest(plan), 'historicalMutationFailuresObserved': plan['historicalMutationFailuresObserved'], 'historicalWriteOutcome': 'unknown', 'quarantinedObserved': plan['quarantinedObserved'], 'holds': plan['holds'], 'phase': 'admitted', 'liveCopyConsistency': 'not_acquired', 'readyForColdStartVerification': False, 'historicalWriteRecovered': False, 'writerStarted': False}
    handles = {}; lock = None
    if verify_stopped:
        previous = private_json(output / 'checkpoint.json', maximum=4*1024*1024)
        require(previous.get('planSha256') == state['planSha256'] and previous.get('liveCopyConsistency') == 'non_atomic' and previous.get('phase') != 'stable_copy_verified', 'RESUME_EVIDENCE_REQUIRED')
        require(all(absent(plan, role) for role in ['worker', 'engine']), 'PROCESSES_REMAIN')
        verify_acquisition(plan, output / 'live', previous.get('live'))
        state = previous
        require(not require_service or state.get('supervised') is True, 'SUPERVISOR_SCOPE_REQUIRED')
        if state.get('supervised'): require(state.get('serviceStopIntentObserved') and service_stopped(), 'SUPERVISOR_STOP_NOT_PROVEN')
    else:
        require(not output.exists(), 'EXISTING_ACQUISITION_INSPECT_FIRST')
        check_marker(plan); read_control(plan)
        try:
            for role in ['worker', 'engine']:
                check_process(plan, role); handles[role] = os.pidfd_open(plan['epoch'][role]['pid']); check_process(plan, role)
            state['supervised'] = managed_service(plan)
            require(not require_service or state['supervised'], 'SUPERVISOR_SCOPE_REQUIRED')
            if state['supervised']:
                manager = service_state()
                require(manager['active'] == 'active' and manager['mainPid'] == plan['epoch']['worker']['pid'] and not manager['jobsPresent'], 'SUPERVISOR_IDENTITY_CHANGED')
                require(manager['killMode'] == 'process' and manager['sendSigkill'] == 'no', 'SUPERVISOR_POLICY_CHANGED')
            output.mkdir(mode=0o700)
        except Exception:
            for fd in handles.values(): os.close(fd)
            raise
    try:
        if not verify_stopped:
            checkpoint(output, state)
            state['live'] = copy_sources(plan, output / 'live'); state['liveCopyConsistency'] = 'non_atomic'; state['phase'] = 'live_copy_preserved'; checkpoint(output, state)
            roles = ['worker', 'engine']
            if state['supervised']:
                await_service_stop(plan, output, state, handles); roles = ['engine']
            for role in roles:
                if state.get('supervised'):
                    require(service_stopped(), 'SUPERVISOR_RESTARTED')
                    if role == 'engine' and absent(plan, role):
                        state['phase'] = 'engine_absent'; checkpoint(output, state); continue
                check_marker(plan); read_control(plan); check_process(plan, role)
                require(not select.select([handles[role]], [], [], 0)[0], 'PROCESS_EXITED_BEFORE_SIGNAL')
                state['phase'] = role + '_stop_intent'; checkpoint(output, state)
                signal.pidfd_send_signal(handles[role], signal.SIGTERM)
                wait_gone(plan, role, handles[role]); state['phase'] = role + '_absent'; checkpoint(output, state)
        require(all(absent(plan, role) for role in ['worker', 'engine']), 'PROCESSES_REMAIN')
        check_marker(plan); read_control(plan)
        lock = os.open(Path(plan['store']) / '.agentmemory-writer.lock', os.O_RDWR | os.O_NOFOLLOW)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(signature(os.fstat(lock))[:2] == signature((Path(plan['store']) / '.agentmemory-writer.lock').lstat())[:2], 'WRITER_LOCK_REPLACED')
        verify_acquisition(plan, output / 'live', state.get('live'))
        state['phase'] = 'stable_copy_intent'; checkpoint(output, state)
        # Never overwrite an interrupted partial stable copy.
        destination = output / ('stable' if not (output / 'stable').exists() else 'stable-resumed')
        require(not destination.exists(), 'STABLE_COPY_ALREADY_EXISTS')
        state['stable'] = copy_sources(plan, destination, stable=True)
        state['stableDirectory'] = destination.name
        require(all(absent(plan, role) for role in ['worker', 'engine']), 'PROCESSES_REMAIN')
        check_marker(plan); read_control(plan)
        if state.get('supervised'): require(service_stopped(), 'SUPERVISOR_RESTARTED')
        state['phase'] = 'stable_copy_verified'; state['readyForColdStartVerification'] = True; state['stableCopyConsistency'] = 'stable_under_cooperative_writer_lock'; state['requiresFreshStartupGuards'] = True
        checkpoint(output, state)
        return summary(state)
    except Exception as error:
        state['blockedAfter'] = state['phase']; state['phase'] = 'blocked'; state['readyForColdStartVerification'] = False
        state['errorCode'] = str(error) if isinstance(error, Refused) else 'MAINTENANCE_IO_OR_PROCESS_FAILURE'
        try: checkpoint(output, state)
        except Exception: pass
        raise Refused(state['errorCode']) from None
    finally:
        if lock is not None: os.close(lock)
        for fd in handles.values(): os.close(fd)


def summary(state):
    return {k: state[k] for k in ['phase', 'readyForColdStartVerification', 'historicalWriteRecovered', 'writerStarted']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--maintenance-cold-stop', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--verify-stopped-only', action='store_true')
    parser.add_argument('--require-service', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.maintenance_cold_stop, Path(args.output), args.verify_stopped_only, args.require_service)))
    except Exception as error:
        code = str(error) if isinstance(error, Refused) else 'MAINTENANCE_REFUSED'
        print(json.dumps({'phase': 'blocked', 'errorCode': code, 'readyForColdStartVerification': False, 'historicalWriteRecovered': False, 'writerStarted': False}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
