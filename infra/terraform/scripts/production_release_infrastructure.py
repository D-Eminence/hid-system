"""Local/operator Terraform reconciliation using the same production deployment lease.

Plan releases the lease for human review. Apply acquires a fresh lease, checks the
same index and regenerates a saved plan; managed changes must exactly match the
reviewed fingerprint before that saved plan is applied. No automatic approval.

Reconcile is only the apply's own post-apply step, run on its own after an apply
stopped before recording what it changed (LIVE_INDEX_DIFFERS). It changes no
infrastructure: a dry run prints the exact index rows it would replace and their
SHA-256 and writes nothing; a second run with that SHA-256 writes them.
"""
import argparse
import copy
import json
import pathlib
import subprocess
import tempfile
import time
import uuid
from production_deployment_core import (AWS, COMPONENTS, INDEX_KEY, Lease, ReleaseError, Store,
    atomic_json, canonical, file_sha, require, sha, task_config_hash, validate_index)

ROOT = pathlib.Path(__file__).resolve().parents[1]


def physical(row):
    return {k:row[k] for k in ('image_uri','task_definition','config_sha256')}


def live_backend(aws):
    result = {}
    for name in COMPONENTS:
        body = aws.call('ecs','describe-services',{'cluster':'hid-production','services':['hid-production-'+name]})
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


# Read-only values that AWS moves forward by itself between two plans. Terraform
# never sets them, so they cannot change what an apply does, but they appear in
# both `before` and (for an in-place update) `after`. Keep this list explicit.
SELF_MOVING_ATTRIBUTES = {'aws_db_instance': ('latest_restorable_time',)}


def fingerprint(plan):
    # Data-source refreshes and lease identities are reads, not infrastructure changes.
    changes = []
    for r in plan.get('resource_changes',[]):
        if r.get('mode') != 'managed' or r['change']['actions'] == ['no-op']:
            continue
        row = copy.deepcopy({k:r[k] for k in ('address','mode','type','change') if k in r})
        for side in ('before','after'):
            values = row['change'].get(side)
            if isinstance(values,dict):
                for key in SELF_MOVING_ATTRIBUTES.get(row.get('type'),()):
                    values.pop(key,None)
        changes.append(row)
    return sha(canonical(sorted(changes,key=lambda r:r['address'])))


def source_hash():
    paths=list(ROOT.glob('*.tf'))+[ROOT/'.terraform.lock.hcl']
    paths.extend(p for p in (ROOT/'modules').rglob('*') if p.is_file() and p.suffix != '.md'
                 and '__pycache__' not in p.parts and '.terraform' not in p.parts)
    paths.extend(ROOT/'scripts'/p for p in ('production_deployment_core.py','production_release_infrastructure.py','read_production_release_state.py'))
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
        require(reviewed['environment'] == 'production' and reviewed['var_file_sha256'] == file_sha(var_file),
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
                atomic_json(manifest,{'schema':'hid.infrastructure-review/v1','environment':'production',
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


def revision(arn):
    family, _, number = arn.rpartition(':')
    require(family.startswith('arn:aws:ecs:') and ':task-definition/' in family and number.isdigit(),
            'INDEX_RECONCILE_TASK_DEFINITION_INVALID')
    return family, int(number)


def newer(before, after):
    old_family, old_number = revision(before)
    new_family, new_number = revision(after)
    require(new_family == old_family and new_number > old_number, 'INDEX_RECONCILE_REVISION_NOT_NEWER')


def live_migration(aws, task_definition):
    task = aws.call('ecs','describe-task-definition',{'taskDefinition':task_definition})['taskDefinition']
    containers = [c for c in task['containerDefinitions'] if c['name'] == 'database-migration']
    require(len(containers) == 1, 'LIVE_CONTAINER_DIFFERS')
    return {'migration_task_definition':task['taskDefinitionArn'],'migration_image_uri':containers[0]['image']}


def reconcile(aws, store, expected_drift, accepted_drift_sha=None, migration_task_definition=None, make_lease=None):
    """Record live service rows an apply changed but did not record. Never deploys."""
    expected = set(expected_drift or [])
    require(expected and expected <= set(COMPONENTS) | {'migration'}, 'INDEX_RECONCILE_EXPECTED_DRIFT_REQUIRED')
    require(migration_task_definition, 'INDEX_RECONCILE_MIGRATION_OUTPUT_REQUIRED')
    lease = (make_lease or (lambda: Lease(aws,'terraform-'+uuid.uuid4().hex)))().acquire()
    reconciled = True
    try:
        index, meta = store.read(INDEX_KEY); validate_index(index)
        live = settled_backend(aws, lease)
        require(set(live) == set(index['backend']), 'COMPLETE_BACKEND_INDEX_REQUIRED')
        require(all(live[n]['image_uri'] == index['backend'][n]['image_uri'] for n in live),
                'INFRASTRUCTURE_CHANGED_APPLICATION_IMAGE')
        before, after = {}, {}
        for name in sorted(live):
            if physical(index['backend'][name]) != live[name]:
                newer(index['backend'][name]['task_definition'], live[name]['task_definition'])
                before[name], after[name] = physical(index['backend'][name]), live[name]
        migration = live_migration(aws, migration_task_definition)
        recorded = {k:index[k] for k in ('migration_task_definition','migration_image_uri')}
        if migration != recorded:
            require(migration['migration_image_uri'] == recorded['migration_image_uri'],
                    'INFRASTRUCTURE_CHANGED_APPLICATION_IMAGE')
            newer(recorded['migration_task_definition'], migration['migration_task_definition'])
            before['migration'], after['migration'] = recorded, migration
        require(after, 'INDEX_RECONCILE_NOTHING_TO_RECORD')
        require(set(after) == expected, 'INDEX_RECONCILE_UNEXPECTED_DRIFT')
        drift = {'index_version_id':meta['VersionId'],'before':before,'after':after}
        digest = sha(canonical(drift))
        if accepted_drift_sha is None:
            return {'status':'dry-run','index_written':False,'drift':drift,'drift_sha256':digest}
        require(accepted_drift_sha == digest, 'INDEX_RECONCILE_REVIEW_REQUIRED')
        next_index = copy.deepcopy(index)
        for name in after:
            if name == 'migration': next_index.update(after['migration'])
            else: next_index['backend'][name] = {**index['backend'][name], **after[name]}
        validate_index(next_index)
        require(settled_backend(aws, lease) == live, 'LIVE_STATE_CHANGED_DURING_RECONCILE')
        lease.assert_owned()
        reconciled = False
        result = store.put(INDEX_KEY, next_index, etag=meta['ETag'])
        saved, _ = store.read(INDEX_KEY, result['VersionId'])
        require(saved == next_index, 'INDEX_RECONCILE_READBACK_DIFFERS')
        reconciled = True
        return {'status':'reconciled','index_written':True,'version_id':result['VersionId'],
                'recorded':sorted(after),'drift_sha256':digest}
    finally:
        # A write that may have landed keeps the lease for operator recovery, as apply does.
        lease.release(reconciled=reconciled)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode',choices=['plan','apply','reconcile'])
    parser.add_argument('--var-file')
    parser.add_argument('--manifest')
    parser.add_argument('--accepted-review-sha256')
    parser.add_argument('--expect-drift', action='append', default=[],
                        help='reconcile: a component (or "migration") the stopped apply changed; repeat for each')
    parser.add_argument('--accepted-drift-sha256', help='reconcile: the drift_sha256 a dry run printed')
    args = parser.parse_args()
    try:
        if args.mode == 'reconcile':
            aws = AWS(); aws.account()
            migration = terraform('output','-json','migration_task_definition_arn',output=True)
            print(json.dumps(reconcile(aws, Store(aws), args.expect_drift, args.accepted_drift_sha256, migration), sort_keys=True))
        else:
            require(args.var_file and args.manifest, 'ENVIRONMENT_INPUT_REQUIRED')
            run(args.mode,args.var_file,args.manifest,args.accepted_review_sha256)
    except ReleaseError as error:
        print(json.dumps({'status':'failed','code':str(error)})); raise SystemExit(1)
