"""Operator bootstrap and conservative abandoned-lease recovery. No actions on import.

Bootstrap records observed live versions, never deploys them. A human-supplied
origin-secret version attestation is necessary because Cloudflare masks secrets.
Recovery only unlocks an expired, stopped holder when live state still agrees
with the verified index. Partial/uncertain rollouts require operator restoration.
"""
import argparse
import json
import os
import re
import time
import urllib.error
import urllib.request
from deployment_core import (ACCOUNT, REGION, INDEX_KEY, AWS, GitHub, Lease, ReleaseError,
    Store, TARGETS, canonical, require, retain_image, sha, validate_index)
from release_infrastructure import live_backend, physical, terraform

HOSTS={'admin':'admin.staging.healthidentitydirectory.com','web':'staging.healthidentitydirectory.com',
    'ehr':'ehr.staging.healthidentitydirectory.com','lab':'lab.staging.healthidentitydirectory.com',
    'pharmacy':'pharmacy.staging.healthidentitydirectory.com','ocr':'migrate.staging.healthidentitydirectory.com',
    'outreach':'outreach.staging.healthidentitydirectory.com','public':'www.staging.healthidentitydirectory.com'}


def cloud_read(suffix):
    account=os.environ.get('CLOUDFLARE_ACCOUNT_ID',''); token=os.environ.get('CLOUDFLARE_API_TOKEN','')
    require(re.fullmatch(r'[a-f0-9]{32}',account) and token,'NONINTERACTIVE_CLOUDFLARE_CREDENTIALS_REQUIRED')
    request=urllib.request.Request('https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/'+suffix,
        headers={'Authorization':'Bearer '+token})
    try:
        with urllib.request.urlopen(request,timeout=30) as response: body=json.load(response)
    except (urllib.error.URLError,urllib.error.HTTPError): raise ReleaseError('WORKER_INVENTORY_UNAVAILABLE') from None
    require(body.get('success') is True,'WORKER_INVENTORY_UNAVAILABLE')
    return body['result']


def live_workers():
    result={}
    domains={r['hostname']:r.get('service') for r in cloud_read('domains')}
    for app,host in HOSTS.items():
        require(domains.get(host)=='hid-'+app+'-staging','WORKER_DOMAIN_DIFFERS')
        rows=cloud_read('scripts/hid-'+app+'-staging/deployments')
        rows=rows.get('deployments',[]) if isinstance(rows,dict) else rows
        require(rows and len(rows[0].get('versions',[]))==1 and rows[0]['versions'][0]['percentage']==100,
            'SINGLE_LIVE_WORKER_VERSION_REQUIRED')
        version=rows[0]['versions'][0]['version_id']
        require(re.fullmatch(r'[a-f0-9-]{36}',version),'EXACT_WORKER_VERSION_REQUIRED')
        details=cloud_read('scripts/hid-'+app+'-staging/versions/'+version)
        require(any(b.get('name')=='ORIGIN_AUTH_TOKEN' and b.get('type')=='secret_text'
            for b in details.get('resources',{}).get('bindings',[])),'WORKER_ORIGIN_BINDING_REQUIRED')
        result[app]={'hostname':host,'version_id':version}
    return result


def bootstrap(origin_version):
    aws=AWS(); aws.account(); store=Store(aws)
    lease=Lease(aws,'bootstrap-'+__import__('uuid').uuid4().hex).acquire()
    safe=True
    try:
        origin=aws.call('secretsmanager','describe-secret',{'SecretId':'/hid/staging/cloudflare-origin'})
        versions=[v for v,labels in origin.get('VersionIdsToStages',{}).items() if 'AWSCURRENT' in labels]
        require(versions==[origin_version],'EXPLICIT_CURRENT_ORIGIN_VERSION_ATTESTATION_REQUIRED')
        backend=live_backend(aws); frontend=live_workers()
        configuration=terraform('output','-json','deployment_automation_configuration',output=True)
        migration=configuration['migration_task_definition']
        task=aws.call('ecs','describe-task-definition',{'taskDefinition':migration})['taskDefinition']
        value={'schema':'hid.staging-index/v1','account':ACCOUNT,'region':REGION,'environment':'staging','verified':True,
            'backend':backend,'frontend':{app:{**row,'origin_secret_version_id':origin_version,
                'bootstrap_origin_version_attested':True} for app,row in frontend.items()},
            'migration_task_definition':migration,'migration_network':configuration['migration_network'],
            'migration_image_uri':next(c['image'] for c in task['containerDefinitions'] if c['name']=='database-migration')}
        validate_index(value)
        require(backend==live_backend(aws) and frontend==live_workers(),'BOOTSTRAP_LIVE_STATE_CHANGED')
        # Protect every initial live digest, including token agents and the schema runner.
        for name,row in backend.items():
            retain_image(aws,lease,name,row['image_uri'])
            definition=aws.call('ecs','describe-task-definition',{'taskDefinition':row['task_definition']})['taskDefinition']
            for container in definition['containerDefinitions']:
                if container['name']=='workload-token-agent': retain_image(aws,lease,'identity-api',container['image'])
        retain_image(aws,lease,'database-migration',value['migration_image_uri'])
        lease.assert_owned(); safe=False
        # IfNoneMatch prevents replacing an existing release index.
        meta=store.put(INDEX_KEY,value)
        safe=True
        print(json.dumps({'status':'bootstrapped','version_id':meta['VersionId'],'sha256':sha(canonical(value)),
            'backend_count':len(backend),'worker_count':len(frontend),'source_provenance':'unknown until first admitted release'}))
    finally: lease.release(reconciled=safe)


def recovery_review(aws,store):
    item=aws.call('dynamodb','get-item',{'TableName':'hid-staging-deployment-leases',
        'Key':{'environment':{'S':'hid-staging'}},'ConsistentRead':True}).get('Item',{})
    holder=item.get('holder',{}).get('S'); generation=item.get('generation',{}).get('N')
    require(holder and generation and int(item.get('expires_at',{}).get('N','0')) < time.time(),'EXPIRED_LEASE_REQUIRED')
    value,meta=store.read(INDEX_KEY); validate_index(value)
    require(live_backend(aws)=={n:physical(r) for n,r in value['backend'].items()},'PARTIAL_BACKEND_REQUIRES_RESTORATION')
    require(live_workers()=={n:{k:r[k] for k in ('hostname','version_id')} for n,r in value['frontend'].items()},
        'PARTIAL_WORKER_ROLLOUT_REQUIRES_RESTORATION')
    for family in ('hid-staging-database-migration','hid-staging-identity-promotion'):
        running=aws.call('ecs','list-tasks',{'cluster':'hid-staging','family':family,'desiredStatus':'RUNNING'})
        require(not running.get('taskArns'),'MIGRATION_TASK_STILL_RUNNING')
    match=re.fullmatch(r'(backend|frontend)-(\d+)-(\d+)-[a-f0-9]{16}',holder)
    if match:
        run=GitHub(TARGETS[match[1]]['repo']).get('actions/runs/'+match[2])
        require(run.get('status')=='completed','WORKFLOW_STILL_RUNNING')
    return {'schema':'hid.lease-recovery/v1','holder':holder,'generation':generation,
        'index_version_id':meta['VersionId'],'index_sha256':sha(canonical(value)),'github_holder':bool(match)}


def recover(accepted, stopped):
    aws=AWS(); aws.account(); store=Store(aws)
    review=recovery_review(aws,store); digest=sha(canonical(review))
    if not accepted:
        print(json.dumps({**review,'review_sha256':digest})); return
    require(accepted==digest and stopped==review['holder'],'EXACT_STOPPED_HOLDER_AND_REVIEW_REQUIRED')
    # Repeat readback immediately before unlocking; conditional generation prevents a race.
    require(recovery_review(aws,store)==review,'RECOVERY_STATE_CHANGED')
    aws.call('dynamodb','update-item',{'TableName':'hid-staging-deployment-leases','Key':{'environment':{'S':'hid-staging'}},
        'UpdateExpression':'REMOVE holder, expires_at SET #s = :ready',
        'ConditionExpression':'holder = :h AND generation = :g AND expires_at < :now',
        'ExpressionAttributeNames':{'#s':'status'},'ExpressionAttributeValues':{':h':{'S':review['holder']},
            ':g':{'N':review['generation']},':now':{'N':str(int(time.time()))},':ready':{'S':'ready'}}},mutation=True)
    print(json.dumps({'status':'reconciled-and-unlocked','generation':review['generation']}))


if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('mode',choices=['bootstrap','recovery-review','recover'])
    parser.add_argument('--confirmed-origin-version'); parser.add_argument('--accepted-review-sha256'); parser.add_argument('--confirm-holder-stopped')
    args=parser.parse_args()
    try:
        if args.mode=='bootstrap': bootstrap(args.confirmed_origin_version)
        else: recover(args.accepted_review_sha256 if args.mode=='recover' else None,args.confirm_holder_stopped)
    except ReleaseError as error:
        print(json.dumps({'status':'failed','code':str(error)})); raise SystemExit(1)
