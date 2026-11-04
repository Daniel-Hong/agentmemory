import unittest,tempfile,tarfile,hashlib,io
from unittest.mock import patch
from pathlib import Path
import importlib.util
spec=importlib.util.spec_from_file_location('archive_runtime',Path(__file__).with_name('kit-runtime.py'));runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
verify_archive=runtime.verify_archive
class Verification(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.p=Path(self.tmp.name)/'code.tgz';self.rows=[('a',b'one'),('b',b'two')];self.expected={n:hashlib.sha256(b).hexdigest()for n,b in self.rows}
 def tearDown(self):self.tmp.cleanup()
 def pack(self,rows=None,symlink=False):
  with tarfile.open(self.p,'w:gz')as t:
   for n,b in self.rows if rows is None else rows:
    m=tarfile.TarInfo(n);m.size=len(b)
    if symlink:m.type=tarfile.SYMTYPE;m.linkname='elsewhere'
    t.addfile(m,None if symlink else io.BytesIO(b))
  return hashlib.sha256(self.p.read_bytes()).hexdigest()
 def test_normal(self):verify_archive(self.p,self.pack(),self.expected)
 def test_reordered(self):verify_archive(self.p,self.pack(self.rows[::-1]),self.expected)
 def test_missing(self):
  with self.assertRaisesRegex(RuntimeError,'ARCHIVE_SET_CHANGED'):verify_archive(self.p,self.pack(self.rows[:1]),self.expected)
 def test_extra(self):
  with self.assertRaisesRegex(RuntimeError,'ARCHIVE_SET_CHANGED'):verify_archive(self.p,self.pack(self.rows+[('c',b'x')]),self.expected)
 def test_duplicate(self):
  with self.assertRaisesRegex(RuntimeError,'ARCHIVE_SET_CHANGED'):verify_archive(self.p,self.pack(self.rows+[self.rows[0]]),self.expected)
 def test_member_symlink(self):
  with self.assertRaisesRegex(RuntimeError,'ARCHIVE_SET_CHANGED'):verify_archive(self.p,self.pack(symlink=True),self.expected)
 def test_outer_hash(self):
  self.pack()
  with self.assertRaisesRegex(RuntimeError,'ARCHIVE_CHANGED'):verify_archive(self.p,'0'*64,self.expected)
 def test_inner_hash(self):
  with self.assertRaisesRegex(RuntimeError,'ARCHIVE_READBACK_FAILED'):verify_archive(self.p,self.pack([('a',b'bad'),self.rows[1]]),self.expected)
 def test_change_during_verification(self):
  h=self.pack();original=hashlib.file_digest;changed=False
  def digest(stream,*args,**kwargs):
   nonlocal changed
   value=original(stream,*args,**kwargs)
   if not changed:
    changed=True
    with self.p.open('ab')as f:f.write(b'changed')
   return value
  with patch.object(runtime.hashlib,'file_digest',side_effect=digest):
   with self.assertRaisesRegex(RuntimeError,'ARCHIVE_CHANGED'):verify_archive(self.p,h,self.expected)
 def test_path_symlink(self):
  h=self.pack();link=self.p.with_name('link');link.symlink_to(self.p)
  with self.assertRaisesRegex(RuntimeError,'ARCHIVE_CHANGED'):verify_archive(link,h,self.expected)
if __name__=='__main__':unittest.main()
