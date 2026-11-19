import contextlib
import copy
import io
import json
import os
import pathlib
import re
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import production_deployment_core as c
import production_deployment as b
from test_production_deployment_core import ctx, image, index


class FakeAWS:
    def account(self): pass


class FakeLease:
    def __init__(self,*args,**kwargs): self.released=None; self.reads=0
    def acquire(self): return self
    def assert_owned(self): self.reads+=1
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

    def execute(self, failure=False, alert_failure=False, loss=False, components=('identity-api',), waves=None,
                events=None, pending_before=0, output=None):
        baseline=index(); state={n:brow.copy() for n,brow in baseline['backend'].items()}
        physical=lambda:{n:{k:r[k] for k in ('image_uri','task_definition','config_sha256')} for n,r in state.items()}
        objects={c.INDEX_KEY:copy.deepcopy(baseline)}; calls=[]; lease=FakeLease()
        events=[] if events is None else events
        class FakeStore:
            def __init__(self,*args): pass
            def read(self,key,version=None): return copy.deepcopy(objects[key]),{'ETag':'prior','VersionId':'v1'}
            def put(self,key,value,etag=None):
                if '/intent-' in key: events.append(('intent',value['component']))
                objects[key]=copy.deepcopy(value); return {'ETag':'next','VersionId':'v2'}
        class FakeECS:
            def __init__(self,*args): self.migration_checks=None
            def snapshot(self): return physical()
            def prepare(self,targets):
                events.append(('prepare',list(targets)))
                return {name:{'family':name} for name in targets},len(targets)+1
            def register_prepared(self,name,payload):
                assert payload=={'family':name}
                events.append(('register',name)); return baseline['backend'][name]['task_definition'][:-1]+'2'
            def migrate(self,uri,contract,settings,release_id):
                events.append(('migrate',None))
                self.migration_checks=({'pending_before':0,'plan_after':'skipped','reason':b.SKIPPED_PLAN_AFTER,'tasks':1}
                    if not pending_before else {'pending_before':pending_before,'plan_after':'ran','tasks':4})
                return baseline['migration_task_definition'][:-1]+'2'
            def update(self,name,arn):
                calls.append((name,arn)); state[name]['task_definition']=arn
                state[name]['image_uri']=image(name,'b' if arn.endswith(':2') else 'a')
                if arn.endswith(':2') and failure:
                    if loss: lease.assert_owned=lambda:c.require(False,'LEASE_LOST')
                    raise c.ReleaseError('HEALTH_CHECK_FAILED')
                lease.assert_owned()
            def update_all(self,targets):
                events.append(('update_all',list(targets)))
                if waves is not None: waves.append(list(targets))
                for name,arn in targets.items(): self.update(name,arn)
            def definition(self,arn): return {'containerDefinitions':[{'name':'database-migration','image':image('database-migration')}]}
        candidate=c.make_candidate(ctx(),list(components),{n:{'image_uri':image(n,'b'), 'publication_sha256':'d'*64} for n in components},{'select':'success'})
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder); c.atomic_json(root/'release/candidate.json',candidate)
            env={'EXPECTED_CANDIDATE_SHA256':c.file_sha(root/'release/candidate.json'),
                 'RELEASE_CONFIG_JSON':json.dumps({'account':c.ACCOUNT,'region':c.REGION,'migration_network':baseline['migration_network']})}
            with patch.dict(os.environ,env),patch.multiple(b,ROOT=root,AWS=FakeAWS,Store=FakeStore,
                    ECS=FakeECS,Lease=lambda *args:lease,context=lambda kind:ctx()),patch.object(b,'GitHub',autospec=True) as gh,patch.object(b,'notify') as notify,\
                    contextlib.redirect_stdout(output if output is not None else io.StringIO()):
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

    def test_services_roll_out_together_and_the_gateway_after_them(self):
        waves=[]
        baseline,state,objects,calls,lease=self.execute(components=('gateway','ehr-api','identity-api'),waves=waves)
        self.assertEqual(waves,[['identity-api','ehr-api'],['gateway']]); self.assertTrue(lease.released)
        self.assertTrue(all(state[n]['task_definition'].endswith(':2') for n in ('gateway','ehr-api','identity-api')))
        self.assertEqual(state['lab-api'],baseline['backend']['lab-api'])

    def test_a_failed_wave_restores_every_service_it_started(self):
        waves=[]
        baseline,state,objects,calls,lease=self.execute(failure=True,components=('ehr-api','identity-api'),waves=waves)
        self.assertEqual(waves[0],['identity-api','ehr-api']); self.assertEqual(state,baseline['backend'])
        self.assertEqual(waves[-1],['ehr-api','identity-api']); self.assertTrue(lease.released)

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

    def test_update_all_starts_every_rollout_before_waiting_for_any(self):
        class RecordingAWS(FakeAWS):
            def __init__(self): self.calls=[]
            def call(self,service,operation,body,mutation=False): self.calls.append((operation,body['service'])); return {}
        aws=RecordingAWS(); ecs=b.ECS(aws,FakeLease()); looks=[]
        answers={'identity-api':[None,('service','definition')],'ehr-api':[('service','definition')]}
        def look(component,expected,seen):
            looks.append(component); return answers[component].pop(0),True
        with patch.object(ecs,'look',side_effect=look),patch.object(b.time,'sleep') as sleep:
            ecs.update_all({'identity-api':'arn:identity:2','ehr-api':'arn:ehr:2'})
        self.assertEqual(aws.calls,[('update-service','hid-production-identity-api'),('update-service','hid-production-ehr-api')])
        self.assertEqual(sorted(looks[:2]),['ehr-api','identity-api']); self.assertEqual(looks[2:],['identity-api'])
        self.assertEqual(sleep.call_count,1)

    def test_update_all_times_out_while_any_rollout_is_unhealthy(self):
        class QuietAWS(FakeAWS):
            def call(self,*args,**kwargs): return {}
        ecs=b.ECS(QuietAWS(),FakeLease())
        clock=iter([0,0,1000])
        with patch.object(ecs,'look',side_effect=lambda component,expected,seen:(None,seen)),patch.object(b.time,'sleep'),\
                patch.object(b.time,'monotonic',side_effect=lambda:next(clock)):
            with self.assertRaisesRegex(c.ReleaseError,'ECS_HEALTH_TIMEOUT'): ecs.update_all({'identity-api':'arn:1'})

    def test_every_sweep_looks_at_every_pending_service_with_one_lease_read(self):
        class QuietAWS(FakeAWS):
            def __init__(self): self.mutations=[]
            def call(self,service,operation,body,mutation=False): self.mutations.append((operation,mutation)); return {}
        lease=FakeLease(); aws=QuietAWS(); ecs=b.ECS(aws,lease); sweeps=[]; lock=threading.Lock()
        # identity-api settles on sweep 1, ehr-api on sweep 2, lab-api on sweep 3.
        settles={'identity-api':1,'ehr-api':2,'lab-api':3}; looked={n:0 for n in settles}
        def look(component,expected,seen):
            with lock:
                looked[component]+=1
                if len(sweeps)<looked[component]: sweeps.append(set())
                sweeps[looked[component]-1].add(component)
            self.assertEqual(expected,'arn:'+component)
            return (('service','definition') if looked[component]>=settles[component] else None),True
        with patch.object(ecs,'look',side_effect=look),patch.object(b.time,'sleep') as sleep:
            ecs.update_all({n:'arn:'+n for n in settles})
        self.assertEqual(sweeps,[{'identity-api','ehr-api','lab-api'},{'ehr-api','lab-api'},{'lab-api'}])
        self.assertEqual(aws.mutations,[('update-service',True)]*3)
        # One lease read before each update-service, then one per sweep (not one per service per sweep).
        self.assertEqual(lease.reads,3+3)
        self.assertEqual([call.args for call in sleep.call_args_list],[(b.ROLLOUT_POLL_SECONDS,)]*2)
        self.assertEqual(b.ROLLOUT_POLL_SECONDS,5)

    def test_a_failing_look_in_a_sweep_fails_the_rollout(self):
        ecs=b.ECS(type('Quiet',(FakeAWS,),{'call':lambda self,*a,**k:{}})(),FakeLease())
        def look(component,expected,seen):
            if component=='ehr-api': raise c.ReleaseError('ECS_ROLLED_BACK_TO_DIFFERENT_REVISION')
            return None,seen
        with patch.object(ecs,'look',side_effect=look),patch.object(b.time,'sleep'):
            with self.assertRaisesRegex(c.ReleaseError,'ECS_ROLLED_BACK_TO_DIFFERENT_REVISION'):
                ecs.update_all({'identity-api':'arn:1','ehr-api':'arn:2','lab-api':'arn:3'})

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

class LiveAWS(FakeAWS):
    """A read-only fake of the 12 live services: every call answers from a fixed per-service table."""
    prefix='arn:aws:ecs:'+c.REGION+':'+c.ACCOUNT

    def __init__(self, broken=(), delay=0.002):
        self.broken, self.delay, self.lock = dict(broken), delay, threading.Lock()
        self.calls=[]; self.inflight=0; self.peak=0

    def task(self, n): return self.prefix+':task-definition/hid-production-'+n+':7'

    def definition(self, n):
        containers=[{'name':n,'image':image(n),'healthCheck':{'command':['CMD','true']},'cpu':256}]
        if n!='gateway': containers.append({'name':'workload-token-agent','image':image('identity-api','e')})
        return {'family':'hid-production-'+n,'networkMode':'awsvpc','runtimePlatform':{'cpuArchitecture':'ARM64'},
            'taskRoleArn':'arn:aws:iam::'+c.ACCOUNT+':role/hid-staging-task',
            'executionRoleArn':'arn:aws:iam::'+c.ACCOUNT+':role/hid-staging-exec','containerDefinitions':containers}

    def answer(self, operation, body):
        if operation=='describe-services':
            n=body['services'][0].removeprefix('hid-production-')
            if self.broken.get(n)=='missing': return {'failures':[{'reason':'MISSING'}],'services':[]}
            return {'services':[{'serviceArn':self.prefix+':service/'+c.CLUSTER+'/hid-production-'+n,'status':'ACTIVE',
                'serviceName':'hid-production-'+n,'taskDefinition':self.task(n),'desiredCount':1,'runningCount':1,
                'pendingCount':0,'deployments':[{'rolloutState':'COMPLETED'}],
                'serviceRegistries':[{'registryArn':'arn:aws:servicediscovery:'+c.REGION+':'+c.ACCOUNT+':service/srv-'+n}],
                'loadBalancers':[{'targetGroupArn':'tg-'+n}]}]}
        if operation=='list-tasks': return {'taskArns':['task/'+body['serviceName']]}
        if operation=='describe-tasks':
            n=body['tasks'][0].removeprefix('task/hid-production-')
            return {'tasks':[{'taskDefinitionArn':self.task(n),'lastStatus':'RUNNING',
                'containers':[{'name':n,'image':image(n),'healthStatus':'HEALTHY'}],
                'attachments':[{'details':[{'name':'privateIPv4Address','value':'10.0.0.'+str(c.COMPONENTS.index(n))}]}]}]}
        if operation=='describe-task-definition':
            return {'taskDefinition':self.definition(body['taskDefinition'].rsplit('/',1)[1].removeprefix('hid-production-').rsplit(':',1)[0])}
        if operation=='list-instances':
            n=body['ServiceId'].removeprefix('srv-')
            return {'Instances':[{'Attributes':{'AWS_INSTANCE_IPV4':'10.0.0.'+str(c.COMPONENTS.index(n))}}]}
        if operation=='describe-target-health':
            n=body['TargetGroupArn'].removeprefix('tg-')
            return {'TargetHealthDescriptions':[{'TargetHealth':{'State':'unhealthy' if self.broken.get(n)=='unhealthy' else 'healthy'}}]}
        raise AssertionError(operation)

    def call(self, service, operation, body=None, mutation=False):
        assert not mutation
        with self.lock:
            self.calls.append(operation); self.inflight+=1; self.peak=max(self.peak,self.inflight)
        try:
            if self.delay: time.sleep(self.delay)
            return self.answer(operation, body)
        finally:
            with self.lock: self.inflight-=1


class ParallelReadTests(unittest.TestCase):
    def serial_snapshot(self, ecs):
        # The controller's previous algorithm: one service after another, through healthy().
        result={}
        for n in c.COMPONENTS:
            service=ecs.service(n)
            service,definition=ecs.healthy(n,service['taskDefinition'],deadline=30)
            container=next(x for x in definition['containerDefinitions'] if x['name']==n)
            result[n]={'image_uri':container['image'],'task_definition':service['taskDefinition'],
                'config_sha256':c.task_config_hash(definition,n)}
        return result

    def test_parallel_snapshot_matches_serial_with_one_describe_and_one_lease_read(self):
        serial_aws=LiveAWS(delay=0); serial=self.serial_snapshot(b.ECS(serial_aws,FakeLease()))
        aws=LiveAWS(); lease=FakeLease(); ecs=b.ECS(aws,lease)
        result=ecs.snapshot()
        self.assertEqual(result,serial); self.assertEqual(list(result),list(c.COMPONENTS))
        self.assertEqual(lease.reads,1)
        # The duplicate describe-services is gone; every other check is still made for all 12 services.
        self.assertEqual(serial_aws.calls.count('describe-services'),24); self.assertEqual(aws.calls.count('describe-services'),12)
        for operation in ('list-tasks','describe-tasks','describe-task-definition','list-instances','describe-target-health'):
            self.assertEqual(aws.calls.count(operation),12,operation)
        self.assertGreater(aws.peak,1); self.assertLessEqual(aws.peak,b.READ_POOL)

    def test_snapshot_fails_when_any_one_service_fails(self):
        for broken,code in (({'support-api':'unhealthy'},'LOAD_BALANCER_NOT_HEALTHY'),({'ocr-api':'missing'},'STAGING_SERVICE_MISSING'),
                            # Two failures: the error is the one of the service first in order, as with a serial snapshot.
                            ({'gateway':'missing','ehr-api':'unhealthy'},'LOAD_BALANCER_NOT_HEALTHY')):
            with self.subTest(broken=broken):
                with self.assertRaisesRegex(c.ReleaseError,code): b.ECS(LiveAWS(broken),FakeLease()).snapshot()
                with self.assertRaisesRegex(c.ReleaseError,code): self.serial_snapshot(b.ECS(LiveAWS(broken,delay=0),FakeLease()))

    def test_snapshot_still_waits_for_an_unsettled_service_then_times_out(self):
        aws=LiveAWS(delay=0); ecs=b.ECS(aws,FakeLease())
        unsettled=lambda component,expected,seen,service=None:(None,True)
        clock=iter([0,0,10,20,30])
        with patch.object(ecs,'look',side_effect=unsettled),patch.object(b.time,'sleep') as sleep,\
                patch.object(b.time,'monotonic',side_effect=lambda:next(clock)):
            with self.assertRaisesRegex(c.ReleaseError,'ECS_HEALTH_TIMEOUT'): ecs.current('identity-api')
        self.assertEqual(sleep.call_count,3)

    def test_parallel_returns_in_order_and_waits_for_started_work_before_raising(self):
        finished=[]
        def work(n):
            if n==2: raise c.ReleaseError('SECOND')
            time.sleep(0.01); finished.append(n); return n*10
        self.assertEqual(b.parallel(lambda n:n*10,range(9),4),[n*10 for n in range(9)])
        with self.assertRaisesRegex(c.ReleaseError,'SECOND'): b.parallel(work,[0,1,2,3],4)
        self.assertEqual(sorted(finished),[0,1,3])

    def test_prepare_protects_each_image_once_before_any_registration(self):
        aws=LiveAWS(delay=0); lease=FakeLease(); ecs=b.ECS(aws,lease); protected=[]; lock=threading.Lock()
        def protect(component,uri):
            with lock: protected.append((component,uri))
        targets={n:image(n,'b') for n in ('identity-api','ehr-api','lab-api')}
        with patch.object(ecs,'protect_image',side_effect=protect):
            payloads,count=ecs.prepare(targets)
        expected={(n,image(n,'b')) for n in targets}|{(n,image(n)) for n in targets}|{('identity-api',image('identity-api','e'))}
        self.assertEqual(sorted(protected),sorted(expected)); self.assertEqual(count,len(expected))
        self.assertEqual(list(payloads),list(targets))
        for n,payload in payloads.items():
            self.assertEqual(payload,c.task_payload(aws.definition(n),n,targets[n]))
        self.assertNotIn('register-task-definition',aws.calls)
        # A failure protecting any image fails the wave before anything is registered.
        with patch.object(ecs,'protect_image',side_effect=c.ReleaseError('ROLLBACK_IMAGE_UNAVAILABLE')):
            with self.assertRaisesRegex(c.ReleaseError,'ROLLBACK_IMAGE_UNAVAILABLE'): ecs.prepare(targets)

    def test_protect_pool_is_small(self):
        self.assertLessEqual(b.PROTECT_POOL,4); self.assertTrue(6<=b.READ_POOL<=8)


class MigrationPlanTests(unittest.TestCase):
    def migrate(self, pending_before):
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
                    starts.append(args['overrides']['containerOverrides'][0]['command']); return {'tasks':[{'taskArn':'task/'+str(len(starts))}]}
                if operation=='describe-tasks': return {'tasks':[{'lastStatus':'STOPPED','containers':[{'exitCode':0}]}]}
                if operation=='get-log-events':
                    if len(starts)==1 and pending_before: return {'events':[{'message':'1 pending migration(s)'},{'message':'0099_add.sql '+'a'*64}]}
                    return {'events':[{'message':'0 pending migration(s)'}]}
                raise AssertionError(operation)
        ecs=b.ECS(AWS(),FakeLease())
        contract={'changed':True,'files':{'services/ehr-api/database/migrations/0099_add.sql':'a'*64}}
        with patch.object(ecs,'definition',return_value=task),patch.object(ecs,'protect_image'):
            ecs.migrate(image('database-migration','b'),contract,{'migration_task_definition':task['taskDefinitionArn'],
                'migration_network':index()['migration_network']},'release')
        return starts,ecs.migration_checks

    def test_plan_after_is_skipped_only_when_plan_before_found_nothing_pending(self):
        starts,checks=self.migrate(0)
        self.assertEqual(starts,[['scripts/apply-migrations.mjs','--plan']])
        self.assertEqual(checks,{'pending_before':0,'plan_after':'skipped','reason':'PLAN_BEFORE_FOUND_ZERO_PENDING','tasks':1})
        starts,checks=self.migrate(1)
        self.assertEqual(starts[-1],['scripts/apply-migrations.mjs','--plan']); self.assertEqual(len(starts),4)
        self.assertEqual(checks,{'pending_before':1,'plan_after':'ran','tasks':4})


class DeployPhaseTests(unittest.TestCase):
    execute=BackendControllerTests.execute
    LINE=re.compile(r'deploy-phase \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ phase=([a-z-]+) phase_s=\d+\.\d elapsed_s=\d+\.\d( [a-z_]+=\d+)*')

    def phase_lines(self, output):
        return [line for line in output.getvalue().splitlines() if line.startswith('deploy-phase ')]

    def test_registration_keeps_register_intent_order_per_service_before_rollout(self):
        events=[]
        self.execute(components=('gateway','ehr-api','identity-api','database-migration'),events=events)
        self.assertEqual(events,[('migrate',None),('prepare',['identity-api','ehr-api']),
            ('register','identity-api'),('intent','identity-api'),('register','ehr-api'),('intent','ehr-api'),
            ('update_all',['identity-api','ehr-api']),
            ('prepare',['gateway']),('register','gateway'),('intent','gateway'),('update_all',['gateway'])])

    def test_skipped_plan_after_is_recorded_in_the_receipt_and_log(self):
        output=io.StringIO()
        baseline,state,objects,calls,lease=self.execute(components=('identity-api','database-migration'),output=output)
        receipt=next(v for k,v in objects.items() if k.endswith('/complete.json'))
        self.assertEqual(receipt['migration_checks'],{'pending_before':0,'plan_after':'skipped',
            'reason':'PLAN_BEFORE_FOUND_ZERO_PENDING','tasks':1})
        self.assertIn('"migration_plan_after": "skipped", "reason": "PLAN_BEFORE_FOUND_ZERO_PENDING"',output.getvalue())
        self.assertIn(' phase=migration ',output.getvalue())
        output=io.StringIO()
        baseline,state,objects,calls,lease=self.execute(components=('identity-api','database-migration'),pending_before=2,output=output)
        receipt=next(v for k,v in objects.items() if k.endswith('/complete.json'))
        self.assertEqual(receipt['migration_checks']['plan_after'],'ran'); self.assertNotIn('migration_plan_after',output.getvalue())
        # Releases without the migration runner carry no migration record.
        baseline,state,objects,calls,lease=self.execute()
        self.assertNotIn('migration_checks',next(v for k,v in objects.items() if k.endswith('/complete.json')))

    def test_phase_lines_carry_only_names_seconds_and_counts(self):
        for kwargs in ({'components':('gateway','ehr-api','identity-api','database-migration')},{'failure':True}):
            output=io.StringIO()
            self.execute(output=output,**kwargs)
            lines=self.phase_lines(output)
            self.assertTrue(lines)
            for line in lines:
                self.assertRegex(line,'^'+self.LINE.pattern+'$')
                # No release id, account, image, digest, ARN, component or other free text.
                for forbidden in (c.ACCOUNT,'sha256','arn:','backend-','-api','=gateway','@','/'):
                    self.assertNotIn(forbidden,line)
            names=[self.LINE.match(line).group(1) for line in lines]
            self.assertTrue(set(names)<=b.PHASES)
            if kwargs.get('failure'): self.assertIn('rollback-snapshot',names)
            else: self.assertEqual(names,['approval','lease','snapshot-before','receipt-started','migration','register-services',
                'rollout-services','register-gateway','rollout-gateway','snapshot-after','index-and-receipt','notify'])

    def test_phase_marks_refuse_free_text(self):
        written=[]; phases=b.Phases(out=lambda line,flush:written.append(line))
        for bad in ({'phase':'patient Ada'},{'phase':'lease','note':'text'},{'phase':'lease','count':1.5},{'phase':'lease','Bad':1}):
            phase=bad.pop('phase')
            with self.assertRaisesRegex(c.ReleaseError,'UNKNOWN_PHASE|PHASE_COUNTS_ONLY'): phases.mark(phase,**bad)
        self.assertEqual(written,[])
        phases.mark('lease',services=12); self.assertRegex(written[0],r' phase=lease .* services=12$')
        # A failed write never fails the release.
        b.Phases(out=lambda line,flush:(_ for _ in ()).throw(OSError('closed'))).mark('lease')


if __name__=='__main__': unittest.main()
