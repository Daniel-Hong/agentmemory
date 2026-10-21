import fcntl
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('dashboard_updates', Path(__file__).with_name('dashboard-updates.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class DashboardUpdatesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='am-dashboard-update-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.spool = self.root / 'requests'
        self.spool.mkdir(mode=0o700)
        self.runner = m.Runner(self.root / 'state', self.spool, trusted_uid=os.getuid(), request_uid=os.getuid(), trust_anchor=self.root)
        self.runner.initialize()
        self.kit = self.root / 'reviewed'
        self.kit.mkdir(mode=0o755)
        self.marker = self.root / 'executions'
        self.program = "import pathlib,sys\nassert sys.argv[1:] == ['--apply']\np=pathlib.Path(%r)\np.write_text((p.read_text() if p.exists() else '')+'applied\\n')\nprint('private secret output')\n" % str(self.marker)
        self.metadata = {'id': 'release-1', 'version': '0.9.30-test.1', 'sourceCommit': 'a' * 40, 'packageSha256': 'b' * 64, 'changeSummary': 'Synthetic candidate', 'tests': ['synthetic execution'], 'entrypoint': 'apply.py', 'executionClosureReviewed': True, 'reviewedBy': 'synthetic administrator', 'files': {}}
        self.save_kit()

    def save_kit(self):
        (self.kit / 'apply.py').write_text(self.program)
        (self.kit / 'apply.py').chmod(0o644)
        self.metadata['files'] = {'apply.py': m.sha(self.kit / 'apply.py')}
        (self.kit / 'kit.json').write_text(json.dumps(self.metadata))
        (self.kit / 'kit.json').chmod(0o644)

    def enroll(self):
        self.runner.enroll(self.kit)

    def request(self, job=None, candidate='release-1'):
        job = job or str(uuid.uuid4())
        path = self.spool / (job + '.json')
        path.write_text(json.dumps({'jobId': job, 'candidateId': candidate}))
        path.chmod(0o600)
        return job

    def queue(self, job):
        with patch.object(m.subprocess, 'run') as start:
            result = self.runner.request(job)
        start.assert_called_once()
        self.assertEqual(start.call_args.args[0], ['/usr/bin/systemctl', 'start', '--no-block', 'agentmemory-update@' + job + '.service'])
        return result

    def test_dispatch_real_program_and_idempotence(self):
        self.enroll()
        job = self.request()
        self.assertEqual(self.queue(job)['status'], 'queued')
        result = self.runner.run_job(job)
        self.assertEqual(result['status'], 'applied_pending_acceptance')
        self.assertFalse(result['verificationComplete'])
        self.assertEqual(self.marker.read_text(), 'applied\n')
        with patch.object(m.subprocess, 'run') as start:
            self.assertEqual(self.runner.request(job)['status'], 'applied_pending_acceptance')
            start.assert_not_called()
        self.runner.run_job(job)
        self.assertEqual(self.marker.read_text(), 'applied\n')
        self.assertNotIn('secret', json.dumps(result))
        self.assertEqual((self.runner.state / 'private' / (job + '.log')).stat().st_mode & 0o777, 0o600)

    def test_real_process_holds_global_lock_while_program_runs(self):
        release = self.root / 'release'
        self.program += "import time\nprint('PHASE: preflight_verified',flush=True)\nlimit=time.monotonic()+10\nwhile not pathlib.Path(%r).exists() and time.monotonic()<limit: time.sleep(.01)\n" % str(release)
        self.save_kit()
        self.enroll()
        job = self.request()
        self.queue(job)
        code = "import importlib.util; from pathlib import Path; s=importlib.util.spec_from_file_location('r', %r); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.Runner(Path(%r), Path(%r), trusted_uid=%d, request_uid=%d, trust_anchor=Path(%r)).run_job(%r)" % (str(Path(m.__file__)), str(self.runner.state), str(self.spool), os.getuid(), os.getuid(), str(self.root), job)
        process = subprocess.Popen([sys.executable, '-I', '-c', code], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not self.marker.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(self.marker.exists())
            with self.assertRaisesRegex(m.Rejected, 'BUSY'):
                self.runner.request(self.request())
            while self.runner.job(job)['phase'] != 'preflight_verified' and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual(self.runner.job(job)['status'], 'running')
            self.assertEqual(self.runner.job(job)['phase'], 'preflight_verified')
        finally:
            release.touch()
            stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0, stderr.decode())
        self.assertEqual(self.runner.job(job)['status'], 'applied_pending_acceptance')

    def test_invalid_requests_and_no_arbitrary_arguments(self):
        self.enroll()
        for invalid in ['../etc/passwd', '--enroll', 'not-a-uuid', str(uuid.uuid4()).upper()]:
            with self.subTest(invalid=invalid), self.assertRaises(m.Rejected):
                self.runner.request(invalid)
        with self.assertRaisesRegex(m.Rejected, 'UNKNOWN_CANDIDATE'):
            self.queue(self.request(candidate='missing'))
        job = self.request()
        path = self.spool / (job + '.json')
        path.write_text(json.dumps({'jobId': job, 'candidateId': 'release-1', 'command': 'false'}))
        with self.assertRaises(m.Rejected):
            self.runner.request(job)
        path.write_text('x' * 4097)
        with self.assertRaises(m.Rejected):
            self.runner.request(job)

    def test_spool_symlink_permissions_and_uuid_conflict(self):
        self.enroll()
        job = self.request()
        self.queue(job)
        self.request(job, candidate='release-2')
        with self.assertRaisesRegex(m.Rejected, 'JOB_CONFLICT'):
            self.runner.request(job)
        other = self.request()
        path = self.spool / (other + '.json')
        path.chmod(0o644)
        with self.assertRaises(m.Rejected):
            self.runner.request(other)
        path.unlink()
        path.symlink_to(self.spool / (job + '.json'))
        with self.assertRaises(m.Rejected):
            self.runner.request(other)

    def test_unknown_job_and_failure_are_safe(self):
        with self.assertRaises(m.Rejected):
            self.runner.run_job(str(uuid.uuid4()))
        self.program = "raise RuntimeError('private backup location must not be public')\n"
        self.save_kit()
        self.enroll()
        job = self.request()
        self.queue(job)
        result = self.runner.run_job(job)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['errorCode'], 'PROGRAM_FAILED')
        self.assertNotIn('backup', json.dumps(result))

    def test_tampered_and_extra_vault_file_rejected_before_execution(self):
        self.enroll()
        job = self.request()
        self.queue(job)
        (self.runner.state / 'vault/release-1/apply.py').write_text('raise SystemExit(0)')
        result = self.runner.run_job(job)
        self.assertEqual(result['errorCode'], 'UNTRUSTED_KIT')
        self.assertFalse(self.marker.exists())

    def test_manifest_rewrite_and_unlisted_file_are_not_trusted(self):
        self.enroll()
        job = self.request()
        self.queue(job)
        root = self.runner.state / 'vault/release-1'
        metadata = json.loads((root / 'kit.json').read_text())
        metadata['changeSummary'] = 'altered after approval'
        (root / 'kit.json').write_text(json.dumps(metadata))
        self.assertEqual(self.runner.run_job(job)['errorCode'], 'UNTRUSTED_KIT')
        self.assertFalse(self.marker.exists())

    def test_owner_and_trusted_ancestor_are_required(self):
        self.enroll()
        job = self.request()
        previous_uid = self.runner.request_uid
        self.runner.request_uid = previous_uid + 1
        with self.assertRaises(m.Rejected):
            self.runner.request(job)
        self.runner.request_uid = previous_uid
        self.kit.chmod(0o777)
        with self.assertRaises(m.Rejected):
            self.runner.checked_kit(self.kit)
        self.kit.chmod(0o755)
        (self.kit / 'unlisted.py').write_text('print("unreviewed")')
        with self.assertRaises(m.Rejected):
            self.runner.checked_kit(self.kit)

    def test_global_lock_and_pending_job_prevent_concurrent_dispatch(self):
        self.enroll()
        job = self.request()
        self.queue(job)
        with self.assertRaisesRegex(m.Rejected, 'BUSY'):
            self.runner.request(self.request())
        with self.runner.lock():
            with self.assertRaisesRegex(m.Rejected, 'BUSY'):
                self.runner.run_job(job)

    def test_enrollment_rejects_open_closure_traversal_symlink_and_secret(self):
        self.metadata['executionClosureReviewed'] = False
        self.save_kit()
        with self.assertRaises(m.Rejected):
            self.enroll()
        self.metadata['executionClosureReviewed'] = True
        self.save_kit()
        for name in ['../escape', 'private.env', '.env', 'data/original', 'queues/outbox']:
            with self.subTest(name=name):
                self.metadata['files'][name] = '0' * 64
                (self.kit / 'kit.json').write_text(json.dumps(self.metadata))
                with self.assertRaises(m.Rejected):
                    self.enroll()
                del self.metadata['files'][name]
        self.save_kit()
        (self.kit / 'linked').symlink_to(self.kit / 'apply.py')
        with self.assertRaises(m.Rejected):
            self.enroll()
        (self.kit / 'linked').unlink()
        (self.kit / 'apply.py').chmod(0o666)
        with self.assertRaises(m.Rejected):
            self.enroll()
        self.assertFalse((self.runner.state / 'vault/release-1').exists())

    def test_previous_boot_interrupted_requires_explicit_ack_and_never_reruns(self):
        self.enroll()
        job = self.request()
        self.queue(job)
        value = self.runner.job(job)
        value['bootId'] = 'previous-boot'
        self.runner.save_job(value, 'running', 'applying')
        recovered = self.runner.recover_incomplete()
        self.assertEqual(recovered['interrupted'], [job])
        interrupted = self.runner.job(job)
        self.assertEqual(interrupted['status'], 'interrupted')
        self.assertEqual(interrupted['phase'], 'inspection_required')
        self.assertEqual(interrupted['errorCode'], 'UPDATE_INTERRUPTED')
        self.runner.run_job(job)
        self.assertFalse(self.marker.exists())
        with self.assertRaisesRegex(m.Rejected, 'BUSY'):
            self.runner.request(self.request())
        acknowledged = self.runner.acknowledge_recovery(job)
        self.assertEqual(acknowledged['status'], 'failed')
        self.assertTrue(acknowledged['recoveryAcknowledged'])
        self.assertEqual(acknowledged['errorCode'], 'UPDATE_INTERRUPTED')
        self.assertEqual([e['status'] for e in acknowledged['events']], ['queued', 'running', 'interrupted', 'failed'])
        with self.assertRaisesRegex(m.Rejected, 'CANDIDATE_PREVIOUSLY_FAILED'):
            self.runner.request(self.request())

    def test_same_boot_recovery_checks_unit_state_and_protects_dispatch_interval(self):
        self.enroll()
        job = self.request()
        self.queue(job)
        with patch.object(m.subprocess, 'run', return_value=m.subprocess.CompletedProcess([], 0, stdout='inactive\n')) as query:
            self.assertEqual(self.runner.recover_incomplete()['interrupted'], [])
            query.assert_not_called()
        value = self.runner.job(job)
        value['createdAt'] = '2020-01-01T00:00:00+00:00'
        self.runner.write(self.runner.job_path(job), value)
        with patch.object(m.subprocess, 'run', return_value=m.subprocess.CompletedProcess([], 0, stdout='activating\n')):
            self.assertEqual(self.runner.recover_incomplete()['interrupted'], [])
        with patch.object(m.subprocess, 'run', return_value=m.subprocess.CompletedProcess([], 0, stdout='failed\n')):
            self.assertEqual(self.runner.recover_incomplete()['interrupted'], [job])
        with self.runner.lock():
            with self.assertRaisesRegex(m.Rejected, 'BUSY'):
                self.runner.recover_incomplete()

    def test_previous_boot_queued_job_cannot_be_replayed_directly(self):
        self.enroll()
        job = self.request()
        self.queue(job)
        value = self.runner.job(job)
        value['bootId'] = 'old-boot'
        self.runner.write(self.runner.job_path(job), value)
        self.assertEqual(self.runner.run_job(job)['status'], 'interrupted')
        self.assertFalse(self.marker.exists())
        with self.assertRaisesRegex(m.Rejected, 'NOT_INTERRUPTED'):
            self.runner.acknowledge_recovery(self.request())

    def test_enrollment_publication_failures_are_repairable_without_changed_id(self):
        original = self.runner.write
        for stage in ['private', 'public']:
            with self.subTest(stage=stage):
                def fail(path, value, mode=0o644):
                    expected = self.runner.state / ('catalog.json' if stage == 'private' else 'public/catalog.json')
                    if path == expected:
                        raise OSError('synthetic publication failure')
                    return original(path, value, mode)
                with patch.object(self.runner, 'write', side_effect=fail):
                    with self.assertRaises(OSError):
                        self.enroll()
                if stage == 'private':
                    self.assertFalse((self.runner.state / 'vault/release-1').exists())
                else:
                    self.assertTrue((self.runner.state / 'vault/release-1').exists())
                    self.runner.refresh_catalog()
                    self.enroll()
                    self.assertEqual(len(json.loads((self.runner.state / 'public/catalog.json').read_text())['candidates']), 1)
                    self.program += '# different kit\n'
                    self.save_kit()
                    with self.assertRaisesRegex(m.Rejected, 'CANDIDATE_EXISTS'):
                        self.enroll()

    def test_crash_after_vault_rename_can_reenroll_same_exact_snapshot(self):
        self.enroll()
        self.runner.write(self.runner.state / 'catalog.json', {'candidates': []}, 0o600)
        self.runner.write(self.runner.state / 'public/catalog.json', {'candidates': []})
        self.enroll()
        self.assertEqual(len(self.runner.catalog()), 1)

    def test_public_catalog_limits_reject_before_private_or_vault_commit(self):
        self.metadata['tests'] = ['synthetic'] * 51
        self.save_kit()
        with self.assertRaisesRegex(m.Rejected, 'INVALID_METADATA'):
            self.enroll()
        self.metadata['tests'] = ['x' * 1000] * 50
        self.metadata['changeSummary'] = 'x' * 8192
        self.save_kit()
        self.enroll()
        self.assertLessEqual((self.runner.state / 'public/catalog.json').stat().st_size, 65536)
        previous = (self.runner.state / 'catalog.json').read_bytes()
        self.metadata['id'] = 'release-2'
        self.save_kit()
        with self.assertRaisesRegex(m.Rejected, 'CATALOG_LIMIT'):
            self.enroll()
        self.assertEqual((self.runner.state / 'catalog.json').read_bytes(), previous)
        self.assertFalse((self.runner.state / 'vault/release-2').exists())
        crowded = [{**self.runner.catalog()[0], 'id': 'existing-' + str(i)} for i in range(100)]
        with patch.object(self.runner, 'catalog', return_value=crowded):
            with self.assertRaisesRegex(m.Rejected, 'CATALOG_LIMIT'):
                self.enroll()
        self.assertEqual((self.runner.state / 'catalog.json').read_bytes(), previous)

    def test_atomic_private_commit_then_fsync_failure_keeps_snapshot_for_repair(self):
        original = self.runner.write
        def committed_then_failed(path, value, mode=0o644):
            original(path, value, mode)
            if path == self.runner.state / 'catalog.json':
                raise OSError('synthetic directory fsync failure after rename')
        with patch.object(self.runner, 'write', side_effect=committed_then_failed):
            with self.assertRaises(OSError):
                self.enroll()
        self.assertTrue((self.runner.state / 'vault/release-1').exists())
        self.enroll()
        self.assertEqual(len(json.loads((self.runner.state / 'public/catalog.json').read_text())['candidates']), 1)
        (self.runner.state / 'public/catalog.json').unlink()
        self.runner.recover_incomplete()
        self.assertEqual(len(json.loads((self.runner.state / 'public/catalog.json').read_text())['candidates']), 1)

    def test_only_literal_known_phase_lines_enter_public_durable_history(self):
        self.program = "import sys\nassert sys.argv[1:]==['--apply']\nprint('PHASE: normal_shutdown_verified',flush=True)\nprint('PHASE: normal_shutdown_verified',flush=True)\nprint('PHASE: ../../etc',flush=True)\nprint('SECRET_PRIVATE_backup_path=/private/secret',flush=True)\nprint('PHASE: latest_private_backup_verified',flush=True)\nprint('PHASE: '+ 'x'*20000,flush=True)\nprint('PHASE: runtime_and_data_verified',flush=True)\n"
        self.save_kit()
        self.enroll()
        job = self.request()
        self.queue(job)
        result = self.runner.run_job(job)
        self.assertEqual(result['status'], 'applied_pending_acceptance')
        self.assertFalse(result['verificationComplete'])
        phases = [event['phase'] for event in result['events']]
        self.assertEqual(phases, ['queued', 'applying', 'normal_shutdown_verified', 'latest_private_backup_verified', 'runtime_and_data_verified', 'awaiting_acceptance'])
        public = json.dumps(result)
        self.assertNotIn('SECRET_PRIVATE', public)
        self.assertNotIn('../../etc', public)
        private = (self.runner.state / 'private' / (job + '.log')).read_bytes()
        self.assertIn(b'SECRET_PRIVATE_backup_path=/private/secret', private)
        self.assertIn(b'PHASE: ../../etc', private)
        self.assertIn(b'PHASE: ' + b'x' * 20000, private)

    def test_failed_copy_does_not_publish_candidate(self):
        with patch.object(m.shutil, 'copyfile', side_effect=OSError('synthetic disk failure')):
            with self.assertRaises(OSError):
                self.enroll()
        self.assertEqual(json.loads((self.runner.state / 'public/catalog.json').read_text())['candidates'], [])
        self.assertFalse((self.runner.state / 'vault/release-1').exists())


if __name__ == '__main__':
    unittest.main()
