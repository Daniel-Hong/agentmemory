"""Paired reviewed SDK contracts using synthetic files/System only."""
import json
import os
import unittest
from pathlib import Path
import test_sdk_shutdown_compat as shutdown


class SdkPredecessorTests(unittest.TestCase):
    def setUp(self):
        shutdown.ShutdownTests.setUp(self)
        self.tx.start_attempted = False
        self.tx.owner, self.tx.anchor = os.getuid(), self.root
        self.tx.paths.update(public=self.root / 'public', releases=self.root / 'releases', dropin=self.root / 'service.conf', data=self.root / 'data')
        self.profile = {'backgroundControlVersion': 2, 'automaticMemoryRecovery': True, 'storageCompletion': 'sdk-v1', 'nativeEngineCompatibility': '0.22.1', 'serverDependencyMode': 'bundled-sdk0.25-v1'}
        self.version = '0.9.31-daniel.33'
        self.directory = self.tx.paths['releases'] / (self.version + '-' + 'a' * 8)
        self.manifest = self.directory / 'package.json'
        self.kitpath = self.tx.paths['public'] / 'prior-sdk' / 'kit.json'
        self.releasepath = self.kitpath.with_name('release.json')
        self.tx.baseline = {'protectedFiles': {}, 'receiptPath': str(self.root / 'activation.json')}
        self.write(self.manifest, {'version': self.version, 'agentmemoryCompatibility': self.profile})
        for name in ['dist/cli.mjs', 'dist/index.mjs']:
            self.write(self.directory / name, b'/* synthetic reviewed code */')
        ledger = {str(p): self.module.sha(p) for p in [self.manifest, self.directory / 'dist/cli.mjs', self.directory / 'dist/index.mjs']}
        identity = {'applied': True, 'sourceCommit': 'a' * 40, 'candidateHash': 'b' * 64, 'installedFileHashes': ledger}
        self.tx.baseline['receiptIdentity'] = identity
        self.write(Path(self.tx.baseline['receiptPath']), {**identity, 'version': self.version}, bound=False)
        self.write(self.releasepath, {'packageVersion': self.version, 'sourceCommit': 'a' * 40, 'packageFiles': {name: self.module.sha(self.directory / name) for name in ['package.json', 'dist/cli.mjs', 'dist/index.mjs']}})
        self.oldkit = {'version': self.version, 'sourceCommit': 'a' * 40, 'packageSha256': 'b' * 64, 'shutdownCompletion': 'sdk-v1', 'executionClosureReviewed': True, 'reviewedBy': 'AI synthetic review', 'files': {'release.json': self.module.sha(self.releasepath), 'package.tgz': 'b' * 64}}
        self.write(self.kitpath.with_name('kit-runtime.py'), b'# reviewed synthetic sdk guard')
        self.oldkit['files']['kit-runtime.py'] = self.module.sha(self.kitpath.with_name('kit-runtime.py'))
        self.write(self.kitpath, self.oldkit)
        self.tx.baseline['protectedFiles'][str(self.kitpath.with_name('package.tgz'))] = 'b' * 64
        self.write(self.tx.paths['dropin'], ('[Service]\nExecStart=\nExecStart=/usr/bin/node ' + str(self.directory / 'dist/cli.mjs') + ' --data-dir ' + str(self.tx.paths['data']) + ' --native-compat\nExecStop=\nExecStop=/usr/bin/node ' + str(self.directory / 'dist/cli.mjs') + ' stop --native-compat --data-dir ' + str(self.tx.paths['data']) + '\nExecStartPre=\nExecStartPre=/usr/bin/python3 -I -B ' + str(self.kitpath.with_name('kit-runtime.py')) + ' --guard\n').encode())
        self.health = {'version': self.version, 'storageDurability': {'completion': 'sdk', 'mutationFailures': 0}}
        self.tx.api = lambda path: self.health
        self.tx.previous_version = self.version
        self.tx.candidate_manifest = lambda: {'agentmemoryCompatibility': dict(self.profile)}
        self.identities = {101: 1001, 102: 1002, 103: 1003}
        self.tx.system.process_identity = lambda pid: (pid, self.identities[pid])
        self.commands = {line.split('=', 1)[0]: line.split('=', 1)[1] for line in self.tx.paths['dropin'].read_text().splitlines() if line.startswith(('ExecStart=', 'ExecStop=', 'ExecStartPre=')) and not line.endswith('=')}
        self.tx.system.service_commands = lambda: dict(self.commands)

    def write(self, path, value, bound=True):
        path.parent.mkdir(parents=True, exist_ok=True)
        for parent in (path.parent, *path.parent.parents):
            if not parent.is_relative_to(self.root): break
            parent.chmod(0o700)
        path.write_bytes(value if isinstance(value, bytes) else json.dumps(value).encode())
        path.chmod(0o600)
        if bound: self.tx.baseline['protectedFiles'][str(path)] = self.module.sha(path)

    def prove(self):
        self.tx.predecessor_contract = self.tx.predecessor_shutdown_contract(self.health)

    def test_matching_paired_sdk_contract_accepts_fresh_initial_sdk_stop(self):
        self.prove(); self.tx.stop()
        self.assertTrue(self.tx.certified_stopped)
        self.assertIs(self.tx.stop_receipt['verified'], False)
        self.assertIs(self.tx.stop_receipt['durability']['synced'], False)

    def test_unproven_initial_stop_is_refused_before_service_control(self):
        with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_CONTRACT_UNVERIFIED'): self.tx.stop()
        self.assertFalse(self.tx.system.stopped)

    def test_contract_or_process_change_after_preflight_refuses_before_stop(self):
        self.prove(); self.identities[101] += 1
        with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_CONTRACT_CHANGED'): self.tx.stop()
        self.assertFalse(self.tx.system.stopped)

    def test_changed_bound_kit_is_refused_before_stop(self):
        self.prove(); self.kitpath.write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'SDK_PREDECESSOR_CONTRACT_UNVERIFIED'): self.tx.stop()
        self.assertFalse(self.tx.system.stopped)

    def test_missing_root_contract_is_not_inferred_from_sdk_health(self):
        self.write(self.tx.paths['dropin'], b'[Service]\nExecStart=/usr/bin/node /unbound/cli.mjs\n')
        with self.assertRaisesRegex(RuntimeError, 'SDK_PREDECESSOR_CONTRACT_UNVERIFIED'): self.prove()
        self.assertFalse(self.tx.system.stopped)

    def test_old_candidate_must_explicitly_advertise_sdk(self):
        self.oldkit.pop('shutdownCompletion'); self.write(self.kitpath, self.oldkit)
        with self.assertRaisesRegex(RuntimeError, 'SDK_PREDECESSOR_CONTRACT_UNVERIFIED'): self.prove()

    def test_new_candidate_must_explicitly_advertise_sdk(self):
        self.tx.kit = {}
        with self.assertRaisesRegex(RuntimeError, 'SDK_PREDECESSOR_CONTRACT_UNVERIFIED'): self.prove()

    def test_target_profile_must_match_predecessor(self):
        self.tx.candidate_manifest = lambda: {'agentmemoryCompatibility': {**self.profile, 'automaticMemoryRecovery': False}}
        with self.assertRaisesRegex(RuntimeError, 'SDK_PREDECESSOR_CONTRACT_UNVERIFIED'): self.prove()

    def test_live_version_and_mutation_failures_are_checked(self):
        for health in [{'version': '0.9.31-daniel.32', 'storageDurability': {'completion': 'sdk', 'mutationFailures': 0}}, {'version': self.version, 'storageDurability': {'completion': 'sdk', 'mutationFailures': 1}}]:
            with self.subTest(health=health):
                with self.assertRaisesRegex(RuntimeError, 'SDK_PREDECESSOR_CONTRACT_UNVERIFIED'): self.tx.predecessor_shutdown_contract(health)

    def test_old_manifest_symlink_is_refused(self):
        copy = self.root / 'outside.json'; copy.write_bytes(self.manifest.read_bytes())
        self.manifest.unlink(); self.manifest.symlink_to(copy)
        with self.assertRaisesRegex(RuntimeError, 'SDK_PREDECESSOR_CONTRACT_UNVERIFIED'): self.prove()

    def test_sdk_receipt_still_refuses_false_disk_claim(self):
        self.prove(); self.receipt['verified'] = True
        with self.assertRaisesRegex(RuntimeError, 'SHUTDOWN_NOT_VERIFIED'): self.tx.stop()
        self.assertFalse(self.tx.certified_stopped)

    def test_sdk_receipt_still_requires_all_processes_gone(self):
        self.prove(); self.tx.system.remains.add(102)
        with self.assertRaisesRegex(RuntimeError, 'SHUTDOWN_PROCESS_REMAINS'): self.tx.stop()

    def test_disk_predecessor_cannot_use_sdk_receipt(self):
        self.health['storageDurability']['completion'] = 'disk'; self.prove()
        with self.assertRaisesRegex(RuntimeError, 'SHUTDOWN_NOT_VERIFIED'): self.tx.stop()

    def test_disk_predecessor_accepts_only_verified_disk_receipt(self):
        self.health['storageDurability']['completion'] = 'disk'; self.prove()
        self.receipt.update(verified=True); self.receipt['durability'].update(completion='disk', synced=True)
        self.tx.stop(); self.assertTrue(self.tx.certified_stopped)


    def test_root_review_is_required(self):
        self.oldkit['executionClosureReviewed'] = False; self.write(self.kitpath, self.oldkit)
        with self.assertRaisesRegex(RuntimeError, 'SDK_PREDECESSOR_CONTRACT_UNVERIFIED'): self.prove()

    def test_group_writable_predecessor_kit_is_refused(self):
        self.kitpath.chmod(0o666)
        with self.assertRaisesRegex(RuntimeError, 'SDK_PREDECESSOR_CONTRACT_UNVERIFIED'): self.prove()

    def test_bound_service_must_start_bound_predecessor_code(self):
        text = self.tx.paths['dropin'].read_text().replace(str(self.directory / 'dist/cli.mjs'), '/unbound/cli.mjs')
        self.write(self.tx.paths['dropin'], text.encode())
        with self.assertRaisesRegex(RuntimeError, 'SDK_PREDECESSOR_CONTRACT_UNVERIFIED'): self.prove()

    def test_activation_identity_must_remain_exact(self):
        path = Path(self.tx.baseline['receiptPath']); data = json.loads(path.read_text()); data['candidateHash'] = 'c' * 64; self.write(path, data, bound=False)
        with self.assertRaisesRegex(RuntimeError, 'SDK_PREDECESSOR_CONTRACT_UNVERIFIED'): self.prove()

    def test_release_table_must_bind_installed_profile(self):
        data = json.loads(self.releasepath.read_text()); data['packageFiles']['package.json'] = 'c' * 64
        self.write(self.releasepath, data); self.oldkit['files']['release.json'] = self.module.sha(self.releasepath); self.write(self.kitpath, self.oldkit)
        with self.assertRaisesRegex(RuntimeError, 'SDK_PREDECESSOR_CONTRACT_UNVERIFIED'): self.prove()

    def test_installed_code_change_after_preflight_refuses_before_stop(self):
        self.prove(); (self.directory / 'dist/cli.mjs').write_bytes(b'changed synthetic code')
        with self.assertRaisesRegex(RuntimeError, 'SDK_PREDECESSOR_CONTRACT_UNVERIFIED'): self.tx.stop()
        self.assertFalse(self.tx.system.stopped)

    def test_pid_file_change_after_fresh_proof_cannot_replace_proven_worker(self):
        self.prove(); identity = self.tx.system.process_identity
        def changed(pid):
            result = identity(pid)
            if pid == 103:
                (self.root / 'worker.pid').write_text('201')
                self.receipt['pid'] = 201
                self.tx.system.remains.add(101)
            return result
        self.tx.system.process_identity = changed
        with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_CONTRACT_CHANGED'): self.tx.stop()
        self.assertFalse(self.tx.system.stopped)
        self.assertFalse(self.tx.certified_stopped)

    def test_effective_service_override_is_refused(self):
        self.commands['ExecStart'] = '/unbound/cli.mjs'
        with self.assertRaisesRegex(RuntimeError, 'SDK_PREDECESSOR_CONTRACT_UNVERIFIED'): self.prove()
        self.assertFalse(self.tx.system.stopped)

    def test_late_pid_replacement_cannot_certify_a_different_worker(self):
        self.prove(); identity = self.tx.system.process_identity; count = 0
        def changed(pid):
            nonlocal count
            result = identity(pid)
            if pid == 103:
                count += 1
                if count == 2:
                    (self.root / 'worker.pid').write_text('201'); self.receipt['pid'] = 201; self.tx.system.remains.add(101)
            return result
        self.tx.system.process_identity = changed
        with self.assertRaisesRegex(RuntimeError, 'SHUTDOWN_NOT_VERIFIED'): self.tx.stop()
        self.assertFalse(self.tx.certified_stopped)

    def test_effective_command_parser_rejects_ambiguous_or_ignored_commands(self):
        from unittest.mock import patch
        for raw in ['{ argv[]=/usr/bin/node fixture ; ignore_errors=yes ; }', '{ argv[]=one ; ignore_errors=no ; } { argv[]=two ; ignore_errors=no ; }']:
            with self.subTest(raw=raw), patch.object(self.module.subprocess, 'check_output', return_value=raw):
                with self.assertRaisesRegex(RuntimeError, 'SERVICE_COMMAND_UNVERIFIED'): self.module.System().service_commands()

    def test_effective_command_parser_reads_only_three_expected_fields(self):
        from unittest.mock import patch
        commands = {'ExecStart': 'node fixture', 'ExecStop': 'node fixture stop', 'ExecStartPre': 'python fixture guard'}
        raw = ['{ path=fixture ; argv[]=' + value + ' ; ignore_errors=no ; pid=123 ; }' for value in commands.values()]
        with patch.object(self.module.subprocess, 'check_output', side_effect=raw) as read:
            self.assertEqual(self.module.System().service_commands(), commands)
            self.assertEqual([call.args[0][-2] for call in read.call_args_list], list(commands))

if __name__ == '__main__': unittest.main()
