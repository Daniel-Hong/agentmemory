import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import unittest
from unittest.mock import patch
import test_dashboard_kit as base


class ManualRecoveryTests(unittest.TestCase):
    candidate_compatibility = {'backgroundControlVersion': 2, 'automaticMemoryRecovery': True}
    write = base.TransactionTests.write
    api = base.RecoveryCompatibilityTests.api

    def setUp(self):
        base.TransactionTests.setUp(self)
        self.system.inactive = lambda: self.system.stopped
        self.system.main_pid = lambda: 0 if self.system.stopped else 103
        control_path = self.paths['data'] / 'state_store.db/mem%3Abackground-control%3Av1.bin'
        self.control = {'manual-pause': {'version': 2, 'paused': True, 'resumePending': False, 'holds': ['deployment', 'manual', 'memory'], 'recovery': {'attempts': 2, 'nextAttemptAt': 987654}}}
        self.control_path = control_path
        def failure():
            self.write(control_path, json.dumps(self.control, sort_keys=True).encode())
            raise RuntimeError('SYNTHETIC_FAILURE')
        self.tx.verify_runtime = failure
        with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_FAILURE'):
            self.tx.apply()
        self.failed = self.tx
        self.failed_transaction = (self.failed.work / 'transaction.json').read_bytes()
        self.saved_control = control_path.read_bytes()
        package = self.root / 'recovery.tgz'
        files = {'package.json': json.dumps({'version': '0.9.30-daniel.7', 'agentmemoryCompatibility': {'backgroundControlVersion': 2, 'automaticMemoryRecovery': False}}).encode(), 'dist/cli.mjs': b'// synthetic recovery CLI', 'dist/index.mjs': b'// synthetic recovery worker'}
        files.update({f'plugin/scripts/codex-compat/{i}.js': str(i).encode() for i in range(13)})
        with tarfile.open(package, 'w:gz') as archive:
            for name, data in files.items():
                entry = tarfile.TarInfo('package/' + name);entry.size = len(data);archive.addfile(entry, io.BytesIO(data))
        release = {'sourceCommit': 'b' * 40, 'packageVersion': '0.9.30-daniel.7', 'packageFiles': {name: self.runtime.hashlib.sha256(data).hexdigest() for name, data in files.items()}, 'artifactHashes': {}, 'verificationFiles': {}}
        metadata = {'id': 'recovery-7', 'version': release['packageVersion'], 'sourceCommit': release['sourceCommit'], 'packageSha256': self.runtime.sha(package), 'changeSummary': 'Synthetic recovery', 'tests': ['synthetic manual recovery']}
        draft = self.root / 'recovery-draft'
        self.prepare.prepare(package, release, self.failed.baseline, metadata, draft)
        review = self.root / 'recovery-review.json'
        self.write(review, json.dumps({'executionClosureReviewed': True, 'reviewedBy': 'explicit synthetic review', 'draftManifestSha256': self.runtime.sha(draft / 'kit.json')}).encode())
        self.enroll.install(draft, review, state=self.state, runner=self.runner, owner=os.getuid(), anchor=self.root, run=lambda *args, **kw: None)
        self.recovery = self.new_recovery()
        self.plan = self.recovery.work / 'stopped-recovery-plan.json'

    def new_recovery(self):
        value = self.runtime.Runtime(self.paths['public'] / 'recovery-7', paths=self.paths, owner=os.getuid(), anchor=self.root, service_uid=os.getuid(), service_gid=os.getgid(), system=self.system)
        def api(path, body=None):
            if path == 'health':return {'version': value.kit['version'], 'status': 'healthy', 'storageDurability': {'mutationFailures': 0}, 'memoryPressure': {'automaticMemoryRecovery': False}}
            if path == 'background/control':
                saved = json.loads(self.control_path.read_text())['manual-pause']
                return {'control': {'formatVersion': 2, 'status': 'paused', 'pausedRequested': True, 'activeOperations': 0, 'error': None, 'holds': saved['holds'], 'recovery': saved['recovery']}}
            return {'sessions': [], 'flags': [], 'scheduleEnabled': False}
        value.api = api
        return value

    def prepare_plan(self):
        return self.recovery.prepare_stopped_recovery(self.failed.root, self.plan)['planSha256']

    def test_real_recovery_and_fresh_process_duplicate_preserve_data_and_actual_receipt(self):
        digest = self.prepare_plan();starts = self.system.actions.count('start')
        self.assertTrue(self.recovery.recover_stopped(self.plan, digest)['recovered'])
        self.assertEqual(self.system.actions.count('start'), starts + 1)
        self.assertEqual(self.control_path.read_bytes(), self.saved_control)
        self.assertEqual((self.failed.work / 'transaction.json').read_bytes(), self.failed_transaction)
        receipt = self.runtime.read_json(self.recovery.receipt)
        self.assertTrue(receipt['applied']);self.assertFalse(receipt['verificationComplete'])
        self.assertEqual(receipt['stoppedRecoveryPlanSha256'], digest)
        self.assertTrue(self.new_recovery().recover_stopped(self.plan, digest)['alreadyRecovered'])
        self.assertEqual(self.system.actions.count('start'), starts + 1)

    def test_rejects_wrong_hash_changed_data_and_no_second_plan(self):
        digest = self.prepare_plan()
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_PLAN_CHANGED'):self.recovery.recover_stopped(self.plan, '0' * 64)
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_PLAN_PATH_REFUSED'):self.prepare_plan()
        self.write(self.raw, b'{"changed":true}')
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_PLAN_CHANGED'):self.recovery.recover_stopped(self.plan, digest)
        self.assertEqual(self.system.actions.count('start'), 1)

    def test_rejects_changed_selected_code_and_shutdown_receipt(self):
        self.write(self.failed.version / 'dist/cli.mjs', b'changed')
        with self.assertRaisesRegex(RuntimeError, 'PROTECTED_FILE_CHANGED'):self.prepare_plan()
        self.assertEqual(self.system.actions.count('start'), 1)

    def test_rejects_non_stopped_unverified_and_wrong_baseline(self):
        self.system.stopped = False
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_SERVICE_NOT_STOPPED'):self.prepare_plan()
        self.system.stopped = True
        self.recovery.baseline = dict(self.recovery.baseline, receiptIdentity={})
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_BASELINE_MISMATCH'):self.prepare_plan()

    def test_lock_conflict_and_untrusted_plan_path(self):
        descriptor = os.open(self.state / 'dispatch.lock', os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, 'RECOVERY_BUSY'):self.prepare_plan()
        finally:os.close(descriptor)
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_PLAN_PATH_REFUSED'):
            self.recovery.prepare_stopped_recovery(self.failed.root, self.root / 'wrong.json')

    def test_partial_stage_requires_manual_inspection_and_never_starts(self):
        digest = self.prepare_plan()
        def partial():
            self.recovery.version.mkdir();raise RuntimeError('SYNTHETIC_PARTIAL_STAGE')
        self.recovery.user_stage = partial
        with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_PARTIAL_STAGE'):self.recovery.recover_stopped(self.plan, digest)
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_PARTIAL_REQUIRES_INSPECTION'):self.new_recovery().recover_stopped(self.plan, digest)
        self.assertEqual(self.system.actions.count('start'), 1)
        self.assertEqual(self.control_path.read_bytes(), self.saved_control)

    def test_post_start_failure_certifies_stop_without_old_code_switch(self):
        digest = self.prepare_plan()
        self.recovery.verify_runtime = lambda: (_ for _ in ()).throw(RuntimeError('SYNTHETIC_VERIFY_FAILURE'))
        with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_VERIFY_FAILURE'):self.recovery.recover_stopped(self.plan, digest)
        self.assertTrue(self.system.stopped)
        self.assertEqual(self.paths['dropin'].read_bytes(), self.recovery.dropin_bytes())
        self.assertEqual(self.control_path.read_bytes(), self.saved_control)
        self.assertFalse(self.recovery.receipt.exists())

    def test_rejects_changed_genuine_prior_receipt(self):
        prior = Path(self.recovery.baseline['receiptPath'])
        self.write(prior, b'{"applied":false,"sourceCommit":"previous"}')
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_RECEIPT_CHANGED'):self.prepare_plan()

    def test_rejects_changed_shutdown_proof_and_missing_certification(self):
        receipt = self.paths['runtime'] / 'shutdown-receipt.json'
        self.write(receipt, receipt.read_bytes() + b' ')
        with self.assertRaisesRegex(RuntimeError, 'SHUTDOWN_RECEIPT_CHANGED'):self.prepare_plan()

    def test_rejects_private_mutable_kit_and_wrong_plan_path(self):
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_KIT_PATH_REFUSED'):
            self.recovery.prepare_stopped_recovery(self.failed.work, self.plan)
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_PLAN_PATH_REFUSED'):
            self.recovery.recover_stopped(self.root / 'other.json', '0' * 64)

    def test_plan_change_and_recovery_profile_enabled_are_refused(self):
        digest = self.prepare_plan();self.write(self.plan, self.plan.read_bytes() + b' ')
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_PLAN_CHANGED'):self.recovery.recover_stopped(self.plan, digest)
        self.plan.unlink()
        original = self.recovery.verify_dependency_reuse
        def enabled():original();self.recovery.candidate_automatic_memory_recovery = True
        self.recovery.verify_dependency_reuse = enabled
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_PROFILE_REQUIRED'):self.prepare_plan()

    def test_hold_or_budget_mismatch_after_start_stops_without_applied_receipt(self):
        digest = self.prepare_plan();original = self.recovery.api
        def changed(path, body=None):
            value = original(path, body)
            if path == 'background/control':value['control']['holds'] = ['memory']
            return value
        self.recovery.api = changed
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_HOLDS_CHANGED'):self.recovery.recover_stopped(self.plan, digest)
        self.assertTrue(self.system.stopped);self.assertFalse(self.recovery.receipt.exists())

    def test_duplicate_requires_root_completion_and_active_runtime(self):
        digest = self.prepare_plan();self.recovery.recover_stopped(self.plan, digest)
        completed_path = self.recovery.work / 'transaction.json'
        completed = completed_path.read_bytes()
        self.write(completed_path, b'{"phase":"failed"}')
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_PARTIAL_REQUIRES_INSPECTION'):self.new_recovery().recover_stopped(self.plan, digest)
        self.write(completed_path, completed);self.system.stopped = True
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_RUNTIME_UNVERIFIED'):self.new_recovery().recover_stopped(self.plan, digest)
        self.assertEqual(self.system.actions.count('start'), 2)

    def test_uncertified_failure_state_and_artifact_tamper_are_refused(self):
        transaction = self.failed.work / 'transaction.json';original = transaction.read_bytes()
        state = json.loads(original);state['shutdownCertified'] = False;self.write(transaction, json.dumps(state).encode())
        with self.assertRaisesRegex(RuntimeError, 'FAILED_STATE_UNVERIFIED'):self.prepare_plan()
        self.write(transaction, original)
        self.write(self.recovery.public / 'package.tgz', b'changed package')
        with self.assertRaisesRegex(RuntimeError, 'PUBLIC_KIT_CHANGED'):self.prepare_plan()

    def test_duplicate_rejects_wrong_health_identity_without_new_start(self):
        digest = self.prepare_plan();self.recovery.recover_stopped(self.plan, digest)
        duplicate = self.new_recovery();original = duplicate.api
        def wrong(path, body=None):
            value = original(path, body)
            if path == 'health':value['version'] = 'unrelated'
            return value
        duplicate.api = wrong
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_RUNTIME_UNVERIFIED'):duplicate.recover_stopped(self.plan, digest)
        self.assertEqual(self.system.actions.count('start'), 2)


if __name__ == '__main__':unittest.main()
