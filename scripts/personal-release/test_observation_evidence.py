import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

MODULE = Path(__file__).with_name('observation-evidence.py')


class ObservationEvidenceTests(unittest.TestCase):
    def load(self):
        spec = importlib.util.spec_from_file_location('evidence', MODULE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_alias_survives_process_exit_without_raw_identifier(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'run.json'
            module = self.load()
            first = module.AliasRun.create(path)
            alias = first.alias('synthetic-private-id')
            code = "import runpy,sys; m=runpy.run_path(sys.argv[1]); print(m['AliasRun'].resume(sys.argv[2]).alias('synthetic-private-id'))"
            result = subprocess.check_output([sys.executable, '-c', code, str(MODULE), str(path)], text=True).strip()
            self.assertEqual(alias, result)
            self.assertNotIn('synthetic-private-id', path.read_text())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                module.AliasRun.create(path)

    def test_missing_partial_insecure_or_symlink_state_is_not_new_run(self):
        module = self.load()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'run.json'
            with self.assertRaises(FileNotFoundError):
                module.AliasRun.resume(path)
            path.write_text('{')
            os.chmod(path, 0o600)
            with self.assertRaises(ValueError):
                module.AliasRun.resume(path)
            path.unlink()
            module.AliasRun.create(path)
            os.chmod(path, 0o644)
            with self.assertRaises(ValueError):
                module.AliasRun.resume(path)
            os.chmod(path, 0o600)
            link = Path(directory) / 'link'
            link.symlink_to(path)
            with self.assertRaises(OSError):
                module.AliasRun.resume(link)

    def test_run_identity_mismatch_refuses_join(self):
        module = self.load()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'run.json'
            run = module.AliasRun.create(path)
            data = json.loads(path.read_text())
            data['key'] = '00' * 32
            path.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                module.AliasRun.resume(path)
            self.assertNotIn(run.alias('synthetic'), json.dumps(data))

    def test_field_schema_distinguishes_missing_invalid_and_supported(self):
        classify = self.load().retry_metadata
        self.assertEqual(classify({})['retryCount'], {'state': 'absent'})
        self.assertEqual(classify({'attempts': True})['retryCount'], {'state': 'unsupported'})
        self.assertEqual(classify({'attempts': 3})['retryCount'], {'state': 'value', 'value': 3})
        self.assertEqual(classify({'nextAttemptAt': 'bad'})['nextRetryAt'], {'state': 'unsupported'})
        self.assertEqual(classify({'lastError': 'private contents'})['errorCategory'], {'state': 'present', 'value': 'other_redacted'})
        self.assertNotIn('private contents', json.dumps(classify({'lastError': 'private contents'})))


if __name__ == '__main__':
    unittest.main()
