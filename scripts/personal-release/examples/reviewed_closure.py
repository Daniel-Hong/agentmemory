"""Read-only registered closure verifier; callers supply a reviewed ID/trust check."""
from pathlib import Path
import hashlib,json,re
def require(ok,code):
    if not ok:raise RuntimeError(code)
def sha(path):
    with Path(path).open('rb')as f:return hashlib.file_digest(f,'sha256').hexdigest()
def checked_manifest(root, *, expected_id, trusted):
    trusted(root/'kit.json');kit=json.loads((root/'kit.json').read_text())
    require(kit.get('id')==expected_id and kit.get('entrypoint')=='kit-runtime.py'
        and kit.get('executionClosureReviewed')is True and bool(kit.get('reviewedBy')),'CANDIDATE_CLOSURE_UNREVIEWED')
    require(set(p.name for p in root.iterdir())=={'kit.json',*kit['files']},'CANDIDATE_FILE_SET_CHANGED')
    for name,h in kit['files'].items():
        require(Path(name).name==name and not name.startswith('.')and re.fullmatch('[a-f0-9]{64}',h),'CANDIDATE_MANIFEST_UNSAFE')
        trusted(root/name);require(sha(root/name)==h,'CANDIDATE_FILE_CHANGED')
    require({'kit-runtime.py','kit-runtime-base.py','engine_component_adapter.py','kit-queues.py','kit-integrity.py','baseline.json','release.json','package.tgz'}<=kit['files'].keys() and set(kit['files'])-{'kit-runtime.py','kit-runtime-base.py','engine_component_adapter.py','kit-queues.py','kit-integrity.py','baseline.json','release.json','package.tgz'}<={'review-evidence.json'},'CANDIDATE_CLOSURE_INCOMPLETE')
    return kit
