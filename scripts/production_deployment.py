"""Guarded ECS release controller. Uses only GitHub runner inputs and the shared wire contract."""
import argparse
import concurrent.futures
import copy
import datetime
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
GATEWAY_VEX = "security/gateway-runtime.vex.json"
PENDING_LINE = re.compile(r"(\d+) pending migration\(s\)")
PLAN_LINE = re.compile(r"(\d{4}_[a-z0-9_]+\.sql) ([a-f0-9]{64})")
ORDER = ("identity-api","notification-api","ehr-api","lab-api","pharmacy-api","ocr-api",
         "outreach-api","notification-worker","event-dispatcher","ocr-worker","support-api","gateway")
# Read-only AWS calls run side by side in a small pool; ECR retention writes use a smaller one.
# Each call is still one serial `aws` subprocess with the wrapper's own retry and error rules.
READ_POOL = 6
PROTECT_POOL = 4
ROLLOUT_POLL_SECONDS = 5
SKIPPED_PLAN_AFTER = "PLAN_BEFORE_FOUND_ZERO_PENDING"
# ORD-7's governed catalogue load, opt-in (CATALOG_LOAD): the signed seed files where the migration image carries
# them (services/ehr-api/Dockerfile copies them by name to /app/docs/codes), and the loader's three kinds of last line:
# its evidence line when it loaded (exit 0), its one line when it loaded nothing (a refusal, exit 2, or a failure),
# and its line when the connection was lost once its COMMIT was sent (exit 1): the version may have committed.
CATALOG_SEEDS = {"medicine":"/app/docs/codes/hid-medicines.json","lab_test":"/app/docs/codes/hid-lab-tests.json"}
CATALOG_LOADED = re.compile(r'\{"status":"loaded",.*\}')
CATALOG_NOT_LOADED = re.compile(r"load-catalog: .*; nothing loaded(?:; run the release again at a quieter time)?")
CATALOG_COMMIT_UNKNOWN = re.compile(re.escape("load-catalog: the connection was lost during commit, so the load may have "
    "committed; ask for the same load again to settle it (it loads, or is refused as already loaded)"))
CATALOG_LAST_LINE = re.compile(CATALOG_NOT_LOADED.pattern+"|"+CATALOG_COMMIT_UNKNOWN.pattern)
OUTCOME_UNKNOWN = "outcome unknown"
EVIDENCE_PENDING = "evidence pending"
EVIDENCE_LINE_MISSING = "evidence line missing"
EVIDENCE_UNREADABLE = "evidence unreadable"
# The operator's next step after a failure that follows a load: the loaded version stays loaded and asking for it again
# is refused. After a load whose outcome is unknown, the same load is asked for again, which settles it: it loads, or
# it is refused as already loaded. An unreconciled release (the lease lost, or a rollback that could not be confirmed)
# is reconciled first.
NEXT_AFTER_LOAD = "dispatch the release again with catalog_load none"
RECONCILE_FIRST = "reconcile this release first (it ended unreconciled and keeps the deployment lease), then "
NEXT_AFTER_LOAD_UNRECONCILED = RECONCILE_FIRST+NEXT_AFTER_LOAD
NEXT_AFTER_UNKNOWN = ("dispatch the release again with catalog_load {} to settle it (it loads, or is refused as already "
                      "loaded; once refused, dispatch again with catalog_load none)")
PHASES = frozenset({"approval","lease","snapshot-before","receipt-started","migration","catalog","register-services",
    "rollout-services","register-gateway","rollout-gateway","snapshot-after","index-and-receipt","notify",
    "rollback-rollout","rollback-snapshot","rollback-index"})

def parallel(work, items, workers):
    """Runs work(item) for every item and returns results in item order.

    Raises the error of the first item, in order, that failed. Every started call has finished
    before this returns or raises, so nothing keeps running behind the caller's back."""
    items = list(items)
    if len(items) <= 1: return [work(item) for item in items]
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(workers,len(items))) as pool:
        futures = [pool.submit(work,item) for item in items]
        try:
            return [future.result() for future in futures]
        except BaseException:
            for future in futures: future.cancel()
            raise

class Phases:
    """Timestamped progress lines: a fixed phase name, elapsed seconds and integer counts only.

    Progress output never decides a release, so nothing here raises into deploy(): a line that fails
    its checks (unknown phase, a count that is not a plain integer) or fails to print is dropped."""
    def __init__(self, clock=time.monotonic, out=print):
        self.clock, self.out = clock, out
        self.start = self.last = clock()

    def mark(self, phase, **counts):
        """Prints one phase line; returns whether it was printed. Never raises."""
        try:
            if phase not in PHASES: return False
            if not all(re.fullmatch(r"[a-z_]+",k) and type(v) is int for k,v in counts.items()): return False
            now = self.clock()
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            line = "deploy-phase %s phase=%s phase_s=%.1f elapsed_s=%.1f" % (stamp,phase,now-self.last,now-self.start)
            self.last = now
            self.out(line+"".join(" %s=%d" % item for item in sorted(counts.items())), flush=True)
            return True
        except Exception:
            return False

    def migration(self, release_id, checks):
        """Logs the migration outcome. Never raises: the durable record is migration_checks in the receipt."""
        try:
            skipped = checks.get("plan_after") == "skipped"
            if skipped:
                self.out(json.dumps({"release_id":release_id,"migration_plan_after":"skipped",
                    "reason":checks["reason"]}), flush=True)
            self.mark("migration",pending_before=int(checks["pending_before"]),tasks=int(checks["tasks"]),
                plan_after_skipped=int(skipped))
        except Exception:
            pass

def catalog_request(value, mode, desired):
    """The seed kinds the release asked to load, in load order; [] when not asked (unset, empty or "none").

    The catalogue phase never runs unless asked: only a deploy that carries the migration image may ask, and only
    for "medicine", "lab_test" or both, comma separated. Anything else is refused before the release starts."""
    if value in (None, "", "none"): return []
    kinds = value.split(",")
    require(len(set(kinds)) == len(kinds) and set(kinds) <= set(CATALOG_SEEDS), "INVALID_CATALOG_LOAD_REQUEST")
    require(mode == "deploy" and "database-migration" in desired, "CATALOG_LOAD_NEEDS_MIGRATION_IMAGE")
    return [kind for kind in CATALOG_SEEDS if kind in kinds]

def catalog_seeds(kinds):
    """Each asked seed as this checkout holds it: its version and the file's sha256, by kind, in load order.

    The deploy job checks out the commit the migration image was built from, and the image carries these files
    by name, so a receipt can name a seed that loaded even when the loader's evidence line never arrives. A seed
    missing here is missing from the image: refused (CATALOG_SEED_MISSING) before the release starts."""
    seeds = {}
    for kind in kinds:
        try:
            data = (ROOT/"docs/codes"/pathlib.PurePosixPath(CATALOG_SEEDS[kind]).name).read_bytes()
            seed = json.loads(data)
        except (OSError, ValueError):
            raise ReleaseError("CATALOG_SEED_MISSING") from None
        require(isinstance(seed, dict) and seed.get("kind") == kind and isinstance(seed.get("version"), str),
                "CATALOG_SEED_MISSING")
        seeds[kind] = {"version":seed["version"],"file_sha256":sha(data)}
    return seeds

def catalog_outcome(line, kind):
    """The loader's evidence line as the receipt records it, or None when it is not one for this kind: every field the
    receipt records must be there ("replaced" too, null when nothing was replaced)."""
    try: outcome = json.loads(line)
    except ValueError: return None
    if not (isinstance(outcome, dict) and outcome.get("status") == "loaded" and outcome.get("kind") == kind
            and "replaced" in outcome
            and isinstance(outcome.get("version"), str) and type(outcome.get("items")) is int
            and all(isinstance(outcome.get(k), str) and re.fullmatch(r"[0-9a-f]{64}", outcome[k])
                    for k in ("fileSha256","approvalsSha256"))
            and (outcome.get("replaced") is None or isinstance(outcome.get("replaced"), str))): return None
    return {"kind":kind,"status":"loaded","version":outcome["version"],"file_sha256":outcome["fileSha256"],
            "approvals_sha256":outcome["approvalsSha256"],"items":outcome["items"],"replaced":outcome["replaced"]}

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
            if not receipt.get(key): continue
            if key == "vex_sha256" and component == "gateway" and not receipt.get("assessment_sha256"):
                # The gateway's VEX is the committed, owner-approved file (Q99 A), not a per-build one.
                require(file_sha(ROOT/GATEWAY_VEX) == receipt[key], "ASSESSMENT_CHANGED")
            else:
                require(file_sha(path.with_name(name)) == receipt[key], "ASSESSMENT_CHANGED")
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
        self.migration_checks = None
        self.catalog_checks = None

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
        return self.look(component, expected, seen_expected)

    def look(self, component, expected, seen_expected, service=None):
        """check() without the lease read: the caller checks the lease once for a batch of read-only looks."""
        service = service or self.service(component)
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
        """Verifies all 12 services (revision, image, container health, Cloud Map, targets), side by side.

        Every call here is a read, so the lease is read once for the whole snapshot; any one service
        failing fails the snapshot, as before."""
        self.lease.assert_owned()
        rows = parallel(self.current, COMPONENTS, READ_POOL)
        return dict(zip(COMPONENTS, rows))

    def current(self, component, deadline=30):
        """The live, settled revision of one service: the same looks as healthy(), reusing the first describe."""
        service = self.service(component)
        expected = service["taskDefinition"]
        end = time.monotonic()+deadline
        seen_expected = False
        while time.monotonic() < end:
            result, seen_expected = self.look(component, expected, seen_expected, service)
            if result: break
            service = None
            time.sleep(10)
        else:
            raise ReleaseError("ECS_HEALTH_TIMEOUT")
        service, definition = result
        container = next(c for c in definition["containerDefinitions"] if c["name"] == component)
        image(component, container["image"])
        return {"image_uri":container["image"],"task_definition":service["taskDefinition"],
            "config_sha256":task_config_hash(definition,component)}

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

    def prepare(self, targets):
        """Builds each service's new task definition and protects every image it touches, before any registration.

        Reads run side by side; each distinct image is protected once (ECR reads, then put-image after a
        lease check) in a pool of PROTECT_POOL. Returns ({component: payload}, number of images protected)."""
        names = list(targets)
        def read(component):
            service = self.service(component)
            definition = self.definition(service["taskDefinition"])
            payload = task_payload(definition,component,targets[component])
            # Protect application and any unchanged token-agent image before replacing tasks.
            images = [(component,targets[component]),
                      (component,next(c["image"] for c in definition["containerDefinitions"] if c["name"] == component))]
            images += [("identity-api",c["image"]) for c in definition["containerDefinitions"] if c["name"] == "workload-token-agent"]
            return payload, images
        rows = parallel(read, names, READ_POOL)
        images = list(dict.fromkeys(item for _,found in rows for item in found))
        parallel(lambda item: self.protect_image(*item), images, PROTECT_POOL)
        return {name:row[0] for name,row in zip(names,rows)}, len(images)

    def register(self, component, uri):
        payloads,_ = self.prepare({component:uri})
        return self.register_prepared(component,payloads[component])

    def register_prepared(self, component, payload):
        """Registers one prepared definition (serial; a mutation, after a lease check)."""
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
        if not targets: return
        for component, arn in targets.items():
            self.lease.assert_owned()
            self.aws.call("ecs","update-service",{"cluster":CLUSTER,"service":"hid-production-"+component,
                "taskDefinition":arn},mutation=True)
        end = time.monotonic()+deadline
        seen = dict.fromkeys(targets, False)
        pending = list(targets)
        while True:
            # One lease read per sweep; the sweep itself only reads, every pending service side by side.
            self.lease.assert_owned()
            looks = parallel(lambda component: self.look(component, targets[component], seen[component]), pending, READ_POOL)
            for component, (result, seen[component]) in zip(list(pending), looks):
                if result: pending.remove(component)
            if not pending: return
            if time.monotonic() >= end: raise ReleaseError("ECS_HEALTH_TIMEOUT")
            time.sleep(ROLLOUT_POLL_SECONDS)

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
        tasks = []
        def run(mode,phase=None):
            self.lease.assert_owned()
            tasks.append(phase or mode)
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
            self.migration_checks = {"pending_before":pending,"plan_after":"ran","tasks":len(tasks)}
        else:
            # Plan-before saw nothing pending and this release started no task since, under the same
            # lease: a second plan task could only repeat that answer. Record that it was skipped and why.
            self.migration_checks = {"pending_before":0,"plan_after":"skipped","reason":SKIPPED_PLAN_AFTER,"tasks":len(tasks)}
        return definition["taskDefinitionArn"]

    def load_catalog(self, arn, network, release_id, seeds):
        """ORD-7's governed loader, after the migrations succeeded: one task per seed file (seeds: catalog_seeds)
        on the migration task definition this release registered, its command overridden. A refusal (exit 2,
        nothing loaded) stops the release, and so does any other non-zero exit; either way the loader's last line is
        printed. A task that exits 0 has loaded its seed, so the checks name it as loaded at once (kind, version and
        sha256 from the checkout, "evidence pending"), before its log is read. Then its evidence line replaces that
        entry; without one, the entry says "evidence line missing" and the release stops with
        CATALOG_LOAD_EVIDENCE_MISSING; if the log cannot be read (throttling, the lease check), it says "evidence
        unreadable" and the release stops with that error. A loader whose last line says the connection was lost
        during its commit may have loaded: the checks name the seed as "outcome unknown" (kind, version and sha256
        from the checkout) and the release stops with CATALOG_LOAD_OUTCOME_UNKNOWN."""
        self.catalog_checks = []
        for kind, seed in seeds.items():
            self.lease.assert_owned()
            task = self.aws.call("ecs","run-task",{"cluster":CLUSTER,"taskDefinition":arn,"launchType":"FARGATE",
                "clientToken":sha((release_id+"catalog-"+kind).encode()),
                "networkConfiguration":{"awsvpcConfiguration":network},"enableExecuteCommand":False,
                "overrides":{"containerOverrides":[{"name":"database-migration",
                    "command":["scripts/load-catalog.mjs","--seed",CATALOG_SEEDS[kind]]}]}},mutation=True)
            require(not task.get("failures") and len(task.get("tasks",[])) == 1, "CATALOG_LOAD_START_FAILED")
            task_arn = task["tasks"][0]["taskArn"]
            end = time.monotonic()+600
            while True:
                require(time.monotonic() < end, "CATALOG_LOAD_TIMEOUT")
                self.lease.assert_owned()
                rows = self.aws.call("ecs","describe-tasks",{"cluster":CLUSTER,"tasks":[task_arn]})
                require(not rows.get("failures") and len(rows.get("tasks",[])) == 1, "CATALOG_LOAD_TASK_MISSING")
                if rows["tasks"][0]["lastStatus"] == "STOPPED": break
                time.sleep(5)
            codes = [c.get("exitCode") for c in rows["tasks"][0]["containers"]]
            if all(code == 0 for code in codes):
                # Exit 0 is a committed load: the version is live whatever the log says or whether it can be read,
                # so the checks (and any receipt written after a failure) name it now, before the log is read.
                check = {"kind":kind,"status":"loaded","version":seed["version"],"file_sha256":seed["file_sha256"],
                         "evidence":EVIDENCE_PENDING}
                self.catalog_checks.append(check)
                try:
                    line, _ = self.catalog_line(task_arn,CATALOG_LOADED)
                except Exception:
                    check["evidence"] = EVIDENCE_UNREADABLE
                    self.print_loaded(release_id,check)
                    raise
                outcome = catalog_outcome(line,kind) if line is not None else None
                if outcome is None:
                    check["evidence"] = EVIDENCE_LINE_MISSING
                    self.print_loaded(release_id,check)
                    raise ReleaseError("CATALOG_LOAD_EVIDENCE_MISSING")
                self.catalog_checks[-1] = outcome
                continue
            # Any other exit: the loader's last line (its refusal or failure line, else whatever it printed last).
            line, last = self.catalog_line(task_arn,CATALOG_LAST_LINE)
            if line is not None and CATALOG_COMMIT_UNKNOWN.fullmatch(line):
                # The connection was lost once the loader's COMMIT was sent: the version may have committed. The checks
                # (and the failed receipt) name the seed so; asking for the same load again settles it.
                self.catalog_checks.append({"kind":kind,"status":OUTCOME_UNKNOWN,"version":seed["version"],
                                            "file_sha256":seed["file_sha256"]})
                print(json.dumps({"release_id":release_id,"catalog_load":OUTCOME_UNKNOWN,"kind":kind,"exit_codes":codes,
                    "message":line}), flush=True)
                raise ReleaseError("CATALOG_LOAD_OUTCOME_UNKNOWN")
            refused = 2 in codes
            print(json.dumps({"release_id":release_id,"catalog_load":"refused" if refused else "failed","kind":kind,
                "exit_codes":codes,"message":line if line is not None else last}), flush=True)
            raise ReleaseError("CATALOG_LOAD_REFUSED" if refused else "CATALOG_LOAD_FAILED")

    @staticmethod
    def print_loaded(release_id, check):
        """The line naming a seed that loaded without its evidence line: kind, version, sha256 and why."""
        print(json.dumps({"release_id":release_id,"catalog_load":"loaded","kind":check["kind"],"version":check["version"],
            "file_sha256":check["file_sha256"],"evidence":check["evidence"]}), flush=True)

    def catalog_line(self, arn, pattern):
        """The loader's line matching pattern in the task's log (the migration log group), and the log's last line:
        polls reads only, never re-runs a task, and after 90 seconds returns (None, the last line or None)."""
        end = time.monotonic()+90
        last = None
        while time.monotonic() < end:
            self.lease.assert_owned()
            try:
                events = self.aws.call("logs","get-log-events",{"logGroupName":"/hid/staging/database-migration",
                    "logStreamName":"migration/database-migration/"+arn.split("/")[-1],"startFromHead":True}).get("events",[])
                lines = [e["message"] for e in events if isinstance(e.get("message"), str) and e["message"].strip()]
                if lines: last = lines[-1]
                found = [line for line in lines if pattern.fullmatch(line)]
                if found: return found[-1], last
            except ReleaseError as error:
                if str(error) != "AWS_ResourceNotFoundException": raise
            time.sleep(5)
        return None, last

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
    catalog = catalog_seeds(catalog_request(os.environ.get("CATALOG_LOAD"), mode, candidate["evidence"]))
    github = GitHub(ctx["repository"])
    phases = Phases()
    # The approval step before cloud credentials already waited for GitHub's job records to settle.
    approval = github.assert_approval(candidate, settle=120)
    phases.mark("approval")
    aws = AWS()
    aws.account()
    store = Store(aws)
    lease = Lease(aws,candidate["release_id"]).acquire()
    phases.mark("lease")
    reconciled, started, previous, updated = False, False, None, []
    alert_failed = False
    receipt_key = "production/releases/"+candidate["release_id"]+"/"
    try:
        index, index_meta = store.read(INDEX_KEY)
        validate_index(index)
        ecs = ECS(aws,lease)
        previous = ecs.snapshot()
        phases.mark("snapshot-before",services=len(previous))
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
        phases.mark("receipt-started")
        migration_arn = index.get("migration_task_definition")
        if "database-migration" in desired:
            settings = json.loads(os.environ["RELEASE_CONFIG_JSON"])
            require(settings.get("account") == ACCOUNT and settings.get("region") == REGION, "STAGING_RELEASE_CONFIG_REQUIRED")
            require(settings["migration_network"] == index["migration_network"], "MIGRATION_NETWORK_DIFFERS_FROM_INDEX")
            settings["migration_task_definition"] = index["migration_task_definition"]
            migration_arn = ecs.migrate(desired["database-migration"],candidate["schema_change"],settings,candidate["release_id"])
            phases.migration(candidate["release_id"],ecs.migration_checks)
            if catalog:
                # Only when asked, and only once the migrations succeeded: the same task definition, the loader's command.
                ecs.load_catalog(migration_arn,settings["migration_network"],candidate["release_id"],catalog)
                phases.mark("catalog",seeds=len(catalog))
        # The services roll out side by side; the gateway, which routes to them, follows once they are healthy.
        rollout = [name for name in ORDER if name in desired]
        for label, wave in (("services",[n for n in rollout if n != "gateway"]), ("gateway",[n for n in rollout if n == "gateway"])):
            if not wave: continue
            # Reads and image protection for the whole wave first; nothing is registered or updated yet.
            payloads, protected = ecs.prepare({name:desired[name] for name in wave})
            targets = {}
            for name in wave:
                arn = ecs.register_prepared(name,payloads[name])
                # Record mutation intent durably before sending update-service (including uncertain responses).
                store.put(receipt_key+"intent-"+name+".json",{"component":name,"prior":previous[name],
                    "target_task_definition":arn})
                updated.append(name)
                targets[name] = arn
            phases.mark("register-"+label,services=len(targets),images=protected)
            ecs.update_all(targets)
            phases.mark("rollout-"+label,services=len(targets))
        after = ecs.snapshot()
        phases.mark("snapshot-after",services=len(after))
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
            "candidate":candidate,"before":index["backend"],"after":new_backend,"migration_task_definition":migration_arn,
            **({"migration_checks":ecs.migration_checks} if ecs.migration_checks else {}),
            **({"catalog_checks":ecs.catalog_checks} if ecs.catalog_checks else {})})
        reconciled = True
        phases.mark("index-and-receipt")
        try: notify(aws,candidate,"success" if mode == "deploy" else "rollback-success")
        except ReleaseError:
            alert_failed = True
            print(json.dumps({"release_id":candidate["release_id"],"alert_status":"failed"}))
        phases.mark("notify")
        print(json.dumps({"release_id":candidate["release_id"],"status":"success","components":updated}))
    except Exception as error:
        # Never retry an uncertain update blindly. Describe live state, then restore only this release's intent targets.
        if started and previous is not None:
            try:
                lease.assert_owned()
                ecs.update_all({name:previous[name]["task_definition"] for name in reversed(updated)})
                phases.mark("rollback-rollout",services=len(updated))
                after = ecs.snapshot()
                phases.mark("rollback-snapshot",services=len(after))
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
                    "before":previous,"after":after,
                    # A catalogue version loaded before the failure stays loaded (each seed is its own transaction);
                    # a seed whose commit lost its connection is named with its outcome unknown.
                    **({"catalog_checks":ecs.catalog_checks} if ecs.catalog_checks else {})})
                reconciled = True
                phases.mark("rollback-index")
            except Exception:
                # Lease loss/uncertain rollback blocks takeover until explicit reconciliation.
                reconciled = False
        if not started: reconciled = True
        try:
            checks = ecs.catalog_checks or []
            loaded = [{"kind":k["kind"],"version":k["version"]} for k in checks if k.get("status") == "loaded"]
            unknown = [{"kind":k["kind"],"version":k["version"]} for k in checks if k.get("status") == OUTCOME_UNKNOWN]
            if loaded or unknown:
                # The runbook (planned contract, ORD-7): a loaded version stays loaded and loading it again is refused;
                # a load whose outcome is unknown is asked for again (only that seed), which settles it. Unreconciled
                # (the lease lost, or a rollback that could not be confirmed), the release is reconciled first.
                step = NEXT_AFTER_UNKNOWN.format(",".join(k["kind"] for k in unknown)) if unknown else NEXT_AFTER_LOAD
                print(json.dumps({"release_id":candidate["release_id"],
                    **({"catalog_loaded_before_failure":loaded} if loaded else {}),
                    **({"catalog_outcome_unknown":unknown} if unknown else {}),
                    "next":step if reconciled else RECONCILE_FIRST+step}), flush=True)
        except Exception: pass
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
