import unittest,tempfile,pathlib,json,importlib.util,types
from unittest.mock import patch
P=pathlib.Path;s=importlib.util.spec_from_file_location('runner',P(__file__).with_name('seal-stop.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Test(unittest.TestCase):
 def exercise(self,helper_ok=True,allgone=True):
  with tempfile.TemporaryDirectory() as d:
   r=P(d);helper=r/'helper';helper.write_text('synthetic');marker=r/'marker';marker.write_text('unchanged');rpc=r/'rpc';receipt=r/'receipt';rpc.write_text(json.dumps({'marker':str(marker),'markerSha256':m.sha(marker),'receipt':str(receipt)}));config=r/'config';config.write_text(json.dumps({'service':'agentmemory.service','helper':str(helper),'rpcConfig':str(rpc),'result':str(r/'sealed-for-recovery-123-1.json'),'user':'daniel','processes':{'compose':{'pid':123,'start':'1','exe':'/synthetic'}},'reviewedFiles':{str(helper):m.sha(helper),str(rpc):m.sha(rpc)}}));calls=[]
   def run(argv,**kwargs):
    calls.append(argv)
    if argv[0]=='/usr/bin/node' and helper_ok:receipt.write_text(json.dumps({'kind':'sealed-for-recovery','storageSealed':True,'verifiedClean':False,'markerSha256':m.sha(marker),'before':{'mutationFailures':1},'after':{'mutationFailures':1}}))
    return types.SimpleNamespace(returncode=0 if helper_ok else 78)
   with patch.object(m,'ROOT_RECEIPT_DIR',r),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'trusted'),patch.object(m,'rootReceiptDirectory',return_value=None),patch.object(m,'matches',return_value=True),patch.object(m,'gone',return_value=allgone),patch.object(m.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=1000,pw_gid=1000,pw_name='fixture',pw_dir=d)),patch.object(m.subprocess,'run',side_effect=run),patch.object(m.subprocess,'check_output',side_effect=['123\n','ActiveState=inactive\nResult=exit-code\nMainPID=0\n']):
    if helper_ok and allgone:m.main(str(config));self.assertFalse(json.loads((r/'sealed-for-recovery-123-1.json.stopped').read_text())['verifiedClean'])
    else:
     with self.assertRaises(RuntimeError):m.main(str(config))
   return calls
 def test_helper_failure_never_stops_service(self):self.assertFalse(any('stop' in x for x in self.exercise(False)))
 def test_exact_seal_allgone_can_preserve_unclean_stop_result(self):self.assertEqual(sum('stop' in x for x in self.exercise()),1)
 def test_remaining_process_never_force_killed(self):self.assertFalse(any('kill' in x for x in self.exercise(True,False)))
if __name__=='__main__':unittest.main()
