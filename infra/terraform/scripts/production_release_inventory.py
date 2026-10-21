"""Prepare and initialize the retained production release index, never deploy apps.

Requires healthy production runtime/Workers, verified protection, an explicit
origin-version attestation and an accepted fresh inventory hash. No staging
baseline is relabeled as production. Existing indexes are never overwritten.
"""
import argparse
import copy
import datetime
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
import zipfile
from production_deployment_core import (ACCOUNT,REGION,CLUSTER,COMPONENTS,INDEX_KEY,AWS,Lease,Store,
    ReleaseError,atomic_json,canonical,file_sha,image,require,sha,task_config_hash,validate_index)
import configure_production_environments as gates

HOSTS={'admin':'admin.healthidentitydirectory.com','web':'app.healthidentitydirectory.com',
       'ehr':'ehr.healthidentitydirectory.com','lab':'lab.healthidentitydirectory.com',
       'pharmacy':'pharmacy.healthidentitydirectory.com','ocr':'migrate.healthidentitydirectory.com',
       'outreach':'outreach.healthidentitydirectory.com','public':'healthidentitydirectory.com'}
PROFILED_SERVICES={'identity-api','ehr-api','lab-api','pharmacy-api','ocr-api','outreach-api','notification-api'}

class Frontends:
    """Verify current CI archives and reuse the published exact-byte HTTP checks."""
    def __init__(self,checkout,artifact,run_id,apps=None,repository='D-Eminence/health'):
        self.root=pathlib.Path(checkout).resolve();self.artifact=pathlib.Path(artifact).resolve()
        repositories={'D-Eminence/health':1428636965,'D-Eminence/Health-id':1396718647}
        require(repository in repositories,'UNTRUSTED_BASELINE_FRONTEND_REPOSITORY')
        require(re.fullmatch(r'[1-9][0-9]*',str(run_id)),'EXACT_FRONTEND_BUILD_RUN_REQUIRED')
        git=['git','-c','safe.directory='+self.root.as_posix()]
        head=subprocess.check_output(git+['rev-parse','HEAD'],cwd=self.root,text=True).strip()
        require(subprocess.run(git+['diff','--quiet','HEAD','--','scripts','config','package-lock.json','infra/cloudflare/src'],
                               cwd=self.root,capture_output=True).returncode==0,'CLEAN_FRONTEND_VERIFIER_REQUIRED')
        prefix='repos/'+repository+'/'
        metadata=gates.request(prefix.rstrip('/'))
        require(metadata.get('id')==repositories[repository] and metadata.get('owner',{}).get('id')==182018869,
                'BASELINE_REPOSITORY_IDENTITY_CHANGED')
        run=gates.request(prefix+'actions/runs/'+str(run_id))
        require(run.get('head_sha')==head and run.get('head_branch')=='main'
                and run.get('conclusion')=='success' and run.get('run_attempt')==1
                and run.get('event') in ('push','workflow_dispatch')
                and run.get('path')=='.github/workflows/production-frontends.yml','SUCCESSFUL_FRONTEND_BUILD_REQUIRED')
        # A rollback baseline may legitimately run older sources. The successful
        # run, exact commit and archive digest are verified, not relabeled latest.
        artifacts=gates.request(prefix+'actions/runs/'+str(run_id)+'/artifacts?per_page=100')['artifacts']
        matches=[r for r in artifacts if r.get('name')=='production-frontends-'+head and not r.get('expired')]
        require(len(matches)==1 and matches[0].get('digest')=='sha256:'+file_sha(self.artifact),
                'GITHUB_FRONTEND_ARCHIVE_DIGEST_DIFFERS')
        # The downloaded archive is bound to GitHub before any source verifier is imported.
        with zipfile.ZipFile(self.artifact) as archive:
            require(len(archive.namelist())==10 and set(archive.namelist())=={'manifest.json','worker-preparation.json'}|{a+'.zip' for a in HOSTS}
                    and sum(v.file_size for v in archive.infolist())<200_000_000,'EXACT_FRONTEND_ARTIFACT_CONTENTS_REQUIRED')
            folder=self.root/'build/production';folder.mkdir(parents=True,exist_ok=True)
            for name in archive.namelist():(folder/name).write_bytes(archive.read(name))
        scripts=str(self.root/'scripts');sys.path.insert(0,scripts)
        previous=sys.modules.get('staging_release')
        try:
            # Operator inventory helpers can already have imported another checkout.
            # Load this checkout's pure archive verifier explicitly, not from cache.
            release_spec=importlib.util.spec_from_file_location('staging_release',self.root/'scripts/staging_release.py')
            release_module=importlib.util.module_from_spec(release_spec)
            sys.modules['staging_release']=release_module;release_spec.loader.exec_module(release_module)
            spec=importlib.util.spec_from_file_location('bootstrap_frontend_verifier',self.root/'scripts/deploy-production-workers.py')
            self.verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.verifier)
            self.manifest=json.loads((folder/'manifest.json').read_bytes())
            entries=self.verifier.verify_manifest(self.manifest,folder,head,self.root/'config/production.json',
                self.root/'package-lock.json',self.root/'infra/cloudflare/src',environment='production')
        finally:
            sys.path.remove(scripts)
            if previous is None:sys.modules.pop('staging_release',None)
            else:sys.modules['staging_release']=previous
        selected=set(HOSTS) if apps is None else set(apps)
        require(bool(selected) and selected<=set(HOSTS) and (apps is None or len(apps)==len(selected)),
                'EXACT_BASELINE_PORTAL_SELECTION_REQUIRED')
        self.entries={row['app']:row for row in entries if row['app'] in selected};self.source=head;self.run_id=str(run_id)
        self.dependencies=json.loads((self.root/'config/production-release-dependencies.json').read_bytes())
        self.fingerprint={'repository':repository,'source_commit':head,'run_id':str(run_id),'apps':sorted(selected),'artifact_sha256':file_sha(self.artifact),
                          'manifest_sha256':file_sha(folder/'manifest.json')}

    def check(self):
        return {app:self.verifier.verify_assets(app,row) for app,row in self.entries.items()}

    def compatibility(self,index):
        self.verifier.assert_dependencies({'backend_dependencies':self.dependencies},index,
            json.loads((self.root/'config/production.json').read_bytes())['backend_contract'])

    def preserve(self,store,lease,frontend):
        result=copy.deepcopy(frontend)
        for app,entry in self.entries.items():
            path=self.root/'build/production'/entry['archive']
            require(file_sha(path)==entry['sha256'],'BOOTSTRAP_ARCHIVE_CHANGED')
            lease.assert_owned()
            archive=store.upload('production/archives/bootstrap-'+self.run_id+'/'+app+'.zip',path)
            result[app].update(source_repository=self.fingerprint['repository'],source_commit=self.source,archive=archive)
        return result

class FrontendSet:
    """Complete per-portal baseline, preserving each admitted historical source."""
    def __init__(self,groups):
        require(bool(groups),'COMPLETE_FRONTEND_BASELINE_REQUIRED')
        self.groups=groups;seen=set();dependencies=None
        for group in groups:
            apps=set(group.entries)
            require(not seen.intersection(apps),'DUPLICATE_BASELINE_PORTAL')
            seen.update(apps)
            # Do not silently replace an old portal's exact backend pins with a
            # newer contract. Conflicts need an explicitly reviewed compatibility
            # decision before bootstrap can admit the existing mixed release.
            if dependencies is None:dependencies=group.dependencies
            require(group.dependencies==dependencies,'BASELINE_DEPENDENCY_CONFLICT_REVIEW_REQUIRED')
        require(seen==set(HOSTS),'COMPLETE_FRONTEND_BASELINE_REQUIRED')
        self.dependencies=dependencies
        self.fingerprint={'groups':[g.fingerprint for g in groups]}
        self.run_id=sha(canonical(self.fingerprint))[:24]

    def check(self):
        result={}
        for group in self.groups:result.update(group.check())
        return result

    def compatibility(self,index):
        for group in self.groups:group.compatibility(index)

    def preserve(self,store,lease,frontend):
        result=copy.deepcopy(frontend)
        for group in self.groups:result=group.preserve(store,lease,result)
        return result

class Cloud:
    def __init__(self):
        self.account=os.environ.get('CLOUDFLARE_ACCOUNT_ID','');self.token=os.environ.get('CLOUDFLARE_API_TOKEN','')
        require(re.fullmatch(r'[a-f0-9]{32}',self.account) and self.token,'CLOUDFLARE_AUTOMATION_CREDENTIALS_REQUIRED')
    def read(self,path):
        request=urllib.request.Request('https://api.cloudflare.com/client/v4/accounts/'+self.account+'/workers/'+path,
            headers={'Authorization':'Bearer '+self.token})
        try:
            with urllib.request.urlopen(request,timeout=30) as response:result=json.load(response)
        except (urllib.error.URLError,urllib.error.HTTPError):raise ReleaseError('PRODUCTION_WORKER_INVENTORY_UNAVAILABLE') from None
        require(result.get('success') is True,'PRODUCTION_WORKER_INVENTORY_UNAVAILABLE')
        return result['result']

def live_workers(cloud):
    domains={r['hostname']:r.get('service') for r in cloud.read('domains')}
    result={}
    for app,host in HOSTS.items():
        name='hid-'+app+'-production'
        require(domains.get(host)==name,'PRODUCTION_WORKER_DOMAIN_NOT_BOOTSTRAPPED:'+app)
        rows=cloud.read('scripts/'+name+'/deployments')
        rows=rows.get('deployments',[]) if isinstance(rows,dict) else rows
        require(rows and len(rows[0].get('versions',[]))==1 and rows[0]['versions'][0].get('percentage')==100,
                'SINGLE_LIVE_PRODUCTION_WORKER_VERSION_REQUIRED')
        version=rows[0]['versions'][0]['version_id']
        require(re.fullmatch(r'[a-f0-9-]{36}',version),'EXACT_PRODUCTION_WORKER_VERSION_REQUIRED')
        details=cloud.read('scripts/'+name+'/versions/'+version)
        bindings=details.get('resources',{}).get('bindings',[])
        require(any(v.get('name')=='ORIGIN_AUTH_TOKEN' and v.get('type')=='secret_text' for v in bindings),
                'PRODUCTION_ORIGIN_BINDING_REQUIRED')
        values={v['name']:v.get('text') for v in bindings if v.get('type')=='plain_text'}
        require(values.get('EXPECTED_HOST')==host and values.get('DEPLOYMENT_ENV')=='production'
                and values.get('API_ORIGIN')=='https://api.healthidentitydirectory.com',
                'PRODUCTION_WORKER_CONFIGURATION_DIFFERS')
        result[app]={'hostname':host,'version_id':version}
    return result

def live_backend(aws):
    result={}
    for component in COMPONENTS:
        body=aws.call('ecs','describe-services',{'cluster':CLUSTER,'services':['hid-production-'+component]})
        require(not body.get('failures') and len(body.get('services',[]))==1,'LIVE_PRODUCTION_SERVICE_MISSING')
        service=body['services'][0]
        require(service.get('status')=='ACTIVE' and service.get('desiredCount')==service.get('runningCount')==1
                and service.get('pendingCount')==0 and len(service.get('deployments',[]))==1
                and service['deployments'][0].get('rolloutState')=='COMPLETED','LIVE_PRODUCTION_SERVICE_UNSETTLED')
        task=aws.call('ecs','describe-task-definition',{'taskDefinition':service['taskDefinition']})['taskDefinition']
        containers=[c for c in task['containerDefinitions'] if c['name']==component]
        require(len(containers)==1,'EXACT_APPLICATION_CONTAINER_REQUIRED')
        values={v['name']:v['value'] for v in containers[0].get('environment',[])}
        # Gateway and background workers have no deployment-profile switch.
        # Their exact admitted images/configurations are still bound below.
        require((component not in PROFILED_SERVICES and 'HID_DEPLOYMENT_ENV' not in values)
                or values.get('HID_DEPLOYMENT_ENV')=='production','STAGING_RUNTIME_CANNOT_BOOTSTRAP_PRODUCTION')
        image(component,containers[0]['image'])
        result[component]={'image_uri':containers[0]['image'],'task_definition':service['taskDefinition'],
                           'config_sha256':task_config_hash(task,component)}
    return result

def attach_sources(backend,publications):
    require(set(publications)==set(COMPONENTS)|{'database-migration'},'COMPLETE_ADMITTED_PUBLICATIONS_REQUIRED')
    result=copy.deepcopy(backend)
    for component,row in publications.items():
        require(re.fullmatch(r'[a-f0-9]{40}',row.get('source_commit',''))
                and re.fullmatch(r'[a-f0-9]{64}',row.get('publication_sha256','')),'VERIFIED_PUBLICATION_PROVENANCE_REQUIRED')
        image(component,row.get('image_uri',''))
        if component in result:
            require(result[component]['image_uri']==row['image_uri'],'LIVE_IMAGE_DIFFERS_FROM_ADMITTED_PUBLICATION')
            result[component].update(source_commit=row['source_commit'],publication_sha256=row['publication_sha256'])
    return result

def collect(aws,cloud,configuration,origin_version,publications):
    require(configuration.get('account')==ACCOUNT and configuration.get('region')==REGION
            and configuration.get('index_key')==INDEX_KEY,'EXACT_PRODUCTION_AUTOMATION_CONFIGURATION_REQUIRED')
    require(re.fullmatch(r'[a-f0-9-]{32,64}',origin_version or ''),'EXPLICIT_ORIGIN_VERSION_ATTESTATION_REQUIRED')
    metadata=aws.call('secretsmanager','describe-secret',{'SecretId':'/hid/staging/cloudflare-origin'})
    current=[v for v,labels in metadata.get('VersionIdsToStages',{}).items() if 'AWSCURRENT' in labels]
    require(current==[origin_version],'ORIGIN_VERSION_CHANGED')
    backend=attach_sources(live_backend(aws),publications)
    frontend=live_workers(cloud)
    migration=configuration['migration_task_definition']
    definition=aws.call('ecs','describe-task-definition',{'taskDefinition':migration})['taskDefinition']
    containers=[c for c in definition['containerDefinitions'] if c['name']=='database-migration']
    require(len(containers)==1 and containers[0]['image']==publications['database-migration']['image_uri'],
            'MIGRATION_RUNNER_DIFFERS_FROM_ADMITTED_PUBLICATION')
    network=configuration['migration_network']
    require(network.get('assignPublicIp')=='DISABLED' and len(network.get('subnets',[]))==2
            and len(network.get('securityGroups',[]))==1,'PRIVATE_MIGRATION_NETWORK_REQUIRED')
    value={'schema':'hid.production-index/v1','environment':'production','verified':True,'account':ACCOUNT,'region':REGION,
           'backend':backend,'frontend':{app:{**row,'origin_secret_version_id':origin_version,
           'bootstrap_origin_version_attested':True} for app,row in frontend.items()},
           'migration_task_definition':migration,'migration_network':network,'migration_image_uri':containers[0]['image']}
    validate_index(value)
    return value

def prepare(aws,cloud,configuration,origin_version,publications,output,frontends=None):
    require(frontends is not None,'VERIFIED_FRONTEND_ARCHIVES_REQUIRED')
    aws.account();gates.run(gates.request,False,configuration.get('approval_mode','protected'))
    value=collect(aws,cloud,configuration,origin_version,publications)
    frontends.compatibility(value)
    checks=frontends.check()
    manifest={'schema':'hid.production-bootstrap-review/v1','created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'configuration_sha256':sha(canonical(configuration)),'publications_sha256':sha(canonical(publications)),
              'origin_version':origin_version,'index':value,'frontend_evidence':frontends.fingerprint,
              'frontend_checks':checks,'deployment_performed':False}
    atomic_json(output,manifest)
    return {'status':'prepared','manifest_sha256':file_sha(output),'deployment_performed':False}

def retain(aws,lease,component,uri):
    image(component,uri)
    repository='staging/hid/'+('ehr-api' if component=='database-migration' else component)
    digest=uri.split('@')[1];tag='retain-'+digest[7:]
    policy=json.loads(aws.call('ecr','get-lifecycle-policy',{'repositoryName':repository})['lifecyclePolicyText'])
    rules=[r for r in policy['rules'] if r['selection'].get('tagPrefixList')==['retain-']]
    require(len(rules)==1 and rules[0].get('rulePriority')==1
            and rules[0]['selection'].get('countType')=='imageCountMoreThan'
            and rules[0]['selection'].get('countNumber',0)>=1000000,'ROLLBACK_RETENTION_POLICY_REQUIRED')
    details=aws.call('ecr','describe-images',{'repositoryName':repository,'imageIds':[{'imageDigest':digest}]})
    require(len(details.get('imageDetails',[]))==1,'ADMITTED_IMAGE_UNAVAILABLE')
    if tag not in details['imageDetails'][0].get('imageTags',[]):
        body=aws.call('ecr','batch-get-image',{'repositoryName':repository,'imageIds':[{'imageDigest':digest}]})
        require(len(body.get('images',[]))==1 and not body.get('failures'),'ROLLBACK_MANIFEST_UNAVAILABLE')
        lease.assert_owned()
        aws.call('ecr','put-image',{'repositoryName':repository,'imageManifest':body['images'][0]['imageManifest'],
                 'imageDigest':digest,'imageTag':tag},mutation=True)
    check=aws.call('ecr','describe-images',{'repositoryName':repository,'imageIds':[{'imageDigest':digest}]})
    require(any(tag in v.get('imageTags',[]) for v in check.get('imageDetails',[])),'ROLLBACK_RETENTION_READBACK_FAILED')

def bootstrap(aws,cloud,configuration,publications,path,accepted_hash,frontends=None):
    require(accepted_hash==file_sha(path),'EXACT_ACCEPTED_BOOTSTRAP_MANIFEST_REQUIRED')
    manifest=json.loads(pathlib.Path(path).read_bytes())
    created=datetime.datetime.fromisoformat(manifest['created_at'])
    require(created.tzinfo and datetime.timedelta(0)<=datetime.datetime.now(datetime.timezone.utc)-created<datetime.timedelta(minutes=20),
            'FRESH_BOOTSTRAP_INVENTORY_REQUIRED')
    require(manifest.get('schema')=='hid.production-bootstrap-review/v1'
            and manifest['configuration_sha256']==sha(canonical(configuration))
            and manifest['publications_sha256']==sha(canonical(publications)),'BOOTSTRAP_INPUTS_CHANGED')
    require(frontends is not None and manifest.get('frontend_evidence')==frontends.fingerprint,
            'VERIFIED_FRONTEND_ARCHIVES_REQUIRED')
    aws.account();gates.run(gates.request,False,configuration.get('approval_mode','protected'))
    store=Store(aws,configuration['release_bucket'],configuration['release_kms_key_arn'])
    lease=Lease(aws,'production-bootstrap-'+uuid.uuid4().hex,table=configuration['lease_table']).acquire()
    reconciled=True
    try:
        actual=collect(aws,cloud,configuration,manifest['origin_version'],publications)
        require(actual==manifest['index'],'BOOTSTRAP_LIVE_STATE_CHANGED')
        frontends.compatibility(actual)
        require(frontends.check()==manifest['frontend_checks'],'BOOTSTRAP_HTTP_HEALTH_CHANGED')
        # Protect the application, migration and unchanged sidecar digests before
        # exposing the baseline to routine deployment. No app service is changed.
        for component,row in publications.items():
            retain(aws,lease,component,row['image_uri'])
        for row in actual['backend'].values():
            task=aws.call('ecs','describe-task-definition',{'taskDefinition':row['task_definition']})['taskDefinition']
            for container in task['containerDefinitions']:
                if container['name']=='workload-token-agent':retain(aws,lease,'identity-api',container['image'])
        require(collect(aws,cloud,configuration,manifest['origin_version'],publications)==actual,
                'BOOTSTRAP_LIVE_STATE_CHANGED_DURING_RETENTION')
        actual['frontend']=frontends.preserve(store,lease,actual['frontend'])
        # Recheck bytes after archive preservation; never call an untested version healthy.
        require(frontends.check()==manifest['frontend_checks'],'BOOTSTRAP_HTTP_HEALTH_CHANGED')
        require(collect(aws,cloud,configuration,manifest['origin_version'],publications)==manifest['index'],
                'BOOTSTRAP_LIVE_STATE_CHANGED_BEFORE_INDEX')
        initial_release='frontend-bootstrap-'+sha(canonical(frontends.fingerprint))[:24]
        actual['frontend_release']=initial_release
        lease.assert_owned()
        store.put('production/releases/'+initial_release+'/complete.json',{
            'schema':'hid.release-receipt/v1','kind':'frontend','status':'success','operation':'bootstrap-inventory',
            'candidate':{'backend_dependencies':frontends.dependencies},'after':actual['frontend'],
            'inventory_manifest_sha256':accepted_hash,'frontend_evidence':frontends.fingerprint,
            'checks':manifest['frontend_checks'],'deployment_performed':False})
        lease.assert_owned();reconciled=False
        result=store.put(INDEX_KEY,actual)
        saved,metadata=store.read(INDEX_KEY,result['VersionId'])
        require(saved==actual,'BOOTSTRAP_INDEX_READBACK_DIFFERS');reconciled=True
        return {'status':'bootstrapped','version_id':metadata['VersionId'],'sha256':sha(canonical(saved)),
                'backend_count':len(actual['backend']),'worker_count':len(actual['frontend']),'deployment_performed':False}
    finally:lease.release(reconciled=reconciled)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['prepare','bootstrap'])
    parser.add_argument('--configuration',required=True);parser.add_argument('--publications',required=True)
    parser.add_argument('--manifest',required=True);parser.add_argument('--confirmed-origin-version');parser.add_argument('--accepted-sha256')
    parser.add_argument('--frontend-checkout');parser.add_argument('--frontend-artifact')
    parser.add_argument('--frontend-run-id');parser.add_argument('--frontend-groups')
    args=parser.parse_args()
    try:
        configuration=json.loads(pathlib.Path(args.configuration).read_bytes())
        publications=json.loads(pathlib.Path(args.publications).read_bytes());aws=AWS();cloud=Cloud()
        if args.frontend_groups:
            require(not any([args.frontend_checkout,args.frontend_artifact,args.frontend_run_id]),'ONE_FRONTEND_BASELINE_INPUT_REQUIRED')
            groups=json.loads(pathlib.Path(args.frontend_groups).read_bytes())
            require(isinstance(groups,list),'FRONTEND_BASELINE_GROUPS_REQUIRED')
            frontends=FrontendSet([Frontends(g['checkout'],g['artifact'],g['run_id'],g['apps'],g['repository']) for g in groups])
        else:
            require(all([args.frontend_checkout,args.frontend_artifact,args.frontend_run_id]),'FRONTEND_BASELINE_INPUTS_REQUIRED')
            frontends=Frontends(args.frontend_checkout,args.frontend_artifact,args.frontend_run_id)
        result=prepare(aws,cloud,configuration,args.confirmed_origin_version,publications,args.manifest,frontends) if args.mode=='prepare' else \
            bootstrap(aws,cloud,configuration,publications,args.manifest,args.accepted_sha256,frontends)
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'status':'blocked','code':str(error) if isinstance(error,(ReleaseError,gates.SetupError)) else type(error).__name__}))
        raise SystemExit(1)
