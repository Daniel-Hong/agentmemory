import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class KitTests(unittest.TestCase):
    def test_draft_cannot_synthesize_administrator_approval(self):
        prepare = load('prepare-dashboard-kit')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'payload'
            source.write_bytes(b'package fixture')
            metadata = {'id': 'release-6', 'version': '0.9.30-daniel.6', 'sourceCommit': 'a' * 40,
                        'packageSha256': prepare.sha(source), 'changeSummary': 'Reviewed release', 'tests': ['fixture']}
            draft = root / 'draft'
            prepare.prepare(source, {'packageFiles': {'package.json': 'b' * 64}}, {}, metadata, draft)
            kit = json.loads((draft / 'kit.json').read_text())
            review = json.loads((draft / 'review-template.json').read_text())
            self.assertFalse(kit['executionClosureReviewed'])
            self.assertFalse(review['executionClosureReviewed'])
            self.assertEqual(review['reviewedBy'], '')
            self.assertEqual(review['draftManifestSha256'], prepare.sha(draft / 'kit.json'))

    def test_user_owned_or_unreviewed_kit_cannot_be_enrolled(self):
        enroll = load('enroll-reviewed-kit')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            review = root / 'review.json'
            review.write_text(json.dumps({'executionClosureReviewed': False, 'reviewedBy': ''}))
            review.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, 'ROOT_OWNED_PATH_REQUIRED'):
                enroll.read_review(review, owner=os.getuid() + 1, anchor=root)
            with self.assertRaisesRegex(RuntimeError, 'ADMINISTRATOR_REVIEW_REQUIRED'):
                enroll.read_review(review, owner=os.getuid(), anchor=root)

    def test_root_apply_rejects_external_python_before_import(self):
        runtime = load('kit-runtime')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            outside = root / 'outside.py'
            outside.write_text('raise AssertionError("external code must never load")')
            outside.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, 'ROOT_OWNED_PATH_REQUIRED'):
                runtime.load_helper(root, 'kit-integrity.py', owner=os.getuid() + 1, anchor=root)
            with self.assertRaisesRegex(RuntimeError, 'UNSUPPORTED_HELPER'):
                runtime.load_helper(root, 'outside.py', owner=os.getuid(), anchor=root)


class TransactionTests(unittest.TestCase):
    def setUp(self):
        import io
        import tarfile
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = load('kit-runtime')
        self.prepare = load('prepare-dashboard-kit')
        self.enroll = load('enroll-reviewed-kit')
        self.paths = {k: self.root / v.lstrip('/') for k, v in self.runtime.DEFAULT_PATHS.items()}
        self.paths['rootfs'] = self.root
        for key, path in self.paths.items():
            if key not in ('env', 'engine', 'dropin', 'rootfs'):
                path.mkdir(parents=True, exist_ok=True)
        self.write(self.paths['env'], b'AGENTMEMORY_SECRET=synthetic\n')
        self.write(self.paths['engine'], b'synthetic engine')
        self.write(self.paths['dropin'], b'old dropin', 0o644)
        self.write(self.paths['legacy'] / 'node_modules/dependency/index.js', b'dependency')
        self.write(self.paths['legacy'] / 'package.json', b'{}')
        self.write(self.paths['runtime'] / 'worker.pid', b'101')
        self.write(self.paths['runtime'] / 'iii.pid', b'102')
        self.write(self.paths['data'] / 'state_store.db/mem%3Aindex%3Abm25.bin', b'{}')
        self.raw = self.paths['data'] / 'state_store.db/mem%3Aobs%3Atest.bin'
        self.write(self.raw, b'{"a":{"sourceRaw":{"raw":"original"}}}')
        self.hook = self.root / 'home/daniel/.claude/settings.json'
        self.write(self.hook, b'old hook command')
        for name in self.runtime.WRAPPERS:
            self.write(self.paths['bin'] / name, b'old ' + name.encode(), 0o755)
        assets = {}
        for name, mode in self.runtime.ROOT_ASSETS.items():
            target = self.root / name.lstrip('/')
            self.write(target, b'fixed root asset', mode)
            assets[str(target)] = self.runtime.sha(target)
        protected = {str(p): self.runtime.sha(p) for p in (self.hook, self.paths['env'], self.paths['engine'], self.paths['dropin'], *[self.paths['bin'] / n for n in self.runtime.WRAPPERS])}
        old_receipt = self.root / 'old-receipt.json'
        self.write(old_receipt, b'{"applied":true,"sourceCommit":"previous"}')
        self.old_archive = self.root / 'old.tar.gz'
        with tarfile.open(self.old_archive, 'w:gz') as tar:
            info = tarfile.TarInfo('old-code'); info.size = 3
            tar.addfile(info, io.BytesIO(b'old'))
        manifest = {'version': '0.9.30-daniel.6'}
        if getattr(self, 'candidate_compatibility', None) is not None or getattr(self, 'explicit_null_candidate_profile', False):
            manifest['agentmemoryCompatibility'] = self.candidate_compatibility
        files = {'package.json': json.dumps(manifest).encode(), 'dist/cli.mjs': b'// synthetic CLI'}
        files.update({f'plugin/scripts/codex-compat/{i}.js': str(i).encode() for i in range(13)})
        hashes = {n: self.runtime.hashlib.sha256(v).hexdigest() for n, v in files.items()}
        package = self.root / 'package.tgz'
        with tarfile.open(package, 'w:gz') as tar:
            for name, data in files.items():
                info = tarfile.TarInfo('package/' + name); info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        release = {'sourceCommit': 'a' * 40, 'packageVersion': '0.9.30-daniel.6', 'packageFiles': hashes, 'artifactHashes': {}, 'verificationFiles': {}}
        baseline = {'protectedFiles': protected, 'rootAssets': assets, 'compatibilityFiles': {n: h for n, h in hashes.items() if n.startswith('plugin/')}, 'receiptPath': str(old_receipt), 'receiptIdentity': {'applied': True, 'sourceCommit': 'previous'}, 'archives': [{'path': str(self.old_archive), 'sha256': self.runtime.sha(self.old_archive), 'files': {'old-code': self.runtime.hashlib.sha256(b'old').hexdigest()}}]}
        metadata = {'id': 'release-6', 'version': release['packageVersion'], 'sourceCommit': release['sourceCommit'], 'packageSha256': self.runtime.sha(package), 'changeSummary': 'Synthetic fixture', 'tests': ['isolated transaction']}
        self.draft = self.root / 'draft'
        self.prepare.prepare(package, release, baseline, metadata, self.draft)
        self.review = self.root / 'review.json'
        self.write(self.review, json.dumps({'executionClosureReviewed': True, 'reviewedBy': 'explicit fixture administrator', 'draftManifestSha256': self.runtime.sha(self.draft / 'kit.json')}).encode())
        self.state = self.root / 'var/lib/agentmemory-updates'
        (self.state / 'public').mkdir(exist_ok=True)
        self.runner = self.root / 'runner'
        self.write(self.runner, b'fixture runner')
        for directory in self.root.rglob('*'):
            if directory.is_dir():
                directory.chmod(0o755)
        self.calls = []
        self.enroll.install(self.draft, self.review, state=self.state, runner=self.runner, owner=os.getuid(), anchor=self.root, run=lambda args, **kw: self.calls.append(args))
        self.system = FakeSystem(self)
        self.tx = self.runtime.Runtime(self.paths['public'] / 'release-6', paths=self.paths, owner=os.getuid(), anchor=self.root, service_uid=os.getuid(), service_gid=os.getgid(), system=self.system)
        self.tx.api = self.api

    def write(self, path, data, mode=0o600):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)

    def api(self, path, body=None):
        if path == 'health':
            return {'version': '0.9.30-daniel.6', 'status': 'healthy', 'storageDurability': {'mutationFailures': 0}}
        if path == 'memories?latest=true':
            return {'memories': [{'title': 'AgentMemory 운영 및 유지보수 가이드'}]}
        if path == 'background/control':
            return {'control': {'pausedRequested': True, 'status': 'paused' if self.system.started else 'pausing', 'activeOperations': 0 if self.system.started else 3, 'error': None}}
        return {'sessions': [], 'flags': [], 'scheduleEnabled': False}

    def test_reviewed_snapshot_enrolls_without_apply_and_entire_transaction_preserves_data(self):
        self.assertEqual(self.calls[0][4], '--enroll')
        self.assertFalse(any('systemctl' in item or item == '--apply' for item in self.calls[0]))
        original, hook = self.raw.read_bytes(), self.hook.read_bytes()
        self.tx.apply()
        receipt = self.runtime.read_json(self.tx.receipt)
        self.assertEqual(receipt['receiptId'], 'personal-deployment')
        self.assertFalse(receipt['verificationComplete'])
        self.assertTrue(receipt['preservationReceipt']['readBackVerified'])
        self.assertEqual(self.raw.read_bytes(), original)
        self.assertEqual(self.hook.read_bytes(), hook)
        self.assertEqual(self.system.actions, ['stop', 'reload', 'start'])
        self.tx.guard()

    def test_uncertified_shutdown_never_backs_up_stages_or_starts(self):
        for fault in ('stale', 'wrong-pid', 'unsynced', 'alive'):
            with self.subTest(fault=fault):
                self.system.fault = fault
                with self.assertRaises(RuntimeError):
                    self.tx.apply()
                self.assertIsNone(self.tx.backup)
                self.assertFalse(self.tx.version.exists())
                self.assertNotIn('start', self.system.actions)
                self.system.stopped = False

    def test_next_update_baseline_is_json_only_and_preserves_all_prior_archives(self):
        self.tx.apply()
        prior = self.prepare.baseline_from_kit(self.tx.public, self.tx.receipt)
        self.assertEqual(len(prior['archives']), 2)
        self.assertEqual(prior['compatibilityFiles'], self.tx.baseline['compatibilityFiles'])
        for archive in prior['archives']:
            self.runtime.verify_archive(archive['path'], archive['sha256'], archive['files'])
        self.assertEqual(prior['receiptIdentity']['sourceCommit'], self.tx.kit['sourceCommit'])

    def test_existing_runner_accepts_exact_reviewed_kit_shape(self):
        runner = load('dashboard-updates')
        checked = runner.Runner(state=self.state, trusted_uid=os.getuid(), request_uid=os.getuid(), trust_anchor=self.root).checked_kit(self.state / 'incoming/release-6')
        self.assertEqual(checked['entrypoint'], 'kit-runtime.py')
        self.assertTrue(checked['executionClosureReviewed'])

    def test_root_asset_modes_and_package_tar_links_are_rejected(self):
        import io
        import tarfile
        asset = self.root / 'usr/local/libexec/agentmemory-update-runner'
        asset.chmod(0o775)
        with self.assertRaisesRegex(RuntimeError, 'ROOT_OWNED_PATH_REQUIRED'):
            self.tx.preflight()
        asset.chmod(0o755)
        self.tx.preflight(); self.tx.stop(); self.tx.backup_latest()
        with tarfile.open(self.tx.public / 'package.tgz', 'w:gz') as package:
            member = tarfile.TarInfo('package/evil'); member.type = tarfile.SYMTYPE; member.linkname = '/etc/shadow'
            package.addfile(member)
        with self.assertRaisesRegex(RuntimeError, 'UNSAFE_PACKAGE'):
            self.tx.user_stage()
        self.assertFalse((self.tx.version / 'evil').exists())

    def test_fork_uses_service_identity_and_drops_other_file_descriptors(self):
        fd = os.open(self.review, os.O_RDONLY)
        try:
            result = self.runtime.run_as_user(lambda: {'uid': os.geteuid(), 'gid': os.getegid(), 'env': list(os.environ), 'extraOpen': Path('/proc/self/fd/' + str(fd)).exists()}, os.getuid(), os.getgid())
        finally:
            os.close(fd)
        self.assertEqual(result['uid'], os.getuid())
        self.assertEqual(result['gid'], os.getgid())
        self.assertFalse(result['extraOpen'])
        self.assertEqual(set(result['env']), {'PATH', 'HOME', 'LANG'})

    def test_retained_npm_symlinks_are_backed_up_without_following_external_links(self):
        link = self.paths['legacy'] / 'node_modules/.bin/dependency'
        link.parent.mkdir()
        link.symlink_to('../dependency/index.js')
        self.tx.preflight(); self.tx.stop(); self.tx.backup_latest()
        saved = self.tx.backup / 'retained-package/node_modules/.bin/dependency'
        self.assertEqual(os.readlink(saved), '../dependency/index.js')
        self.assertEqual(saved.read_bytes(), b'dependency')
        link.unlink(); link.symlink_to(self.paths['env'])
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_SYMLINK_REFUSED'):
            self.tx.copy_private(self.paths['legacy'], self.root / 'bad-copy', allowed_root=self.paths['legacy'])
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_SYMLINK_REFUSED'):
            self.tx.copy_private(link, self.root / 'bad-env-copy')

    def test_dependency_reuse_changes_reject_before_pause_or_service_stop(self):
        executed = 0
        for field in ('dependencies', 'optionalDependencies', 'engines'):
            with self.subTest(field=field):
                self.write(self.paths['legacy'] / 'package.json', json.dumps({field: {'changed': '99'}}).encode())
                self.tx.api = lambda *a, **kw: self.fail('API reached before dependency compatibility check')
                with self.assertRaisesRegex(RuntimeError, 'DEPENDENCY_REUSE_NOT_COMPATIBLE'):
                    self.tx.preflight()
                self.assertEqual(self.system.actions, [])
                self.assertIsNone(self.tx.backup)
                executed += 1
        self.assertEqual(executed, 3)

    def test_unwritable_install_paths_reject_before_api_pause_and_stop(self):
        parent = self.paths['releases']
        parent.chmod(0o555)
        try:
            self.tx.api = lambda *args, **kw: self.fail('API reached before install permission check')
            with self.assertRaisesRegex(RuntimeError, 'INSTALL_PATH_NOT_WRITABLE'):
                self.tx.apply()
            self.assertEqual(self.system.actions, [])
        finally:
            parent.chmod(0o755)

    def test_failure_after_certified_stop_restores_previous_service_without_data_restore(self):
        def failed_backup():
            raise RuntimeError('BACKUP_READBACK_FAILED')
        self.tx.backup_latest = failed_backup
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_READBACK_FAILED'):
            self.tx.apply()
        self.assertEqual(self.system.actions, ['stop', 'start'])
        state = self.runtime.read_json(self.paths['public_state'] / 'release-6.json')
        self.assertEqual(state['recoveryStatus'], 'restored')
        self.assertEqual(state['errorCode'], 'BACKUP_READBACK_FAILED')
        self.assertEqual(state['failedPhase'], 'normal_shutdown_verified')
        self.assertNotIn('private', json.dumps(state))

    def test_previous_server_start_failure_is_reported_without_retries_or_data_restore(self):
        def failed_backup():
            raise RuntimeError('BACKUP_READBACK_FAILED')
        original = self.system.service
        def service(action):
            if action == 'start':
                self.system.actions.append(action)
                raise RuntimeError('SYNTHETIC_START_FAILURE')
            original(action)
        self.tx.backup_latest = failed_backup
        self.system.service = service
        raw = self.raw.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_READBACK_FAILED'):
            self.tx.apply()
        self.assertEqual(self.system.actions, ['stop', 'start'])
        state = self.runtime.read_json(self.paths['public_state'] / 'release-6.json')
        self.assertEqual(state['recoveryStatus'], 'restore_failed')
        self.assertEqual(self.raw.read_bytes(), raw)

    def test_recovery_requires_the_actual_previous_version_not_the_failed_new_version(self):
        from unittest.mock import patch
        original_api, original_service = self.api, self.system.service
        starts = []
        def service(action):
            if action == 'start':
                starts.append(action)
            original_service(action)
        def api(path, body=None):
            result = original_api(path, body)
            if path == 'health':
                result['version'] = 'previous-version' if not starts else '0.9.30-daniel.6'
            return result
        self.system.service = service
        self.tx.api = api
        self.tx.verify_runtime = lambda: (_ for _ in ()).throw(RuntimeError('SYNTHETIC_POST_START_FAILURE'))
        restore = self.tx.restore_previous_service
        def bounded_restore():
            with patch.object(self.runtime.time, 'monotonic', side_effect=[0, 121]):
                restore()
        self.tx.restore_previous_service = bounded_restore
        with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_POST_START_FAILURE'):
            self.tx.apply()
        self.assertEqual(len(starts), 2)
        state = self.runtime.read_json(self.paths['public_state'] / 'release-6.json')
        self.assertEqual(state['recoveryStatus'], 'restore_failed')
        self.assertEqual(self.tx.previous_version, 'previous-version')

    def test_snapshot_retry_is_exact_and_does_not_apply(self):
        self.enroll.install(self.draft, self.review, state=self.state, runner=self.runner, owner=os.getuid(), anchor=self.root, run=lambda args, **kw: self.calls.append(args))
        self.assertEqual(len(self.calls), 2)
        (self.paths['public'] / 'release-6/package.tgz').write_bytes(b'tampered')
        with self.assertRaisesRegex(RuntimeError, 'SNAPSHOT_CHANGED'):
            self.enroll.install(self.draft, self.review, state=self.state, runner=self.runner, owner=os.getuid(), anchor=self.root, run=lambda *a, **kw: self.fail('tampered snapshot enrolled'))

    def test_stage_failure_restores_only_wrappers_and_leaves_latest_data(self):
        original_stage = self.tx.user_stage
        def broken_stage():
            original_stage()
            raise RuntimeError('SYNTHETIC_STAGE_FAILURE')
        self.tx.user_stage = broken_stage
        with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_STAGE_FAILURE'):
            self.tx.apply()
        self.tx.guard(before=True)
        self.assertTrue(self.tx.version.exists())
        self.assertIn('start', self.system.actions)
        self.assertTrue(self.runtime.read_json(self.tx.work / 'transaction.json')['codeRollbackVerified'])
        self.assertIn(b'original', self.raw.read_bytes())

    def test_post_start_failure_requires_new_certified_stop_before_code_restore(self):
        def failed_verification():
            self.write(self.raw, b'{"a":{"sourceRaw":{"raw":"original"},"new":true}}')
            raise RuntimeError('SYNTHETIC_POST_START_FAILURE')
        self.tx.verify_runtime = failed_verification
        with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_POST_START_FAILURE'):
            self.tx.apply()
        self.assertEqual(self.system.actions, ['stop', 'reload', 'start', 'stop', 'reload', 'start'])
        self.tx.guard(before=True)
        self.assertIn(b'"new":true', self.raw.read_bytes())
        self.assertTrue(self.runtime.read_json(self.tx.work / 'transaction.json')['codeRollbackVerified'])

    def test_uncertified_new_worker_blocks_code_rollback_and_data_restore(self):
        def failed_verification():
            self.system.fault = 'unsynced'
            raise RuntimeError('SYNTHETIC_POST_START_FAILURE')
        self.tx.verify_runtime = failed_verification
        with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_POST_START_FAILURE'):
            self.tx.apply()
        self.assertEqual(self.paths['dropin'].read_bytes(), self.tx.dropin_bytes())
        self.assertFalse(self.runtime.read_json(self.tx.work / 'transaction.json')['codeRollbackVerified'])
        self.assertEqual(self.system.actions, ['stop', 'reload', 'start', 'stop'])

    def test_startup_guard_accepts_only_root_published_staged_phase(self):
        self.tx.preflight(); self.tx.stop(); self.tx.backup_latest(); self.tx.stage(); self.tx.activate()
        self.assertFalse(self.tx.receipt.exists())
        self.tx.guard()
        self.tx.record('failed')
        with self.assertRaisesRegex(RuntimeError, 'ACTIVE_RECEIPT_MISSING'):
            self.tx.guard()



class RecoveryCompatibilityTests(unittest.TestCase):
    candidate_compatibility = {'backgroundControlVersion': 2, 'automaticMemoryRecovery': False}
    setUp = TransactionTests.setUp
    write = TransactionTests.write

    def api(self, path, body=None):
        value = TransactionTests.api(self, path, body)
        if path == 'health':
            value['version'] = '0.9.30-daniel.6' if self.paths['dropin'].read_bytes() == self.tx.dropin_bytes() else '0.9.30-daniel.5'
        if path == 'background/control' and getattr(self, 'previous_capability', False):
            value['control']['formatVersion'] = 2
        return value

    def known_previous(self, *, automatic=False, protected=True, protected_entrypoint=True, protected_index=True):
        self.previous_capability = True
        directory = self.paths['releases'] / '0.9.30-daniel.5-previous'
        manifest = directory / 'package.json'
        self.write(manifest, json.dumps({'version': '0.9.30-daniel.5', 'agentmemoryCompatibility': {'backgroundControlVersion': 2, 'automaticMemoryRecovery': automatic}}).encode())
        self.write(self.paths['dropin'], ('[Service]\nExecStart=\nExecStart=/usr/bin/node ' + str(directory / 'dist/cli.mjs') + ' --data-dir ' + str(self.paths['data']) + '\n').encode(), 0o644)
        self.tx.baseline['protectedFiles'][str(self.paths['dropin'])] = self.runtime.sha(self.paths['dropin'])
        if protected:
            self.tx.baseline['protectedFiles'][str(manifest)] = self.runtime.sha(manifest)
        entrypoint = directory / 'dist/cli.mjs'
        self.write(entrypoint, b'// synthetic reviewed previous entrypoint')
        if protected_entrypoint:
            self.tx.baseline['protectedFiles'][str(entrypoint)] = self.runtime.sha(entrypoint)
        index = directory / 'dist/index.mjs'
        self.write(index, b'// synthetic reviewed previous worker')
        if protected_index:
            self.tx.baseline['protectedFiles'][str(index)] = self.runtime.sha(index)
        chunk = directory / 'dist/shared-chunk.mjs'
        self.write(chunk, b'// synthetic dynamically imported worker chunk')
        self.tx.baseline['protectedFiles'][str(chunk)] = self.runtime.sha(chunk)
        (directory / 'node_modules').symlink_to(self.paths['legacy'] / 'node_modules', target_is_directory=True)
        installed = dict(self.tx.baseline['protectedFiles'])
        receipt_path = Path(self.tx.baseline['receiptPath'])
        receipt = self.runtime.read_json(receipt_path)
        receipt['installedFileHashes'] = installed
        self.write(receipt_path, json.dumps(receipt).encode())
        self.tx.baseline['receiptIdentity']['installedFileHashes'] = installed
        return manifest

    def fail_after_v2_write(self, *, shutdown_fault=None, after_write=None):
        self.control_file = self.paths['data'] / 'state_store.db/mem%3Abackground-control%3Av1.bin'
        self.v2 = {'manual-pause': {'version': 2, 'paused': True, 'resumePending': False, 'holds': ['deployment', 'manual', 'memory'], 'recovery': {'attempts': 2, 'nextAttemptAt': 987654}}}
        self.expected_control = json.dumps(self.v2, sort_keys=True).encode()
        def failure():
            self.write(self.control_file, self.expected_control)
            if after_write:
                after_write()
            self.system.fault = shutdown_fault
            raise RuntimeError('SYNTHETIC_POST_START_FAILURE')
        self.tx.verify_runtime = failure
        with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_POST_START_FAILURE'):
            self.tx.apply()
        self.assertEqual(self.control_file.read_bytes(), self.expected_control)
        return self.runtime.read_json(self.tx.work / 'transaction.json')

    def test_unknown_previous_after_v2_start_stays_stopped_and_never_switches_old_code(self):
        state = self.fail_after_v2_write()
        self.assertEqual(self.system.actions, ['stop', 'reload', 'start', 'stop'])
        self.assertTrue(self.system.stopped)
        self.assertEqual(self.paths['dropin'].read_bytes(), self.tx.dropin_bytes())
        self.assertEqual((self.paths['bin'] / self.runtime.WRAPPERS[0]).read_bytes(), self.tx.wrapper_bytes())
        self.assertEqual(state['recoveryStatus'], 'manual_required')
        self.assertFalse(state['codeRollbackVerified'])
        self.assertEqual(state['rollbackErrorCode'], 'BACKGROUND_CONTROL_ROLLBACK_INCOMPATIBLE')
        with self.assertRaisesRegex(RuntimeError, 'BACKGROUND_CONTROL_ROLLBACK_INCOMPATIBLE'):
            self.tx.rollback_code_only()
        self.assertEqual(self.system.actions.count('start'), 1)
        self.assertEqual(self.control_file.read_bytes(), self.expected_control)

    def test_hash_proven_recovery_disabled_previous_can_restore_without_rewinding_v2(self):
        self.known_previous()
        state = self.fail_after_v2_write()
        self.assertEqual(self.system.actions, ['stop', 'reload', 'start', 'stop', 'reload', 'start'])
        self.assertEqual(state['recoveryStatus'], 'restored')
        self.assertTrue(state['codeRollbackVerified'])
        self.tx.guard(before=True)

    def test_unprotected_previous_manifest_cannot_authorize_rollback(self):
        self.known_previous(protected=False)
        state = self.fail_after_v2_write()
        self.assertEqual(state['recoveryStatus'], 'manual_required')
        self.assertEqual(self.system.actions.count('start'), 1)

    def test_unprotected_previous_entrypoint_cannot_authorize_rollback(self):
        self.known_previous(protected_entrypoint=False)
        state = self.fail_after_v2_write()
        self.assertEqual(state['recoveryStatus'], 'manual_required')
        self.assertEqual(self.system.actions.count('start'), 1)

    def test_manifest_alone_without_authenticated_capability_cannot_authorize_rollback(self):
        self.known_previous()
        self.previous_capability = False
        state = self.fail_after_v2_write()
        self.assertEqual(state['recoveryStatus'], 'manual_required')
        self.assertEqual(self.system.actions.count('start'), 1)

    def test_previous_with_auto_recovery_enabled_cannot_be_rollback_target(self):
        self.known_previous(automatic=True)
        state = self.fail_after_v2_write()
        self.assertEqual(state['recoveryStatus'], 'manual_required')
        self.assertEqual(self.system.actions.count('start'), 1)

    def test_changed_previous_entrypoint_after_start_blocks_old_code_restore(self):
        manifest = self.known_previous()
        state = self.fail_after_v2_write(after_write=lambda: self.write(manifest.parent / 'dist/cli.mjs', b'tampered'))
        self.assertEqual(self.system.actions, ['stop', 'reload', 'start', 'stop'])
        self.assertEqual(self.paths['dropin'].read_bytes(), self.tx.dropin_bytes())
        self.assertEqual(state['recoveryStatus'], 'manual_required')
        self.assertEqual(state['rollbackErrorCode'], 'PROTECTED_FILE_CHANGED')

    def test_future_or_malformed_reported_format_is_refused_before_pause_or_stop(self):
        original = self.api
        for version in (3, '2', None, True, -1):
            with self.subTest(version=version):
                self.setUp()
                def api(path, body=None):
                    result = original(path, body)
                    if path == 'background/control':
                        result['control']['formatVersion'] = version
                    return result
                self.tx.api = api
                with self.assertRaisesRegex(RuntimeError, 'BACKGROUND_CONTROL_FORMAT_UNSUPPORTED'):
                    self.tx.apply()
                self.assertEqual(self.system.actions, [])

    def test_malformed_previous_profile_never_authorizes_rollback(self):
        profiles = ({'backgroundControlVersion': 2.0, 'automaticMemoryRecovery': False}, {'backgroundControlVersion': 2, 'automaticMemoryRecovery': False, 'extra': True}, None, [])
        for profile in profiles:
            with self.subTest(profile=profile):
                self.setUp()
                manifest = self.known_previous()
                self.write(manifest, json.dumps({'version': '0.9.30-daniel.5', 'agentmemoryCompatibility': profile}).encode())
                self.tx.baseline['protectedFiles'][str(manifest)] = self.runtime.sha(manifest)
                state = self.fail_after_v2_write()
                self.assertEqual(state['recoveryStatus'], 'manual_required')
                self.assertEqual(self.system.actions.count('start'), 1)

    def test_missing_worker_index_in_protected_baseline_blocks_rollback(self):
        self.known_previous(protected_index=False)
        state = self.fail_after_v2_write()
        self.assertEqual(state['recoveryStatus'], 'manual_required')
        self.assertEqual(self.system.actions.count('start'), 1)

    def test_previous_worker_index_mutation_blocks_code_restore(self):
        manifest = self.known_previous()
        state = self.fail_after_v2_write(after_write=lambda: self.write(manifest.parent / 'dist/index.mjs', b'changed worker'))
        self.assertEqual(self.system.actions, ['stop', 'reload', 'start', 'stop'])
        self.assertEqual(self.paths['dropin'].read_bytes(), self.tx.dropin_bytes())
        self.assertEqual(state['rollbackErrorCode'], 'PROTECTED_FILE_CHANGED')

    def test_unlisted_runtime_chunk_in_previous_release_blocks_rollback(self):
        manifest = self.known_previous()
        self.write(manifest.parent / 'dist/unlisted-chunk.mjs', b'unreviewed chunk')
        state = self.fail_after_v2_write()
        self.assertEqual(state['recoveryStatus'], 'manual_required')
        self.assertEqual(self.system.actions.count('start'), 1)

    def test_chunk_added_after_preflight_blocks_code_restore(self):
        manifest = self.known_previous()
        state = self.fail_after_v2_write(after_write=lambda: self.write(manifest.parent / 'dist/unlisted-chunk.mjs', b'unreviewed chunk'))
        self.assertEqual(self.system.actions, ['stop', 'reload', 'start', 'stop'])
        self.assertEqual(self.paths['dropin'].read_bytes(), self.tx.dropin_bytes())
        self.assertEqual(state['rollbackErrorCode'], 'PREVIOUS_RELEASE_FILE_SET_CHANGED')

    def test_previous_receipt_without_bound_install_ledger_cannot_authorize_rollback(self):
        self.known_previous()
        del self.tx.baseline['receiptIdentity']['installedFileHashes']
        state = self.fail_after_v2_write()
        self.assertEqual(state['recoveryStatus'], 'manual_required')
        self.assertEqual(self.system.actions.count('start'), 1)

    def test_shutdown_failure_never_switches_code_or_starts_previous(self):
        self.known_previous()
        state = self.fail_after_v2_write(shutdown_fault='unsynced')
        self.assertEqual(self.system.actions, ['stop', 'reload', 'start', 'stop'])
        self.assertFalse(state['codeRollbackVerified'])
        self.assertEqual(self.paths['dropin'].read_bytes(), self.tx.dropin_bytes())

    def test_invalid_candidate_profile_is_refused_before_api_or_stop(self):
        for profile in ({'backgroundControlVersion': 3, 'automaticMemoryRecovery': False}, {'backgroundControlVersion': 2, 'automaticMemoryRecovery': 'false'}, {'backgroundControlVersion': 2}, [], None):
            with self.subTest(profile=profile):
                self.candidate_compatibility = profile
                self.explicit_null_candidate_profile = profile is None
                self.setUp()
                self.tx.api = lambda *args, **kw: self.fail('API reached before candidate profile validation')
                with self.assertRaisesRegex(RuntimeError, 'BACKGROUND_CONTROL_PROFILE_INVALID'):
                    self.tx.apply()
                self.assertEqual(self.system.actions, [])

    def test_old_schema_candidate_is_refused_before_pause_or_stop_on_v2_server(self):
        self.candidate_compatibility = None
        self.setUp()
        self.known_previous()
        with self.assertRaisesRegex(RuntimeError, 'BACKGROUND_CONTROL_DOWNGRADE_REFUSED'):
            self.tx.apply()
        self.assertEqual(self.system.actions, [])


class FakeSystem:
    def __init__(self, fixture):
        self.fixture = fixture
        self.stopped = False
        self.started = False
        self.actions = []
        self.fault = None

    def verify_identity(self):
        pass

    def main_pid(self):
        return 103

    def alive(self, pid):
        return self.fault == 'alive' or not self.stopped

    def reload(self):
        self.actions.append('reload')

    def service(self, action):
        self.actions.append(action)
        if action == 'stop':
            self.stopped = True
            at = self.fixture.runtime.datetime.datetime.now(self.fixture.runtime.datetime.timezone.utc)
            if self.fault == 'stale':
                at -= self.fixture.runtime.datetime.timedelta(days=1)
            self.fixture.write(self.fixture.paths['runtime'] / 'shutdown-receipt.json', json.dumps({'at': at.isoformat(), 'pid': 99 if self.fault == 'wrong-pid' else 101, 'verified': True, 'durability': {'synced': self.fault != 'unsynced', 'mutationFailures': 0}}).encode())
        elif action == 'start':
            self.started = True
            self.stopped = False


if __name__ == '__main__':
    unittest.main()
