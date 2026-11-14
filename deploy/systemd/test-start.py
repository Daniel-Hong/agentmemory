import importlib.util,json,os,pathlib,subprocess,tempfile,unittest
from unittest.mock import patch
P=pathlib.Path
spec=importlib.util.spec_from_file_location('starter',P(__file__).with_name('start.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def setUp(self):
  self.cfg={'namespace':'isolated','engine':'/fixture/iii','composeFile':'/fixture/c.yaml'};self.state={'kind':'compose','composePid':123,'namespace':'isolated','binPath':'/fixture/iii','file':'/fixture/c.yaml'}
  self.proof=('200','/fixture/iii',[b'/fixture/iii',b'compose',b'--namespace',b'isolated',b'--up',b'--file',b'/fixture/c.yaml'],P('/proc/self/cgroup').read_bytes(),os.getuid())
 def test_exact_identity(self):
  with patch.object(m,'identity',return_value=self.proof):self.assertEqual(m.validate(self.cfg,self.state,'100')[0],123)
 def test_engine_process_title(self):
  proof=list(self.proof);proof[2]=[b'iii:c:isolated',*proof[2][1:]]
  with patch.object(m,'identity',return_value=tuple(proof)):self.assertEqual(m.validate(self.cfg,self.state,'100')[0],123)
 def test_reject_reused_process_or_foreign_owner_or_argv(self):
  for index,value in [(0,'99'),(1,'/foreign/iii'),(2,[b'wrong']),(3,b'foreign'),(4,os.getuid()+1)]:
   proof=list(self.proof);proof[index]=value
   with patch.object(m,'identity',return_value=tuple(proof)),self.assertRaisesRegex(RuntimeError,'IDENTITY'):m.validate(self.cfg,self.state,'100')
 def test_reject_metadata(self):
  for key,value in [('kind','native'),('composePid',True),('namespace','other'),('file','/other')]:
   with patch.object(m,'identity',return_value=self.proof),self.assertRaises(RuntimeError):m.validate(self.cfg,{**self.state,key:value},'100')
if __name__=='__main__':unittest.main()
