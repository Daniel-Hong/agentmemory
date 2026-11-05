"""Real bootstrap publication in a temporary state; never uses operating records."""
import hashlib,importlib.util,json,os,tempfile,types,unittest
from pathlib import Path
HERE=Path(__file__).resolve().parent

def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
bootstrap=load('closure_test_bootstrap',HERE/'enroll-reviewed-kit.py')
verifier=load('closure_test_verifier',HERE/'examples/reviewed_closure.py')
class ReviewedClosureTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  state=self.root/'state';state.mkdir(mode=0o700);(state/'public').mkdir(mode=0o755);draft=self.root/'draft';draft.mkdir(mode=0o700)
  names=['kit-runtime.py','kit-runtime-base.py','engine_component_adapter.py','kit-queues.py','kit-integrity.py','baseline.json','release.json','package.tgz']
  for n in names:(draft/n).write_bytes(b'synthetic fixture\n')
  hashes={n:hashlib.sha256((draft/n).read_bytes()).hexdigest()for n in names}
  kit={'id':'synthetic-sdk-successor','entrypoint':'kit-runtime.py','executionClosureReviewed':False,'files':hashes};(draft/'kit.json').write_text(json.dumps(kit))
  review=self.root/'review.json';review.write_text(json.dumps({'executionClosureReviewed':True,'reviewedBy':'synthetic reviewer','draftManifestSha256':hashlib.sha256((draft/'kit.json').read_bytes()).hexdigest()}));review.chmod(0o600)
  runner=self.root/'nonexecuted-runner';runner.write_text('synthetic');runner.chmod(0o600)
  self.calls=[];bootstrap.install(draft,review,state=state,runner=runner,owner=os.getuid(),anchor=self.root,run=lambda *a,**k:self.calls.append(a))
  self.p=state/'public/release-kits/synthetic-sdk-successor'
 def checked(self):return verifier.checked_manifest(self.p,expected_id='synthetic-sdk-successor',trusted=lambda p:bootstrap.trusted(Path(p),os.getuid(),self.root))
 def test_accepts_actual_bootstrap_review_evidence(self):
  self.assertEqual(len(self.calls),1);k=self.checked();self.assertEqual(len(k['files']),9);self.assertIn('review-evidence.json',k['files'])
 def test_changed_review_bytes_are_rejected(self):
  p=self.p/'review-evidence.json';p.write_bytes(p.read_bytes()+b' ')
  with self.assertRaisesRegex(RuntimeError,'CANDIDATE_FILE_CHANGED'):self.checked()
 def test_unknown_hashed_file_is_rejected(self):
  p=self.p/'extra.py';p.write_bytes(b'fixture');p.chmod(0o644);m=self.p/'kit.json';k=json.loads(m.read_text());k['files']['extra.py']=verifier.sha(p);m.write_text(json.dumps(k))
  with self.assertRaisesRegex(RuntimeError,'CANDIDATE_CLOSURE_INCOMPLETE'):self.checked()
 def test_missing_core_is_rejected(self):
  p=self.p/'kit.json';k=json.loads(p.read_text());k['files'].pop('kit-queues.py');(self.p/'kit-queues.py').unlink();p.write_text(json.dumps(k))
  with self.assertRaisesRegex(RuntimeError,'CANDIDATE_CLOSURE_INCOMPLETE'):self.checked()
 def test_unhashed_extra_is_rejected(self):
  (self.p/'extra.py').write_text('fixture')
  with self.assertRaisesRegex(RuntimeError,'CANDIDATE_FILE_SET_CHANGED'):self.checked()
if __name__=='__main__':unittest.main()
