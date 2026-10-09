# Event Dispatcher Deployment and Container Acceptance

Date: 2026-08-11
Classification: implemented with external environment verification pending

## 2026-08-12 notification-routing addendum

The regional IaC now includes the first governed consumer target: one
allowlisted ordinary-notification EventBridge rule, KMS-encrypted SQS queue and
DLQ, and Notification Worker. Authentication OTP never uses this path. Any
statement below that no EventBridge rule, queue, or consumer exists describes
the earlier dispatcher-only checkpoint and is retained as historical evidence.
Live AWS delivery/redrive/provider behavior remains externally pending.

## 1. Scope and outcome

This acceptance phase reviews the existing neutral event dispatcher as a
deployable artifact. It does not redesign delivery, add an event producer,
invent a consumer, or change the durable inbox transaction rule. Applied
migrations `0001` through `0026` remain unchanged.

The dispatcher is structurally ready for an immutable container build and an
ECS/Fargate task definition. Host-process, PostgreSQL, least-privilege,
verified-TLS, concurrency, health, metrics, configuration, and shutdown
acceptance pass. Docker, a container scanner, AWS credentials/resources, ECR,
ECS/Fargate, and CloudWatch are absent from this environment, so image and live
AWS evidence remain external.

## 2. Source and production-build state

The deployable package is `services/event-dispatcher`, with an independent
lockfile, strict TypeScript configuration, tests, production build, and exact
`node dist/main.js` entry point. It imports no owning service implementation
and references only the `integration` database command surface.

Fresh acceptance results:

| Check | Result |
| --- | --- |
| Dispatcher lint/typecheck | Passed |
| Dispatcher production build | Passed |
| Dispatcher tests | 5 suites / 18 tests passed |
| Production dependency audit | `npm audit --omit=dev`: 0 vulnerabilities |
| Platform graph/static container and IAM contract | Passed |
| Root production build | Passed for shared client, both frontends, six APIs, OCR worker, and dispatcher |

The npm advisory check is package-level evidence. It is not a container image
or operating-system vulnerability scan.

## 3. Container tooling availability

`docker --version` and `docker info` both returned `docker: command not found`.
Podman, nerdctl, Buildah, Finch, Trivy, Grype, and Syft are also absent. Docker
was not installed and no alternate image build was fabricated.

Consequences:

* image build: not executed;
* image ID/digest and size: unavailable;
* image layer/content inspection: not executed;
* runtime user inside a built image: not executed;
* container health/signal/restart/two-replica execution: not executed; and
* image vulnerability/secret scan: not executed.

## 4. Dockerfile and build-context review

The Dockerfile intentionally uses the repository root as build context but
copies only the dispatcher manifest/lockfile, TypeScript configuration, source,
and compiled output. It never uses `COPY . .`. Both build and runtime stages
use lockfile-enforced `npm ci`; the runtime uses `npm ci --omit=dev` and removes
the npm cache.

The final stage contains only:

* dispatcher `package.json` and `package-lock.json`;
* production `node_modules`; and
* compiled `dist` output.

It does not copy `.env.example`, local env files, repository metadata,
frontends, migrations, tests, source, AWS credentials, database credentials,
or workload-token contents into the runtime stage.

The configured base is `node:22-bookworm-slim`, consistent with the repository
container contract and Node engine requirement. Its live registry digest,
current maintenance status, and operating-system findings require the external
image build/scan pipeline; no digest was invented here.

## 5. Root `.dockerignore` and static secret review

The root ignore file excludes `.git`, `.codex`, `.agents`, `node_modules`,
`dist`, coverage, all non-example env files, private-key/certificate/JWT files,
AWS credential directories, workload-token mounts, secret directories,
temporary PostgreSQL data, logs/debug artifacts, and the reference-only
`upstream_snapshot`.

A filename-only static scan of the dispatcher inputs found no AWS access-key,
private-key, or JWT-shaped secret pattern. This is static source/build-context
evidence only. Final layers still require inspection after a real build.

## 6. Non-root and filesystem contract

The final Dockerfile uses `USER node`; port `3010` is unprivileged. Runtime
source contains no filesystem state writer. Delivery progress, attempts,
leases, retry state, and consumer deduplication remain in PostgreSQL. The
container requires no persistent application volume and is disposable.

The image now sets the container-only status bind to `0.0.0.0`, while ordinary
host development remains loopback-only. `STOPSIGNAL SIGTERM` and a Node-based
readiness `HEALTHCHECK` are present. Actual UID/GID, file readability, and image
filesystem behavior await a real container run.

The dispatcher does not use HID inter-service workload JWTs, so a HID rotating
workload-token mount is not applicable. The Docker context still excludes such
mount files. AWS authentication is delegated to the normal AWS SDK provider
chain and the future ECS task role.

## 7. Configuration and fail-closed behavior

Production configuration requires all of the following:

* dispatcher enabled;
* EventBridge transport selected;
* explicit dispatcher database URL;
* PostgreSQL TLS enabled;
* a valid base64-encoded PEM trust certificate;
* explicit EventBridge bus name;
* valid batch, concurrency, polling, lease, retry, timeout, and drain bounds;
* no static AWS access-key/secret pair; and
* HTTPS for any explicit AWS endpoint override; and
* no global `NODE_TLS_REJECT_UNAUTHORIZED=0` bypass.

Deterministic transport is rejected in production. Disabled transport cannot
be paired with an enabled dispatcher. A disabled dispatcher cannot name an
active transport. Production database URLs containing `ssl`, `sslmode`,
`sslcert`, `sslkey`, `sslrootcert`, or `sslnegotiation` query parameters are
rejected so the URL cannot replace the dedicated verified-CA settings with
`no-verify` or plaintext behavior. Production also rejects Node's global TLS
verification-disable switch.

Local development remains explicit: disabled by default, deterministic only
when selected, and plaintext PostgreSQL only when its TLS flag is explicitly
false.

## 8. Health, readiness, and metrics

The built host process returned:

* liveness `200` with `status=live`;
* readiness `200` with `acceptingDispatch=true`;
* database dependency `ready`;
* deterministic transport dependency `ready`; and
* Prometheus metrics with three delivered events, zero pending/claimed/retry/
  terminal rows, three successes, zero failures/retries, and bounded average
  latency.

The current status listener also exposes private read-only
`GET /api/v1/operations/failures?limit=<bounded>` for the Identity-owned Admin
aggregation path. It is backed by an exact command-owned database function and
whitelists PHI-minimal terminal evidence; it exposes no payload and provides no
retry mutation.

Readiness now checks both PostgreSQL and the configured transport and reports
only safe `ready`, `unavailable`, or `unknown` dependency states. It returns
`503` when disabled, starting, draining, database-unavailable, or
transport-unavailable. EventBridge readiness uses `DescribeEventBus` against
the exact configured bus.

The image health check calls `/api/v1/health/ready`, not liveness, so a process
with unavailable required dependencies is not reported healthy.

## 9. Database connectivity and representative LOGIN

A fresh disposable PostgreSQL 16.14 cluster applied all 26 migrations, then
passed runtime-role provisioning/catalog assertions and the complete
rollback-only schema/RLS suite.

A temporary passwordless acceptance LOGIN was created only inside that
disposable cluster:

```text
hid_event_dispatcher_acceptance LOGIN
        |
        `--> hid_event_dispatcher NOLOGIN
```

The built dispatcher connected as that LOGIN and delivered a synthetic,
PHI-free `PatientRegistered` envelope through deterministic transport. The
database recorded both `delivered` state and a `delivered` attempt.

Catalog and negative checks proved:

* membership was exactly `hid_event_dispatcher`;
* all four delivery/status commands were executable;
* no direct domain-outbox or integration-state table access existed;
* Identity, EHR, Lab, Pharmacy, OCR, and Outreach mutations each failed with
  PostgreSQL `42501`;
* the LOGIN was not superuser, database creator, role creator, or BYPASSRLS;
  and
* the LOGIN owned no protected schema or table.

The temporary LOGIN was dropped, its absence was confirmed, the cluster was
stopped, and the entire temporary cluster directory was removed. No password
or credential was committed. A real environment-specific production LOGIN is
still unverified and must be provisioned outside migrations.

## 10. PostgreSQL TLS

The disposable PostgreSQL cluster was restarted with TLS and a temporary local
CA. The production dispatcher database configuration connected successfully,
`pg_stat_ssl` confirmed TLS, certificate verification remained enabled, and a
different untrusted CA was rejected. Production URL-based TLS overrides and
malformed base64/PEM trust material are also covered by unit tests.

This proves application behavior, not the production network or RDS trust
chain. Production still requires the approved RDS endpoint, current CA,
private network/security groups, TLS enforcement, and an environment-specific
non-owner LOGIN.

## 11. EventBridge adapter and destination safety

The adapter uses the AWS SDK credential provider chain, `maxAttempts: 1`, a
caller-owned timeout, and batches of at most ten. Bus name comes only from
trusted configuration. Source is derived from the registered producer as
`ng.hid.<producer>` and detail type from the accepted contract as
`<event-type>.v<version>`. Producer payload cannot select a region, endpoint,
bus, source, or detail type.

`Detail` is exactly the previously accepted immutable, recursively validated,
PHI-minimal envelope. No additional transport payload is added. Unit evidence
continues to prove per-entry partial success, safe timeout/authorization
classification, and independent delivered/failure recording.

No AWS region, profile, web-identity file, ECS credential endpoint, bus name,
AWS CLI, or live authorized bus was present. Live `PutEvents`, denied IAM,
wrong-bus failure, provider partial response, and post-acceptance crash-window
execution remain external. They were not simulated as live evidence.

## 12. IAM contract

The checked example policy grants only:

* `events:DescribeEventBus`; and
* `events:PutEvents`

on one exact event-bus ARN. It has no wildcard resource and no S3, KMS,
Textract, RDS administration, IAM, or unrelated permissions. Static platform
verification parses and asserts this allowlist. Actual task-role attachment,
allow behavior, and unrelated-action denial remain live AWS evidence.

## 13. Signal handling and restart recovery

`SIGTERM` now first stops new claims and marks readiness unavailable, while an
in-flight transport call may complete. A configured drain timer bounds that
grace period and aborts the transport only after expiry. EventBridge retains
its independent request timeout, and database commands retain bounded query
timeouts.

A built host process received an actual `SIGTERM`, logged `draining` then
`stopped`, and exited `0`. A unit test proves an in-flight publish is not
aborted at the moment shutdown is requested. The full database suite again
proved expired-lease recovery, stale-token rejection, and the
publish-accepted/database-mark-failed redelivery window.

Container SIGTERM, forced drain timeout, task replacement, and container
restart recovery remain unexecuted because no container runtime exists.

## 14. Horizontal scale and resource bounds

Two independent built dispatcher instances used the same temporary non-owner
LOGIN with batch size one. Each claimed and delivered one distinct event; the
database ended with three delivered events total and no duplicate active
claim.

Configuration bounds pool size, worker concurrency, EventBridge batch size,
poll interval, lease, maximum attempts, exponential retry interval, transport
timeout, and drain timeout. The adapter performs no uncontrolled parallel
publish and keeps at most one bounded batch per configured worker in flight.
These are safe initial controls, not production capacity tuning or load-test
evidence.

Two-container execution and production load/capacity evidence remain external.

## 15. Logs and metrics

Structured JSON logs contain safe operational metadata: stable event and
correlation IDs, event type/version, producer, attempt, transport, duration,
and bounded error codes. Payloads, provider response bodies, tokens, database
URLs, and credentials are not logged.

Prometheus output preserves:

* accepting-dispatch state;
* pending, claimed, retry-scheduled, delivered, and terminal counts;
* oldest pending age;
* success, failure, and retry counts; and
* average successful dispatch latency.

Metrics use no patient, facility, event, or other high-cardinality PHI labels.

## 16. Minimum production monitoring contract

The future deployment should alarm on at least:

* readiness unavailable or task count below desired count;
* database dependency unavailable;
* transport dependency unavailable;
* oldest pending event age above the approved service objective;
* terminal failure count greater than zero;
* sustained delivery failures/retries;
* no successful dispatch while backlog is growing; and
* repeated task restarts or drain-timeout logs.

CloudWatch log groups, metric ingestion, dashboards, and alarms were not
created or verified.

## 17. ECS/Fargate readiness

Static contracts are compatible with ECS/Fargate:

* stateless non-root image configuration;
* unprivileged port `3010`;
* environment/secret-driven configuration;
* task-role credential provider compatibility;
* readiness health check;
* SIGTERM and bounded drain;
* stdout/stderr logs;
* no local persistence dependency; and
* no HID workload-token mount requirement.

The task should run in private networking with RDS and EventBridge reachability,
use the exact-bus task role, deliver the RDS CA through an approved mechanism,
and configure a stop timeout longer than the bounded drain plus database
command allowance. No task definition was created or deployed.

## 18. ECR and immutable image flow

The future publishing flow is:

```text
locked root-context build
    -> operating-system/dependency/secret scan
    -> immutable release tag and image digest
    -> ECR push
    -> digest-pinned ECS task definition
    -> staged health/drain/EventBridge acceptance
```

`latest` must not be the only production identity. No registry login, image
tag, digest, push, or ECR repository operation occurred.

## 19. Security review summary

No deployment change introduced static AWS keys, wildcard IAM, a root runtime
requirement, an image-baked secret, production deterministic fallback,
plaintext token logging, PostgreSQL certificate bypass, cross-domain grants,
or payload-controlled EventBridge destinations.

The applied migration checksum remains:

```text
1a2c2f5269397fb54e6df5bf3ae08bf373b62f68cec3f2104994faa2d8a32f3f
```

No migration was edited or added.

## 20. External evidence still required

| Surface | Status |
| --- | --- |
| Docker build, image size, digest | Not verified; runtime unavailable |
| Final image content/layer and secret inspection | Not verified |
| Container runtime user/health/SIGTERM/restart/two replicas | Not verified |
| Container image vulnerability scan | Not verified; scanner unavailable |
| Live EventBridge success/failure/partial response | Not verified; no authorized AWS environment |
| Live exact-bus IAM allow/deny | Not verified |
| Production dispatcher database LOGIN | Not verified; representative local LOGIN passed |
| Production PostgreSQL TLS/RDS CA/network | Not verified; representative verified TLS passed |
| HID workload-token mount | Not applicable to dispatcher |
| ECS/Fargate task/runtime | Not verified |
| ECR push/digest/task reference | Not verified |
| CloudWatch logs/metrics/alarms | Not verified |
| AWS deployment | Not performed |

## 21. Recommended next stage

An authorized deployment environment should build and scan the exact image,
provision the non-owner LOGIN and trusted RDS TLS path, attach the exact-bus
task role, exercise EventBridge success/failure/partial results, and collect
ECS health/drain/restart/two-replica plus CloudWatch evidence.

Those external gates do not require more local event-delivery redesign. The
governed HID Super Admin foundation has since been implemented in dedicated
`apps/admin/` with Identity-owned administration APIs and no direct database
access. That later integration adds only the safe terminal-failure read surface
described above; it does not change dispatcher delivery semantics or add an
arbitrary retry command. Live image/AWS evidence remains the next external gate.
