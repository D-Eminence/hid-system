"""Local/operator Terraform reconciliation using the same staging deployment lease.

Plan releases the lease for human review. Apply acquires a fresh lease, checks the
same index and regenerates a saved plan; managed changes must exactly match the
reviewed fingerprint before that saved plan is applied. No automatic approval.
"""
import argparse
import copy
import json
import pathlib
import subprocess
import tempfile
import time
import uuid
from deployment_core import (AWS, COMPONENTS, INDEX_KEY, Lease, ReleaseError, Store,
    atomic_json, canonical, file_sha, require, sha, task_config_hash, validate_index)

ROOT = pathlib.Path(__file__).resolve().parents[1]


def physical(row):
    return {k:row[k] for k in ('image_uri','task_definition','config_sha256')}


def live_backend(aws):
    result = {}
    for name in COMPONENTS:
        body = aws.call('ecs','describe-services',{'cluster':'hid-staging','services':['hid-staging-'+name]})
        require(not body.get('failures') and len(body.get('services',[])) == 1, 'LIVE_SERVICE_MISSING')
        service = body['services'][0]
        require(service['status'] == 'ACTIVE' and service['desiredCount'] > 0
            and service['runningCount'] == service['desiredCount'] and service['pendingCount'] == 0
            and len(service.get('deployments',[])) == 1
            and service['deployments'][0].get('rolloutState') == 'COMPLETED', 'LIVE_SERVICE_UNSETTLED')
        task = aws.call('ecs','describe-task-definition',{'taskDefinition':service['taskDefinition']})['taskDefinition']
        containers = [c for c in task['containerDefinitions'] if c['name'] == name]
        require(len(containers) == 1, 'LIVE_CONTAINER_DIFFERS')
        result[name] = {'image_uri':containers[0]['image'],'task_definition':service['taskDefinition'],
                        'config_sha256':task_config_hash(task,name)}
    return result


def resolved_inputs(index, meta, lease):
    validate_index(index)
    return {'image_uris':{n:r['image_uri'] for n,r in index['backend'].items()},
        'migration_image_uri':index['migration_image_uri'], 'enable_deployment_automation':True,
        'enforce_release_index':True,'deployment_automation_bootstrap':False,
        'release_index_version_id':meta['VersionId'],'release_index_sha256':sha(canonical(index)),
        'release_lease_holder':lease.holder,'release_lease_generation':lease.generation}


def fingerprint(plan):
    # Data-source refreshes and lease identities are reads, not infrastructure changes.
    changes = [{k:r[k] for k in ('address','mode','type','change') if k in r}
        for r in plan.get('resource_changes',[]) if r.get('mode') == 'managed'
        and r['change']['actions'] != ['no-op']]
    return sha(canonical(sorted(changes,key=lambda r:r['address'])))


def source_hash():
    paths=list(ROOT.glob('*.tf'))+[ROOT/'.terraform.lock.hcl']
    paths.extend(p for p in (ROOT/'modules').rglob('*') if p.is_file() and p.suffix != '.md'
                 and '__pycache__' not in p.parts and '.terraform' not in p.parts)
    paths.extend(ROOT/'scripts'/p for p in ('deployment_core.py','release_infrastructure.py','read-release-state.py'))
    return sha(canonical({p.relative_to(ROOT).as_posix():file_sha(p) for p in sorted(paths)}))


def settled_backend(aws,lease):
    end=time.monotonic()+900
    while time.monotonic()<end:
        lease.assert_owned()
        try: return live_backend(aws)
        except ReleaseError as error:
            if str(error) != 'LIVE_SERVICE_UNSETTLED': raise
        time.sleep(10)
    raise ReleaseError('INFRASTRUCTURE_RUNTIME_NOT_SETTLED')


def terraform(*args, output=False):
    result = subprocess.run(['terraform',*args],cwd=ROOT,capture_output=output,text=True,timeout=3600)
    require(result.returncode == 0,'TERRAFORM_FAILED')
    return json.loads(result.stdout) if output else None


def run(mode, var_file, manifest, accepted_hash=None):
    require(pathlib.Path(var_file).is_file(), 'ENVIRONMENT_INPUT_REQUIRED')
    if mode == 'apply':
        require(accepted_hash == file_sha(manifest), 'EXPLICIT_REVIEWED_MANIFEST_HASH_REQUIRED')
        reviewed = json.loads(pathlib.Path(manifest).read_text())
        require(reviewed['environment'] == 'staging' and reviewed['var_file_sha256'] == file_sha(var_file),
                'REVIEWED_INPUT_CHANGED')
        require(reviewed['source_sha256'] == source_hash(),'REVIEWED_INFRASTRUCTURE_SOURCE_CHANGED')
    aws = AWS(); aws.account(); store = Store(aws)
    lease = Lease(aws,'terraform-'+uuid.uuid4().hex).acquire()
    safe = True
    try:
        index,meta = store.read(INDEX_KEY); validate_index(index)
        require(live_backend(aws) == {n:physical(r) for n,r in index['backend'].items()}, 'LIVE_INDEX_DIFFERS')
        if mode == 'apply':
            require(meta['VersionId'] == reviewed['index_version_id'] and sha(canonical(index)) == reviewed['index_sha256'],
                    'REVIEWED_RELEASE_CHANGED_REPLAN_REQUIRED')
        with tempfile.TemporaryDirectory() as folder:
            inputs = pathlib.Path(folder)/'release.tfvars.json'
            saved = pathlib.Path(folder)/'reviewed.tfplan'
            atomic_json(inputs,resolved_inputs(index,meta,lease))
            terraform('plan','-input=false','-var-file='+str(pathlib.Path(var_file).resolve()),
                '-var-file='+str(inputs),'-out='+str(saved))
            plan = terraform('show','-json',str(saved),output=True)
            digest = fingerprint(plan)
            if mode == 'plan':
                atomic_json(manifest,{'schema':'hid.infrastructure-review/v1','environment':'staging',
                    'index_version_id':meta['VersionId'],'index_sha256':sha(canonical(index)),
                    'var_file_sha256':file_sha(var_file),'source_sha256':source_hash(),'managed_change_sha256':digest})
                safe = True
                print(json.dumps({'review_manifest':str(manifest),'review_sha256':file_sha(manifest)}))
                return
            require(digest == reviewed['managed_change_sha256'], 'INFRASTRUCTURE_PLAN_CHANGED_REVIEW_REQUIRED')
            lease.assert_owned()
            safe = False
            terraform('apply','-input=false',str(saved))
            # Configuration changes can create new ECS revisions. Record actual settled state.
            next_index = copy.deepcopy(index)
            live = settled_backend(aws,lease)
            require(all(row['image_uri']==index['backend'][name]['image_uri'] for name,row in live.items()),
                    'INFRASTRUCTURE_CHANGED_APPLICATION_IMAGE')
            next_index['backend'] = {n:{**index['backend'][n],**row} for n,row in live.items()}
            migration = terraform('output','-json','migration_task_definition_arn',output=True)
            task = aws.call('ecs','describe-task-definition',{'taskDefinition':migration})['taskDefinition']
            next_index.update(migration_task_definition=migration,
                migration_image_uri=next(c['image'] for c in task['containerDefinitions'] if c['name']=='database-migration'))
            lease.assert_owned(); validate_index(next_index)
            store.put(INDEX_KEY,next_index,etag=meta['ETag'])
            safe = True
    finally:
        # On uncertain apply or reconciliation failure, retain the lease for recovery.
        lease.release(reconciled=safe)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode',choices=['plan','apply'])
    parser.add_argument('--var-file',required=True)
    parser.add_argument('--manifest',required=True)
    parser.add_argument('--accepted-review-sha256')
    args = parser.parse_args()
    try: run(args.mode,args.var_file,args.manifest,args.accepted_review_sha256)
    except ReleaseError as error:
        print(json.dumps({'status':'failed','code':str(error)})); raise SystemExit(1)
