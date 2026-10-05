import datetime, hashlib, importlib.util, io, json, pathlib, tarfile, tempfile, unittest
from unittest import mock
spec = importlib.util.spec_from_file_location('assessment', pathlib.Path(__file__).with_name('assess-staging-runtime.py'))
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)

class AssessmentGuards(unittest.TestCase):
    def exercise(self, mutate=lambda policy, scan, metadata: None, changed_binary=False, affected_import=False):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory); (root/'security').mkdir()
            binary=b'\x7fELF'+b'fixture native binary'
            policy={'expires_at':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=1)).isoformat(),
                    'elf_inventory':{'notification-worker':{'nodejs/bin/node':hashlib.sha256(binary).hexdigest()}},
                    'findings':[{'id':'CVE-ASSESSMENT','packages':['libc6'],'versions':{'libc6':'exact'},
                                 'justification':'vulnerable_code_not_in_execute_path','rationale':'fixture'}]}
            scan={'matches':[{'vulnerability':{'id':'CVE-ASSESSMENT','severity':'High'},
                              'artifact':{'name':'libc6','version':'exact','purl':'pkg:deb/libc6@exact'}}]}
            metadata={'Id':'sha256:'+'a'*64,'Architecture':'arm64','Os':'linux'}
            mutate(policy,scan,metadata)
            (root/'security/staging-novu-runtime-assessment.json').write_text(json.dumps(policy))
            def docker(*args):
                return json.dumps([metadata]) if args[1:3]==('image','inspect') else 'fixture-container'
            def export(args,**kwargs):
                if args[1]=='export':
                    payload=binary+b'changed' if changed_binary else binary
                    with tarfile.open(args[3],'w') as archive:
                        member=tarfile.TarInfo('nodejs/bin/node');member.size=len(payload)
                        archive.addfile(member,io.BytesIO(payload))
            with mock.patch.object(a,'ROOT',root),mock.patch.object(a,'run',docker),mock.patch.object(a.subprocess,'run',export),\
                    mock.patch.object(a,'elf_imports',return_value=['strfmon'] if affected_import else []):
                a.assess('notification-worker','fixture-image',scan,root/'evidence')
            receipt=json.loads((root/'evidence/runtime-assessment.json').read_text())
            self.assertEqual(receipt['image_id'],metadata['Id'])
            self.assertEqual(receipt['raw_high_matches'],1)

    def test_exact_reviewed_image_passes(self): self.exercise()
    def test_native_drift_blocks(self):
        with self.assertRaisesRegex(RuntimeError,'inventory changed'):self.exercise(changed_binary=True)
    def test_affected_import_blocks(self):
        with self.assertRaisesRegex(RuntimeError,'execution path'):self.exercise(affected_import=True)
    def test_unknown_advisory_blocks(self):
        with self.assertRaisesRegex(RuntimeError,'Unassessed'):self.exercise(lambda p,s,m:s['matches'][0]['vulnerability'].update(id='CVE-NEW'))
    def test_changed_package_version_blocks(self):
        with self.assertRaisesRegex(RuntimeError,'Unassessed'):self.exercise(lambda p,s,m:s['matches'][0]['artifact'].update(version='changed'))
    def test_critical_never_suppressed(self):
        with self.assertRaisesRegex(RuntimeError,'Unassessed'):self.exercise(lambda p,s,m:s['matches'][0]['vulnerability'].update(severity='Critical'))
    def test_expired_assessment_blocks(self):
        with self.assertRaisesRegex(RuntimeError,'expired'):self.exercise(lambda p,s,m:p.update(expires_at='2020-01-01T00:00:00+00:00'))
    def test_other_platform_blocks(self):
        with self.assertRaisesRegex(RuntimeError,'ARM64'):self.exercise(lambda p,s,m:m.update(Architecture='amd64'))

if __name__=='__main__':unittest.main()
