"""Synthetic release-kit shutdown protocol and preservation contracts only."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ShutdownTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'HOME': str(self.root), 'XDG_CONFIG_HOME': str(self.root / 'config')})
        self.env.start(); self.addCleanup(self.env.stop)
        self.module = load('kit-runtime')
        clock = patch.object(self.module.time, 'time', side_effect=lambda: next(self.clock))
        self.clock = iter([10, 12] * 100)
        clock.start(); self.addCleanup(clock.stop)
        self.tx = object.__new__(self.module.Runtime)
        self.tx.paths = {'runtime': self.root}
        self.tx.kit = {'shutdownCompletion': 'sdk-v1'}
        self.tx.start_attempted = True
        self.tx.certified_stopped = False
        self.tx.record = lambda *a, **kw: None
        (self.root / 'worker.pid').write_text('101')
        (self.root / 'iii.pid').write_text('102')
        self.receipt = {'pid': 101, 'at': '', 'completed': True, 'verified': False, 'errorCode': None,
                        'durability': {'completed': True, 'completion': 'sdk', 'synced': False, 'mutationFailures': 0}}
        fixture = self
        class System:
            stopped = False
            identity_checked = False
            remains = set()
            def verify_identity(self): self.identity_checked = True
            def main_pid(self): return 0 if self.stopped else 103
            def inactive(self): return self.stopped
            def alive(self, pid): return not self.stopped or pid in self.remains
            def service(self, action):
                assert action == 'stop'
                self.stopped = True
                fixture.receipt['at'] = datetime.datetime.fromtimestamp(11, datetime.timezone.utc).isoformat()
                (fixture.root / 'shutdown-receipt.json').write_text(json.dumps(fixture.receipt))
        self.tx.system = System()

    def test_opted_in_candidate_stop_accepts_completion_without_changing_disk_claim(self):
        self.tx.stop()
        self.assertTrue(self.tx.certified_stopped)
        self.assertTrue(self.tx.system.identity_checked)
        self.assertIs(self.tx.stop_receipt['verified'], False)
        self.assertIs(self.tx.stop_receipt['durability']['synced'], False)

    def test_default_and_pre_candidate_stop_reject_sdk(self):
        for kit, started in (({}, True), ({'shutdownCompletion': 'sdk-v1'}, False)):
            with self.subTest(kit=kit, started=started):
                self.tx.kit, self.tx.start_attempted = kit, started
                self.tx.system.stopped = False
                with self.assertRaisesRegex(RuntimeError, 'SHUTDOWN_NOT_VERIFIED'): self.tx.stop()

    def test_sdk_requires_both_completion_flags_no_error_and_no_mutation_failures(self):
        for field, value in (('completed', False), ('verified', True), ('errorCode', 'ENGINE_LOST')):
            with self.subTest(field=field):
                saved = self.receipt[field]; self.receipt[field] = value
                with self.assertRaisesRegex(RuntimeError, 'SHUTDOWN_NOT_VERIFIED'): self.tx.stop()
                self.receipt[field] = saved; self.tx.system.stopped = False
        for field, value in (('completed', False), ('synced', True), ('mutationFailures', 1), ('completion', 'unknown')):
            with self.subTest(durability=field):
                saved = self.receipt['durability'][field]; self.receipt['durability'][field] = value
                with self.assertRaisesRegex(RuntimeError, 'SHUTDOWN_NOT_VERIFIED'): self.tx.stop()
                self.receipt['durability'][field] = saved; self.tx.system.stopped = False

    def test_all_processes_must_exit(self):
        for pid in (101, 102, 103):
            with self.subTest(pid=pid):
                self.tx.system.remains = {pid}; self.tx.system.stopped = False
                with self.assertRaisesRegex(RuntimeError, 'SHUTDOWN_PROCESS_REMAINS'): self.tx.stop()

    def test_legacy_disk_contract_still_passes(self):
        self.tx.kit = {}
        self.receipt.update(verified=True)
        self.receipt['durability'] = {'synced': True, 'mutationFailures': 0}
        self.tx.stop()
        self.assertTrue(self.tx.certified_stopped)

    def test_sdk_candidate_cannot_restart_previous_release(self):
        self.tx.certified_stopped = True
        self.tx.candidate_background_control_version = 2
        self.tx.previous_recovery_compatible = True
        self.tx.verify_previous_recovery_files = lambda: None
        self.tx.guard = lambda **kw: self.fail('old code must remain stopped')
        with self.assertRaisesRegex(RuntimeError, 'SDK_ROLLBACK_RESTART_REFUSED'):
            self.tx.restore_previous_service()

    def test_recovery_requires_explicit_failed_sdk_protocol(self):
        self.tx.system.stopped = True
        with self.assertRaisesRegex(RuntimeError, 'SHUTDOWN_NOT_VERIFIED'):
            self.tx.require_stopped(self.receipt)
        self.tx.require_stopped(self.receipt, completion='sdk-v1')

    def test_sdk_apply_failure_keeps_manual_recovery_admissible(self):
        self.tx.stop_requested = True
        self.tx.preflight = lambda: None
        self.tx.backup_latest = lambda: None
        self.tx.stage = lambda: None
        self.tx.activate = lambda: None
        self.tx.verify_runtime = lambda: (_ for _ in ()).throw(RuntimeError('SYNTHETIC_FAILURE'))
        self.tx.rollback_code_only = lambda: setattr(self.tx, 'certified_stopped', True)
        self.tx.stage_attempted = True
        self.tx.phase = 'started'
        self.tx.paths['public_state'] = self.root
        def service(action):
            if action == 'start': self.tx.system.stopped = False
            else:
                self.tx.certified_stopped = True
                (self.root / 'shutdown-receipt.json').write_text('{}')
        self.tx.stop = lambda: service('stop')
        self.tx.system.service = service
        records = []
        self.tx.record = lambda phase, **extra: records.append((phase, extra))
        with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_FAILURE'): self.tx.apply()
        self.assertEqual(records[-1][1]['recoveryStatus'], 'manual_required')

    def test_shared_spool_snapshot_and_rollback_preserve_sdk_and_legacy_prefixes(self):
        self.tx.uid = os.getuid()
        self.tx.queues = load('kit-queues')
        self.tx.paths['shared_spool'] = self.root / 'home/.local/share/agentmemory/capture-spool'
        source = self.tx.paths['shared_spool']; source.mkdir(parents=True, mode=0o700)
        files = {'legacy.jsonl': b'old', 'sdk-originals/source': b'new', 'held/quota': b'quota', '.tmp/pending': b'pending'}
        for name, data in files.items():
            path = source / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        result = self.tx.user_shared_source_snapshot()
        self.addCleanup(lambda: self.module.shutil.rmtree(result['directory'], ignore_errors=True))
        self.tx.shared_source_snapshot = result['record']
        for name, data in files.items(): self.assertEqual((Path(result['directory']) / 'snapshot' / name).read_bytes(), data)
        (source / 'legacy.jsonl').write_bytes(b'old appended')
        self.tx.user_verify_shared_source()
        (source / 'sdk-originals/source').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'SHARED_SOURCE_CHANGED'): self.tx.user_verify_shared_source()


    def test_shared_backup_is_private_readback_and_removes_own_staging(self):
        self.tx.uid, self.tx.gid = os.getuid(), os.getgid()
        self.tx.queues = load('kit-queues')
        self.tx.paths['shared_spool'] = self.root / 'home/shared-spool'
        self.tx.paths['shared_spool'].mkdir(parents=True, mode=0o700)
        (self.tx.paths['shared_spool'] / 'original').write_bytes(b'original')
        self.tx.backup = self.root / 'private-backup'; self.tx.backup.mkdir(mode=0o700)
        self.module.USER_ENV['HOME'] = str(self.root)
        self.tx.backup_shared_source()
        self.assertEqual((self.tx.backup / 'shared-spool/original').read_bytes(), b'original')
        self.assertEqual((self.tx.paths['shared_spool'] / 'original').read_bytes(), b'original')
        self.assertEqual(list(self.root.glob('.sdk-source-*')), [])
        self.assertIs(self.module.read_json(self.tx.backup / 'shared-source.json')['liveSourceModified'], False)

    def test_shared_source_symlink_and_missing_original_fail_closed(self):
        self.tx.uid = os.getuid(); self.tx.queues = load('kit-queues')
        source = self.root / 'shared'; source.mkdir(mode=0o700)
        self.tx.paths['shared_spool'] = source
        (source / 'original').write_bytes(b'original')
        saved = self.tx.user_shared_source_snapshot()
        self.addCleanup(lambda: self.module.shutil.rmtree(saved['directory'], ignore_errors=True))
        self.tx.shared_source_snapshot = saved['record']
        (source / 'original').unlink()
        with self.assertRaisesRegex(RuntimeError, 'SHARED_SOURCE_CHANGED'): self.tx.user_verify_shared_source()
        (source / 'original').symlink_to(self.root / 'worker.pid')
        with self.assertRaisesRegex(RuntimeError, 'SHARED_SOURCE_CHANGED'): self.tx.user_verify_shared_source()


    def test_root_never_reads_replaced_staging_directory(self):
        self.tx.uid, self.tx.gid = os.getuid(), os.getgid()
        self.tx.queues = load('kit-queues')
        source = self.root / 'shared'; source.mkdir(mode=0o700)
        self.tx.paths['shared_spool'] = source
        (source / 'original').write_bytes(b'original')
        self.tx.backup = self.root / 'backup'; self.tx.backup.mkdir(mode=0o700)
        self.module.USER_ENV['HOME'] = str(self.root)
        outside = self.root / 'outside/snapshot'; outside.mkdir(parents=True)
        (outside / 'original').write_bytes(b'OUTSIDE SECRET')
        real_trusted = self.module.trusted
        def swap(path, *args):
            real_trusted(path, *args)
            path = Path(path)
            if path.name.startswith('.sdk-source-'):
                path.rename(path.with_name('saved-stage'))
                path.symlink_to(outside.parent, target_is_directory=True)
        with patch.object(self.module, 'trusted', side_effect=swap):
            with self.assertRaises((RuntimeError, OSError)): self.tx.backup_shared_source()
        leaked = self.tx.backup / 'shared-spool/original'
        self.assertFalse(leaked.exists(), 'root must reject the swap before reading outside bytes')


class ManifestTests(unittest.TestCase):
    write = load('test_dashboard_kit').TransactionTests.write
    api = load('test_dashboard_kit').TransactionTests.api

    def setUp(self):
        load('test_dashboard_kit').TransactionTests.setUp(self)
        self.runtime.USER_ENV['HOME'] = str(self.root)

    def test_version31_is_admitted_but_other_minors_are_refused(self):
        kit_path = self.tx.root / 'kit.json'
        original = self.runtime.read_json(kit_path)
        for version in ('0.9.31-daniel.33', '0.9.32-daniel.1'):
            value = {**original, 'version': version}
            kit_path.write_text(json.dumps(value))
            if version.startswith('0.9.31'):
                with self.assertRaisesRegex(RuntimeError, 'CANDIDATE_IDENTITY_MISMATCH'):
                    self.runtime.Runtime(self.tx.root, paths=self.paths, owner=os.getuid(), anchor=self.root)
            else:
                with self.assertRaisesRegex(RuntimeError, 'INVALID_VERSION'):
                    self.runtime.Runtime(self.tx.root, paths=self.paths, owner=os.getuid(), anchor=self.root)

    def test_reviewed_sdk_kit_also_requires_sdk_package_capability(self):
        self.tx.kit['shutdownCompletion'] = 'sdk-v1'
        with self.assertRaisesRegex(RuntimeError, 'SDK_PACKAGE_CAPABILITY_REQUIRED'):
            self.tx.verify_dependency_reuse()

class BundledDependencyTests(unittest.TestCase):
    write = ManifestTests.write
    api = ManifestTests.api

    def setUp(self):
        ManifestTests.setUp(self)
        self.current_dependencies = {'iii-sdk': '0.22.1', '@iii-dev/helpers': '0.22.1', 'unchanged': '1.0.0'}
        self.proposed_dependencies = {**self.current_dependencies, 'iii-sdk': '0.25.0', '@iii-dev/helpers': '0.25.0', 'yaml': '^2.8.1', 'json5': '^2.2.3'}
        self.profile = {'backgroundControlVersion': 2, 'automaticMemoryRecovery': True, 'storageCompletion': 'sdk-v1', 'nativeEngineCompatibility': '0.22.1'}
        self.tx.kit['shutdownCompletion'] = 'sdk-v1'
        self.write(self.paths['legacy'] / 'package.json', json.dumps({'dependencies': self.current_dependencies}).encode())

    def candidate(self, *, dependencies=None, profile=None, extra_files=None, extra_manifest=None):
        import io
        import tarfile
        proposed = {'dependencies': dependencies or self.proposed_dependencies, 'agentmemoryCompatibility': profile or self.profile, **(extra_manifest or {})}
        files = {'package.json': json.dumps(proposed).encode(), **(extra_files or {})}
        self.tx.release['packageFiles'] = {name: self.runtime.hashlib.sha256(data).hexdigest() for name, data in files.items()}
        with tarfile.open(self.tx.root / 'package.tgz', 'w:gz') as archive:
            for name, data in files.items():
                entry = tarfile.TarInfo('package/' + name); entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))

    def test_sdk_native_profile_alone_never_relaxes_dependency_reuse(self):
        self.candidate()
        with self.assertRaisesRegex(RuntimeError, 'DEPENDENCY_REUSE_NOT_COMPATIBLE'):
            self.tx.verify_dependency_reuse()


    def bundle(self, *, code=None, closure_update=None, dependencies=None, extra_manifest=None):
        files = code or {'dist/cli.mjs': b'import path from "node:path"; export const value = 1;', 'dist/chunk.js': b'export const chunk = true;'}
        closure = {'version': 1, 'mode': 'bundled-sdk0.25-v1',
                   'bundledPackages': {'iii-sdk': '0.25.0', '@iii-dev/helpers': '0.25.0', 'yaml': '2.8.1', 'json5': '2.2.3'},
                   'files': {name: self.runtime.hashlib.sha256(data).hexdigest() for name, data in files.items()},
                   'externalSpecifiers': {name: [] for name in files}}
        if closure_update: closure_update(closure)
        files = {**files, 'dist/server-sdk-bundle.json': json.dumps(closure).encode()}
        self.candidate(profile={**self.profile, 'serverDependencyMode': 'bundled-sdk0.25-v1'}, dependencies=dependencies, extra_files=files, extra_manifest=extra_manifest)

    def test_exact_four_dependency_delta_requires_verified_complete_bundle(self):
        self.bundle()
        self.tx.verify_dependency_reuse()

    def test_bundle_mode_requires_closure_even_for_unchanged_dependencies(self):
        self.candidate(profile={**self.profile, 'serverDependencyMode': 'bundled-sdk0.25-v1'}, dependencies=self.current_dependencies)
        with self.assertRaisesRegex(RuntimeError, 'SDK_BUNDLE_CLOSURE_REQUIRED'): self.tx.verify_dependency_reuse()

    def test_missing_or_wrong_hash_inventory_and_unknown_version_are_rejected(self):
        mutations = (lambda row: row['files'].pop('dist/chunk.js'),
                     lambda row: row['files'].update({'dist/chunk.js': '0' * 64}),
                     lambda row: row.update(version=2),
                     lambda row: row['externalSpecifiers'].pop('dist/chunk.js'))
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.bundle(closure_update=mutate)
                with self.assertRaisesRegex(RuntimeError, 'SDK_BUNDLE_UNVERIFIED'): self.tx.verify_dependency_reuse()

    def test_bound_package_bytes_cannot_differ_from_release_hashes(self):
        self.bundle()
        self.tx.release['packageFiles']['dist/cli.mjs'] = '0' * 64
        with self.assertRaises(RuntimeError): self.tx.verify_dependency_reuse()
        self.bundle()
        self.tx.release['packageFiles']['dist/server-sdk-bundle.json'] = '0' * 64
        with self.assertRaises(RuntimeError): self.tx.verify_dependency_reuse()

    def test_forged_empty_external_audit_cannot_hide_forbidden_imports(self):
        for statement in (b'import x from "iii-sdk";', b'export * from "@iii-dev/helpers/http";',
                          b'await import("yaml");', b'require("json5");', b'await import("@opentelemetry/api");',
                          b'const child = "require(\\\"iii-sdk\\\")";', b'await import/*comment*/("iii-sdk");',
                          b'const sdk = require("iii\\x2dsdk");', b'const __require = require; __require("iii-sdk");', b'await import(`iii-sdk`);'):
            with self.subTest(statement=statement):
                self.bundle(code={'dist/cli.mjs': statement})
                with self.assertRaisesRegex(RuntimeError, 'SDK_BUNDLE_UNVERIFIED'): self.tx.verify_dependency_reuse()

    def test_audit_forbidden_specifier_is_rejected_even_without_matching_source(self):
        self.bundle(closure_update=lambda row: row['externalSpecifiers']['dist/cli.mjs'].append('iii-sdk'))
        with self.assertRaisesRegex(RuntimeError, 'SDK_BUNDLE_UNVERIFIED'): self.tx.verify_dependency_reuse()

    def test_extra_dependency_optional_engine_changes_remain_rejected(self):
        for dependencies, extra in (({**self.proposed_dependencies, 'unchanged': '2.0.0'}, {}),
                                    (self.proposed_dependencies, {'optionalDependencies': {'unexpected': '1'}}),
                                    (self.proposed_dependencies, {'engines': {'node': '>=99'}})):
            with self.subTest(extra=extra, dependencies=dependencies):
                self.bundle(dependencies=dependencies, extra_manifest=extra)
                with self.assertRaisesRegex(RuntimeError, 'DEPENDENCY_REUSE_NOT_COMPATIBLE'): self.tx.verify_dependency_reuse()


    def test_bundle_capability_never_authorizes_unreviewed_kit_or_other_old_sdk(self):
        self.bundle()
        self.tx.kit.pop('shutdownCompletion')
        with self.assertRaisesRegex(RuntimeError, 'DEPENDENCY_REUSE_NOT_COMPATIBLE'): self.tx.verify_dependency_reuse()
        self.tx.kit['shutdownCompletion'] = 'sdk-v1'
        self.write(self.paths['legacy'] / 'package.json', json.dumps({'dependencies': {**self.current_dependencies, 'iii-sdk': '0.24.0'}}).encode())
        with self.assertRaisesRegex(RuntimeError, 'DEPENDENCY_REUSE_NOT_COMPATIBLE'): self.tx.verify_dependency_reuse()

    def test_actual_tar_member_tampering_is_rejected(self):
        import io
        import tarfile
        for changed in ('dist/cli.mjs', 'dist/server-sdk-bundle.json'):
            with self.subTest(changed=changed):
                self.bundle()
                path = self.tx.root / 'package.tgz'
                with tarfile.open(path) as archive:
                    files = {member.name: archive.extractfile(member).read() for member in archive if member.isfile()}
                files['package/' + changed] += b' altered'
                with tarfile.open(path, 'w:gz') as archive:
                    for name, data in files.items():
                        member = tarfile.TarInfo(name); member.size = len(data); archive.addfile(member, io.BytesIO(data))
                with self.assertRaisesRegex(RuntimeError, 'SDK_BUNDLE_UNVERIFIED'): self.tx.verify_dependency_reuse()


    def test_harmless_bundled_component_labels_are_allowed(self):
        self.bundle(code={'dist/cli.mjs': b'const component = "iii-sdk"; const telemetry = "@opentelemetry/api"; const parser = "yaml";'})
        self.tx.verify_dependency_reuse()


    def test_unlisted_runtime_javascript_in_tar_is_rejected(self):
        import io
        import tarfile
        self.bundle()
        path = self.tx.root / 'package.tgz'
        with tarfile.open(path) as archive:
            files = {member.name: archive.extractfile(member).read() for member in archive if member.isfile()}
        files['package/dist/hidden.cjs'] = b'require("iii-sdk");'
        with tarfile.open(path, 'w:gz') as archive:
            for name, data in files.items():
                member = tarfile.TarInfo(name); member.size = len(data); archive.addfile(member, io.BytesIO(data))
        with self.assertRaisesRegex(RuntimeError, 'SDK_BUNDLE_UNVERIFIED'): self.tx.verify_dependency_reuse()


    def test_malformed_bundle_text_returns_stable_refusal(self):
        for code in (b'\xff', b'const label = "\\u{FFFFFF}";'):
            with self.subTest(code=code):
                self.bundle(code={'dist/cli.mjs': code})
                with self.assertRaisesRegex(RuntimeError, 'SDK_BUNDLE_UNVERIFIED'): self.tx.verify_dependency_reuse()

    def test_malformed_bound_closure_json_returns_stable_refusal(self):
        self.candidate(profile={**self.profile, 'serverDependencyMode': 'bundled-sdk0.25-v1'},
                       extra_files={'dist/cli.mjs': b'export const synthetic = true;', 'dist/server-sdk-bundle.json': b'{malformed'})
        with self.assertRaisesRegex(RuntimeError, 'SDK_BUNDLE_UNVERIFIED'): self.tx.verify_dependency_reuse()



class SdkCandidateTests(unittest.TestCase):
    candidate_compatibility = {'backgroundControlVersion': 2, 'automaticMemoryRecovery': False, 'storageCompletion': 'sdk-v1'}
    write = load('test_dashboard_kit').TransactionTests.write
    api = load('test_dashboard_kit').TransactionTests.api

    def setUp(self):
        load('test_dashboard_kit').TransactionTests.setUp(self)
        self.runtime.USER_ENV['HOME'] = str(self.root)
        self.tx.kit['shutdownCompletion'] = 'sdk-v1'

    def test_capable_candidate_backs_up_fixed_shared_source_before_start(self):
        source = self.paths['shared_spool'] / 'sdk-originals/raw'
        self.write(source, b'synthetic original')
        self.tx.verify_dependency_reuse()
        self.tx.preflight()
        now = self.runtime.time.time()
        with patch.object(self.runtime.time, 'time', side_effect=[now - 1, now + 1]): self.tx.stop()
        self.tx.backup_latest()
        self.assertEqual((self.tx.backup / 'shared-spool/sdk-originals/raw').read_bytes(), b'synthetic original')
        self.tx.verify_data()
        self.write(source, b'changed')
        with self.assertRaisesRegex(RuntimeError, 'SHARED_SOURCE_CHANGED'): self.tx.verify_data()
        self.assertEqual(self.system.actions, ['stop'])



class PreservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.integrity = load('kit-integrity')
        self.before, self.current = self.root / 'before', self.root / 'current'
        for directory in (self.before, self.current):
            (directory / 'state_store.db').mkdir(parents=True)
            self.write(directory, 'mem%3Aindex%3Abm25.bin', {})

    def write(self, directory, name, data):
        (directory / 'state_store.db' / name).write_text(json.dumps(data))

    def test_sdk_inbox_marker_and_original_are_immutable(self):
        original = {'sdk': {'key': 'sdk', 'storageCompletion': 'sdk', 'payload': {'data': 'source'}, 'attempts': 1}}
        self.write(self.before, 'mem%3Acapture%3Ainbox.bin', original)
        for changed in ({'sdk': {**original['sdk'], 'storageCompletion': 'disk'}}, {}):
            self.write(self.current, 'mem%3Acapture%3Ainbox.bin', changed)
            with self.assertRaisesRegex(RuntimeError, 'SDK_CAPTURE_EVIDENCE_CHANGED'):
                self.integrity.verify(self.before, self.current)

    def test_background_hold_and_budget_cannot_disappear(self):
        original = {'manual-pause': {'version': 2, 'paused': True, 'resumePending': False,
                    'holds': ['manual', 'deployment', 'memory'], 'recovery': {'attempts': 2, 'nextAttemptAt': 900}}}
        self.write(self.before, 'mem%3Abackground-control%3Av1.bin', original)
        changed = {'manual-pause': {**original['manual-pause'], 'holds': ['manual']}}
        self.write(self.current, 'mem%3Abackground-control%3Av1.bin', changed)
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_BACKGROUND_HOLDS_CHANGED'):
            self.integrity.verify(self.before, self.current, allow_background_hold=True)

    def test_unknown_history_and_sdk_archives_survive_recursive_backup(self):
        queues, runtime = load('kit-queues'), load('kit-runtime')
        source = self.root / 'data'; source.mkdir()
        files = {'capture-spool/local.jsonl': b'legacy', 'capture-spool/accepted/raw': b'accepted',
                 'capture-spool/sdk-originals/raw': b'sdk original', 'unknown-history.bin': b'opaque'}
        for name, data in files.items():
            path = source / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        guard = object.__new__(runtime.Runtime)
        target = self.root / 'backup'
        snapshot = queues.backup_tree(source, target, 'capture-spool', guard, guard.copy_private)
        self.assertEqual(snapshot['consistency'], 'per-file-verified-prefix')
        self.assertFalse(snapshot['liveQueueModified'])
        for name, data in files.items():
            self.assertEqual((source / name).read_bytes(), data)
            self.assertEqual((target / name).read_bytes(), data)


if __name__ == '__main__': unittest.main()
