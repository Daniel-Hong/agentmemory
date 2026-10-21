"""Body-free baseline selection diagnosis on temporary metadata fixtures."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
class SelectionTests(unittest.TestCase):
    def setUp(self):
        path=HERE/'diagnose-baseline-selection.py'
        self.assertTrue(path.exists(),'body-free baseline selection diagnostic missing')
        spec=importlib.util.spec_from_file_location('selection_diagnostic',path);self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.ids=self.m.IDS;self.runtime={n:'a'*64 for n in self.m.RUNTIME};self.new={**self.runtime,'kit-runtime.py':'b'*64}
        self.dropin=self.put(self.m.DROPIN,b'synthetic current dropin')
        self.identity={'applied':True,'candidateHash':'c'*64,'sourceCommit':'d'*40,'installedFileHashes':{str(self.dropin):self.sha(self.dropin.read_bytes())}}
        self.receipt=self.put(self.m.RECEIPT,self.identity)
        entries=[]
        for role,cid in self.ids.items():
            kit={'id':cid,'files':self.runtime if role=='current' else self.new,'packageSha256':self.identity['candidateHash'],'sourceCommit':self.identity['sourceCommit'],'privateSentinel':'NEVER_PRINT'}
            path=self.put(self.m.PUBLIC+'/'+cid+'/kit.json',kit);entries.append({'id':cid,'kitSha256':self.sha(path.read_bytes())})
        for role in ('primary','recovery'):self.put(self.m.PUBLIC+'/'+self.ids[role]+'/baseline.json',{'receiptPath':str(self.receipt),'receiptIdentity':self.identity})
        self.policy={'dropin':str(self.dropin),'runtimeHashes':self.new,'legacyBaseline':{'protectedFiles':{str(self.dropin):'e'*64}},'archives':str(self.root/'home/daniel/.agentmemory-code-archives'),'assets':{},'privateSentinel':'NEVER_PRINT'}
        self.put(self.m.POLICY,self.policy);self.put(self.m.CATALOG,{'candidates':entries})
        for n in self.m.RUNTIME:self.put(self.m.LIBRARY+'/'+n,b'synthetic library runtime')
        for path in self.root.rglob('*'):
            if path.is_dir():path.chmod(0o755)
    @staticmethod
    def sha(raw):return hashlib.sha256(raw).hexdigest()
    def put(self,name,value):
        p=self.root/name.lstrip('/');p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(value if isinstance(value,bytes) else json.dumps(value).encode());p.chmod(0o644);return p
    def run_diagnostic(self):return self.m.diagnose(self.root,owner=os.getuid(),service_uid=os.getuid(),service_gid=os.getgid())
    def test_exact_current_runtime_rejection_is_distinct_from_receipt_drift(self):
        r=self.run_diagnostic();self.assertFalse(r['current']['admittedByOldRuntimePolicy']);self.assertTrue(r['current']['catalogManifestMatches']);self.assertEqual(r['activation']['mismatchedIdentityFields'],[]);self.assertTrue(r['activation']['dropinMatchesRegisteredIdentity']);self.assertFalse(r['operatingChangeAuthorized'])
    def test_receipt_mismatch_reports_keys_counts_never_values(self):
        v={**self.identity,'sourceCommit':'SECRET_BODY','installedFileHashes':{**self.identity['installedFileHashes'],'PRIVATE_KEY':'PRIVATE_VALUE'}};self.put(self.m.RECEIPT,v)
        r=self.run_diagnostic();self.assertEqual(r['activation']['mismatchedIdentityFields'],['sourceCommit','installedFileHashes']);self.assertEqual(r['activation']['installedMapDifferenceCounts']['unexpected'],1);self.assertNotIn('PRIVATE',json.dumps(r));self.assertNotIn('SECRET',json.dumps(r))
    def test_read_only_no_execution_and_no_private_output(self):
        before={p:p.read_bytes() for p in self.root.rglob('*') if p.is_file()};real=os.open
        def readonly(path,flags,*args,**kwargs):
            self.assertFalse(flags&(os.O_CREAT|os.O_WRONLY|os.O_RDWR));return real(path,flags,*args,**kwargs)
        with patch.object(self.m.os,'open',readonly):r=self.run_diagnostic()
        self.assertTrue(r['readOnly']);self.assertNotIn('NEVER_PRINT',json.dumps(r));self.assertEqual(before,{p:p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
    def test_wrong_current_manifest_or_symlink_refused(self):
        p=self.root/self.m.PUBLIC.lstrip('/')/self.ids['current']/'kit.json';p.write_text(p.read_text()+' ')
        self.assertFalse(self.run_diagnostic()['current']['catalogManifestMatches'])
        p.unlink();p.symlink_to(self.receipt)
        with self.assertRaises((OSError,RuntimeError)):self.run_diagnostic()
    def test_receipt_parent_swap_cannot_redirect_root_read(self):
        parent=self.receipt.parent;original=self.receipt.stat().st_ino
        alternate=parent.with_name('alternate');alternate.mkdir();(alternate/'activation.json').write_text('{"private":"NEVER_PRINT"}')
        real=os.open;opened=[]
        def swap(path,flags,*args,**kwargs):
            if path=='activation.json' and 'dir_fd' in kwargs:
                parent.rename(parent.with_name('preserved-original'));parent.symlink_to(alternate,target_is_directory=True)
                fd=real(path,flags,*args,**kwargs);opened.append(os.fstat(fd).st_ino);return fd
            return real(path,flags,*args,**kwargs)
        with patch.object(self.m.os,'open',swap),self.assertRaises(RuntimeError):self.run_diagnostic()
        self.assertEqual(opened,[original])

    def test_runtime_admission_and_legacy_branch_are_independent(self):
        self.policy['runtimeHashes']=self.runtime;self.policy['legacyBaseline']['protectedFiles'][str(self.dropin)]=self.sha(self.dropin.read_bytes());self.put(self.m.POLICY,self.policy)
        r=self.run_diagnostic();self.assertTrue(r['current']['admittedByOldRuntimePolicy']);self.assertTrue(r['legacyDropinMatches']);self.assertFalse(r['fullBaselineVerified'])
if __name__=='__main__':unittest.main()
