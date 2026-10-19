import copy
import datetime
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS=pathlib.Path(__file__).resolve().parents[1]/'scripts'
sys.path.insert(0,str(SCRIPTS))
spec=importlib.util.spec_from_file_location('inventory',SCRIPTS/'production_release_inventory.py')
i=importlib.util.module_from_spec(spec);spec.loader.exec_module(i)

class InventoryTests(unittest.TestCase):
    def cloud(self,alter=None):
        class Cloud:
            def read(self,path):
                if path=='domains':return [{'hostname':host,'service':'hid-'+app+'-production'} for app,host in i.HOSTS.items()]
                if path.endswith('/deployments'):return [{'versions':[{'version_id':'11111111-1111-1111-1111-111111111111','percentage':100}]}]
                app=path.split('/')[1].removeprefix('hid-').removesuffix('-production')
                values={'EXPECTED_HOST':i.HOSTS[app],'DEPLOYMENT_ENV':'production','API_ORIGIN':'https://api.healthidentitydirectory.com'}
                result={'resources':{'bindings':[{'name':'ORIGIN_AUTH_TOKEN','type':'secret_text'}]+[
                    {'name':name,'type':'plain_text','text':text} for name,text in values.items()]}}
                if alter:alter(result)
                return result
        return Cloud()
    def test_live_production_workers(self):self.assertEqual(set(i.live_workers(self.cloud())),set(i.HOSTS))
    def backend(self,staging=False):
        aws=mock.Mock()
        def call(service,operation,args):
            if operation=='describe-services':
                component=args['services'][0].removeprefix('hid-staging-')
                return {'services':[{'status':'ACTIVE','desiredCount':1,'runningCount':1,'pendingCount':0,
                    'deployments':[{'rolloutState':'COMPLETED'}],'taskDefinition':component}]}
            component=args['taskDefinition']
            return {'taskDefinition':{'containerDefinitions':[{'name':component,
                'image':self.publications()[component]['image_uri'],'environment':
                [{'name':'HID_DEPLOYMENT_ENV','value':'staging' if staging else 'production'}]
                if component in i.PROFILED_SERVICES else []}]}}
        aws.call.side_effect=call;return aws
    def test_services_without_profile_switch_use_their_real_contract(self):
        with mock.patch.object(i,'task_config_hash',return_value='a'*64):
            self.assertEqual(set(i.live_backend(self.backend())),set(i.COMPONENTS))
    def test_staging_api_profile_cannot_be_relabelled(self):
        with self.assertRaisesRegex(i.ReleaseError,'STAGING_RUNTIME_CANNOT_BOOTSTRAP_PRODUCTION'):
            i.live_backend(self.backend(staging=True))
    def test_staging_domains_cannot_be_relabelled(self):
        cloud=self.cloud();old=cloud.read
        cloud.read=lambda path:[{'hostname':h,'service':'hid-'+a+'-staging'} for a,h in i.HOSTS.items()] if path=='domains' else old(path)
        with self.assertRaisesRegex(i.ReleaseError,'NOT_BOOTSTRAPPED'):i.live_workers(cloud)
    def test_worker_origin_configuration_and_secret_required(self):
        for alter in [lambda r:r['resources']['bindings'].pop(0),
                      lambda r:r['resources']['bindings'][2].update(text='staging'),
                      lambda r:r['resources']['bindings'][3].update(text='https://api.staging.healthidentitydirectory.com')]:
            with self.assertRaises(i.ReleaseError):i.live_workers(self.cloud(alter))
    def publications(self):
        return {c:{'image_uri':'659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/'+('ehr-api' if c=='database-migration' else c)+'@sha256:'+'a'*64,
                   'source_commit':'b'*40,'publication_sha256':'c'*64} for c in (*i.COMPONENTS,'database-migration')}
    def test_sources_must_match_every_actual_admitted_image(self):
        publications=self.publications();backend={c:{'image_uri':publications[c]['image_uri']} for c in i.COMPONENTS}
        actual=i.attach_sources(backend,publications)
        self.assertTrue(all(r['source_commit']=='b'*40 for r in actual.values()))
        changed=copy.deepcopy(publications);changed['ehr-api']['image_uri']=changed['ehr-api']['image_uri'][:-1]+'d'
        with self.assertRaisesRegex(i.ReleaseError,'LIVE_IMAGE_DIFFERS'):i.attach_sources(backend,changed)
        del changed['identity-api']
        with self.assertRaisesRegex(i.ReleaseError,'COMPLETE_ADMITTED'):i.attach_sources(backend,changed)
    def test_unaccepted_inventory_has_no_cloud_effects(self):
        with tempfile.TemporaryDirectory() as folder:
            path=pathlib.Path(folder)/'manifest.json';path.write_text('{}')
            aws=mock.Mock()
            with self.assertRaisesRegex(i.ReleaseError,'EXACT_ACCEPTED'):
                i.bootstrap(aws,mock.Mock(),{}, {},path,'wrong')
            self.assertEqual(aws.mock_calls,[])
    def test_stale_inventory_cannot_initialize_index(self):
        with tempfile.TemporaryDirectory() as folder:
            path=pathlib.Path(folder)/'manifest.json'
            path.write_text(json.dumps({'created_at':(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=1)).isoformat()}))
            aws=mock.Mock()
            with self.assertRaisesRegex(i.ReleaseError,'FRESH_BOOTSTRAP'):
                i.bootstrap(aws,mock.Mock(),{}, {},path,i.file_sha(path))
            self.assertEqual(aws.mock_calls,[])
    def test_rollback_retention_must_precede_index_admission(self):
        aws=mock.Mock();aws.call.return_value={'lifecyclePolicyText':json.dumps({'rules':[]})}
        row=self.publications()['ehr-api']
        with self.assertRaisesRegex(i.ReleaseError,'ROLLBACK_RETENTION_POLICY_REQUIRED'):
            i.retain(aws,mock.Mock(),'ehr-api',row['image_uri'])
        self.assertTrue(all(not call.kwargs.get('mutation') for call in aws.call.mock_calls))
    def bootstrap_case(self,drift=False,existing=False):
        events=[];index={'backend':{c:{'task_definition':'observed-task'} for c in i.COMPONENTS},'frontend':{}}
        store=mock.Mock()
        def put(key,value):
            events.append('conditional-index-create')
            self.assertEqual(key,'production/current.json');self.assertEqual(value,index)
            if existing:raise i.ReleaseError('EXISTING_INDEX_CANNOT_BE_REPLACED')
            return {'VersionId':'verified-version'}
        def receipt_or_index(key,value):
            if key.endswith('/complete.json'):
                self.assertEqual(value['operation'],'bootstrap-inventory');return {'VersionId':'receipt-version'}
            return put(key,value)
        store.put.side_effect=receipt_or_index
        store.read.side_effect=lambda *args:(copy.deepcopy(index),{'VersionId':'verified-version'})
        lease=mock.Mock(spec=['acquire','assert_owned','release']);lease.acquire.return_value=lease
        aws=mock.Mock();aws.call.return_value={'taskDefinition':{'containerDefinitions':[]}}
        configuration={'release_bucket':'expected-bucket','release_kms_key_arn':'expected-key','lease_table':'expected-lease'}
        publications=self.publications()
        frontends=mock.Mock();frontends.fingerprint={'verified':'archive'};frontends.run_id='123'
        frontends.dependencies={'declared':True};frontends.check.return_value={'web':{'deep_link_verified':True}}
        frontends.preserve.side_effect=lambda store,lease,rows:rows
        with tempfile.TemporaryDirectory() as folder:
            path=pathlib.Path(folder)/'manifest.json'
            manifest={'schema':'hid.production-bootstrap-review/v1','created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'configuration_sha256':i.sha(i.canonical(configuration)), 'publications_sha256':i.sha(i.canonical(publications)),
                'origin_version':'verified-origin-version','index':copy.deepcopy(index),
                'frontend_evidence':frontends.fingerprint,'frontend_checks':frontends.check.return_value}
            path.write_text(json.dumps(manifest))
            snapshots=[index,{'backend':'changed'} if drift else index,copy.deepcopy(index)]
            with mock.patch.object(i.gates,'run'),mock.patch.object(i,'Store',return_value=store),\
                mock.patch.object(i,'Lease',return_value=lease),mock.patch.object(i,'collect',side_effect=snapshots),\
                mock.patch.object(i,'retain',side_effect=lambda *args:events.append('retain')):
                if drift or existing:
                    with self.assertRaises(i.ReleaseError):i.bootstrap(aws,mock.Mock(),configuration,publications,path,i.file_sha(path),frontends)
                else:
                    result=i.bootstrap(aws,mock.Mock(),configuration,publications,path,i.file_sha(path),frontends)
                    self.assertEqual(result['status'],'bootstrapped')
                    self.assertEqual(result['version_id'],'verified-version')
                    self.assertFalse(result['deployment_performed'])
        if drift:
            store.put.assert_not_called();lease.release.assert_called_with(reconciled=True)
        else:
            self.assertEqual(events[-1],'conditional-index-create')
            self.assertEqual(events.count('retain'),13)
            lease.release.assert_called_with(reconciled=not existing)
        self.assertTrue(all(not call.kwargs.get('mutation') for call in aws.call.mock_calls))
    def test_prepare_requires_verified_archives_before_cloud_access(self):
        aws=mock.Mock()
        with self.assertRaisesRegex(i.ReleaseError,'VERIFIED_FRONTEND_ARCHIVES_REQUIRED'):
            i.prepare(aws,mock.Mock(),{},None,{},'unused')
        self.assertEqual(aws.mock_calls,[])
    def test_failed_build_cannot_supply_bootstrap_verifier(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(i.subprocess,'check_output',return_value='a'*40), \
             mock.patch.object(i.subprocess,'run',return_value=mock.Mock(returncode=0)), \
             mock.patch.object(i.gates,'request',return_value={'head_sha':'a'*40,'head_branch':'main','conclusion':'failure'}):
            with self.assertRaisesRegex(i.ReleaseError,'SUCCESSFUL_FRONTEND_BUILD_REQUIRED'):
                i.Frontends(folder,pathlib.Path(folder)/'missing.zip','123')
    def test_frontend_artifact_tampering_blocks_before_import(self):
        with tempfile.TemporaryDirectory() as folder:
            path=pathlib.Path(folder)/'artifact.zip';path.write_bytes(b'tampered')
            run={'head_sha':'a'*40,'head_branch':'main','conclusion':'success','run_attempt':1,
                 'event':'push','path':'.github/workflows/production-frontends.yml'}
            with mock.patch.object(i.subprocess,'check_output',return_value='a'*40), \
                 mock.patch.object(i.subprocess,'run',return_value=mock.Mock(returncode=0)), \
                 mock.patch.object(i.gates,'request',side_effect=[run,{'object':{'sha':'a'*40}},
                    {'artifacts':[{'name':'production-frontends-'+'a'*40,'expired':False,'digest':'sha256:'+'b'*64}]}]):
                with self.assertRaisesRegex(i.ReleaseError,'GITHUB_FRONTEND_ARCHIVE_DIGEST_DIFFERS'):
                    i.Frontends(folder,path,'123')
    def test_bootstrap_retains_then_creates_and_reads_back_index(self):self.bootstrap_case()
    def test_last_second_live_drift_denies_index_write(self):self.bootstrap_case(drift=True)
    def test_existing_index_is_never_overwritten(self):self.bootstrap_case(existing=True)

if __name__=='__main__':unittest.main()
