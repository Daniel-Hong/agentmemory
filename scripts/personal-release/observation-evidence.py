"""Local run-scoped aliases for future authorized, metadata-only observers.

The private run file is not a report: retain it outside Git until reconciliation
finishes. It contains no event identifiers, bodies, or credentials. Losing it
means earlier aliases cannot be joined; never silently create replacement state.
"""
import datetime
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import stat


class AliasRun:
    def __init__(self, key):
        self._key = key
        self.run_id = hashlib.sha256(b'agentmemory-observer-run-v1' + key).hexdigest()

    @classmethod
    def create(cls, path):
        path = Path(path)
        run = cls(secrets.token_bytes(32))
        payload = json.dumps({'version': 1, 'runId': run.run_id, 'key': run._key.hex()}).encode()
        temporary = path.with_name(path.name + '.pending-' + secrets.token_hex(8))
        try:
            descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.link(temporary, path, follow_symlinks=False)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)
        return run

    @classmethod
    def resume(cls, path):
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o600:
                raise ValueError('PRIVATE_RUN_STATE_REQUIRED')
            if metadata.st_size > 512:
                raise ValueError('INVALID_RUN_STATE')
            try:
                record = json.loads(stream.read(513))
                key = bytes.fromhex(record['key'])
                run = cls(key)
                if len(key) != 32 or record['version'] != 1 or record['runId'] != run.run_id:
                    raise ValueError()
            except (ValueError, KeyError, TypeError):
                raise ValueError('INVALID_RUN_STATE') from None
        return run

    def alias(self, identifier):
        if not isinstance(identifier, str) or not identifier or len(identifier) > 4096:
            raise ValueError('INVALID_IDENTIFIER')
        return hmac.new(self._key, identifier.encode(), hashlib.sha256).hexdigest()


def retry_metadata(record):
    """Classify future authorized extracts without raw error or identifier output."""
    result = {}
    for field, output in [('attempts', 'retryCount'), ('nextAttemptAt', 'nextRetryAt')]:
        if field not in record:
            result[output] = {'state': 'absent'}
            continue
        value = record[field]
        valid = False
        if field == 'attempts':
            valid = type(value) is int and 0 <= value <= 10_000_000
        elif isinstance(value, str) and len(value) <= 40:
            try:
                parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
                valid = parsed.tzinfo is not None
            except ValueError:
                pass
        result[output] = {'state': 'value', 'value': value} if valid else {'state': 'unsupported'}
    error = record.get('lastError')
    if 'lastError' not in record:
        result['errorCategory'] = {'state': 'absent'}
    elif not isinstance(error, str):
        result['errorCategory'] = {'state': 'unsupported'}
    else:
        lowered = error.lower()
        category = 'timeout' if 'timeout' in lowered or 'timed out' in lowered else 'too_large' if 'too-large' in lowered else 'other_redacted'
        result['errorCategory'] = {'state': 'present', 'value': category}
    return result
