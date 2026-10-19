"""Compare stopped backup with current file-KV; output only safe counters."""
from pathlib import Path
import hashlib
import json
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
            require(retained({k: v for k, v in old.items() if k != 'manual-pause'}, {k: v for k, v in new.items() if k != 'manual-pause'}), 'ORIGINAL_STATE_NOT_PRESERVED')
        elif scope.startswith('mem:obs:'):
            for key, row in old.items():
                require(key in new, 'ORIGINAL_OBSERVATION_REMOVED')
                for field in ('sourceRaw', 'source'):
                    if field in row: require(new[key].get(field) == row[field], 'ORIGINAL_SOURCE_CHANGED')
                raw += 1
        elif scope == 'mem:capture:inbox':
            for key,row in old.items():
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
