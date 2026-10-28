"""Guarded ECS release controller. Uses only GitHub runner inputs and the shared wire contract."""
import argparse
import copy
import json
import os
import pathlib
import re
import time
import urllib.request
from production_deployment_core import (ACCOUNT, REGION, CLUSTER, COMPONENTS, INDEX_KEY, REGISTER_FIELDS, AWS,
    GitHub, Lease, Store, ReleaseError, atomic_json, canonical, changed_paths, context, file_sha, git,
    image, make_candidate, migration_files, notify, require, RUNTIME_GRANTS, schema_contract, sha, summarize,
    task_config_hash, task_payload, validate_candidate, validate_index)

ROOT = pathlib.Path(__file__).resolve().parents[1]
PENDING_LINE = re.compile(r"(\d+) pending migration\(s\)")
PLAN_LINE = re.compile(r"(\d{4}_[a-z0-9_]+\.sql) ([a-f0-9]{64})")
ORDER = ("identity-api","notification-api","ehr-api","lab-api","pharmacy-api","ocr-api",
         "outreach-api","notification-worker","event-dispatcher","ocr-worker","support-api","gateway")

def candidate():
    ctx = context("backend")
    require(git("rev-parse","HEAD",cwd=ROOT) == ctx["source_commit"], "SOURCE_CHECKOUT_DIFFERS")
    require(not git("status","--porcelain","--untracked-files=no",cwd=ROOT), "DIRTY_SOURCE")
    selected = json.loads(os.environ["SELECTED_COMPONENTS"])
    if isinstance(selected,dict): selected = selected["component"]
    require(selected and set(selected) <= {*COMPONENTS,"database-migration"}, "INVALID_COMPONENT_SELECTION")
    folder = ROOT/"release-evidence"
    records = {}
    for path in folder.rglob("publication.json"):
        receipt = json.loads(path.read_text())
        component = receipt.get("component")
        require(component in selected and component not in records, "DUPLICATE_OR_UNSELECTED_PUBLICATION")
        require(all(str(receipt.get(key)) == ctx[key] for key in ("source_commit","run_id","run_attempt")),
                "PUBLICATION_SOURCE_DIFFERS")
        image(component, receipt["image_uri"])
        require(receipt["digest"] == receipt["image_uri"].split("@")[1]
                and receipt.get("architecture") == "arm64" and receipt.get("os") == "linux"
                and receipt.get("high_critical_findings") == 0 and receipt.get("deployment_authorized") is False,
                "UNADMITTED_PUBLICATION")
        for key, name in (("sbom_sha256","sbom.spdx.json"),("scan_sha256","grype.json"),
                          ("raw_scan_sha256","grype.raw.json")):
            require(file_sha(path.with_name(name)) == receipt[key], "PUBLICATION_EVIDENCE_CHANGED")
        for key,name in (("assessment_sha256","runtime-assessment.json"),("vex_sha256","runtime.vex.json")):
            if receipt.get(key): require(file_sha(path.with_name(name)) == receipt[key], "ASSESSMENT_CHANGED")
        records[component] = {"image_uri":receipt["image_uri"],"publication_sha256":file_sha(path),
            "sbom_sha256":receipt["sbom_sha256"],"scan_sha256":receipt["scan_sha256"]}
    require(set(records) == set(selected), "COMPLETE_PUBLICATION_SET_REQUIRED")
    paths = changed_paths(ROOT)
    contract = schema_contract(ROOT, paths, carry="database-migration" in records)
    if contract.get("changed") and not contract.get("carried"):
        require("database-migration" in records, "MIGRATION_IMAGE_REQUIRED")
        base = os.environ["BASE_SHA"]
        for name in contract["files"]:
            # Changed applied files or RDS substitutions are outside this automatic additive path.
            # The role bootstrap file is the one existing file a reviewed change may modify.
            change = "M" if name == RUNTIME_GRANTS else "A"
            require(git("diff","--diff-filter="+change,"--name-only",base,"HEAD","--",name,cwd=ROOT) == name,
                    "ONLY_NEW_REVIEWED_SCHEMA_FILES_ALLOWED")
    checks = {"select":"success","build":"success","verify-publisher":"success","publish":"success"}
    release = make_candidate(ctx, selected, records, checks, schema=contract)
    atomic_json(ROOT/"release/candidate.json",release)
    summarize(release)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"],"a") as output:
            output.write("candidate_sha256="+file_sha(ROOT/"release/candidate.json")+"\n")

def rollback_receipt(store,release_id,version=None):
    require(re.fullmatch(r"backend-(?:[0-9]+-[0-9]+-[a-f0-9]{16}|bootstrap-[a-f0-9]{24})",release_id or ""), "RECORDED_ROLLBACK_RELEASE_REQUIRED")
    old,meta = store.read("production/releases/"+release_id+"/complete.json",version)
    require(old.get("status") == "success" and old.get("kind") == "backend", "HEALTHY_ROLLBACK_RECEIPT_REQUIRED")
    if release_id.startswith("backend-bootstrap-"):
        require(old.get("operation") == "bootstrap-inventory" and old.get("deployment_performed") is False
                and re.fullmatch(r"[a-f0-9]{64}",old.get("inventory_manifest_sha256","")), "VERIFIED_BOOTSTRAP_RECEIPT_REQUIRED")
    return old,meta


def rollback_candidate(release_id):
    ctx = context("backend")
    aws = AWS()
    aws.account()
    old,meta = rollback_receipt(Store(aws),release_id)
    desired = old["after"]
    require(set(desired) == set(COMPONENTS), "COMPLETE_ROLLBACK_TARGET_REQUIRED")
    for name,row in desired.items(): image(name,row["image_uri"])
    evidence = {name:{"image_uri":row["image_uri"],"target_config_sha256":row["config_sha256"]}
                for name,row in desired.items()}
    release = make_candidate(ctx,list(COMPONENTS),evidence,{"prepare":"success"},
        rollback_ref={"release_id":release_id,"version_id":meta["VersionId"],"sha256":sha(canonical(old))})
    atomic_json(ROOT/"release/candidate.json",release)
    summarize(release)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"],"a") as output:
            output.write("candidate_sha256="+file_sha(ROOT/"release/candidate.json")+"\n")

class ECS:
    def __init__(self, aws, lease):
        self.aws, self.lease = aws, lease

    def service(self, component):
        body = self.aws.call("ecs","describe-services",{"cluster":CLUSTER,"services":["hid-production-"+component]})
        require(not body.get("failures") and len(body.get("services",[])) == 1, "STAGING_SERVICE_MISSING")
        value = body["services"][0]
        require(value["serviceArn"].startswith("arn:aws:ecs:"+REGION+":"+ACCOUNT+":service/"+CLUSTER+"/")
                and value.get("status") == "ACTIVE", "UNEXPECTED_SERVICE")
        return value

    def definition(self, arn):
        families = "hid-production-(?:"+"|".join(COMPONENTS)+")|hid-staging-database-migration"
        require(re.fullmatch("arn:aws:ecs:"+REGION+":"+ACCOUNT+":task-definition/(?:"+families+r"):[1-9][0-9]*",arn or ""), "FOREIGN_TASK_DEFINITION")
        return self.aws.call("ecs","describe-task-definition",{"taskDefinition":arn})["taskDefinition"]

    def verify_discovery(self, service, tasks):
        registries = service.get("serviceRegistries", [])
        if not registries:
            return
        addresses = {d["value"] for task in tasks for attachment in task.get("attachments", [])
                     for d in attachment.get("details", []) if d.get("name") == "privateIPv4Address"}
        require(len(addresses) == len(tasks), "CURRENT_TASK_NETWORK_ADDRESSES_REQUIRED")
        for registry in registries:
            arn = registry.get("registryArn", "")
            require(arn.startswith("arn:aws:servicediscovery:"+REGION+":"+ACCOUNT+":service/"),
                    "FOREIGN_DISCOVERY_REGISTRY")
            instances = self.aws.call("servicediscovery", "list-instances", {
                "ServiceId": arn.rsplit("/", 1)[-1], "MaxResults": 100})
            require(not instances.get("NextToken"), "DISCOVERY_INVENTORY_PAGINATION_REQUIRED")
            registered = {row.get("Attributes", {}).get("AWS_INSTANCE_IPV4")
                          for row in instances.get("Instances", [])}
            require(addresses <= registered, "CURRENT_TASK_DISCOVERY_REGISTRATION_MISSING")

    def healthy(self, component, expected, deadline=900):
        end = time.monotonic()+deadline
        seen_expected = False
        while time.monotonic() < end:
            result, seen_expected = self.check(component, expected, seen_expected)
            if result: return result
            time.sleep(10)
        raise ReleaseError("ECS_HEALTH_TIMEOUT")

    def check(self, component, expected, seen_expected):
        """One look at a rollout: (service and definition once it is healthy, else None; whether the target was seen)."""
        self.lease.assert_owned()
        service = self.service(component)
        seen_expected = seen_expected or service["taskDefinition"] == expected
        complete = (service["taskDefinition"] == expected and service["desiredCount"] > 0
            and service["runningCount"] == service["desiredCount"] and service["pendingCount"] == 0
            and len(service.get("deployments",[])) == 1
            and service["deployments"][0].get("rolloutState") == "COMPLETED")
        # A circuit breaker settling on the old revision is a failed candidate.
        if seen_expected and service["taskDefinition"] != expected and service.get("deployments") and all(d.get("rolloutState") == "COMPLETED" for d in service["deployments"]):
            raise ReleaseError("ECS_ROLLED_BACK_TO_DIFFERENT_REVISION")
        if complete:
            ids = self.aws.call("ecs","list-tasks",{"cluster":CLUSTER,"serviceName":service["serviceName"],
                                                   "desiredStatus":"RUNNING"}).get("taskArns",[])
            require(len(ids) == service["desiredCount"], "RUNNING_TASK_SET_DIFFERS")
            tasks = self.aws.call("ecs","describe-tasks",{"cluster":CLUSTER,"tasks":ids})
            definition = self.definition(expected)
            primary = next(c for c in definition["containerDefinitions"] if c["name"] == component)
            require(not tasks.get("failures") and len(tasks.get("tasks",[])) == len(ids) and all(t.get("taskDefinitionArn") == expected
                and t.get("lastStatus") == "RUNNING" for t in tasks["tasks"]), "RUNNING_TASK_REVISION_DIFFERS")
            for task in tasks["tasks"]:
                container = next(c for c in task["containers"] if c["name"] == component)
                require(container.get("image") == primary["image"], "RUNNING_IMAGE_DIFFERS")
                if "healthCheck" in primary:
                    require(container.get("healthStatus") == "HEALTHY", "CONTAINER_NOT_HEALTHY")
            self.verify_discovery(service, tasks["tasks"])
            for lb in service.get("loadBalancers",[]):
                targets = self.aws.call("elbv2","describe-target-health",{"TargetGroupArn":lb["targetGroupArn"]})
                # Container checks prove task health; target checks also require enough healthy registrations.
                healthy = [t for t in targets.get("TargetHealthDescriptions",[]) if t.get("TargetHealth",{}).get("State") == "healthy"]
                require(len(healthy) >= service["desiredCount"], "LOAD_BALANCER_NOT_HEALTHY")
            return (service, definition), seen_expected
        return None, seen_expected

    def snapshot(self):
        result = {}
        for component in COMPONENTS:
            service = self.service(component)
            service, definition = self.healthy(component,service["taskDefinition"],deadline=30)
            container = next(c for c in definition["containerDefinitions"] if c["name"] == component)
            image(component, container["image"])
            result[component] = {"image_uri":container["image"],"task_definition":service["taskDefinition"],
                "config_sha256":task_config_hash(definition,component)}
        return result

    def protect_image(self, component, uri):
        image(component,uri)
        repository = "staging/hid/"+("ehr-api" if component == "database-migration" else component)
        digest = uri.split("@")[1]
        tag = "retain-"+digest[7:]
        policy = json.loads(self.aws.call("ecr","get-lifecycle-policy",{"repositoryName":repository})["lifecyclePolicyText"])
        protection = [r for r in policy["rules"] if r["selection"].get("tagPrefixList") == ["retain-"]]
        require(len(protection) == 1 and protection[0]["rulePriority"] == 1
                and protection[0]["selection"].get("countType") == "imageCountMoreThan"
                and protection[0]["selection"].get("countNumber",0) >= 1000000, "ROLLBACK_RETENTION_POLICY_REQUIRED")
        details = self.aws.call("ecr","describe-images",{"repositoryName":repository,"imageIds":[{"imageDigest":digest}]}).get("imageDetails",[])
        require(len(details) == 1, "ROLLBACK_IMAGE_UNAVAILABLE")
        if tag not in details[0].get("imageTags",[]):
            payload = self.aws.call("ecr","batch-get-image",{"repositoryName":repository,"imageIds":[{"imageDigest":digest}]})
            require(len(payload.get("images",[])) == 1 and not payload.get("failures"), "IMAGE_MANIFEST_UNAVAILABLE")
            self.lease.assert_owned()
            self.aws.call("ecr","put-image",{"repositoryName":repository,"imageManifest":payload["images"][0]["imageManifest"],
                "imageDigest":digest,"imageTag":tag},mutation=True)
        require(any(tag in r.get("imageTags",[]) for r in self.aws.call("ecr","describe-images",{
            "repositoryName":repository,"imageIds":[{"imageDigest":digest}]}).get("imageDetails",[])), "IMAGE_RETENTION_READBACK_FAILED")

    def register(self, component, uri):
        service = self.service(component)
        definition = self.definition(service["taskDefinition"])
        payload = task_payload(definition,component,uri)
        # Protect application and any unchanged token-agent image before replacing tasks.
        self.protect_image(component,uri)
        self.protect_image(component,next(c["image"] for c in definition["containerDefinitions"] if c["name"] == component))
        for container in definition["containerDefinitions"]:
            if container["name"] == "workload-token-agent":
                self.protect_image("identity-api",container["image"])
        self.lease.assert_owned()
        result = self.aws.call("ecs","register-task-definition",payload,mutation=True)["taskDefinition"]
        require({k:result[k] for k in REGISTER_FIELDS if k in result} == payload, "REGISTERED_CONFIGURATION_DIFFERS")
        return result["taskDefinitionArn"]

    def update(self, component, arn):
        self.lease.assert_owned()
        self.aws.call("ecs","update-service",{"cluster":CLUSTER,"service":"hid-production-"+component,
            "taskDefinition":arn},mutation=True)
        return self.healthy(component,arn)

    def update_all(self, targets, deadline=900):
        """Starts every rollout, then waits for all of them together: services roll out side by side."""
        for component, arn in targets.items():
            self.lease.assert_owned()
            self.aws.call("ecs","update-service",{"cluster":CLUSTER,"service":"hid-production-"+component,
                "taskDefinition":arn},mutation=True)
        end = time.monotonic()+deadline
        seen = dict.fromkeys(targets, False)
        pending = list(targets)
        while True:
            for component in list(pending):
                result, seen[component] = self.check(component, targets[component], seen[component])
                if result: pending.remove(component)
            if not pending: return
            if time.monotonic() >= end: raise ReleaseError("ECS_HEALTH_TIMEOUT")
            time.sleep(10)

    def migrate(self, uri, contract, settings, release_id):
        template = settings["migration_task_definition"]
        definition = self.definition(template)
        payload = task_payload(definition,"database-migration",uri)
        self.protect_image("database-migration",uri)
        self.lease.assert_owned()
        definition = self.aws.call("ecs","register-task-definition",payload,mutation=True)["taskDefinition"]
        require({k:definition[k] for k in REGISTER_FIELDS if k in definition} == payload, "MIGRATION_CONFIGURATION_DIFFERS")
        network = settings["migration_network"]
        require(network["assignPublicIp"] == "DISABLED" and len(network["subnets"]) == 2
                and len(network["securityGroups"]) == 1, "PRIVATE_MIGRATION_NETWORK_REQUIRED")
        def run(mode,phase=None):
            self.lease.assert_owned()
            task = self.aws.call("ecs","run-task",{"cluster":CLUSTER,"taskDefinition":definition["taskDefinitionArn"],
                "launchType":"FARGATE","clientToken":sha((release_id+(phase or mode)).encode()),
                "networkConfiguration":{"awsvpcConfiguration":network},"enableExecuteCommand":False,
                "overrides":{"containerOverrides":[{"name":"database-migration",
                    "command":["scripts/apply-migrations.mjs"]+([] if mode == "apply" else ["--"+mode])}]}},mutation=True)
            require(not task.get("failures") and len(task.get("tasks",[])) == 1, "MIGRATION_START_FAILED")
            arn = task["tasks"][0]["taskArn"]
            end = time.monotonic()+600
            while time.monotonic() < end:
                self.lease.assert_owned()
                rows = self.aws.call("ecs","describe-tasks",{"cluster":CLUSTER,"tasks":[arn]})
                require(not rows.get("failures") and len(rows.get("tasks",[])) == 1, "MIGRATION_TASK_MISSING")
                item = rows["tasks"][0]
                if item["lastStatus"] == "STOPPED":
                    require(all(c.get("exitCode") == 0 for c in item["containers"]), "MIGRATION_FAILED")
                    log = self.migration_logs(arn)
                    pending = [int(m.group(1)) for e in log if (m := PENDING_LINE.fullmatch(e["message"]))]
                    plan = [(m.group(1), m.group(2)) for e in log if (m := PLAN_LINE.fullmatch(e["message"]))]
                    require(len(pending) == 1 and len(plan) == pending[0], "MIGRATION_PLAN_EVIDENCE_MISSING")
                    return pending[0], plan
                time.sleep(5)
            raise ReleaseError("MIGRATION_TIMEOUT")
        pending, plan = run("plan","before")
        if pending:
            # Bind the exact bytes the image will apply to the reviewed declaration.
            declared = {(pathlib.PurePosixPath(p).name, contract["files"][p]) for p in migration_files(contract)}
            require(contract.get("changed") and set(plan) == declared, "UNREVIEWED_PENDING_MIGRATIONS")
            run("dry-run")
            run("apply")
        require(run("plan","after")[0] == 0, "PENDING_MIGRATIONS_REMAIN")
        return definition["taskDefinitionArn"]

    def migration_logs(self, arn):
        # Task exit can precede CloudWatch delivery. Poll reads only, never re-run a task.
        end = time.monotonic()+90
        while time.monotonic() < end:
            self.lease.assert_owned()
            try:
                events = self.aws.call("logs","get-log-events",{"logGroupName":"/hid/staging/database-migration",
                    "logStreamName":"migration/database-migration/"+arn.split("/")[-1],"startFromHead":True}).get("events",[])
                # Wait for every plan line, not just the count, before trusting the plan.
                counts = [int(m.group(1)) for e in events if (m := PENDING_LINE.fullmatch(e["message"]))]
                if counts and sum(1 for e in events if PLAN_LINE.fullmatch(e["message"])) >= counts[0]: return events
            except ReleaseError as error:
                if str(error) != "AWS_ResourceNotFoundException": raise
            time.sleep(5)
        raise ReleaseError("MIGRATION_PLAN_EVIDENCE_MISSING")

def deploy(mode="deploy", rollback_id=None):
    ctx = context("backend")
    path = ROOT/"release/candidate.json"
    candidate = json.loads(path.read_text())
    require(file_sha(path) == os.environ.get("EXPECTED_CANDIDATE_SHA256"), "APPROVED_ARTIFACT_CHANGED")
    validate_candidate(candidate,ctx)
    github = GitHub(ctx["repository"])
    # The approval step before cloud credentials already waited for GitHub's job records to settle.
    approval = github.assert_approval(candidate, settle=120)
    aws = AWS()
    aws.account()
    store = Store(aws)
    lease = Lease(aws,candidate["release_id"]).acquire()
    reconciled, started, previous, updated = False, False, None, []
    alert_failed = False
    receipt_key = "production/releases/"+candidate["release_id"]+"/"
    try:
        index, index_meta = store.read(INDEX_KEY)
        validate_index(index)
        ecs = ECS(aws,lease)
        previous = ecs.snapshot()
        require(previous == {n:{k:r[k] for k in ("image_uri","task_definition","config_sha256")}
                             for n,r in index["backend"].items()}, "LIVE_BASELINE_DIFFERS_FROM_INDEX")
        validate_candidate(candidate,ctx)
        github.assert_current_source(candidate)
        desired = {name:row["image_uri"] for name,row in candidate["evidence"].items()}
        if mode == "rollback":
            require(candidate.get("operation") == "rollback", "ROLLBACK_APPROVAL_REQUIRED")
            rollback_id = candidate["rollback_ref"]["release_id"]
            old,_ = rollback_receipt(store,rollback_id,candidate["rollback_ref"]["version_id"])
            require(sha(canonical(old)) == candidate["rollback_ref"]["sha256"], "ROLLBACK_RECEIPT_CHANGED")
            require(old.get("status") == "success" and old.get("kind") == "backend", "HEALTHY_ROLLBACK_RECEIPT_REQUIRED")
            require(desired == {name:row["image_uri"] for name,row in old["after"].items()}, "ROLLBACK_TARGET_CHANGED")
            require(all(previous[n]["config_sha256"] == row["config_sha256"] for n,row in old["after"].items()),
                    "ROLLBACK_CONFIGURATION_NO_LONGER_COMPATIBLE")
        store.put(receipt_key+"started.json",{"schema":"hid.release-receipt/v1","kind":"backend",
            "candidate":candidate,"approval":approval,"before":previous,"status":"started"})
        started = True
        migration_arn = index.get("migration_task_definition")
        if "database-migration" in desired:
            settings = json.loads(os.environ["RELEASE_CONFIG_JSON"])
            require(settings.get("account") == ACCOUNT and settings.get("region") == REGION, "STAGING_RELEASE_CONFIG_REQUIRED")
            require(settings["migration_network"] == index["migration_network"], "MIGRATION_NETWORK_DIFFERS_FROM_INDEX")
            settings["migration_task_definition"] = index["migration_task_definition"]
            migration_arn = ecs.migrate(desired["database-migration"],candidate["schema_change"],settings,candidate["release_id"])
        # The services roll out side by side; the gateway, which routes to them, follows once they are healthy.
        rollout = [name for name in ORDER if name in desired]
        for wave in ([n for n in rollout if n != "gateway"], [n for n in rollout if n == "gateway"]):
            targets = {}
            for name in wave:
                arn = ecs.register(name,desired[name])
                # Record mutation intent durably before sending update-service (including uncertain responses).
                store.put(receipt_key+"intent-"+name+".json",{"component":name,"prior":previous[name],
                    "target_task_definition":arn})
                updated.append(name)
                targets[name] = arn
            if targets: ecs.update_all(targets)
        after = ecs.snapshot()
        lease.assert_owned()
        current,_ = store.read(INDEX_KEY,index_meta["VersionId"])
        require(current == index, "INDEX_BASELINE_VERSION_DIFFERS")
        new_index = copy.deepcopy(index)
        metadata = old["after"] if mode == "rollback" else index["backend"]
        new_backend = {n:{**metadata[n],**row} for n,row in after.items()}
        if mode != "rollback":
            for name in updated:
                new_backend[name].update(source_commit=candidate["source_commit"],
                    publication_sha256=candidate["evidence"][name]["publication_sha256"])
        new_index.update(backend=new_backend,backend_release=candidate["release_id"],verified=True)
        if migration_arn:
            new_index["migration_task_definition"] = migration_arn
            new_index["migration_image_uri"] = next(c["image"] for c in ecs.definition(migration_arn)["containerDefinitions"]
                                                    if c["name"] == "database-migration")
        require(all(after[n]["image_uri"] == desired[n] for n in desired if n in COMPONENTS), "DEPLOYED_DIGEST_DIFFERS")
        index_meta = store.put(INDEX_KEY,new_index,etag=index_meta["ETag"])
        store.put(receipt_key+"complete.json",{"schema":"hid.release-receipt/v1","kind":"backend","status":"success",
            "candidate":candidate,"before":index["backend"],"after":new_backend,"migration_task_definition":migration_arn})
        reconciled = True
        try: notify(aws,candidate,"success" if mode == "deploy" else "rollback-success")
        except ReleaseError:
            alert_failed = True
            print(json.dumps({"release_id":candidate["release_id"],"alert_status":"failed"}))
        print(json.dumps({"release_id":candidate["release_id"],"status":"success","components":updated}))
    except Exception as error:
        # Never retry an uncertain update blindly. Describe live state, then restore only this release's intent targets.
        if started and previous is not None:
            try:
                lease.assert_owned()
                ecs.update_all({name:previous[name]["task_definition"] for name in reversed(updated)})
                after = ecs.snapshot()
                require(after == previous, "ROLLBACK_BASELINE_NOT_RESTORED")
                # Schema may already be committed; preserve the admitted compatible migration pin.
                restored = copy.deepcopy(index)
                restored["backend"] = {n:{**index["backend"][n],**row} for n,row in after.items()}
                if migration_arn:
                    restored["migration_task_definition"] = migration_arn
                    restored["migration_image_uri"] = next(c["image"] for c in ecs.definition(migration_arn)["containerDefinitions"]
                                                            if c["name"] == "database-migration")
                lease.assert_owned()
                # Reconcile an uncertain conditional index write before another write.
                live_index,live_meta = store.read(INDEX_KEY)
                require(live_index == index or live_index.get("backend_release") == candidate["release_id"],
                        "FOREIGN_INDEX_UPDATE")
                store.put(INDEX_KEY,restored,etag=live_meta["ETag"])
                store.put(receipt_key+"failed.json",{"schema":"hid.release-receipt/v1","kind":"backend",
                    "status":"failed-rolled-back","error_code":str(error) if isinstance(error,ReleaseError) else "CONTROLLER_FAILED",
                    "before":previous,"after":after})
                reconciled = True
            except Exception:
                # Lease loss/uncertain rollback blocks takeover until explicit reconciliation.
                reconciled = False
        if not started: reconciled = True
        try: notify(aws,candidate,"failed-rolled-back" if reconciled and started else "reconciliation-required")
        except Exception: pass
        raise
    finally:
        lease.release(reconciled=reconciled)
    if alert_failed: raise ReleaseError("DEPLOYED_HEALTHY_BUT_OPERATIONS_ALERT_FAILED")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode",choices=["candidate","rollback-candidate","deploy","rollback"])
    parser.add_argument("--release-id")
    args = parser.parse_args()
    try:
        if args.mode == "candidate": candidate()
        elif args.mode == "rollback-candidate": rollback_candidate(args.release_id)
        else: deploy(args.mode,args.release_id)
    except Exception as error:
        print(json.dumps({"status":"failed","code":str(error) if isinstance(error,ReleaseError) else "CONTROLLER_FAILED"}))
        raise SystemExit(1)
