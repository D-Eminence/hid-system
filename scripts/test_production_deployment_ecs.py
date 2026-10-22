import copy
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import production_deployment_core as c
import production_deployment as b
from test_production_deployment_core import ctx, image, index


class FakeAWS:
    def account(self): pass


class FakeLease:
    def __init__(self,*args,**kwargs): self.released=None
    def acquire(self): return self
    def assert_owned(self): pass
    def release(self,reconciled=True): self.released=reconciled


class BackendControllerTests(unittest.TestCase):
    def test_definition_accepts_only_production_components_and_retained_migration(self):
        aws = unittest.mock.Mock()
        aws.call.return_value = {'taskDefinition': {'verified': True}}
        ecs = b.ECS(aws, FakeLease())
        prefix = 'arn:aws:ecs:'+c.REGION+':'+c.ACCOUNT+':task-definition/'
        for family in ['hid-production-'+name for name in c.COMPONENTS]+['hid-staging-database-migration']:
            self.assertEqual(ecs.definition(prefix+family+':1'), {'verified': True})
        aws.reset_mock()
        for arn in [prefix+'hid-staging-gateway:1', prefix+'hid-production-unknown:1',
                    prefix+'hid-production-gateway:0', (prefix+'hid-production-gateway:1').replace(c.ACCOUNT, '999999999999')]:
            with self.assertRaisesRegex(c.ReleaseError, 'FOREIGN_TASK_DEFINITION'):
                ecs.definition(arn)
        aws.call.assert_not_called()

    def test_bootstrap_rollback_receipt_requires_verified_inventory(self):
        store = unittest.mock.Mock()
        receipt = {'kind': 'backend', 'status': 'success', 'operation': 'bootstrap-inventory',
                   'deployment_performed': False, 'inventory_manifest_sha256': 'a'*64}
        store.read.return_value = (receipt, {'VersionId': 'v1'})
        release = 'backend-bootstrap-'+'b'*24
        self.assertEqual(b.rollback_receipt(store, release)[0], receipt)
        receipt['deployment_performed'] = True
        with self.assertRaisesRegex(c.ReleaseError, 'VERIFIED_BOOTSTRAP'):
            b.rollback_receipt(store, release)

    def execute(self, failure=False, alert_failure=False, loss=False):
        baseline=index(); state={n:brow.copy() for n,brow in baseline['backend'].items()}
        physical=lambda:{n:{k:r[k] for k in ('image_uri','task_definition','config_sha256')} for n,r in state.items()}
        objects={c.INDEX_KEY:copy.deepcopy(baseline)}; calls=[]; lease=FakeLease()
        class FakeStore:
            def __init__(self,*args): pass
            def read(self,key,version=None): return copy.deepcopy(objects[key]),{'ETag':'prior','VersionId':'v1'}
            def put(self,key,value,etag=None): objects[key]=copy.deepcopy(value); return {'ETag':'next','VersionId':'v2'}
        class FakeECS:
            def __init__(self,*args): pass
            def snapshot(self): return physical()
            def register(self,name,uri): return baseline['backend'][name]['task_definition'][:-1]+'2'
            def update(self,name,arn):
                calls.append((name,arn)); state[name]['task_definition']=arn
                state[name]['image_uri']=image(name,'b' if arn.endswith(':2') else 'a')
                if arn.endswith(':2') and failure:
                    if loss: lease.assert_owned=lambda:c.require(False,'LEASE_LOST')
                    raise c.ReleaseError('HEALTH_CHECK_FAILED')
                lease.assert_owned()
            def definition(self,arn): return {'containerDefinitions':[{'name':'database-migration','image':image('database-migration')}]}
        candidate=c.make_candidate(ctx(),['identity-api'],{'identity-api':{'image_uri':image('identity-api','b'), 'publication_sha256':'d'*64}},{'select':'success'})
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder); c.atomic_json(root/'release/candidate.json',candidate)
            env={'EXPECTED_CANDIDATE_SHA256':c.file_sha(root/'release/candidate.json')}
            with patch.dict(os.environ,env),patch.multiple(b,ROOT=root,AWS=FakeAWS,Store=FakeStore,
                    ECS=FakeECS,Lease=lambda *args:lease,context=lambda kind:ctx()),patch.object(b,'GitHub',autospec=True) as gh,patch.object(b,'notify') as notify:
                gh.return_value.assert_approval.return_value={'reviewer_ids':[9]}
                if alert_failure: notify.side_effect=c.ReleaseError('SNS_DENIED')
                if failure or alert_failure:
                    with self.assertRaises(c.ReleaseError): b.deploy()
                else: b.deploy()
        return baseline,state,objects,calls,lease

    def test_partial_failure_restores_prior_revision_and_inventory(self):
        baseline,state,objects,calls,lease=self.execute(failure=True)
        self.assertEqual(state,baseline['backend']); self.assertTrue(lease.released)
        self.assertEqual(len(calls),2); self.assertEqual(objects[c.INDEX_KEY],baseline)
        self.assertTrue(any(k.endswith('/failed.json') for k in objects))

    def test_lease_loss_prevents_restore_and_keeps_recovery_lock(self):
        baseline,state,objects,calls,lease=self.execute(failure=True,loss=True)
        self.assertFalse(lease.released); self.assertEqual(len(calls),1)
        self.assertEqual(objects[c.INDEX_KEY],baseline)

    def test_success_preserves_unchanged_component_provenance(self):
        baseline,state,objects,calls,lease=self.execute()
        current=objects[c.INDEX_KEY]
        self.assertEqual(current['backend']['identity-api']['source_commit'],'a'*40)
        self.assertEqual(current['backend']['identity-api']['publication_sha256'],'d'*64)
        self.assertEqual(current['backend']['ehr-api'],baseline['backend']['ehr-api'])
        self.assertTrue(lease.released)

    def test_alert_failure_reports_failure_without_rolling_back_healthy_release(self):
        baseline,state,objects,calls,lease=self.execute(alert_failure=True)
        self.assertEqual(len(calls),1); self.assertTrue(lease.released)
        self.assertTrue(objects[c.INDEX_KEY]['backend']['identity-api']['task_definition'].endswith(':2'))

    def test_discovery_requires_current_task_addresses_not_retired_registrations(self):
        aws=FakeAWS();aws.call=lambda *args,**kwargs:{'Instances':[{'Attributes':{'AWS_INSTANCE_IPV4':'10.0.0.9'}}]}
        ecs=b.ECS(aws,FakeLease())
        service={'serviceRegistries':[{'registryArn':'arn:aws:servicediscovery:'+c.REGION+':'+c.ACCOUNT+':service/srv-fixture'}]}
        tasks=[{'attachments':[{'details':[{'name':'privateIPv4Address','value':'10.0.0.8'}]}]}]
        with self.assertRaisesRegex(c.ReleaseError,'DISCOVERY_REGISTRATION_MISSING'):ecs.verify_discovery(service,tasks)
        tasks[0]['attachments'][0]['details'][0]['value']='10.0.0.9'
        ecs.verify_discovery(service,tasks)
        with self.assertRaisesRegex(c.ReleaseError,'NETWORK_ADDRESSES_REQUIRED'):ecs.verify_discovery(service,[{}])

    def test_circuit_breaker_restoring_old_revision_is_not_success(self):
        ecs=b.ECS(FakeAWS(),FakeLease()); old={'taskDefinition':'old','desiredCount':1,'runningCount':0,'pendingCount':1,'deployments':[{'rolloutState':'IN_PROGRESS'}]}
        expected=dict(old,taskDefinition='new'); settled=dict(old,pendingCount=0,deployments=[{'rolloutState':'COMPLETED'}])
        with patch.object(ecs,'service',side_effect=[expected,settled]),patch.object(b.time,'sleep'):
            with self.assertRaisesRegex(c.ReleaseError,'ROLLED_BACK'): ecs.healthy('identity-api','new')

    def test_log_delivery_delay_does_not_replay_migration(self):
        aws=FakeAWS(); aws.call=lambda *a,**k:{'events':[]}
        ecs=b.ECS(aws,FakeLease())
        with patch.object(aws,'call',side_effect=[c.ReleaseError('AWS_ResourceNotFoundException'),{'events':[]},{'events':[{'message':'0 pending migration(s)'}]}]),patch.object(b.time,'sleep'):
            self.assertEqual(len(ecs.migration_logs('task/id')),1)
        # A split delivery shows the count before every plan line; keep reading until all arrive.
        partial=[{'message':'2 pending migration(s)'},{'message':'0099_a.sql '+'a'*64}]
        with patch.object(aws,'call',side_effect=[{'events':partial},{'events':partial+[{'message':'0100_b.sql '+'b'*64}]}]),patch.object(b.time,'sleep'):
            self.assertEqual(len(ecs.migration_logs('task/id')),3)

    def test_schema_plan_dry_run_apply_and_final_plan_use_distinct_tasks(self):
        task={'family':'hid-staging-database-migration','networkMode':'awsvpc','runtimePlatform':{'cpuArchitecture':'ARM64'},
            'taskRoleArn':'arn:aws:iam::'+c.ACCOUNT+':role/hid-staging-task',
            'executionRoleArn':'arn:aws:iam::'+c.ACCOUNT+':role/hid-staging-exec',
            'containerDefinitions':[{'name':'database-migration','image':image('database-migration')}],
            'taskDefinitionArn':index()['migration_task_definition']}
        starts=[]
        class AWS:
            def call(self,service,operation,args,**kwargs):
                if operation=='register-task-definition': return {'taskDefinition':{**args,'taskDefinitionArn':task['taskDefinitionArn']}}
                if operation=='run-task':
                    starts.append(args); return {'tasks':[{'taskArn':'task/'+str(len(starts))}]}
                if operation=='describe-tasks': return {'tasks':[{'lastStatus':'STOPPED','containers':[{'exitCode':0}]}]}
                if operation=='get-log-events': return {'events':[{'message':'0 pending migration(s)'}] if len(starts)==4 else
                    [{'message':'1 pending migration(s)'},{'message':'0099_add.sql '+('a'*64)}]}
                raise AssertionError(operation)
        ecs=b.ECS(AWS(),FakeLease())
        # The declared role bootstrap file is not a migration the plan reports.
        contract={'changed':True,'files':{'services/ehr-api/database/migrations/0099_add.sql':'a'*64,
            c.RUNTIME_GRANTS:'b'*64}}
        with patch.object(ecs,'definition',return_value=task),patch.object(ecs,'protect_image'):
            ecs.migrate(image('database-migration','b'),contract,{'migration_task_definition':task['taskDefinitionArn'],
                'migration_network':index()['migration_network']},'release')
        self.assertEqual(len({r['clientToken'] for r in starts}),4)
        commands=[r['overrides']['containerOverrides'][0]['command'] for r in starts]
        self.assertEqual(commands,[['scripts/apply-migrations.mjs','--plan'],['scripts/apply-migrations.mjs','--dry-run'],
            ['scripts/apply-migrations.mjs'],['scripts/apply-migrations.mjs','--plan']])
        # A plan whose bytes differ from the declaration, or a declaration that is not reviewed, applies nothing.
        for changed in ({**contract,'files':{**contract['files'],'services/ehr-api/database/migrations/0099_add.sql':'c'*64}},
                        {'changed':False}):
            starts.clear()
            with patch.object(ecs,'definition',return_value=task),patch.object(ecs,'protect_image'):
                with self.assertRaisesRegex(c.ReleaseError,'UNREVIEWED_PENDING_MIGRATIONS'):
                    ecs.migrate(image('database-migration','b'),changed,{'migration_task_definition':task['taskDefinitionArn'],
                        'migration_network':index()['migration_network']},'release')
            self.assertEqual(len(starts),1)

if __name__=='__main__': unittest.main()
