import copy
import importlib.util
import json
import pathlib
import unittest
from unittest.mock import patch
import production_deployment_core as c
import production_release_infrastructure as r
from test_production_deployment_core import image,index

spec=importlib.util.spec_from_file_location('guard',pathlib.Path(__file__).with_name('read_production_release_state.py'))
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

    def _database_plan(self, restorable='2026-11-04T14:00:00Z'):
        database={'multi_az':False,'latest_restorable_time':restorable,'instance_class':'db.t4g.small'}
        after=dict(database,multi_az=True)
        return {'resource_changes':[{'address':'module.data.aws_db_instance.main[0]','mode':'managed','type':'aws_db_instance',
            'change':{'actions':['update'],'before':database,'after':after,'after_unknown':{},'before_sensitive':{},'after_sensitive':{}}}]}

    def test_replanning_ignores_the_database_restore_point_aws_moves_by_itself(self):
        reviewed=r.fingerprint(self._database_plan('2026-11-04T14:00:00Z'))
        self.assertEqual(r.fingerprint(self._database_plan('2026-11-04T14:05:00Z')),reviewed)

    def test_replanning_still_detects_any_other_database_change(self):
        reviewed=r.fingerprint(self._database_plan())
        for side,key,value in (('after','multi_az',False),('after','instance_class','db.t4g.medium'),
                               ('before','instance_class','db.t4g.medium'),('before','multi_az',True)):
            plan=self._database_plan(); plan['resource_changes'][0]['change'][side][key]=value
            self.assertNotEqual(r.fingerprint(plan),reviewed,(side,key))
        plan=self._database_plan(); plan['resource_changes'][0]['change']['actions']=['delete','create']
        self.assertNotEqual(r.fingerprint(plan),reviewed)

    def test_restore_point_is_ignored_only_on_the_database(self):
        plan={'resource_changes':[{'address':'module.x.aws_ecs_service.s','mode':'managed','type':'aws_ecs_service',
            'change':{'actions':['update'],'before':{'latest_restorable_time':'a'},'after':{'latest_restorable_time':'a'}}}]}
        reviewed=r.fingerprint(plan); plan['resource_changes'][0]['change']['before']['latest_restorable_time']='b'
        self.assertNotEqual(r.fingerprint(plan),reviewed)

    def test_restore_point_never_hides_which_resources_change(self):
        reviewed=r.fingerprint(self._database_plan())
        extra=self._database_plan()
        extra['resource_changes'].append({'address':'module.data.aws_s3_bucket.documents','mode':'managed','type':'aws_s3_bucket',
            'change':{'actions':['update'],'before':{'versioning':True},'after':{'versioning':False}}})
        self.assertNotEqual(r.fingerprint(extra),reviewed)
        unchanged=self._database_plan('2026-11-04T14:09:00Z'); row=unchanged['resource_changes'][0]['change']
        row['actions']=['no-op']; row['after']=dict(row['before'])
        self.assertNotEqual(r.fingerprint(unchanged),reviewed)
        self.assertEqual(r.fingerprint(unchanged),r.fingerprint({'resource_changes':[]}))

    def test_database_replacement_is_still_pinned(self):
        plan=self._database_plan(); change=plan['resource_changes'][0]['change']
        change.update(actions=['delete','create'],after=None,after_unknown={'latest_restorable_time':True},replace_paths=[['multi_az']])
        reviewed=r.fingerprint(plan)
        moved=copy.deepcopy(plan); moved['resource_changes'][0]['change']['before']['latest_restorable_time']='2026-11-04T15:00:00Z'
        self.assertEqual(r.fingerprint(moved),reviewed)
        moved['resource_changes'][0]['change']['replace_paths']=[['instance_class']]
        self.assertNotEqual(r.fingerprint(moved),reviewed)

    def test_plans_without_a_database_change_hash_as_before(self):
        def previous(plan):
            changes=[{k:x[k] for k in ('address','mode','type','change') if k in x}
                for x in plan.get('resource_changes',[]) if x.get('mode')=='managed' and x['change']['actions']!=['no-op']]
            return c.sha(c.canonical(sorted(changes,key=lambda x:x['address'])))
        plan={'resource_changes':[
            {'address':'data.external.release_state','mode':'data','change':{'actions':['read'],'after':{'holder':'h'}}},
            {'address':'module.a.aws_ecs_service.s','mode':'managed','type':'aws_ecs_service','change':{'actions':['update'],'before':{'n':1},'after':{'n':2}}},
            {'address':'module.a.aws_ecr_lifecycle_policy.p','mode':'managed','type':'aws_ecr_lifecycle_policy','change':{'actions':['delete','create'],'before':{'p':'x'},'after':{'p':'y'},'replace_paths':[['policy']]}},
            {'address':'module.a.aws_kms_key.k','mode':'managed','type':'aws_kms_key','change':{'actions':['no-op'],'before':{},'after':{}}}]}
        self.assertEqual(r.fingerprint(plan),previous(plan))

    def test_fingerprint_leaves_the_plan_unchanged(self):
        plan=self._database_plan(); snapshot=copy.deepcopy(plan); r.fingerprint(plan)
        self.assertEqual(plan,snapshot)

    def test_saved_plan_read_checks_latest_version_and_lease(self):
        value=index(); query={'environment':'production','account':c.ACCOUNT,'region':c.REGION,'bucket':'hid-staging-releases-'+c.ACCOUNT+'-'+c.REGION,
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

if __name__=='__main__': unittest.main()
