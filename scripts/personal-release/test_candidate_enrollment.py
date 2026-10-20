import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
RID = '12345678-1234-4234-8234-123456789abc'


def load(name='candidate-enrollment'):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(data):
    return hashlib.sha256(data).hexdigest()


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((HERE / 'candidate-enrollment.py').is_file(), 'candidate enrollment implementation missing')
        self.m = load()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.spool = self.root / 'spool'
        self.request = self.spool / RID
        self.draft = self.request / 'draft'
        self.draft.mkdir(parents=True, mode=0o700)
        self.spool.chmod(0o700)
        self.request.chmod(0o700)
        self.contents = {n: b'{}' for n in ('kit.json', 'release.json', 'baseline.json', 'review-template.json')}
        self.contents.update({n: b'# reviewed runtime' for n in ('kit-runtime.py', 'kit-queues.py', 'kit-integrity.py')})
        self.contents['package.tgz'] = b'fixture'
        for name, data in self.contents.items():
            self.write(self.draft / name, data)
        self.write(self.request / 'request.json', json.dumps({'requestId': RID, 'candidateId': 'release-8', 'draftManifestSha256': sha(b'{}')}).encode())
        self.destination = self.root / 'private'
        self.destination.mkdir(mode=0o700)
        self.sentinel = self.root / 'original'
        self.sentinel.write_bytes(b'original source')
        self.addCleanup(lambda: self.assertEqual(self.sentinel.read_bytes(), b'original source'))

    def write(self, path, data):
        path.write_bytes(data)
        path.chmod(0o600)

    def snapshot(self):
        return self.m.snapshot_request(self.spool, RID, self.destination, request_uid=os.getuid())

    def test_snapshot_copies_exact_bytes(self):
        request = self.snapshot()
        self.assertEqual(request['candidateId'], 'release-8')
        self.assertEqual({p.name: p.read_bytes() for p in (self.destination / 'draft').iterdir()}, self.contents)
        self.write(self.draft / 'kit-runtime.py', b'raise Exception("changed")')
        self.assertEqual((self.destination / 'draft/kit-runtime.py').read_bytes(), b'# reviewed runtime')

    def test_canonical_uuid_and_exact_request_schema(self):
        for value in (RID.upper(), '../x', RID + ' extra', '', None):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'INVALID_REQUEST'):
                self.m.request_id(value)
        self.write(self.request / 'request.json', b'{"requestId":"x","extra":1}')
        with self.assertRaises(RuntimeError):
            self.snapshot()

    def test_rejects_links_fifo_extra_and_wrong_owner(self):
        p = self.draft / 'package.tgz'
        for kind in ('symlink', 'hardlink', 'fifo', 'extra', 'owner'):
            with self.subTest(kind=kind):
                data = p.read_bytes()
                p.unlink()
                if kind == 'symlink': p.symlink_to(self.sentinel)
                elif kind == 'hardlink': os.link(self.sentinel, p)
                elif kind == 'fifo': os.mkfifo(p)
                else: self.write(p, data)
                if kind == 'extra': self.write(self.draft / 'extra', b'x')
                try:
                    with self.assertRaises((RuntimeError, OSError)):
                        self.m.snapshot_request(self.spool, RID, self.root / ('dest-' + kind), request_uid=os.getuid() + (kind == 'owner'))
                finally:
                    p.unlink()
                    self.write(p, data)
                    (self.draft / 'extra').unlink(missing_ok=True)

    def test_budget_and_duplicate_json_keys(self):
        self.write(self.request / 'request.json', b' ' * (16 * 1024 + 1))
        with self.assertRaisesRegex(RuntimeError, 'INPUT_TOO_LARGE'):
            self.snapshot()
        self.write(self.request / 'request.json', b'{"requestId":"x","requestId":"y"}')
        with self.assertRaisesRegex(RuntimeError, 'INVALID_JSON'):
            self.snapshot()

    def test_snapshot_changed_during_read_is_rejected(self):
        real = os.read
        changed = False
        def mutate(fd, size):
            nonlocal changed
            data = real(fd, size)
            if data == b'fixture' and not changed:
                changed = True
                self.write(self.draft / 'package.tgz', b'altered')
            return data
        with patch.object(self.m.os, 'read', mutate), self.assertRaisesRegex(RuntimeError, 'INPUT_CHANGED'):
            self.snapshot()

    def test_parent_symlink_is_rejected(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.spool, target_is_directory=True)
        with self.assertRaises((RuntimeError, OSError)):
            self.m.snapshot_request(alias, RID, self.destination, request_uid=os.getuid())




class ValidationTests(unittest.TestCase):
    def setUp(self):
        import io
        import tarfile
        self.m = load()
        self.assertTrue(hasattr(self.m, 'validate_candidate'), 'candidate validator missing')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = {'package.json': json.dumps({'version': '0.9.30-daniel.8', 'engines': {'node': '>=20.0.0'}}).encode(), 'dist/cli.mjs': b'// synthetic'}
        self.files.update({f'plugin/scripts/codex-compat/{i}.mjs': b'// client' for i in range(13)})
        self.package()
        self.current = {'protectedFiles': {}, 'compatibilityFiles': {n: sha(v) for n,v in self.files.items() if n.startswith('plugin/')}}
        self.policy = {'runtimeHashes': {}, 'packageContract': {'engines': {'node': '>=20.0.0'}, 'dependencies': {}, 'optionalDependencies': {}}, 'extraArtifacts': ['RUNBOOK.md']}
        for name in ('kit-runtime.py', 'kit-queues.py', 'kit-integrity.py'):
            (self.root / name).write_bytes(b'# fixed root bytes')
            self.policy['runtimeHashes'][name] = sha(b'# fixed root bytes')
        self.release = {'packageVersion': '0.9.30-daniel.8','sourceCommit': 'a'*40,'packageFiles': {n:sha(v) for n,v in self.files.items()}, 'artifactHashes': {**{'package/'+n:sha(v) for n,v in self.files.items()}, 'agentmemory.tgz': sha((self.root/'package.tgz').read_bytes()), 'RUNBOOK.md': 'b'*64}}
        self.release['verificationFiles'] = dict(self.release['artifactHashes'])
        self.metadata = {'id':'release-8','version':'0.9.30-daniel.8','sourceCommit':'a'*40,'packageSha256':sha((self.root/'package.tgz').read_bytes()),'changeSummary':'Synthetic release','tests':['isolated'], 'entrypoint':'kit-runtime.py','executionClosureReviewed':False,'reviewedBy':''}
        self.refresh()

    def package(self, extra=None):
        import tarfile,io
        with tarfile.open(self.root/'package.tgz', 'w:gz') as tar:
            for name,data in self.files.items():
                member=tarfile.TarInfo('package/'+name);member.size=len(data)
                tar.addfile(member,io.BytesIO(data))
            if extra:tar.addfile(extra)

    def refresh(self):
        for name,data in [('release.json',self.release),('baseline.json',self.current)]:
            (self.root/name).write_text(json.dumps(data))
        self.metadata['files']={n:sha((self.root/n).read_bytes()) for n in ('kit-runtime.py','kit-queues.py','kit-integrity.py','package.tgz','release.json','baseline.json')}
        (self.root/'kit.json').write_text(json.dumps(self.metadata))
        (self.root/'review-template.json').write_text('{}')

    def validate(self):
        return self.m.validate_candidate(self.root,self.policy,self.current)

    def test_valid_package_is_accepted_without_executing_input(self):
        self.assertEqual(self.validate()['id'],'release-8')

    def test_root_execution_closure_is_exact(self):
        (self.root/'kit-runtime.py').write_bytes(b'raise AssertionError("must not execute")')
        self.refresh()
        with self.assertRaisesRegex(RuntimeError,'ROOT_EXECUTION_POLICY_CHANGED'):self.validate()

    def test_release_tables_and_package_identity_match(self):
        self.release['verificationFiles']['agentmemory.tgz']='c'*64
        self.refresh()
        with self.assertRaisesRegex(RuntimeError,'ARTIFACT_TABLE_MISMATCH'):self.validate()

    def test_baseline_forgery_and_wrong_type_rejected(self):
        (self.root/'baseline.json').write_text('{"protectedFiles":{"/etc/passwd":"x"}}')
        self.metadata['files']['baseline.json']=sha((self.root/'baseline.json').read_bytes())
        (self.root/'kit.json').write_text(json.dumps(self.metadata))
        with self.assertRaisesRegex(RuntimeError,'CURRENT_BASELINE_UNVERIFIED'):self.validate()

    def test_client_change_and_dependency_change_rejected(self):
        self.current['compatibilityFiles']['plugin/scripts/codex-compat/0.mjs']='d'*64
        self.refresh()
        with self.assertRaisesRegex(RuntimeError,'CLIENT_COMPATIBILITY_CHANGED'):self.validate()
        self.current['compatibilityFiles']['plugin/scripts/codex-compat/0.mjs']=sha(b'// client')
        self.policy['packageContract']['dependencies']={'new-package':'1'}
        self.refresh()
        with self.assertRaisesRegex(RuntimeError,'DEPENDENCY_REUSE_NOT_COMPATIBLE'):self.validate()

    def test_tar_links_duplicates_private_paths_and_bomb_rejected(self):
        import tarfile
        for name,kind in [('package/../escape',tarfile.DIRTYPE),('package/dist/cli.mjs',tarfile.REGTYPE),('package/private/data',tarfile.REGTYPE),('package/link',tarfile.SYMTYPE)]:
            with self.subTest(name=name):
                extra=tarfile.TarInfo(name);extra.type=kind;extra.linkname='/etc/passwd'
                self.package(extra)
                self.metadata['packageSha256']=sha((self.root/'package.tgz').read_bytes())
                self.release['artifactHashes']['agentmemory.tgz']=self.metadata['packageSha256']
                self.release['verificationFiles']=dict(self.release['artifactHashes']);self.refresh()
                with self.assertRaises(RuntimeError):self.validate()

    def test_unsafe_package_file_names_rejected(self):
        for name in ('../x','.env','data/source','node_modules/a','spool/raw','C:\\secret'):
            with self.subTest(name=name):
                self.release['packageFiles'][name]='b'*64;self.refresh()
                with self.assertRaises(RuntimeError):self.validate()
                del self.release['packageFiles'][name]


class PublishedPackageTests(unittest.TestCase):
    setUp = ValidationTests.setUp
    package = ValidationTests.package
    refresh = ValidationTests.refresh
    validate = ValidationTests.validate
    def test_existing_public_metadata_names_are_supported(self):
        self.files.update({'.env.example':b'# example only', 'plugin/.codex-plugin/plugin.json':b'{}','plugin/.mcp.json':b'{}'})
        self.package()
        self.metadata['packageSha256']=sha((self.root/'package.tgz').read_bytes())
        self.release['packageFiles']={n:sha(v) for n,v in self.files.items()}
        self.release['artifactHashes']={**{'package/'+n:sha(v) for n,v in self.files.items()},'agentmemory.tgz':self.metadata['packageSha256'],'RUNBOOK.md':'b'*64}
        self.release['verificationFiles']=dict(self.release['artifactHashes']);self.refresh()
        self.assertEqual(self.validate()['id'],'release-8')


class EnrollmentTests(unittest.TestCase):
    def setUp(self):
        self.m = load()
        self.assertTrue(hasattr(self.m,'enroll'),'enrollment coordinator missing')
        ValidationTests.setUp(self)
        import shutil
        self.library=self.root/'library';self.library.mkdir(mode=0o755)
        for name in ('kit-runtime.py','kit-queues.py','kit-integrity.py','prepare-dashboard-kit.py','enroll-reviewed-kit.py'):
            shutil.copyfile(HERE/name,self.library/name)
            (self.library/name).chmod(0o600)
        for name in ('kit-runtime.py','kit-queues.py','kit-integrity.py'):
            shutil.copyfile(self.library/name,self.root/name)
            self.policy['runtimeHashes'][name]=sha((self.library/name).read_bytes())
        self.dropin=self.root/'dropin';self.dropin.write_bytes(b'fixed old dropin')
        self.receipt=self.root/'activation.json';self.receipt.write_text('{"applied":true,"sourceCommit":"previous"}')
        self.current.update(protectedFiles={str(self.dropin):sha(self.dropin.read_bytes())},receiptPath=str(self.receipt),receiptIdentity={'applied':True,'sourceCommit':'previous'},archives=[])
        self.refresh()
        self.state=self.root/'state'
        self.runner=self.root/'runner';shutil.copyfile(HERE/'dashboard-updates.py',self.runner)
        self.bootstrap=load('dashboard-updates')
        self.manager=self.bootstrap.Runner(state=self.state,trusted_uid=os.getuid(),trust_anchor=self.root)
        self.manager.initialize()
        original_loader=self.m.load_module
        def fixed_loader(path,**kwargs):
            if Path(path)==self.runner:return self.bootstrap
            return original_loader(path,**kwargs)
        loader_patch=patch.object(self.m,'load_module',fixed_loader);loader_patch.start();self.addCleanup(loader_patch.stop)
        self.helper=self.root/'helper';shutil.copyfile(HERE/'candidate-enrollment.py',self.helper)
        self.policy.update(schemaVersion=1,policyId='fixture-policy',validatorVersion='1',delegatingReview='synthetic administrator',requestUid=1000,requestGid=1000,
            assets={str(p):sha(p.read_bytes()) for p in (*self.library.iterdir(),self.runner,self.helper)},legacyBaseline=self.current,library=str(self.library),runner=str(self.runner),state=str(self.state),dropin=str(self.dropin),publicKits=str(self.state/'public/release-kits'),archives=str(self.root/'archives'))
        self.policy_path=self.root/'policy.json';self.policy_path.write_text(json.dumps(self.policy))
        (self.root/'installation.json').write_text(json.dumps({'installed':True,'policySha256':sha(self.policy_path.read_bytes())}))
        for p in self.root.iterdir():
            if p.is_file():p.chmod(0o600)
        self.spool=self.root/'spool';self.spool.mkdir(mode=0o700)
        self.request=self.spool/RID;self.request.mkdir(mode=0o700)
        self.draft=self.request/'draft';self.draft.mkdir(mode=0o700)
        for n in self.m.DRAFT:
            shutil.copyfile(self.root/n,self.draft/n);(self.draft/n).chmod(0o600)
        self.request_data={'requestId':RID,'candidateId':'release-8','draftManifestSha256':sha((self.draft/'kit.json').read_bytes())}
        (self.request/'request.json').write_text(json.dumps(self.request_data));(self.request/'request.json').chmod(0o600)
        self.original=self.root/'sourceRaw';self.original.write_bytes(b'preserved source')
        self.addCleanup(lambda:self.assertEqual(self.original.read_bytes(),b'preserved source'))
        self.calls=[]

    package=ValidationTests.package
    refresh=ValidationTests.refresh

    def enroll(self, rid=RID):
        return self.m.enroll(rid,policy_path=self.policy_path,state=self.state,spool=self.spool,owner=os.getuid(),anchor=self.root,request_uid=os.getuid() )

    def test_real_cli_umask_preserves_public_receipt_access(self):
        previous=os.umask(0o077)
        try:result=self.enroll()
        finally:os.umask(previous)
        self.assertEqual(result['status'],'registered')
        self.assertEqual((self.state/'public/enrollment').stat().st_mode&0o777,0o755)
        self.assertEqual((self.state/'public/enrollment'/f'{RID}.json').stat().st_mode&0o777,0o644)

    def test_enroll_and_same_uuid_replay_do_not_apply(self):
        first=self.enroll();second=self.enroll()
        self.assertEqual(first,second)
        self.assertEqual(first['status'],'registered');self.assertFalse(first['applied']);self.assertFalse(first['serviceControlled'])
        self.assertEqual(len(self.manager.catalog()),1)
        self.assertEqual(json.loads((self.state/'public/enrollment'/f'{RID}.json').read_text()),first)

    def test_changed_request_and_policy_tamper_rejected(self):
        self.enroll()
        (self.draft/'review-template.json').write_text('{"extra":"changed"}')
        with self.assertRaisesRegex(RuntimeError,'REQUEST_CONFLICT'):self.enroll()
        self.helper.write_text('raise Exception("tampered root")')
        with self.assertRaisesRegex(RuntimeError,'ROOT_EXECUTION_POLICY_CHANGED'):self.enroll()

    def test_public_publish_failure_recovers_without_duplicate(self):
        real=self.m.atomic
        def fail(path,data,mode=0o600):
            if Path(path).parent == self.state/'public/enrollment':raise OSError('disk full')
            return real(path,data,mode)
        with patch.object(self.m,'atomic',fail), self.assertRaises(OSError):self.enroll()
        self.assertEqual(len(self.manager.catalog()),1)
        self.assertEqual(self.enroll()['status'],'registered')
        self.assertEqual(len(self.manager.catalog()),1)

    def test_forged_activation_and_root_dropin_rejected(self):
        self.receipt.write_text('{"applied":true,"sourceCommit":"forged"}')
        result=self.enroll()
        self.assertEqual(result['status'],'rejected')
        self.assertEqual(result['errorCode'],'CURRENT_BASELINE_UNVERIFIED')
        self.assertEqual(self.manager.catalog(),[])

    def test_wrong_call_identity_and_extra_cli_arguments_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'CALLER_NOT_ALLOWED'):
            self.m.check_caller(['helper',RID],euid=1000,sudo_uid='1000')
        for args,sudo in [(['helper',RID,'extra'],'1000'),(['helper',RID],'0'),(['helper',RID],'1001')]:
            with self.assertRaises(RuntimeError):self.m.check_caller(args,euid=0,sudo_uid=sudo)


class RecoveryTests(unittest.TestCase):
    setUp=EnrollmentTests.setUp
    package=EnrollmentTests.package
    refresh=EnrollmentTests.refresh
    enroll=EnrollmentTests.enroll
    def test_journal_write_interruption_can_retry(self):
        real=self.m.atomic
        fired=False
        def fail(path,data,mode=0o600):
            nonlocal fired
            if Path(path).name=='record.json' and not fired:
                fired=True
                raise OSError('simulated disk error before journal commit')
            return real(path,data,mode)
        with patch.object(self.m,'atomic',fail),self.assertRaises(OSError):self.enroll()
        self.assertEqual(self.enroll()['status'],'registered')

    def test_same_candidate_other_uuid_keeps_original_evidence(self):
        import shutil
        self.enroll()
        other='22345678-1234-4234-8234-123456789abc'
        shutil.copytree(self.request,self.spool/other)
        req={**self.request_data,'requestId':other}
        (self.spool/other/'request.json').write_text(json.dumps(req))
        self.assertEqual(self.enroll(other)['status'],'registered')
        self.assertEqual(len(self.manager.catalog()),1)

    def test_failed_package_alias_cannot_erase_failure(self):
        self.enroll()
        job={'jobId':RID,'candidateId':'release-8','status':'failed','events':[{'status':'failed'}]}
        self.manager.write(self.state/'public/jobs'/f'{RID}.json',job)
        with self.assertRaisesRegex(RuntimeError,'FAILED_PACKAGE_REQUIRES_ADMINISTRATOR'):
            self.m.failed_package(self.policy,self.metadata['packageSha256'],os.getuid(),self.root)
        self.assertEqual(json.loads((self.state/'public/jobs'/f'{RID}.json').read_text()),job)

    def test_lock_contention_fails_without_blocking(self):
        self.enroll()
        lock=self.state/'private/enrollment/enrollment.lock'
        with self.m.enrollment_lock(lock,os.getuid()),self.assertRaisesRegex(RuntimeError,'BUSY'):self.enroll()

    def test_missing_install_commit_denies_enrollment(self):
        (self.root/'installation.json').unlink()
        with self.assertRaisesRegex(RuntimeError,'INSTALLATION_NOT_COMMITTED'):self.enroll()

    def test_pending_alias_retry_rechecks_failure_history(self):
        import shutil
        self.enroll()
        other='32345678-1234-4234-8234-123456789abc'
        shutil.copytree(self.request,self.spool/other)
        candidate=self.spool/other/'draft/kit.json'
        kit=json.loads(candidate.read_text());kit['id']='release-8-alias';candidate.write_text(json.dumps(kit))
        req={'requestId':other,'candidateId':'release-8-alias','draftManifestSha256':sha(candidate.read_bytes())}
        (self.spool/other/'request.json').write_text(json.dumps(req))
        with patch.object(self.bootstrap.Runner,'enroll',side_effect=OSError('interrupted before runner enroll')):
            with self.assertRaises(OSError):self.enroll(other)
        job={'jobId':RID,'candidateId':'release-8','status':'failed','events':[{'status':'failed'}]}
        self.manager.write(self.state/'public/jobs'/f'{RID}.json',job)
        result=self.enroll(other)
        self.assertEqual(result['status'],'rejected')
        self.assertEqual(result['errorCode'],'FAILED_PACKAGE_REQUIRES_ADMINISTRATOR')
        self.assertEqual([c['id'] for c in self.manager.catalog()],['release-8'])

    def test_policy_bool_uid_and_unknown_schema_are_rejected(self):
        self.policy['requestUid']=True
        self.policy_path.write_text(json.dumps(self.policy))
        with self.assertRaisesRegex(RuntimeError,'INVALID_POLICY'):self.enroll()


class BudgetTests(unittest.TestCase):
    setUp=ValidationTests.setUp
    package=ValidationTests.package
    refresh=ValidationTests.refresh
    validate=ValidationTests.validate
    def test_declared_tar_bomb_rejected_before_payload_read(self):
        import gzip,tarfile
        member=tarfile.TarInfo('package/bomb');member.size=513*1024*1024
        with gzip.open(self.root/'package.tgz','wb') as f:f.write(member.tobuf()+b'\0'*1024)
        self.metadata['packageSha256']=sha((self.root/'package.tgz').read_bytes())
        self.release['artifactHashes']['agentmemory.tgz']=self.metadata['packageSha256']
        self.release['verificationFiles']=dict(self.release['artifactHashes']);self.refresh()
        with self.assertRaisesRegex(RuntimeError,'INPUT_TOO_LARGE'):self.validate()

    def test_bounded_reader_rejects_trailing_gzip_bomb(self):
        import io,gzip
        compressed=io.BytesIO(gzip.compress(b'x'*1025))
        with gzip.GzipFile(fileobj=compressed) as stream:
            reader=self.m.BoundedReader(stream,1024)
            with self.assertRaisesRegex(RuntimeError,'INPUT_TOO_LARGE'):reader.read(2048)




class CurrentBaselineTests(unittest.TestCase):
    def test_root_catalog_dropin_and_guard_select_current_json_baseline(self):
        import shutil
        from test_dashboard_kit import TransactionTests
        fixture=TransactionTests('test_next_update_baseline_is_json_only_and_preserves_all_prior_archives')
        fixture.setUp();self.addCleanup(fixture.doCleanups)
        fixture.tx.apply()
        m=load()
        library=fixture.root/'library';library.mkdir(mode=0o755)
        for n in (*m.RUNTIME,'prepare-dashboard-kit.py'):
            shutil.copyfile(HERE/n,library/n);(library/n).chmod(0o600)
        runner=load('dashboard-updates')
        manager=runner.Runner(state=fixture.state,trusted_uid=os.getuid(),trust_anchor=fixture.root)
        manager.initialize();manager.enroll(fixture.tx.public)
        policy={'dropin':str(fixture.paths['dropin']),'legacyBaseline':fixture.tx.baseline,'library':str(library),'state':str(fixture.state),
                'runner':str(fixture.runner),'runtimeHashes':{n:sha((library/n).read_bytes()) for n in m.RUNTIME},
                'publicKits':str(fixture.paths['public']),'archives':str(fixture.paths['archives'])}
        real=m.load_module
        def module(path,**kw):
            if Path(path)==fixture.runner:return runner
            value=real(path,**kw)
            if Path(path).name=='kit-runtime.py':value.DEFAULT_PATHS=fixture.paths
            return value
        with patch.object(m,'load_module',module):
            current=m.current_baseline(policy,owner=os.getuid(),anchor=fixture.root)
            self.assertEqual(current,fixture.prepare.baseline_from_kit(fixture.tx.public,fixture.tx.receipt))
            self.assertEqual(len(current['archives']),2)
            expected=current
            fixture.runtime.DEFAULT_PATHS=fixture.paths
            original_guard=fixture.runtime.Runtime.guard
            injection=fixture.root/'unapproved-root-read';injection.write_bytes(b'private fixture')
            def raced_guard(runtime,*args,**kwargs):
                result=original_guard(runtime,*args,**kwargs)
                saved=json.loads(fixture.tx.receipt.read_text())
                saved['installedFileHashes'][str(injection)]=sha(injection.read_bytes())
                fixture.tx.receipt.write_text(json.dumps(saved))
                return result
            # Return the actual fixture runtime module so the post-guard race is deterministic.
            def racing_module(path,**kw):
                if Path(path).name=='kit-runtime.py':return fixture.runtime
                return module(path,**kw)
            with patch.object(m,'load_module',racing_module),patch.object(fixture.runtime.Runtime,'guard',raced_guard):
                selected=m.current_baseline(policy,owner=os.getuid(),anchor=fixture.root)
            self.assertEqual(selected,expected,'activation race must not add a protected path')
            receipt=json.loads(fixture.tx.receipt.read_text());receipt['preservationReceipt']['archive']='/etc/passwd';fixture.tx.receipt.write_text(json.dumps(receipt))
            with self.assertRaisesRegex(RuntimeError,'CURRENT_BASELINE_UNVERIFIED'):
                m.current_baseline(policy,owner=os.getuid(),anchor=fixture.root)

if __name__=='__main__':unittest.main()
