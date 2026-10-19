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
        files = {'package.json': b'{"version":"0.9.30-daniel.6"}', 'dist/cli.mjs': b'// synthetic CLI'}
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
        self.assertNotIn('start', self.system.actions)
        self.assertTrue(self.runtime.read_json(self.tx.work / 'transaction.json')['codeRollbackVerified'])
        self.assertIn(b'original', self.raw.read_bytes())

    def test_post_start_failure_requires_new_certified_stop_before_code_restore(self):
        def failed_verification():
            self.write(self.raw, b'{"a":{"sourceRaw":{"raw":"original"},"new":true}}')
            raise RuntimeError('SYNTHETIC_POST_START_FAILURE')
        self.tx.verify_runtime = failed_verification
        with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_POST_START_FAILURE'):
            self.tx.apply()
        self.assertEqual(self.system.actions, ['stop', 'reload', 'start', 'stop', 'reload'])
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
