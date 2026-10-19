import copy
import importlib.util
import json
import pathlib
import unittest
from unittest.mock import patch
import deployment_core as c
import release_infrastructure as r
import release_inventory as inventory
from test_deployment_core import image,index

spec=importlib.util.spec_from_file_location('guard',pathlib.Path(__file__).with_name('read-release-state.py'))
guard=importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)


class InfrastructureTests(unittest.TestCase):
    def test_resolver_uses_every_current_digest_including_support_and_schema(self):
        lease=type('Lease',(),{'holder':'holder','generation':'2'})()
        resolved=r.resolved_inputs(index(),{'VersionId':'v2'},lease)
        self.assertEqual(set(resolved['image_uris']),set(c.COMPONENTS))
        self.assertEqual(resolved['migration_image_uri'],image('database-migration'))
        self.assertTrue(resolved['enforce_release_index']); self.assertFalse(resolved['deployment_automation_bootstrap'])

    def test_replanning_ignores_read_lease_identity_but_detects_resource_change(self):
        plan={'resource_changes':[{'address':'data.external.release_state','mode':'data','change':{'actions':['read'],'after':{'holder':'old'}}},
            {'address':'module.application.service','mode':'managed','type':'aws_ecs_service','change':{'actions':['update'],'after':{'desired_count':1}}}]}
        before=r.fingerprint(plan); plan['resource_changes'][0]['change']['after']['holder']='new'
        self.assertEqual(r.fingerprint(plan),before)
        plan['resource_changes'][1]['change']['after']['desired_count']=2
        self.assertNotEqual(r.fingerprint(plan),before)

    def test_saved_plan_read_checks_latest_version_and_lease(self):
        value=index(); query={'account':c.ACCOUNT,'region':c.REGION,'bucket':'hid-staging-releases-'+c.ACCOUNT+'-'+c.REGION,
            'version_id':'v1','sha256':c.sha(c.canonical(value)),'holder':'approved','generation':'4'}
        class FakeAWS:
            def account(self): pass
            def call(self,service,operation,args,**kwargs):
                if service=='s3api':
                    self.assert_latest='VersionId' not in args
                    pathlib.Path(kwargs['extra'][0]).write_bytes(c.canonical(value))
                    return {'VersionId':'v2','ServerSideEncryption':'aws:kms','SSEKMSKeyId':'arn:aws:kms:'+c.REGION+':'+c.ACCOUNT+':key/test'}
                return {'Item':{'holder':{'S':'other'},'generation':{'N':'4'},'expires_at':{'N':'9999999999'}}}
        aws=FakeAWS()
        with self.assertRaisesRegex(c.ReleaseError,'INDEX_CHANGED'): guard.read(query,aws)
        self.assertTrue(aws.assert_latest); query['version_id']='v2'
        with self.assertRaisesRegex(c.ReleaseError,'LEASE_LOST'): guard.read(query,aws)

    def test_recovery_refuses_live_holder_and_running_schema_task(self):
        aws=unittest.mock.Mock()
        aws.call.return_value={'Item':{'holder':{'S':'old'},'generation':{'N':'2'},'expires_at':{'N':'9999999999'}}}
        with self.assertRaisesRegex(c.ReleaseError,'EXPIRED'): inventory.recovery_review(aws,unittest.mock.Mock())
        value=index(); value['frontend']={name:{'hostname':host,'version_id':'v1'} for name,host in inventory.HOSTS.items()}
        store=unittest.mock.Mock(); store.read.return_value=(value,{'VersionId':'v1'})
        aws.call.side_effect=[{'Item':{'holder':{'S':'terraform-old'},'generation':{'N':'2'},'expires_at':{'N':'1'}}},
            {'taskArns':['running-schema-task']}]
        with (patch.object(inventory,'live_backend',return_value={n:r.physical(row) for n,row in value['backend'].items()}),
                patch.object(inventory,'live_workers',return_value=value['frontend'])):
            with self.assertRaisesRegex(c.ReleaseError,'STILL_RUNNING'): inventory.recovery_review(aws,store)

if __name__=='__main__': unittest.main()
