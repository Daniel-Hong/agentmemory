"""Compare stopped backup with current file-KV; output only safe counters."""
from pathlib import Path
import hashlib
import json
import re
import tarfile
from urllib.parse import unquote, quote


def require(value, code):
    if not value: raise RuntimeError(code)


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): value.update(block)
    return value.hexdigest()


def namespace(path):
    # Decode the JSON prefix only; iii's trailing rkyv bytes are opaque.
    text = path.read_bytes().decode('utf-8', errors='surrogateescape')
    value, _ = json.JSONDecoder().raw_decode(text.lstrip())
    require(isinstance(value, dict), 'NAMESPACE_SHAPE_INVALID')
    return value


def retained(old, current):
    if isinstance(old, dict):
        return isinstance(current, dict) and all(key in current and retained(value, current[key]) for key, value in old.items())
    if isinstance(old, list):
        return isinstance(current, list) and len(current) >= len(old) and all(retained(value, current[i]) for i, value in enumerate(old))
    return type(old) is type(current) and old == current


def graph_retained(old, current):
    if isinstance(old, dict):
        if not isinstance(current, dict): return False
        for key, value in old.items():
            if key == 'sourceObservationIds':
                selected = current.get(key)
                if not isinstance(value, list) or not isinstance(selected, list) or len(selected) > 32 or any(item not in value for item in selected): return False
                if len(value) <= 32 and value != selected: return False
                if len(value) > 32 and len(selected) != 32: return False
            elif key not in current or not graph_retained(value, current[key]): return False
        return True
    if isinstance(old, list):
        return isinstance(current, list) and len(current) >= len(old) and all(graph_retained(value, current[i]) for i, value in enumerate(old))
    return old == current


def vectors(directory):
    root = namespace(directory / 'mem%3Aindex%3Abm25.bin')
    meta = root.get('vectors:meta')
    if isinstance(meta, dict) and meta.get('v') == 3:
        result = {}
        for path in directory.glob('mem%3Aindex%3Abm25%3Avec%3A*.bin'):
            for key, row in namespace(path).items():
                require(isinstance(row, dict) and row.get('id') == key and key not in result, 'VECTOR_RECORD_INVALID')
                result[key] = (row.get('s'), row.get('e'))
        require(len(result) == meta.get('count'), 'VECTOR_METADATA_COUNT_MISMATCH')
        return result
    manifest = root.get('vectors:manifest')
    if isinstance(manifest, dict):
        from urllib.parse import quote
        chunks = []
        for shard in manifest.get('shards', []):
            row = namespace(directory / (quote(shard['scope'], safe="~()*!.'-") + '.bin'))
            value = row.get(shard['key'])
            require(isinstance(value, str), 'LEGACY_VECTOR_SHARD_MISSING')
            chunks.append(value)
        serialized = ''.join(chunks)
    else: serialized = root.get('vectors')
    if serialized is None: return {}
    require(isinstance(serialized, str), 'LEGACY_VECTOR_INVALID')
    rows = json.loads(serialized)
    require(isinstance(rows, list), 'LEGACY_VECTOR_SHAPE_INVALID')
    return {key: (value.get('sessionId'), value.get('embedding')) for key, value in rows}


def verify(before_data, current_data, *, allow_background_hold=False):
    before = Path(before_data) / 'state_store.db'
    current = Path(current_data) / 'state_store.db'
    require(before.is_dir() and current.is_dir(), 'STATE_DIRECTORIES_REQUIRED')
    checked = unchanged = raw = 0
    volatile = {'mem:health', 'mem:access', 'mem:access-logs', 'mem:viewer-stream'}
    graph = {'mem:graph:nodes', 'mem:graph:edges', 'mem:graph:edge-history', 'mem:graph:snapshot'}
    for path in before.glob('*.bin'):
        scope = unquote(path.stem)
        if scope == 'mem:index:bm25' or scope.startswith('mem:index:bm25:') or scope in volatile: continue
        target = current / path.name
        require(target.is_file(), 'ORIGINAL_NAMESPACE_REMOVED')
        checked += 1
        if digest(path) == digest(target): unchanged += 1; continue
        # A frozen oversized legacy Audit must remain byte-identical.
        require(scope != 'mem:audit', 'LEGACY_AUDIT_CHANGED')
        old, new = namespace(path), namespace(target)
        if scope in graph:
            require(graph_retained(old, new), 'GRAPH_CONTENT_NOT_PRESERVED')
        elif scope == 'mem:metrics':
            for key, row in old.items():
                require(key in new and isinstance(new[key], dict), 'METRICS_RECORD_REMOVED')
                for field in ('totalCalls', 'successCount', 'failureCount', 'qualitySampleCount'):
                    if isinstance(row.get(field), (int, float)): require(new[key].get(field, -1) >= row[field], 'METRICS_COUNTER_REWOUND')
                if row.get('qualityEpochAt') is not None: require(new[key].get('qualityEpochAt') == row['qualityEpochAt'], 'METRICS_EPOCH_CHANGED')
        elif scope == 'mem:background-control:v1' and allow_background_hold:
            # Recovery deliberately changes only the admission hold; all prior values remain in its private backup.
            record = new.get('manual-pause')
            require(isinstance(record, dict) and record.get('paused') is True and record.get('resumePending') is not True, 'RECOVERY_BACKGROUND_NOT_HELD')
            previous = old.get('manual-pause', {})
            require(isinstance(previous, dict) and set(previous.get('holds', [])).issubset(record.get('holds', [])) and retained({k: v for k, v in previous.items() if k not in ('paused', 'resumePending', 'holds')}, record), 'RECOVERY_BACKGROUND_HOLDS_CHANGED')
            require(retained({k: v for k, v in old.items() if k != 'manual-pause'}, {k: v for k, v in new.items() if k != 'manual-pause'}), 'ORIGINAL_STATE_NOT_PRESERVED')
        elif scope.startswith('mem:obs:'):
            for key, row in old.items():
                require(key in new, 'ORIGINAL_OBSERVATION_REMOVED')
                for field in ('sourceRaw', 'source'):
                    if field in row: require(new[key].get(field) == row[field], 'ORIGINAL_SOURCE_CHANGED')
                raw += 1
        elif scope == 'mem:capture:inbox':
            for key,row in old.items():
                if row.get('storageCompletion') == 'sdk':
                    require(key in new and retained(row, new[key]), 'SDK_CAPTURE_EVIDENCE_CHANGED')
                    continue
                if key in new:
                    for field in ('key','eventId','eventSource','sessionId','observationId','payload','acceptedAt'):
                        if field in row: require(new[key].get(field)==row[field],'CAPTURE_EVIDENCE_CHANGED')
                    require(new[key].get('attempts',0)>=row.get('attempts',0),'CAPTURE_ATTEMPTS_REWOUND')
                    continue
                sid,oid=row.get('sessionId'),row.get('observationId')
                require(isinstance(sid,str) and isinstance(oid,str),'CAPTURE_COMPLETION_NOT_VERIFIED')
                if row.get('eventSource')=='client':
                    completion=current/(quote('mem:capture:events:'+key[4:6],safe="~()*!.'-")+'.bin')
                    record=namespace(completion).get(key) if completion.is_file() else None
                    require(isinstance(record,dict) and all(record.get(field)==row.get(field) for field in ('key','eventId','sessionId','project','observationId','acceptedAt')) and record.get('state')!='deleted' and record.get('attempts',0)>=row.get('attempts',0) and record.get('completedAt'),'CAPTURE_COMPLETION_NOT_VERIFIED')
                observation=current/(quote('mem:obs:'+sid,safe="~()*!.'-")+'.bin')
                stored=namespace(observation).get(oid) if observation.is_file() else None
                payload=row.get('payload',{})
                source=stored.get('sourceRaw') if isinstance(stored,dict) else None
                # Inbox payload is already privacy-scrubbed. Fail closed if its exact source cannot be proved.
                require(isinstance(stored,dict) and stored.get('id')==oid and stored.get('sessionId')==sid and isinstance(source,dict) and source.get('id')==oid and source.get('sessionId')==sid and source.get('timestamp')==payload.get('timestamp') and source.get('hookType')==payload.get('hookType') and source.get('raw')==payload.get('data'),'CAPTURE_OBSERVATION_NOT_PRESERVED')
        elif scope == 'mem:sessions':
            for key, row in old.items():
                require(key in new, 'ORIGINAL_SESSION_REMOVED')
                for field in ('id', 'project', 'cwd', 'startedAt'):
                    if field in row: require(new[key].get(field) == row[field], 'SESSION_IDENTITY_CHANGED')
                if isinstance(row.get('observationCount'), int): require(new[key].get('observationCount', -1) >= row['observationCount'], 'SESSION_COUNT_REWOUND')
        else:
            require(retained(old, new), 'ORIGINAL_STATE_NOT_PRESERVED')
    expected, actual = vectors(before), vectors(current)
    if expected:
        metadata = namespace(current / 'mem%3Aindex%3Abm25.bin').get('vectors:meta')
        require(isinstance(metadata, dict) and metadata.get('v') == 3, 'VECTOR_MIGRATION_NOT_COMPLETED')
    require(all(actual.get(key) == row for key, row in expected.items()), 'VECTOR_VALUE_OR_SESSION_CHANGED')
    return {'verified': True, 'checkedNamespaces': checked, 'unchangedNamespaces': unchanged, 'comparedChangedObservations': raw, 'preservedVectors': len(expected), 'originalsPreserved': True, 'dataRewound': False}


def verify_server_bundle(package_path, package_files):
    try:
        _verify_server_bundle(package_path, package_files)
    except (ValueError, TypeError, KeyError, RecursionError, tarfile.TarError, OSError):
        raise RuntimeError('SDK_BUNDLE_UNVERIFIED') from None


def _verify_server_bundle(package_path, package_files):
    name = 'dist/server-sdk-bundle.json'
    table = package_files
    require(name in table, 'SDK_BUNDLE_CLOSURE_REQUIRED')
    inventory = {path: digest for path, digest in table.items() if path.startswith('dist/') and Path(path).suffix in ('.js', '.mjs', '.cjs')}
    require(bool(inventory), 'SDK_BUNDLE_UNVERIFIED')
    def forbidden(specifier):
        return specifier.startswith('@opentelemetry') or any(specifier == root or specifier.startswith(root + '/') for root in ('iii-sdk', '@iii-dev/helpers', 'yaml', 'json5'))
    def decode_literal(token):
        text = token[1:-1]
        text = re.sub(r'\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]{1,6})\})', lambda match: chr(int(next(value for value in match.groups() if value is not None), 16)), text)
        return re.sub(r'\\(.)', r'\1', re.sub(r'\\\r?\n', '', text))
    def scan_literals(text, depth=0):
        tokens = []
        pattern = r'''(?P<skip>\s+|//[^\r\n]*|/\*.*?\*/)|(?P<string>'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(?P<identifier>[A-Za-z_$][\w$]*)|(?P<punctuation>.)'''
        for token in re.finditer(pattern, text, re.DOTALL):
            if token.lastgroup != 'skip':
                tokens.append((token.lastgroup, token.group()))
        for index, (kind, value) in enumerate(tokens):
            if kind == 'string':
                if depth < 2:
                    scan_literals(decode_literal(value), depth + 1)
                continue
            if kind != 'identifier':
                continue
            target = index + 1
            if value == 'from':
                pass
            elif value == 'import' or re.fullmatch(r'(?:__)?require(?:[$_]?\d+)?', value):
                if target < len(tokens) and tokens[target][1] == '(':
                    target += 1
            else:
                continue
            if target < len(tokens) and tokens[target][0] == 'string':
                require(not forbidden(decode_literal(tokens[target][1])), 'SDK_BUNDLE_UNVERIFIED')
    with tarfile.open(package_path) as archive:
        members = archive.getmembers()
        runtime_members = [member.name[8:] for member in members if member.name.startswith('package/dist/') and Path(member.name).suffix in ('.js', '.mjs', '.cjs')]
        require(set(runtime_members) == set(inventory) and len(runtime_members) == len(inventory), 'SDK_BUNDLE_UNVERIFIED')
        def bound_bytes(path):
            selected = [member for member in members if member.name == 'package/' + path]
            require(len(selected) == 1 and selected[0].isfile() and selected[0].size <= 64 * 1024 * 1024, 'SDK_BUNDLE_UNVERIFIED')
            content = archive.extractfile(selected[0]).read()
            require(hashlib.sha256(content).hexdigest() == table[path], 'SDK_BUNDLE_UNVERIFIED')
            return content
        closure = json.loads(bound_bytes(name))
        require(isinstance(closure, dict) and set(closure) == {'version', 'mode', 'bundledPackages', 'files', 'externalSpecifiers'} and type(closure.get('version')) is int and closure['version'] == 1 and closure.get('mode') == 'bundled-sdk0.25-v1', 'SDK_BUNDLE_UNVERIFIED')
        require(closure['bundledPackages'] == {'iii-sdk': '0.25.0', '@iii-dev/helpers': '0.25.0', 'yaml': '2.8.1', 'json5': '2.2.3'} and closure['files'] == inventory, 'SDK_BUNDLE_UNVERIFIED')
        imports = closure['externalSpecifiers']
        require(isinstance(imports, dict) and set(imports) == set(inventory), 'SDK_BUNDLE_UNVERIFIED')
        for path in inventory:
            require(isinstance(imports[path], list) and all(isinstance(item, str) and not forbidden(item) for item in imports[path]), 'SDK_BUNDLE_UNVERIFIED')
            # Independent literal check of reviewed compiler output, not a JS semantic sandbox.
            scan_literals(bound_bytes(path).decode('utf-8'))


def verify_sdk_package_contract(current, proposed, package_path, package_files):
    profile = proposed.get('agentmemoryCompatibility')
    fields = {'backgroundControlVersion', 'automaticMemoryRecovery', 'storageCompletion', 'nativeEngineCompatibility', 'serverDependencyMode'}
    require(isinstance(profile, dict) and set(profile) == fields and type(profile.get('backgroundControlVersion')) is int and profile['backgroundControlVersion'] == 2 and type(profile.get('automaticMemoryRecovery')) is bool and profile.get('storageCompletion') == 'sdk-v1' and profile.get('nativeEngineCompatibility') == '0.22.1' and profile.get('serverDependencyMode') == 'bundled-sdk0.25-v1', 'SDK_PACKAGE_CAPABILITY_REQUIRED')
    verify_server_bundle(package_path, package_files)
    require(all(proposed.get(field, {}) == current.get(field, {}) for field in ('optionalDependencies', 'engines')), 'DEPENDENCY_REUSE_NOT_COMPATIBLE')
    old, new = current.get('dependencies', {}), proposed.get('dependencies', {})
    if old == new:
        return
    allowed = {'iii-sdk': '0.25.0', '@iii-dev/helpers': '0.25.0', 'yaml': '^2.8.1', 'json5': '^2.2.3'}
    require(isinstance(old, dict) and isinstance(new, dict) and all(new.get(key) == value for key, value in allowed.items()) and old.get('iii-sdk') == old.get('@iii-dev/helpers') == '0.22.1' and 'yaml' not in old and 'json5' not in old and {key: value for key, value in old.items() if key not in allowed} == {key: value for key, value in new.items() if key not in allowed}, 'DEPENDENCY_REUSE_NOT_COMPATIBLE')
