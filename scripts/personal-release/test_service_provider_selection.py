"""Synthetic-only tests for a reviewed fixed service provider selection."""
import hashlib
import json
import os
from unittest import TestCase, mock

import test_dashboard_kit as dashboard_fixtures


class ServiceProviderSelectionTests(TestCase):
    def setUp(self):
        self.fixture = dashboard_fixtures.TransactionTests('runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.runtime = self.fixture.runtime
        self.original_dropin = self.fixture.tx.dropin_bytes()
        self.original_env = self.fixture.paths['env'].read_bytes()

    def selected(self, value):
        root = self.fixture.tx.root
        release = json.loads((root / 'release.json').read_text())
        release['serviceProviderSelection'] = value
        (root / 'release.json').write_text(json.dumps(release))
        kit = json.loads((root / 'kit.json').read_text())
        kit['files']['release.json'] = self.runtime.sha(root / 'release.json')
        (root / 'kit.json').write_text(json.dumps(kit))
        tx = self.runtime.Runtime(root, paths=self.fixture.paths, owner=os.getuid(), anchor=self.fixture.root,
                                  service_uid=os.getuid(), service_gid=os.getgid(), system=self.fixture.system)
        tx.api = self.fixture.api
        return tx

    def test_absent_selection_keeps_existing_dropin_and_environment(self):
        self.assertNotIn(b'AGENTMEMORY_LLM_PROVIDER', self.original_dropin)
        self.assertEqual(self.fixture.tx.post_files()[str(self.fixture.paths['env'])], hashlib.sha256(self.original_env).hexdigest())

    def test_reviewed_openai_selection_adds_exactly_one_protected_nonsecret_line(self):
        tx = self.selected({'llm': 'openai'})
        expected = self.original_dropin + b'Environment="AGENTMEMORY_LLM_PROVIDER=openai"\n'
        self.assertEqual(tx.dropin_bytes(), expected)
        self.assertEqual(tx.post_files()[str(self.fixture.paths['dropin'])], hashlib.sha256(expected).hexdigest())
        self.assertEqual(self.fixture.paths['env'].read_bytes(), self.original_env)
        original_api = tx.api
        tx.api = lambda path, body=None: {**original_api(path, body), 'provider': 'llm'} if path == 'config/flags' else original_api(path, body)
        tx.apply()
        self.assertEqual(self.fixture.paths['dropin'].read_bytes(), expected)
        self.assertEqual(self.fixture.paths['env'].read_bytes(), self.original_env)
        # The normal managed guard must still reject a changed selection.
        self.fixture.paths['dropin'].write_bytes(expected.replace(b'=openai', b'=noop'))
        with self.assertRaisesRegex(RuntimeError, 'PROTECTED_FILE_CHANGED'):
            tx.guard()

    def test_refuses_other_providers_extra_fields_and_environment_injection(self):
        for value in (None, True, 'openai', {}, {'llm': 'anthropic'}, {'llm': 'openai', 'extra': 'x'}, {'llm': 'openai\nEnvironment="UNREVIEWED=x"'}):
            with self.subTest(value=value):
                with self.assertRaisesRegex(RuntimeError, 'UNSUPPORTED_SERVICE_PROVIDER_SELECTION'):
                    self.selected(value)
        self.assertEqual(self.fixture.paths['env'].read_bytes(), self.original_env)

    def test_selected_provider_must_be_active_before_acceptance(self):
        tx = self.selected({'llm': 'openai'})
        self.fixture.system.started = True
        calls = []
        tx.verify_data = lambda: calls.append('data')
        tx.guard = lambda: calls.append('guard')
        original_api = tx.api
        tx.api = lambda path, body=None: {**original_api(path, body), 'provider': 'noop'} if path == 'config/flags' else original_api(path, body)
        with mock.patch.object(self.runtime.time, 'monotonic', side_effect=[0, 121]):
            with self.assertRaisesRegex(RuntimeError, 'SELECTED_LLM_PROVIDER_NOT_READY'):
                tx.verify_runtime()
        self.assertEqual(calls, [])
        self.assertEqual(self.fixture.paths['env'].read_bytes(), self.original_env)
