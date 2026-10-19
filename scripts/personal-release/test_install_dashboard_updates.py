import importlib.util, unittest, tempfile, os, hashlib
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('install_dashboard',Path(__file__).with_name('install-dashboard-updates.py'));installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
class InstallTests(unittest.TestCase):
 def test_only_sudoers_is_readable_by_service_group_without_write_permission(self):
  self.assertEqual(installer.asset_group('sudoers',0,0),1000)
  self.assertEqual(installer.asset_group('agentmemory-update-runner',0,0),0)
  self.assertEqual(installer.asset_group('sudoers',1000,1000),1000)
  self.assertEqual(installer.ASSETS['sudoers'][2],0o440)
 def test_installs_actual_helper_assets_and_preserves_existing_catalog(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);calls=[]
   installer.install(root,os.getuid(),os.getgid(),lambda args:calls.append(args))
   helper=root/'usr/local/libexec/agentmemory-update-request';runner=root/'usr/local/libexec/agentmemory-update-runner'
   self.assertEqual(helper.read_bytes(),runner.read_bytes());self.assertEqual(helper.stat().st_mode&0o777,0o755)
   catalog=root/'var/lib/agentmemory-updates/catalog.json';catalog.write_text('{"candidates": [{"id":"keep-history"}]}')
   installer.install(root,os.getuid(),os.getgid(),lambda args:calls.append(args))
   self.assertIn('keep-history',catalog.read_text());self.assertTrue((root/'var/lib/agentmemory-updates/private').exists())
   self.assertTrue(any(args[0]=='/usr/sbin/visudo' for args in calls));self.assertTrue(any(args==['/usr/bin/systemctl','daemon-reload'] for args in calls))
 def test_refuses_symlinked_install_destination_before_replacing_any_asset(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);(root/'usr/local').mkdir(parents=True);outside=root/'outside';outside.mkdir();(root/'usr/local/libexec').symlink_to(outside,target_is_directory=True)
   with self.assertRaises(RuntimeError):installer.install(root,os.getuid(),os.getgid(),lambda args:None)
   self.assertEqual(list(outside.iterdir()),[])
if __name__=='__main__':unittest.main()
