"""Portable production release admission, deployment policy, AWS storage and lease primitives.
No workstation profiles, customer data, third-party packages or deployment on import.
"""
import copy
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ACCOUNT = "659225405023"
REGION = "eu-west-1"
CLUSTER = "hid-production"
OWNER_ID = "182018869"
TARGETS = {
    "backend": {"repo": "D-Eminence/hid-system", "id": "1317340803",
                "branch": "staging-novu-ci-20261005", "environment": "production-backend"},
    "frontend": {"repo": "D-Eminence/health", "id": "1428636965",
                 "branch": "main", "environment": "production-frontend"},
}
COMPONENTS = ("identity-api","ehr-api","lab-api","pharmacy-api","ocr-api","ocr-worker",
              "outreach-api","notification-api","notification-worker","event-dispatcher","gateway","support-api")
INDEX_KEY = "production/current.json"
CHECK_SETTLE_SECONDS = 1200
CHECK_POLL_SECONDS = 20

class ReleaseError(RuntimeError):
    pass

def require(condition, code):
    if not condition:
        raise ReleaseError(code)

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()

def sha(value):
    return hashlib.sha256(value).hexdigest()

def file_sha(path):
    with pathlib.Path(path).open("rb") as source:
        digest = hashlib.file_digest(source, "sha256")
    return digest.hexdigest()

def now():
    return dt.datetime.now(dt.timezone.utc)

def timestamp(value):
    require(isinstance(value, str), "TIMESTAMP_REQUIRED")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ReleaseError("INVALID_TIMESTAMP") from None
    require(parsed.tzinfo is not None, "UTC_TIMESTAMP_REQUIRED")
    return parsed

def atomic_json(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, mode="wb", delete=False) as output:
        temporary = pathlib.Path(output.name)
        output.write(canonical(value) + b"\n")
    os.replace(temporary, path)

def git(*args, cwd=None):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=60)
    require(result.returncode == 0, "GIT_READ_FAILED")
    return result.stdout.strip()

def context(kind, env=None):
    env = os.environ if env is None else env
    target = TARGETS[kind]
    require(env.get("GITHUB_ACTIONS") == "true", "GITHUB_ACTIONS_REQUIRED")
    require(env.get("GITHUB_REPOSITORY") == target["repo"]
            and env.get("GITHUB_REPOSITORY_ID") == target["id"]
            and env.get("GITHUB_REPOSITORY_OWNER_ID") == OWNER_ID, "UNTRUSTED_REPOSITORY")
    require(env.get("GITHUB_REF") == "refs/heads/" + target["branch"], "UNTRUSTED_BRANCH")
    require(env.get("GITHUB_EVENT_NAME") in ("push","workflow_dispatch"), "UNTRUSTED_EVENT")
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")), "EXACT_COMMIT_REQUIRED")
    require(all(re.fullmatch(r"[1-9][0-9]*", env.get(k, "")) for k in ("GITHUB_RUN_ID","GITHUB_RUN_ATTEMPT")), "EXACT_RUN_REQUIRED")
    mode = env.get("PRODUCTION_APPROVAL_MODE", "protected")
    require(mode in ("automatic", "protected"), "INVALID_PRODUCTION_APPROVAL_MODE")
    return {"kind": kind, "repository": target["repo"], "repository_id": target["id"],
            "owner_id": OWNER_ID, "branch": target["branch"], "environment": target["environment"],
            "source_commit": env["GITHUB_SHA"], "run_id": env["GITHUB_RUN_ID"],
            "run_attempt": env["GITHUB_RUN_ATTEMPT"], "approval_mode": mode}

def make_candidate(ctx, components, evidence, checks, schema=None, dependencies=None, rollback_ref=None):
    require(bool(components) and len(components) == len(set(components)), "EXACT_COMPONENT_SET_REQUIRED")
    require(checks and all(v == "success" for v in checks.values()), "REQUIRED_CHECKS_FAILED_OR_SKIPPED")
    start = now()
    candidate = {"schema":"hid.production-release/v1", **ctx, "components":components,
        "operation":"rollback" if rollback_ref else "deploy", "rollback_ref":rollback_ref,
        "evidence":evidence, "checks":checks, "schema_change":schema or {"changed":False},
        "backend_dependencies":dependencies or {}, "created_at":start.isoformat(),
        "expires_at":(start + dt.timedelta(hours=24)).isoformat()}
    candidate["release_id"] = ctx["kind"] + "-" + ctx["run_id"] + "-" + ctx["run_attempt"] + "-" + sha(canonical(candidate))[:16]
    return candidate

def validate_candidate(candidate, ctx, clock=None):
    require(candidate.get("schema") == "hid.production-release/v1", "UNSUPPORTED_RELEASE_SCHEMA")
    require(all(candidate.get(k) == v for k,v in ctx.items()), "CANDIDATE_SOURCE_OR_RUN_DIFFERS")
    require(candidate.get("checks") and all(v == "success" for v in candidate["checks"].values()), "REQUIRED_CHECKS_FAILED_OR_SKIPPED")
    current = clock or now()
    created, expires = timestamp(candidate["created_at"]), timestamp(candidate["expires_at"])
    require(created <= current + dt.timedelta(minutes=5) and created < expires
            and expires-created <= dt.timedelta(hours=24) and current < expires, "CANDIDATE_EXPIRED_OR_INVALID")
    body = dict(candidate)
    release_id = body.pop("release_id", "")
    expected = ctx["kind"]+"-"+ctx["run_id"]+"-"+ctx["run_attempt"]+"-"+sha(canonical(body))[:16]
    require(release_id == expected, "CANDIDATE_CONTENT_CHANGED")
    return candidate

class GitHub:
    def __init__(self, repo, token=None):
        self.repo = repo
        self.token = token or os.environ.get("GITHUB_TOKEN")
        require(bool(self.token), "GITHUB_TOKEN_REQUIRED")

    def get(self, suffix):
        require(not suffix.startswith("/") and ".." not in suffix, "INVALID_GITHUB_PATH")
        request = urllib.request.Request("https://api.github.com/repos/"+self.repo+("/"+suffix if suffix else ""),
            headers={"Authorization":"Bearer "+self.token, "Accept":"application/vnd.github+json",
                     "X-GitHub-Api-Version":"2022-11-28", "User-Agent":"HID-Production-Release/1"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise ReleaseError("GITHUB_HTTP_"+str(error.code)) from None
        except urllib.error.URLError:
            raise ReleaseError("GITHUB_TRANSPORT_UNAVAILABLE") from None

    def jobs(self, candidate):
        values = []
        for page in range(1, 21):
            body = self.get("actions/runs/"+candidate["run_id"]+"/attempts/"+candidate["run_attempt"]+"/jobs?per_page=100&page="+str(page))
            rows = body.get("jobs", [])
            values.extend(rows)
            if len(rows) < 100:
                return values
        raise ReleaseError("JOB_PAGINATION_LIMIT")

    def assert_checks(self, candidate, settle=CHECK_SETTLE_SECONDS, poll=CHECK_POLL_SECONDS):
        # GitHub can report a finished job as queued or in progress for minutes,
        # so wait for every required job to show a conclusion before judging.
        # A concluded job that did not succeed still fails at once.
        matrix = set()
        if candidate["kind"] == "backend" and candidate.get("operation") != "rollback":
            matrix = {prefix+" ("+component+")" for component in candidate["components"] for prefix in ("build", "publish")}
        end = time.monotonic()+settle
        while True:
            rows = self.jobs(candidate)
            required = [r for r in rows if r.get("name") in matrix or any(
                r.get("name") == prefix or r.get("name","").startswith(prefix+" (") for prefix in candidate["checks"])]
            require(all(r.get("conclusion") in (None, "success") for r in required), "REMOTE_REQUIRED_JOB_FAILED_OR_MISSING")
            if all(r.get("conclusion") is not None for r in required):
                break
            require(time.monotonic() < end, "REMOTE_REQUIRED_JOB_STATUS_UNSETTLED")
            time.sleep(poll)
        required = candidate["checks"]
        for prefix in required:
            matched = [r for r in rows if r.get("name") == prefix or r.get("name","").startswith(prefix+" (")]
            require(matched and all(r.get("conclusion") == "success" for r in matched), "REMOTE_REQUIRED_JOB_FAILED_OR_MISSING")
        if candidate["kind"] == "backend" and candidate.get("operation") != "rollback":
            for component in candidate["components"]:
                for prefix in ("build", "publish"):
                    require(any(r.get("name") == prefix+" ("+component+")" and r.get("conclusion") == "success"
                                for r in rows), "MATRIX_COMPONENT_CHECK_MISSING")

    def assert_current_source(self, candidate):
        meta = self.get("")
        require(str(meta.get("id")) == candidate["repository_id"]
                and str(meta.get("owner",{}).get("id")) == OWNER_ID, "REMOTE_REPOSITORY_CHANGED")
        branch = self.get("branches/"+urllib.parse.quote(candidate["branch"], safe=""))
        require(branch.get("commit",{}).get("sha") == candidate["source_commit"], "CANDIDATE_SUPERSEDED")
        run = self.get("actions/runs/"+candidate["run_id"])
        require(run.get("head_sha") == candidate["source_commit"]
                and str(run.get("run_attempt")) == candidate["run_attempt"]
                and run.get("event") in ("push","workflow_dispatch"), "REMOTE_RUN_DIFFERS")

    def assert_approval(self, candidate, settle=CHECK_SETTLE_SECONDS):
        # Review history is run-scoped. Never reuse an older attempt's approval.
        require(candidate["run_attempt"] == "1", "NEW_WORKFLOW_RUN_REQUIRED_FOR_APPROVAL")
        require(os.environ.get("PRODUCTION_DEPLOYMENT_ENABLED") == "true", "DEPLOYMENT_DISABLED")
        settings = self.get("environments/"+candidate["environment"])
        mode = os.environ.get("PRODUCTION_APPROVAL_MODE", "protected")
        require(mode in ("automatic", "protected"), "INVALID_PRODUCTION_APPROVAL_MODE")
        require(candidate.get("approval_mode", "protected") == mode, "CANDIDATE_APPROVAL_MODE_DIFFERS")
        if mode == "automatic":
            # An explicit automatic policy still binds the environment, branch,
            # successful remote jobs and current source before cloud credentials.
            require(not [r for r in settings.get("protection_rules", [])
                         if r.get("type") != "branch_policy"], "AUTOMATIC_ENVIRONMENT_HAS_PROTECTION_RULES")
            require(settings.get("can_admins_bypass") is False, "ADMIN_BYPASS_NOT_ALLOWED")
            require(settings.get("deployment_branch_policy") == {
                "custom_branch_policies": True, "protected_branches": False}, "EXPLICIT_BRANCH_PROTECTION_REQUIRED")
            policies = self.get("environments/"+candidate["environment"]+"/deployment-branch-policies?per_page=100")
            branches = policies.get("branch_policies", [])
            require(len(branches) == 1 and branches[0].get("name") == candidate["branch"]
                    and branches[0].get("type", "branch") == "branch", "DEPLOYMENT_BRANCH_RULE_DIFFERS")
            self.assert_checks(candidate, settle=settle)
            self.assert_current_source(candidate)
            return {"mode": "automatic", "reviewer_ids": [], "environment_id": settings["id"]}
        rules = [r for r in settings.get("protection_rules",[]) if r.get("type") == "required_reviewers"]
        require(len(rules) == 1 and rules[0].get("prevent_self_review") is True, "ENFORCED_REVIEWER_GATE_REQUIRED")
        require(settings.get("can_admins_bypass") is False, "ADMIN_BYPASS_NOT_ALLOWED")
        # Start with explicit user reviewers. Team membership needs a separate verified API permission contract.
        reviewers = rules[0].get("reviewers",[])
        require(reviewers and all(r.get("type") == "User" for r in reviewers), "EXPLICIT_USER_REVIEWERS_REQUIRED")
        allowed = {r["reviewer"]["id"] for r in reviewers}
        policy = settings.get("deployment_branch_policy") or {}
        require(policy.get("custom_branch_policies") is True and not policy.get("protected_branches"), "EXPLICIT_BRANCH_PROTECTION_REQUIRED")
        policies = self.get("environments/"+candidate["environment"]+"/deployment-branch-policies?per_page=100")
        branches = policies.get("branch_policies",[])
        require(len(branches) == 1 and branches[0].get("name") == candidate["branch"]
                and branches[0].get("type","branch") == "branch", "DEPLOYMENT_BRANCH_RULE_DIFFERS")
        history = self.get("actions/runs/"+candidate["run_id"]+"/approvals")
        matches = [r for r in history if r.get("state") == "approved"
            and r.get("user",{}).get("id") in allowed
            and any(e.get("id") == settings["id"] for e in r.get("environments",[]))]
        require(bool(matches), "RECORDED_AUTHORIZED_APPROVAL_REQUIRED")
        self.assert_checks(candidate, settle=settle)
        self.assert_current_source(candidate)
        return {"reviewer_ids":sorted({r["user"]["id"] for r in matches}), "environment_id":settings["id"]}

class AWS:
    def __init__(self, runner=None):
        self.runner = runner or subprocess.run

    def call(self, service, operation, arguments=None, *, mutation=False, extra=None):
        command = ["aws", service, operation]
        env = dict(os.environ, AWS_REGION=REGION, AWS_DEFAULT_REGION=REGION,
                   AWS_PAGER="", AWS_RETRY_MODE="standard", AWS_MAX_ATTEMPTS="1" if mutation else "3")
        # Capture all CLI output. Secret/error payloads never go to a runner log.
        # The streaming GetObject CLI handler does not accept --cli-input-json.
        # Translate only this closed release-read contract; never drop constraints.
        if service == "s3api" and operation == "get-object" and arguments is not None:
            flags = {"Bucket":"--bucket", "Key":"--key", "VersionId":"--version-id",
                     "ExpectedBucketOwner":"--expected-bucket-owner"}
            require({"Bucket", "Key", "ExpectedBucketOwner"} <= set(arguments) <= set(flags)
                    and all(isinstance(v,str) and v for v in arguments.values()), "INVALID_STREAMING_READ_ARGUMENTS")
            for key, flag in flags.items():
                if key in arguments: command += [flag, arguments[key]]
            return self._run(command,env,extra)
        if arguments is not None:
            with tempfile.TemporaryDirectory() as folder:
                path = pathlib.Path(folder)/"input.json"
                path.write_bytes(canonical(arguments))
                return self._run(command+["--cli-input-json","file://"+str(path)], env, extra)
        return self._run(command, env, extra)

    def _run(self, command, env, extra):
        result = self.runner(command+(extra or [])+["--region",REGION,"--output","json","--no-cli-pager"],
                             env=env, capture_output=True, text=True, timeout=90)
        if result.returncode:
            match = re.search(r"\(([A-Za-z0-9]+)\)", result.stderr or "")
            raise ReleaseError("AWS_"+(match.group(1) if match else "REQUEST_UNCERTAIN"))
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def account(self):
        require(self.call("sts","get-caller-identity").get("Account") == ACCOUNT, "WRONG_AWS_ACCOUNT")

class Store:
    def __init__(self, aws, bucket=None, key=None):
        self.aws = aws
        self.bucket = bucket or os.environ.get("RELEASE_BUCKET", "")
        self.key = key or os.environ.get("RELEASE_KMS_KEY_ARN", "")
        require(self.bucket == "hid-staging-releases-"+ACCOUNT+"-"+REGION, "STAGING_RELEASE_BUCKET_REQUIRED")
        require(re.fullmatch("arn:aws:kms:"+REGION+":"+ACCOUNT+r":key/[a-f0-9-]+", self.key), "STAGING_RELEASE_KEY_REQUIRED")

    def read(self, key, version=None):
        require(key.startswith("production/") and ".." not in key, "INVALID_STORAGE_KEY")
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder)/"object"
            args = {"Bucket":self.bucket,"Key":key,"ExpectedBucketOwner":ACCOUNT}
            if version: args["VersionId"] = version
            meta = self.aws.call("s3api","get-object",args,extra=[str(path)])
            require(meta.get("ServerSideEncryption") == "aws:kms"
                    and meta.get("SSEKMSKeyId") == self.key and meta.get("VersionId"), "ENCRYPTED_VERSIONED_STORAGE_REQUIRED")
            return json.loads(path.read_bytes()), meta

    def put(self, key, value, etag=None):
        require(key.startswith("production/") and ".." not in key, "INVALID_STORAGE_KEY")
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder)/"object"
            path.write_bytes(canonical(value))
            args = {"Bucket":self.bucket,"Key":key,"ContentType":"application/json","ExpectedBucketOwner":ACCOUNT,
                    "ServerSideEncryption":"aws:kms","SSEKMSKeyId":self.key}
            if etag: args["IfMatch"] = etag
            else: args["IfNoneMatch"] = "*"
            result = self.aws.call("s3api","put-object",args,mutation=True,extra=["--body",str(path)])
            require(result.get("VersionId"), "VERSIONED_RECEIPT_REQUIRED")
            return result

    def upload(self, key, path):
        require(key.startswith("production/archives/") and ".." not in key, "INVALID_ARCHIVE_KEY")
        result = self.aws.call("s3api","put-object", {"Bucket":self.bucket,"Key":key,"ExpectedBucketOwner":ACCOUNT,
            "ServerSideEncryption":"aws:kms","SSEKMSKeyId":self.key,"IfNoneMatch":"*"}, mutation=True,extra=["--body",str(path)])
        require(result.get("VersionId"), "VERSIONED_ARCHIVE_REQUIRED")
        return {"key":key,"version_id":result["VersionId"],"sha256":file_sha(path)}

class Lease:
    def __init__(self, aws, holder, table=None, ttl=180):
        self.aws, self.holder, self.ttl = aws, holder, ttl
        self.table = table or os.environ.get("RELEASE_LEASE_TABLE", "")
        require(self.table == "hid-staging-deployment-leases", "STAGING_LEASE_TABLE_REQUIRED")
        self.generation = None
        self.lost = threading.Event()
        self.stop = threading.Event()
        self.thread = None

    def _args(self):
        return {"TableName":self.table,"Key":{"environment":{"S":"hid-production"}}}

    def acquire(self):
        require(bool(self.holder) and len(self.holder) <= 200, "LEASE_HOLDER_REQUIRED")
        expiry = int(time.time())+self.ttl
        args = {**self._args(), "UpdateExpression":"SET holder = :h, expires_at = :e, #s = :active ADD generation :one",
            "ConditionExpression":"attribute_not_exists(holder)",
            "ExpressionAttributeNames":{"#s":"status"},
            "ExpressionAttributeValues":{":h":{"S":self.holder},":e":{"N":str(expiry)},
                ":active":{"S":"active"},":one":{"N":"1"}}, "ReturnValues":"ALL_NEW"}
        # Expired holders are never silently stolen. Explicit reconciliation must release them.
        body = self.aws.call("dynamodb","update-item",args,mutation=True)
        self.generation = body["Attributes"]["generation"]["N"]
        self.thread = threading.Thread(target=self._heartbeat, daemon=True)
        self.thread.start()
        return self

    def assert_owned(self):
        require(self.generation is not None and not self.lost.is_set(), "LEASE_LOST")
        item = self.aws.call("dynamodb","get-item",{**self._args(),"ConsistentRead":True}).get("Item",{})
        require(item.get("holder",{}).get("S") == self.holder
                and item.get("generation",{}).get("N") == self.generation
                and int(item.get("expires_at",{}).get("N","0")) > time.time(), "LEASE_LOST")

    def _heartbeat(self):
        while not self.stop.wait(self.ttl/3):
            try:
                args = {**self._args(), "UpdateExpression":"SET expires_at = :e",
                    "ConditionExpression":"holder = :h AND generation = :g AND expires_at > :now",
                    "ExpressionAttributeValues":{":h":{"S":self.holder},":g":{"N":self.generation},
                        ":e":{"N":str(int(time.time())+self.ttl)},":now":{"N":str(int(time.time()))}}}
                self.aws.call("dynamodb","update-item",args,mutation=True)
            except Exception:
                self.lost.set()
                return

    def release(self, reconciled=True):
        self.stop.set()
        if self.thread: self.thread.join(timeout=2)
        if not reconciled or self.lost.is_set(): return
        self.aws.call("dynamodb","update-item",{**self._args(),
            "UpdateExpression":"REMOVE holder, expires_at SET #s = :ready",
            "ConditionExpression":"holder = :h AND generation = :g",
            "ExpressionAttributeNames":{"#s":"status"}, "ExpressionAttributeValues":{
                ":h":{"S":self.holder},":g":{"N":self.generation},":ready":{"S":"ready"}}},mutation=True)

def validate_index(index):
    require(index.get("schema") == "hid.production-index/v1" and index.get("account") == ACCOUNT
            and index.get("region") == REGION and index.get("environment") == "production"
            and index.get("verified") is True, "VERIFIED_STAGING_INDEX_REQUIRED")
    require(set(index.get("backend",{})) == set(COMPONENTS), "COMPLETE_BACKEND_INDEX_REQUIRED")
    for component, row in index["backend"].items():
        image(component, row.get("image_uri",""))
        require(re.fullmatch("arn:aws:ecs:"+REGION+":"+ACCOUNT+":task-definition/hid-production-"+component+r":[1-9][0-9]*",
                             row.get("task_definition","")), "INDEX_TASK_DEFINITION_DIFFERS")
        require(re.fullmatch(r"[a-f0-9]{64}", row.get("config_sha256", "")), "INDEX_CONFIGURATION_HASH_REQUIRED")
    image("database-migration", index.get("migration_image_uri", ""))
    require(re.fullmatch("arn:aws:ecs:"+REGION+":"+ACCOUNT+r":task-definition/hid-staging-database-migration:[1-9][0-9]*",
                         index.get("migration_task_definition", "")), "INDEX_MIGRATION_TASK_REQUIRED")
    return index

def image(component, uri):
    repo = "ehr-api" if component == "database-migration" else component
    require(component in (*COMPONENTS,"database-migration") and re.fullmatch(
        ACCOUNT+r"\.dkr\.ecr\."+REGION+r"\.amazonaws\.com/staging/hid/"+repo+r"@sha256:[a-f0-9]{64}", uri), "IMMUTABLE_STAGING_IMAGE_REQUIRED")
    return uri


def retain_image(aws, lease, component, uri):
    image(component, uri)
    repository = "staging/hid/"+("ehr-api" if component == "database-migration" else component)
    digest = uri.split("@")[1]
    tag = "retain-"+digest[7:]
    policy = json.loads(aws.call("ecr","get-lifecycle-policy",{"repositoryName":repository})["lifecyclePolicyText"])
    protection = [r for r in policy["rules"] if r["selection"].get("tagPrefixList") == ["retain-"]]
    require(len(protection) == 1 and protection[0]["rulePriority"] == 1
        and protection[0]["selection"].get("countType") == "imageCountMoreThan"
        and protection[0]["selection"].get("countNumber",0) >= 1000000,"ROLLBACK_RETENTION_POLICY_REQUIRED")
    details = aws.call("ecr","describe-images",{"repositoryName":repository,"imageIds":[{"imageDigest":digest}]}).get("imageDetails",[])
    require(len(details) == 1,"ROLLBACK_IMAGE_UNAVAILABLE")
    if tag not in details[0].get("imageTags",[]):
        payload = aws.call("ecr","batch-get-image",{"repositoryName":repository,"imageIds":[{"imageDigest":digest}]})
        require(len(payload.get("images",[])) == 1 and not payload.get("failures"),"IMAGE_MANIFEST_UNAVAILABLE")
        lease.assert_owned()
        aws.call("ecr","put-image",{"repositoryName":repository,"imageManifest":payload["images"][0]["imageManifest"],
            "imageDigest":digest,"imageTag":tag},mutation=True)
    require(any(tag in r.get("imageTags",[]) for r in aws.call("ecr","describe-images",{
        "repositoryName":repository,"imageIds":[{"imageDigest":digest}]}).get("imageDetails",[])),"IMAGE_RETENTION_READBACK_FAILED")

REGISTER_FIELDS = ("family","taskRoleArn","executionRoleArn","networkMode","containerDefinitions",
    "volumes","placementConstraints","requiresCompatibilities","cpu","memory","pidMode","ipcMode",
    "proxyConfiguration","inferenceAccelerators","ephemeralStorage","runtimePlatform","enableFaultInjection")

def task_payload(task, component, uri):
    image(component, uri)
    family = ("hid-staging-" if component == "database-migration" else "hid-production-")+component
    require(task.get("family") == family and task.get("networkMode") == "awsvpc"
            and task.get("runtimePlatform",{}).get("cpuArchitecture") == "ARM64", "UNEXPECTED_TASK_PLATFORM")
    require(all(task.get(role,"").startswith("arn:aws:iam::"+ACCOUNT+":role/hid-staging-")
                for role in ("taskRoleArn","executionRoleArn")), "UNEXPECTED_TASK_ROLE")
    payload = {key:copy.deepcopy(task[key]) for key in REGISTER_FIELDS if key in task}
    name = "database-migration" if component == "database-migration" else component
    matches = [c for c in payload["containerDefinitions"] if c["name"] == name]
    require(len(matches) == 1, "EXACT_PRIMARY_CONTAINER_REQUIRED")
    matches[0]["image"] = uri
    require(all(c["name"] in (name,"workload-token-agent") for c in payload["containerDefinitions"]), "UNEXPECTED_SIDECAR")
    return payload

def task_config_hash(task, component):
    value = {key:copy.deepcopy(task[key]) for key in REGISTER_FIELDS if key in task}
    for container in value.get("containerDefinitions",[]):
        if container["name"] == component: container["image"] = "<release-image>"
    return sha(canonical(value))

def summarize(candidate, path=None):
    lines = ["# HID production release candidate", "", "Deployment policy: "+candidate.get("approval_mode", "protected"), "",
        "Repository: "+candidate["repository"], "Commit: "+candidate["source_commit"],
        "Run/attempt: "+candidate["run_id"]+"/"+candidate["run_attempt"],
        "Release: "+candidate["release_id"], "Operation: "+candidate.get("operation","deploy"),
        "Expires: "+candidate["expires_at"], "",
        "Components: "+", ".join(candidate["components"]), "",
        "Existing required checks: "+", ".join(k+"="+v for k,v in candidate["checks"].items()),
        "Schema changes: "+str(candidate["schema_change"].get("changed",False))
            +(" (reviewed declaration carried forward; applies only if production's pending migrations are exactly: "
              +", ".join(pathlib.PurePosixPath(p).name for p in migration_files(candidate["schema_change"]))+")"
              if candidate["schema_change"].get("carried") else ""),
        "Backend dependencies: "+json.dumps(candidate.get("backend_dependencies",{}),sort_keys=True), "",
        "Build results do not certify untested application features.",
        "Prior verified release is rechecked after policy verification before any mutation.", ""]
    for component, evidence in candidate["evidence"].items():
        lines.append(component+": "+(evidence.get("image_uri") or evidence.get("sha256","")))
    text = "\n".join(lines)+"\n"
    if path: pathlib.Path(path).write_text(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output: output.write(text)
    return text

def notify(aws, candidate, state):
    topic = os.environ.get("RELEASE_ALERT_TOPIC_ARN","")
    require(topic == "arn:aws:sns:"+REGION+":"+ACCOUNT+":hid-staging-operations-alerts", "STAGING_ALERT_TOPIC_REQUIRED")
    aws.call("sns","publish",{"TopicArn":topic,"Subject":"HID production "+state,
        "Message":json.dumps({"release":candidate["release_id"],"repository":candidate["repository"],
            "commit":candidate["source_commit"],"state":state,"components":candidate["components"]})},mutation=True)

MIGRATIONS = "services/ehr-api/database/migrations/"
# The role bootstrap revokes every runtime grant before it applies this file,
# so a migration that grants to a runtime role needs the same grant here, or a
# later bootstrap removes it. The release never applies this file (it runs only
# scripts/apply-migrations.mjs); it is declared and reviewed with the new
# migration that carries the grant to provisioned roles.
RUNTIME_GRANTS = "services/ehr-api/database/runtime-grants.sql"

def migration_files(contract):
    return [name for name in contract.get("files", {}) if name.startswith(MIGRATIONS)]

def schema_contract(root, changed_paths, carry=False):
    affected = [p for p in changed_paths if p.startswith("services/ehr-api/database/")]
    metadata = pathlib.Path(root)/"config/production-schema-compatibility.json"
    if not affected:
        # A release that fails after its schema is reviewed leaves those migrations
        # pending, and the next release diffs from the failed commit, so it would
        # never declare them. Carry the reviewed declaration instead: migrate()
        # still applies only when production's pending set equals its migrations.
        if not carry or not metadata.exists(): return {"changed":False}
        try:
            contract = schema_contract(root, list(json.loads(metadata.read_text()).get("files",{})))
        except (ReleaseError, ValueError, OSError, AttributeError, TypeError, RecursionError):
            return {"changed":False}
        return dict(contract, carried=True) if migration_files(contract) else {"changed":False}
    require(metadata.exists(), "SCHEMA_COMPATIBILITY_EVIDENCE_REQUIRED")
    value = json.loads(metadata.read_text())
    require(value.get("schema") == "hid.schema-compatibility/v1" and value.get("backward_compatible") is True
            and value.get("reviewed_by") and value.get("evidence"), "REVIEWED_BACKWARD_COMPATIBILITY_REQUIRED")
    require(set(value.get("files",{})) == set(affected), "EXACT_SCHEMA_CHANGE_DECLARATION_REQUIRED")
    for name, digest in value["files"].items():
        require((re.fullmatch(re.escape(MIGRATIONS)+r"\d{4}_[a-z0-9_]+\.sql", name) or name == RUNTIME_GRANTS)
                and file_sha(pathlib.Path(root)/name) == digest,
                "SCHEMA_DECLARATION_CONTENT_DIFFERS")
    require(RUNTIME_GRANTS not in value["files"] or migration_files(value), "RUNTIME_GRANTS_NEED_A_MIGRATION")
    return {"changed":True,"contract_sha256":file_sha(metadata),"files":value["files"],
            "backward_compatible":True,"evidence":value["evidence"],"reviewed_by":value["reviewed_by"]}

def changed_paths(root):
    base = os.environ.get("BASE_SHA","")
    require(re.fullmatch(r"[a-f0-9]{40}",base) and not re.fullmatch("0+",base), "KNOWN_COMPARISON_BASE_REQUIRED")
    return git("diff","--name-only",base,"HEAD",cwd=root).splitlines()
