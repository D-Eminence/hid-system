import copy
import datetime as dt
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import production_deployment_core as c


def ctx(kind='backend'):
    target=c.TARGETS[kind]
    return c.context(kind,{'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':target['repo'],
        'GITHUB_REPOSITORY_ID':target['id'],'GITHUB_REPOSITORY_OWNER_ID':c.OWNER_ID,
        'GITHUB_REF':'refs/heads/'+target['branch'],'GITHUB_EVENT_NAME':'push',
        'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'42','GITHUB_RUN_ATTEMPT':'1'})


def image(name,digest='a'):
    repo='ehr-api' if name=='database-migration' else name
    return c.ACCOUNT+'.dkr.ecr.'+c.REGION+'.amazonaws.com/staging/hid/'+repo+'@sha256:'+digest*64


def index():
    return {'schema':'hid.production-index/v1','account':c.ACCOUNT,'region':c.REGION,
        'environment':'production','verified':True,'backend':{n:{'image_uri':image(n),
        'task_definition':'arn:aws:ecs:'+c.REGION+':'+c.ACCOUNT+':task-definition/hid-staging-'+n+':1',
        'config_sha256':'b'*64,'source_commit':'c'*40} for n in c.COMPONENTS},
        'migration_image_uri':image('database-migration'),
        'migration_task_definition':'arn:aws:ecs:'+c.REGION+':'+c.ACCOUNT+':task-definition/hid-staging-database-migration:1',
        'migration_network':{'subnets':['subnet-1','subnet-2'],'securityGroups':['sg-1'],'assignPublicIp':'DISABLED'}}


class CoreTests(unittest.TestCase):
    def candidate(self): return c.make_candidate(ctx(),['identity-api'],{'identity-api':{'image_uri':image('identity-api')}},{'select':'success'})

    def test_wrong_ref_and_fork_rejected(self):
        for field,value in [('GITHUB_REF','refs/heads/staging'),('GITHUB_REPOSITORY_ID','999'),('GITHUB_EVENT_NAME','pull_request')]:
            env={'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':c.TARGETS['backend']['repo'],
                'GITHUB_REPOSITORY_ID':c.TARGETS['backend']['id'],'GITHUB_REPOSITORY_OWNER_ID':c.OWNER_ID,
                'GITHUB_REF':'refs/heads/'+c.TARGETS['backend']['branch'],'GITHUB_EVENT_NAME':'push',
                'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'42','GITHUB_RUN_ATTEMPT':'1',field:value}
            with self.assertRaises(c.ReleaseError): c.context('backend',env)

    def test_production_uses_exact_novu_backend_and_main_frontend_branches(self):
        self.assertEqual(ctx('backend')['branch'], 'staging-novu-ci-20261005')
        self.assertEqual(ctx('frontend')['branch'], 'main')
        for kind, bad in [('backend', 'main'), ('backend', 'staging'), ('frontend', 'staging-novu-ci-20261005')]:
            target=c.TARGETS[kind]
            env={'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':target['repo'],
                'GITHUB_REPOSITORY_ID':target['id'],'GITHUB_REPOSITORY_OWNER_ID':c.OWNER_ID,
                'GITHUB_REF':'refs/heads/'+bad,'GITHUB_EVENT_NAME':'push',
                'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'42','GITHUB_RUN_ATTEMPT':'1'}
            with self.assertRaisesRegex(c.ReleaseError, 'UNTRUSTED_BRANCH'): c.context(kind,env)

    def test_candidate_bound_to_artifacts_run_and_expiry(self):
        value=self.candidate(); c.validate_candidate(value,ctx())
        for bad in [dict(value,run_id='43'),dict(value,evidence={}),dict(value,checks={'select':'skipped'})]:
            with self.assertRaises(c.ReleaseError): c.validate_candidate(bad,ctx())
        with self.assertRaisesRegex(c.ReleaseError,'EXPIRED'):
            c.validate_candidate(value,ctx(),c.now()+dt.timedelta(days=2))

    def test_tags_foreign_images_and_incomplete_inventory_rejected(self):
        for uri in [image('identity-api').replace('@sha256:'+('a'*64),':latest'),image('ehr-api'),image('identity-api').replace(c.ACCOUNT,'999999999999')]:
            with self.assertRaises(c.ReleaseError): c.image('identity-api',uri)
        value=index(); c.validate_index(value); del value['backend']['support-api']
        with self.assertRaises(c.ReleaseError): c.validate_index(value)

    def test_exact_configuration_clone_preserves_secret_sidecar_and_health(self):
        task={'family':'hid-staging-identity-api','networkMode':'awsvpc','runtimePlatform':{'cpuArchitecture':'ARM64'},
            'taskRoleArn':'arn:aws:iam::'+c.ACCOUNT+':role/hid-staging-task',
            'executionRoleArn':'arn:aws:iam::'+c.ACCOUNT+':role/hid-staging-exec',
            'containerDefinitions':[{'name':'identity-api','image':image('identity-api'),'secrets':[{'name':'KEY','valueFrom':'staging-reference'}],
                'healthCheck':{'command':['CMD','health']}},
                {'name':'workload-token-agent','image':image('identity-api')}],
            'taskDefinitionArn':'read-only-metadata'}
        before=copy.deepcopy(task); payload=c.task_payload(task,'identity-api',image('identity-api','b'))
        self.assertEqual(task,before); self.assertNotIn('taskDefinitionArn',payload)
        self.assertEqual(payload['containerDefinitions'][0]['secrets'],task['containerDefinitions'][0]['secrets'])
        self.assertEqual(payload['containerDefinitions'][1],task['containerDefinitions'][1])
        self.assertEqual(c.task_config_hash(payload,'identity-api'),c.task_config_hash(task,'identity-api'))
        task['containerDefinitions'].append({'name':'unexpected','image':'latest'})
        with self.assertRaises(c.ReleaseError): c.task_payload(task,'identity-api',image('identity-api','b'))

    def test_s3_stream_body_owner_and_conditional_writes(self):
        class Fake:
            def call(self,s,o,args,**kw):
                self.args=args; self.kw=kw
                self.data=pathlib.Path(kw['extra'][1]).read_bytes()
                return {'VersionId':'v2'}
        aws=Fake(); store=c.Store(aws,'hid-staging-releases-659225405023-eu-west-1','arn:aws:kms:'+c.REGION+':'+c.ACCOUNT+':key/11111111-1111-1111-1111-111111111111')
        store.put(c.INDEX_KEY,{'value':1},etag='"prior"')
        self.assertEqual(aws.args['IfMatch'],'"prior"'); self.assertNotIn('Body',aws.args)
        self.assertEqual(aws.args['ExpectedBucketOwner'],c.ACCOUNT)
        self.assertEqual(aws.kw['extra'][0],'--body'); self.assertEqual(json.loads(aws.data),{'value':1})
        store.put('production/releases/test/complete.json',{'status':'success'})
        self.assertEqual(aws.args['IfNoneMatch'],'*')

    def test_retention_refuses_unprotected_policy_before_image_tagging(self):
        class Fake:
            def call(self,service,operation,args,**kwargs):
                if operation=='get-lifecycle-policy': return {'lifecyclePolicyText':json.dumps({'rules':[]})}
                raise AssertionError('Image mutation before retention protection')
        with self.assertRaisesRegex(c.ReleaseError,'RETENTION_POLICY'):
            c.retain_image(Fake(),None,'identity-api',image('identity-api'))

    def test_expired_lock_cannot_be_stolen_or_released_after_loss(self):
        class Fake:
            def __init__(self): self.calls=[]
            def call(self,s,o,args,**kw):
                self.calls.append((o,args))
                if o=='update-item': raise c.ReleaseError('AWS_ConditionalCheckFailedException')
                return {'Item':{'holder':{'S':'other'},'generation':{'N':'2'},'expires_at':{'N':'0'}}}
        aws=Fake(); lease=c.Lease(aws,'test',table='hid-staging-deployment-leases')
        with self.assertRaises(c.ReleaseError): lease.acquire()
        self.assertEqual(aws.calls[0][1]['ConditionExpression'],'attribute_not_exists(holder)')
        lease.generation='1'
        with self.assertRaises(c.ReleaseError): lease.assert_owned()
        count=len(aws.calls); lease.release(reconciled=False); self.assertEqual(len(aws.calls),count)

    def test_approval_requires_enabled_native_gate_and_new_run(self):
        value=self.candidate(); gh=c.GitHub(value['repository'],token='test')
        with patch.dict(os.environ,{'PRODUCTION_DEPLOYMENT_ENABLED':'false'}):
            with self.assertRaisesRegex(c.ReleaseError,'DISABLED'): gh.assert_approval(value)
        with patch.dict(os.environ,{'PRODUCTION_DEPLOYMENT_ENABLED':'true'}),patch.object(gh,'get',return_value={'protection_rules':[]}):
            with self.assertRaisesRegex(c.ReleaseError,'REVIEWER'): gh.assert_approval(value)
        with self.assertRaisesRegex(c.ReleaseError,'NEW_WORKFLOW_RUN'):
            gh.assert_approval(dict(value,run_attempt='2'))

    def test_approval_rejects_bypass_self_approval_and_wrong_branch(self):
        value=self.candidate(); gh=c.GitHub(value['repository'],token='test')
        settings={'id':7,'can_admins_bypass':False,'deployment_branch_policy':{'custom_branch_policies':True,'protected_branches':False},
            'protection_rules':[{'type':'required_reviewers','prevent_self_review':True,'reviewers':[{'type':'User','reviewer':{'id':9}}]}]}
        def reader(path):
            if path.endswith('deployment-branch-policies?per_page=100'): return {'branch_policies':[{'name':value['branch'],'type':'branch'}]}
            if path.endswith('/approvals'): return [{'state':'approved','user':{'id':9},'environments':[{'id':7}]}]
            return settings
        with patch.dict(os.environ,{'PRODUCTION_DEPLOYMENT_ENABLED':'true'}),patch.object(gh,'get',side_effect=reader),patch.object(gh,'assert_checks'),patch.object(gh,'assert_current_source'):
            self.assertEqual(gh.assert_approval(value)['reviewer_ids'],[9])
            settings['can_admins_bypass']=True
            with self.assertRaisesRegex(c.ReleaseError,'BYPASS'): gh.assert_approval(value)
            settings['can_admins_bypass']=False; settings['protection_rules'][0]['prevent_self_review']=False
            with self.assertRaisesRegex(c.ReleaseError,'REVIEWER'): gh.assert_approval(value)

    def test_remote_missing_skipped_matrix_jobs_fail(self):
        value=self.candidate(); gh=c.GitHub(value['repository'],token='test')
        for jobs in [[],[{'name':'select','conclusion':'skipped'}],[{'name':'select','conclusion':'success'}]]:
            with patch.object(gh,'jobs',return_value=jobs):
                with self.assertRaises(c.ReleaseError): gh.assert_checks(value)
        with patch.object(gh,'jobs',return_value=[{'name':name,'conclusion':'success'} for name in ['select','build (identity-api)','publish (identity-api)']]):
            gh.assert_checks(value)

    def test_remote_superseded_branch_rejected(self):
        value=self.candidate(); gh=c.GitHub(value['repository'],token='test')
        with patch.object(gh,'get',side_effect=[{'id':int(value['repository_id']),'owner':{'id':int(c.OWNER_ID)}},{'commit':{'sha':'b'*40}}]):
            with self.assertRaisesRegex(c.ReleaseError,'SUPERSEDED'): gh.assert_current_source(value)

    def test_schema_needs_exact_reviewed_file_hashes(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder); name='services/ehr-api/database/migrations/0099_add.sql'
            path=root/name; path.parent.mkdir(parents=True); path.write_text('select 1;')
            with self.assertRaisesRegex(c.ReleaseError,'EVIDENCE'): c.schema_contract(root,[name])
            (root/'config').mkdir()
            contract={'schema':'hid.schema-compatibility/v1','backward_compatible':True,'reviewed_by':'HID reviewer',
                'evidence':'existing check','files':{name:c.file_sha(path)}}
            c.atomic_json(root/'config/production-schema-compatibility.json',contract)
            self.assertTrue(c.schema_contract(root,[name])['changed'])
            path.write_text('select 2;')
            with self.assertRaisesRegex(c.ReleaseError,'CONTENT'): c.schema_contract(root,[name])

if __name__=='__main__': unittest.main()
