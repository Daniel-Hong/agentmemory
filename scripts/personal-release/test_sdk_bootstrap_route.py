"""Synthetic existing reviewed-kit bootstrap route; never invokes a service."""
import io
import json
import os
import tarfile
import unittest
from unittest.mock import patch
import test_dashboard_kit as base


class SdkBootstrapRouteTests(unittest.TestCase):
    write = base.TransactionTests.write
    api = base.TransactionTests.api

    def setUp(self):
        base.TransactionTests.setUp(self)
        home = patch.dict(os.environ, {'HOME': str(self.root / 'home'), 'XDG_CONFIG_HOME': str(self.root / 'config')})
        home.start(); self.addCleanup(home.stop)
        self.client_root = self.root / 'home/daniel/.local/share/agentmemory-personal/releases/client-fixture'
        names = ['_capture.mjs', 'manifest.json', 'long-session-hook-client.mjs', *[f'hook{i}.mjs' for i in range(10)]]
        self.old = {f'plugin/scripts/codex-compat/{name}': ('old-' + name).encode() for name in names}
        self.files = {**self.old, 'dist/cli.mjs': b'export const synthetic = true;'}
        for name, data in self.old.items(): self.write(self.client_root / name, data)
        for name in names[:3]: self.files['plugin/scripts/codex-compat/' + name] = ('sdk-' + name).encode()
        baseline = {**self.tx.baseline, 'clientsRetainedAt': str(self.client_root),
                    'compatibilityFiles': {name: self.digest(data) for name, data in self.old.items()}}
        baseline['protectedFiles'] = {**baseline['protectedFiles'], **{str(self.client_root / name): self.digest(data) for name, data in self.old.items()}}
        proposed = {'version': '0.9.31-daniel.33', 'dependencies': {'iii-sdk': '0.25.0', '@iii-dev/helpers': '0.25.0', 'yaml': '^2.8.1', 'json5': '^2.2.3'},
                    'agentmemoryCompatibility': {'backgroundControlVersion': 2, 'automaticMemoryRecovery': True, 'storageCompletion': 'sdk-v1', 'nativeEngineCompatibility': '0.22.1', 'serverDependencyMode': 'bundled-sdk0.25-v1'}}
        self.write(self.paths['legacy'] / 'package.json', json.dumps({'dependencies': {'iii-sdk': '0.22.1', '@iii-dev/helpers': '0.22.1'}}).encode())
        inventory = {'dist/cli.mjs': self.digest(self.files['dist/cli.mjs'])}
        closure = {'version': 1, 'mode': 'bundled-sdk0.25-v1', 'bundledPackages': {'iii-sdk': '0.25.0', '@iii-dev/helpers': '0.25.0', 'yaml': '2.8.1', 'json5': '2.2.3'}, 'files': inventory, 'externalSpecifiers': {'dist/cli.mjs': []}}
        self.files.update({'package.json': json.dumps(proposed).encode(), 'dist/server-sdk-bundle.json': json.dumps(closure).encode()})
        package = self.root / 'sdk-package.tgz'
        with tarfile.open(package, 'w:gz') as archive:
            for name, data in self.files.items():
                member = tarfile.TarInfo('package/' + name); member.size = len(data); archive.addfile(member, io.BytesIO(data))
        release = {'sourceCommit': 'c' * 40, 'packageVersion': proposed['version'], 'packageFiles': {name: self.digest(data) for name, data in self.files.items()}, 'artifactHashes': {}, 'verificationFiles': {}}
        self.transition = {'version': 1, 'files': {name: {'before': self.digest(data), 'after': self.digest(self.files[name])} for name, data in self.old.items() if data != self.files[name]}}
        self.metadata = {'id': 'sdk-bootstrap-33', 'version': proposed['version'], 'sourceCommit': release['sourceCommit'], 'packageSha256': self.runtime.sha(package),
                         'changeSummary': 'Synthetic normal SDK bootstrap route', 'tests': ['synthetic bootstrap and static guard'], 'shutdownCompletion': 'sdk-v1', 'clientTransition': self.transition}
        self.sdk_draft = self.root / 'sdk-draft'
        self.prepare.prepare(package, release, baseline, self.metadata, self.sdk_draft)
        self.sdk_review = self.root / 'sdk-review.json'
        self.review = {'executionClosureReviewed': True, 'reviewedBy': 'explicit synthetic administrator', 'draftManifestSha256': self.runtime.sha(self.sdk_draft / 'kit.json')}
        self.write(self.sdk_review, json.dumps(self.review).encode())
        dashboard = base.load('dashboard-updates')
        self.manager = dashboard.Runner(state=self.state, trusted_uid=os.getuid(), trust_anchor=self.root)
        self.manager.initialize()
        self.dispatches = []

    def digest(self, data):
        return self.runtime.hashlib.sha256(data).hexdigest()

    def bootstrap(self):
        def reviewed_runner(args, **kwargs):
            self.assertEqual(args, ['/usr/bin/python3', '-I', '-B', str(self.runner), '--enroll', str(self.state / 'incoming' / self.metadata['id'])])
            self.dispatches.append(args)
            self.manager.enroll(self.state / 'incoming' / self.metadata['id'])
        return self.enroll.install(self.sdk_draft, self.sdk_review, state=self.state, runner=self.runner, owner=os.getuid(), anchor=self.root, run=reviewed_runner)

    def test_normal_bootstrap_preserves_sdk_metadata_runtime_hashes_and_static_proof(self):
        before = {name: (self.client_root / name).read_bytes() for name in self.old}
        prior_guard_hashes = {str(path): self.runtime.sha(path) for path in self.tx.root.iterdir() if path.is_file()}
        prior_root_assets = self.tx.baseline['rootAssets'].copy()
        result = self.bootstrap()
        self.assertTrue(result['enrolled']); self.assertFalse(result['applied']); self.assertFalse(result['serviceControlled'])
        public = self.paths['public'] / self.metadata['id']
        metadata = self.manager.checked_kit(public)
        self.assertEqual(metadata['shutdownCompletion'], 'sdk-v1')
        self.assertEqual(metadata['clientTransition'], self.transition)
        self.assertEqual(metadata['version'], '0.9.31-daniel.33')
        for name in ('kit-runtime.py', 'kit-queues.py', 'kit-integrity.py'):
            self.assertEqual(metadata['files'][name], self.runtime.sha(base.HERE / name))
            self.assertEqual(self.runtime.sha(public / name), metadata['files'][name])
        # The proof executes reviewed source helpers, never Python or JS from the candidate.
        guard = object.__new__(self.runtime.Runtime)
        guard.root, guard.paths, guard.kit = public, self.paths, metadata
        guard.release = self.runtime.read_json(public / 'release.json')
        guard.integrity = base.load('kit-integrity')
        guard.verify_dependency_reuse()
        self.runtime.verify_map(prior_guard_hashes)
        self.runtime.verify_map(prior_root_assets)
        self.assertEqual({name: (self.client_root / name).read_bytes() for name in self.old}, before)
        self.assertEqual(len(self.dispatches), 1)
        self.assertEqual(len(self.manager.catalog()), 1)

    def test_bootstrap_requires_explicit_review_without_dispatch(self):
        self.review['executionClosureReviewed'] = False
        self.write(self.sdk_review, json.dumps(self.review).encode())
        with self.assertRaisesRegex(RuntimeError, 'ADMINISTRATOR_REVIEW_REQUIRED'): self.bootstrap()
        self.assertEqual(self.dispatches, [])
        self.assertEqual(self.manager.catalog(), [])


if __name__ == '__main__': unittest.main()
