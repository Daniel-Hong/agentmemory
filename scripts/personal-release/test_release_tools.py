import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release_tools', Path(__file__).with_name('release_tools.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ReleaseToolsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='am-release-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'candidate'
        self.root.mkdir()
        self.installed = Path(self.tmp.name) / 'prefix/lib/node_modules/@agentmemory/agentmemory'
        self.installed.mkdir(parents=True)
        self.skill = Path(self.tmp.name) / 'skills/agentmemory/SKILL.md'
        self.skill.parent.mkdir(parents=True)
        self.skill.write_text('protected skill')
        (self.installed / 'index.mjs').write_text('fixture code')
        shutil.copyfile(Path(__file__).with_name('release_tools.py'), self.root / 'release_tools.py')
        (self.root / 'package.tgz').write_bytes(b'code only fixture')
        hashes = {p.name: m.sha(p) for p in self.root.iterdir()}
        self.manifest = {'artifactHashes': hashes, 'verificationFiles': hashes.copy(), 'packageFiles': {'index.mjs': m.sha(self.installed / 'index.mjs')}, 'baselineHashes': {str(self.skill): m.sha(self.skill)}, 'applied': False, 'deployable': False}
        self.save()

    def save(self):
        (self.root / 'release.json').write_text(json.dumps(self.manifest))

    def test_actual_generated_script_and_archive_readback(self):
        command = [sys.executable, str(self.root / 'release_tools.py'), 'preserve', '--root', str(self.root), '--installed', str(self.installed), '--baseline', '--destination', str(self.root.parent / 'archives')]
        result = json.loads(subprocess.check_output(command, text=True))
        self.assertTrue(result['readBackVerified'])
        self.assertEqual(result['entries'], 4)
        self.assertFalse(result['dataIncluded'])

    def test_hash_table_mismatch_rejected_before_preservation(self):
        self.manifest['verificationFiles'] = {}
        self.save()
        with self.assertRaisesRegex(RuntimeError, 'TABLE_MISMATCH'):
            m.preserve(self.root, self.root.parent / 'archives')
        self.assertFalse((self.root.parent / 'archives').exists())

    def test_protected_skill_and_installed_code_mismatch(self):
        self.skill.write_text('changed skill')
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_CHANGED'):
            m.verify(self.root, baseline=True)
        (self.installed / 'index.mjs').write_text('changed code')
        with self.assertRaisesRegex(RuntimeError, 'INSTALLED_HASH_MISMATCH'):
            m.verify(self.root, self.installed)

    def test_unsafe_and_artifact_tamper_rejected(self):
        (self.root / 'package.tgz').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'ARTIFACT_HASH_MISMATCH'):
            m.verify(self.root)
        with self.assertRaisesRegex(RuntimeError, 'UNSAFE_PATH'):
            m.safe(self.root, '../private')


if __name__ == '__main__':
    unittest.main()
