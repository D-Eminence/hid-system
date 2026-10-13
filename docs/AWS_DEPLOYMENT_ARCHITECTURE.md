# HID AWS Deployment Architecture

Status: locally implemented and synthesized; live AWS, Cloudflare, DNS, TLS,
provider, migration, and production behavior remain external acceptance.

## Production boundary

The production model has one regional AWS stack. It deliberately contains no
CloudFront distribution and no AWS-hosted frontend artifacts.

```text
browser
  -> Cloudflare DNS/TLS/WAF
  -> one of the launch Workers Static Assets hosts (www, staging, admin.*;
     ADR-052), serving the Health-id apps/patient-web build
  -> same-origin /api/v1/* Worker proxy
  -> api.healthidentitydirectory.com
  -> regional AWS WAF (origin-secret allow rule + managed/rate rules)
  -> public HTTPS ALB
  -> API-only Gateway
  -> owner API

owner outbox -> Event Dispatcher -> EventBridge
  -> ordinary-notification rule -> encrypted SQS + DLQ
  -> Notification Worker -> Novu / FCM boundary

Identity -> workload-authenticated Notification API
  -> SES / Termii / Meta, with bounded Brevo fallback
     (production at launch: SES email and Termii SMS only, ADR-053)
```

Authentication OTP never enters EventBridge, SQS, Novu, or ordinary delivery
history. The Cloudflare-to-AWS request carries an independent
`x-hid-origin-authorization` secret. The regional WAF rejects a missing or
incorrect value before the ALB target path. This is defense in depth and does
not replace browser authentication, CSRF, authorization, or owner-service
checks. The Gateway does not forward that secret to any backend.

The public API web ACL evaluates, in order (ADR-055):

| Priority | Rule | Action |
|---|---|---|
| 0 | `RequireCloudflareOriginSecret` | Blocks a request without the Worker's `x-hid-origin-authorization` value |
| 10 | `AwsCommonRules` (`AWSManagedRulesCommonRuleSet`) | Every rule blocks except `SizeRestrictions_BODY`, which only counts and labels (`awswaf:managed:aws:core-rule-set:SizeRestrictions_Body`) |
| 11 | `AwsCommonRulesBodySize` | Blocks a labelled request (body over 8 KB) unless it is a `POST` or `PATCH` whose raw path is an encounter-scoped clinical write: `/api/v1/ehr/patients/<uuid>/encounters`, `/<uuid>`, and its `clinical-notes` (with `/<uuid>/revisions`), `diagnoses`, `prescriptions` and `lab-requests` (with `/<uuid>`); lowercase UUIDs, no transformation, so an encoded, dot-segment or case variant keeps the limit (WAF-CRS-BODY) |
| 20 | `AwsKnownBadInputs` | Blocks |
| 30 | `ApiOriginRateLimit` | Blocks a client address over 2,000 requests per 5 minutes, keyed on `X-Real-IP` (`FORWARDED_IP`); an invalid address matches and is blocked; a request without the header is not counted here and the Gateway refuses it (A7) |
| 31 | `ApiOriginEdgeRateLimit` | Blocks a connecting address over 50,000 requests per 5 minutes: the backstop for a leaked origin secret or a request without `X-Real-IP` |

The WAF's body inspection on an ALB covers the first 8 KB, so the other Core
Rule Set body rules inspect only that part of a long clinical note. The body
bound for the exempt routes is the Gateway's `client_max_body_size 512k`
(`413 PAYLOAD_TOO_LARGE`) and ehr-api's own 512 KiB JSON limit. Because every
connection to the ALB comes from the Cloudflare Worker, a limit keyed on the
connecting address would throttle all users behind one Cloudflare egress
address together; the per-client rule keys on the address the Worker took from
`CF-Connecting-IP`, which rule 0 guarantees came from the Worker. A facility or
carrier-grade NAT address counts as one client: watch the
`hid-<env>-origin-rate` metric and raise `API_ORIGIN_CLIENT_RATE_LIMIT`
(`infra/aws/src/hid-regional-stack.ts`) if legitimate clients are blocked
(IP-THRESHOLDS in the release checklist). Keep Cloudflare's Pseudo IPv4 setting
off or in "add header" mode, never "overwrite headers", so `CF-Connecting-IP`
stays the client's real address.

## Client address and gateway routing

The client's address crosses the edge in one header (D-Eminence/hid-system#65):

- The Worker deletes every inbound forwarding header, including any
  `X-Real-IP` the caller sent, and sets `X-Real-IP` from Cloudflare's
  `CF-Connecting-IP` only when that is one valid IPv4 or IPv6 address.
- The Gateway's realip module takes the client address from `X-Real-IP` only
  on connections from the VPC CIDR (`VPC_CIDR`), which in AWS means the public
  ALB. It then sends that address as `X-Forwarded-For` and does not pass
  `X-Real-IP` on; the owner APIs, which trust only the VPC
  (`TRUST_PROXY_CIDRS`), see it as the request address. Per-network limits,
  Turnstile `remoteip` and audit source addresses therefore key on the client,
  not on an ALB node.
- Workers built before this change delete a caller's `X-Real-IP` and set
  none. Behind such a Worker (one not yet redeployed, or rolled back) the
  Gateway finds no client address and refuses the request; it never trusts an
  address the caller chose. Every Worker that proxies `/api/v1` (web, EHR,
  Lab, Pharmacy, OCR, Outreach and admin hosts) must run this change before
  the Gateway requires the header.
- With `HID_REQUIRE_CLIENT_IP=true` (set by CDK in staging and production) an
  API request without a usable client address is refused
  `403 CLIENT_ADDRESS_REQUIRED` before any backend sees it. Identity also
  refuses, in production, a public IP-keyed request whose address is inside
  `TRUST_PROXY_CIDRS`, so a misconfigured edge fails closed rather than
  putting every client in one bucket.

The Gateway resolves its upstream Cloud Map names per request through the
Amazon-provided VPC resolver (`GATEWAY_DNS_RESOLVER`, the VPC CIDR base plus
two; answers cached for 10 seconds). It follows task replacements without a
restart and starts even when a module runs no task; requests to such a module
answer `503 UPSTREAM_UNAVAILABLE`, as do requests to a service that refuses,
resets, times out or closes without answering. A service's own answer, 5xx
included, passes through unchanged with its code, `Set-Cookie` and
`Retry-After` (ADR-055, A8). The Gateway logs one JSON line per request to
stdout (format `hid_api`): the path without its query string, method, status,
timings and request ids, never the request line, query, cookies or
credentials (D7).

`HID_ENABLED_API_ROUTES` lists the modules whose `/api/v1/*` prefixes the
Gateway proxies. Any other module answers `404 API_ROUTE_NOT_FOUND` before
proxying. CDK passes `identity,ehr` (the launch module set) by default; a
staging synth may opt more modules in with the synth input
`HID_ENABLED_API_ROUTES`, and a production synth refuses any module beyond the
launch set. Service-to-service routes (`/api/v1/auth/service-session`,
`/api/v1/identity/service/*`, `/api/v1/identity/outreach/*`,
`/api/v1/ehr/internal/*`, `/api/v1/ehr/documents/scan-events`, and the Lab and
Pharmacy `accept-ehr-*` and `imports/from-ocr` routes) answer
`404 API_ROUTE_NOT_FOUND` at the Gateway in
any letter case, with a trailing slash, dot segments, repeated slashes or
percent-encodings, because callers use the private service names. Every
proxied location also refuses a request target with a backslash before the
query or a `#` anywhere (`400 INVALID_REQUEST_TARGET`): Express would read
such a target as a different path from the one nginx matched, and a browser
cannot send either through the Worker. Disabling a module's routes leaves its
Identity caller subject and EHR's Lab and Pharmacy token files in place:
production configuration validation requires them.

## Environment isolation

Production and staging are separate edge-to-origin trust boundaries. Production
uses `api.healthidentitydirectory.com`, while staging uses
`api.staging.healthidentitydirectory.com`. CDK derives each active hostname
from its typed environment profile and `RootDomainName`; staging therefore
never synthesizes production as its API hostname or browser CORS allowlist.
Each regional stack requires its own no-echo origin authorization parameter
(`ProductionCloudflareOriginSecret` or `StagingCloudflareOriginSecret`). Those
values must be independently generated and installed into the matching
Cloudflare Worker named environment as `ORIGIN_AUTH_TOKEN`; no value is stored
in source, frontend artifacts, or CloudFormation defaults.

## Frontend ownership

**Launch (ADR-052).** Health-id `apps/patient-web` is the single launch
frontend. Only `www` (production), `staging` (staging) and `admin` in both
environments are deployed, each serving the Health-id build staged for that
host with its provenance (`infra/cloudflare/launch-deployment.json`,
`infra/cloudflare/README.md`). The other application hosts in the table below
are configured but not deployed at launch; Lab, Pharmacy, OCR and Outreach are
off (D17), their APIs closed by the gateway's `HID_ENABLED_API_ROUTES`, and
clinicians use the Health-id provider workspace on `www`. hid-system's own
`apps/web` and `apps/admin` are not deployed.

Cloudflare is configured for seven independent static applications:

| Host | Application | Root |
|---|---|---|
| `www.healthidentitydirectory.com` | Web/patient | `/` |
| `ehr.healthidentitydirectory.com` | EHR | `/` |
| `lab.healthidentitydirectory.com` | Lab | `/` |
| `pharmacy.healthidentitydirectory.com` | Pharmacy | `/` |
| `migrate.healthidentitydirectory.com` | HID Migrate | `/` (legacy OCR domain, `/migrate/*`, and `/ocr/*` redirect to root-equivalent paths) |
| `outreach.healthidentitydirectory.com` | Outreach | `/` |
| `admin.healthidentitydirectory.com` | Admin | `/` |

Clinical account recovery and activation has one fixed public route on the
Web/patient application: `/provider/recover` on `www` (and on `staging`), which
opens the clinical account form at its recovery step. Health-id's provider
sign-in pages on the product hosts and on the admin host link there rather than
recovering in place (this repository's own product apps have no such link), because the identity API
accepts the `staff-reset` Turnstile action only from the `www` and `staging`
hostnames. The route takes no return destination; after recovery the person
signs in on that page or returns to their product host themselves.

The apex host performs an originless redirect to `www`. The old OCR hostname
uses a separate originless 308 redirect to the paired Migrate hostname, retaining
the root-equivalent request path and query. Migrate's legacy `/migrate/*` and
`/ocr/*` paths also redirect directly to their root equivalents. Each application Worker serves only its own build,
applies its own permissions policy (and, for the legacy builds, their
service-worker scope; the Health-id build has no service worker or manifest),
and proxies only `/api/v1/*` to the fixed AWS API hostname. HTML, service
workers, and API responses are not cached as durable PHI. Gateway contains no static frontend
output and returns `API_ONLY_ORIGIN` for non-API paths.

Staging has the exact parallel namespace: `staging`, `ehr.staging`,
`lab.staging`, `pharmacy.staging`, `migrate.staging`, `outreach.staging`, and
`admin.staging` under `healthidentitydirectory.com`. A staging Worker can only
proxy to the staging API hostname; it cannot select an origin from request
headers, a path, or a query value.

## Regional AWS resources

The CDK v2 application under `infra/aws` synthesizes:

- a VPC with public edge, private-with-egress application, and isolated
  database subnets;
- one public HTTPS ALB, one internal HTTPS ALB, regional WAF, private service
  discovery, and private DNS;
- eleven independent ECS/Fargate services and one migration task definition;
- eleven immutable, scan-on-push ECR repositories and twelve digest-qualified
  image parameters;
- private encrypted PostgreSQL 16 with TLS enforcement, backups, logs, and
  environment-specific deletion policy;
- a private versioned KMS-encrypted document bucket and the implemented
  Textract boundary;
- one EventBridge bus, one allowlisted ordinary-notification rule, and one
  KMS-encrypted SQS queue with KMS-encrypted DLQ;
- CloudWatch logs, focused runtime/data alarms, and bounded metrics; every
  alarm notifies the environment's operator-created topic
  `hid-<env>-operational-alerts` on ALARM and OK (required in production,
  ADR-053); and
- S3 gateway plus ECR, Logs, Secrets Manager, KMS, EventBridge, SQS, and
  Textract interface endpoints.

Staging and production additionally have a regional API Gateway and Lambda
workload-token issuer backed by a retained P-256 KMS signing key (ADR-047,
accepted). `POST /token` requires AWS IAM authentication;
`GET /.well-known/jwks.json` publishes only the public key. Each method has its
own throttle (30 requests per second, burst 60). Wherever NAT gateways exist
(staging economy and fidelity, production), a second REGIONAL web ACL on the
issuer stage blocks every source except the VPC's NAT gateway Elastic IPs. The
staging issuer is present in every staging mode, including sleep, where it has
no web ACL (no NAT gateway and no running task). Production has its own issuer
of the same design, with its own key, API, `/production` stage and
`hid:production:<service>` subjects. Development retains its external
workload-identity contract and has no issuer API Gateway or Lambda. There is no SNS, Redis,
search cluster, Bedrock resource, CloudFront distribution, or duplicate
frontend host in the regional design.

## Cost-safe staging modes

Staging has no implicit configuration. `HID_STAGING_MODE` must be exactly one
of:

- `sleep`: all ECS desired counts zero; no ALB, WAF association, NAT gateway,
  interface endpoint, public load-balancer IPv4, or autoscaling target. RDS is
  single-AZ and retained with deletion protection, backups and storage; the
  controlled operation stops compute and a staging-only daily schedule re-stops
  the exact instance after AWS automatic restart. S3/KMS, secrets, ECR, logs,
  EventBridge/SQS and DNS metadata remain, as do the stable workload issuer,
  public JWKS endpoint, and fourth KMS key. The issuer has no web ACL in sleep:
  there is no NAT address to allow and no task to call it; its method throttles
  still apply. Token-agent task definitions remain present, but zero ECS tasks
  means no running token agents.
- `economy`: two AZs, one NAT, ECR API/Docker, Logs, Secrets Manager,
  EventBridge, SQS, and Textract endpoints in one AZ plus S3 gateway, two ALBs
  and regional WAF, the issuer's NAT-allowlist web ACL, one Gateway/
  request API replica, workers default zero, bounded worker/API scaling, and a
  single-AZ `db.t4g.small` database with 100 GiB initial storage.
  ECR and Logs endpoints let Gateway and restricted workers bootstrap without
  public HTTPS egress. The live staging migration task can reach only its
  database, the endpoint security group on HTTPS, and the S3 managed prefix
  list for image layers; sleep keeps those migration HTTPS paths closed.
- `fidelity`: two AZs, two NAT gateways, all eight interface endpoints in both
  AZs, two ALBs/WAF, the issuer's NAT-allowlist web ACL, multiple request
  replicas, live workers, Multi-AZ RDS, and
  release/failover/load/migration/provider/rollback parity testing.

Persistent data/security resources and ephemeral ingress/runtime resources are
selected independently by the profile. A sleep transition removes application
ingress while retaining protected data and the workload issuer. It is never
described as zero cost.
Production remains three AZs, Multi-AZ RDS, two NAT gateways, full endpoints,
two ALBs/WAF, the issuer's NAT-allowlist web ACL, and at least two replicas per
enabled service once rolled out: every production desired count defaults to
zero, and the reviewed I6 parameter file raises each enabled service to its live
minimum (ADR-053). The current 3-AZ/2-NAT
shape means one application AZ can share cross-AZ egress during an AZ failure;
a measured third-NAT or alternative-egress evolution is documented capability,
not silently provisioned cost.

## Elasticity and observability

Each runtime has an independent desired count, normal maximum, reviewed
emergency maximum, CPU/memory targets and cooldowns. Request services also use
ALB request count; their p95 latency and aggregate 5xx rates are alarms rather
than high-cardinality scaling dimensions. Notification Worker scales on SQS
visible backlog with oldest age/drain visibility. OCR Worker scales on PHI-free
queue depth and emits age, claims, processed pages, retries, failed pages and
duplicates avoided. Queue depth and age are logged with each claim (from
migration 0075), so a worker that claims nothing emits neither. Event Dispatcher scales on PHI-free outbox depth and emits
oldest age/drain rate without weakening at-least-once delivery.

Typed database pool sizes are part of this contract. Synthesis sums each
service's maximum task count times its pool size and fails if it exceeds the
normal or separately reviewed emergency budget. RDS uses the currently
supported Database Insights Standard mode; the design does not raise
PostgreSQL `max_connections` to make an unsafe scale plan appear viable.

A module outside the enabled set (D17: Lab, Pharmacy, OCR API and worker and
Outreach unless `HID_ENABLED_API_ROUTES` names them, and the Notification
Worker unless `HID_NOTIFICATION_WORKER_ENABLED`, fixed to false in production)
is pinned at zero tasks in every environment: its desired count and scaling
ceiling allow only zero, its scaling target has no policy, and it has no alarm.

Every alarm notifies the environment's operator-created SNS topic
`hid-<env>-operational-alerts` (customer-managed KMS key, exact ARN from the
synth input `HID_OPERATIONAL_ALARM_TOPIC_ARN`; production refuses to synthesize
without it) on ALARM and on OK (ADR-053). Besides the RDS, task, request,
queue, OCR, outbox and log-volume alarms, the workload issuer has Lambda
`Errors` and `Throttles` and stage `5XXError` and `4XXError` alarms (API
Gateway counts 429s in `4XXError`), a literal-text metric filter counts the
token agent's `Workload token renewal unavailable` line on each enabled token
task, and a metric filter counts notification-api's PHI-free
`notification.otp.outcome` lines with outcome `definitive_failure`; both feed
an alarm. A stopped token agent writes no renewal line and is not alarmed.
The running-task alarms of enabled services treat missing data as breaching,
so while production starts at zero tasks the five enabled services'
running-task alarms are in ALARM and notify the topic until the I6 parameter
file scales each to its live minimum (ADR-053).

This topology preserves an elastic path but does not prove million-user
capacity. Ceiling changes require representative load/soak, latency/error,
queue, database I/O/connection, restoration and cost evidence.

## Document lifecycle and OCR cost identity

The versioned document bucket separates `clinical/`, `temporary/`,
`release-evidence/`, and `test-staging/` prefixes. Clinical current and
noncurrent versions, including legacy `objects/` keys, have no generic expiry.
Temporary/test artifacts have bounded expiry; release evidence transitions to
lower-cost storage without losing rollback evidence.

OCR completed-work reuse requires an exact object version and SHA-256 plus the
same provider and versioned operation/features/model contract. Async PDF
Textract starts use a deterministic client request token. Unknown async start
outcomes are retryable because the token prevents a duplicate start; unknown
image outcomes are not blindly retried. This reduces duplicate billing without
reducing extraction quality or hard-rejecting clinical work on price.

## Runtime inventory

| Runtime | Port/route | Database | Business AWS authority |
|---|---|---|---|
| Identity API | 3001; auth/identity/audit/admin | Identity LOGIN | none; calls Notification API over workload identity |
| EHR API | 3002; EHR | EHR LOGIN | exact document S3/KMS read/write |
| Lab API | 3003; Lab | Lab LOGIN | none |
| Pharmacy API | 3004; Pharmacy | Pharmacy LOGIN | none |
| OCR API | 3005; OCR | OCR API LOGIN | none |
| OCR Worker | no browser route | OCR Worker LOGIN | exact document read/decrypt and three Textract calls |
| Outreach API | 3006; Outreach | Outreach LOGIN | none |
| Notification API | 3007; internal only | none | regional `ses:SendEmail`; Termii through HTTPS (production `otp-email-sms` profile, ADR-053); other providers through HTTPS outside production |
| Notification Worker | 3008; internal health only | Notification Worker LOGIN | consume the exact notification queue; providers through HTTPS |
| Event Dispatcher | 3010; internal health only | Dispatcher LOGIN | `PutEvents` to the exact HID bus |
| Gateway | 3000; `/api/v1/*` of the enabled modules only | none | none |
| Database migration | one-shot task | migration administrator | no steady-state service or business authority |

The migration target shares EHR's repository but has its own required image
digest, giving twelve governed image identities for eleven repositories.
Six staging and six production API task definitions also run a token-agent
sidecar from the same admitted Identity API image digest. This adds neither a thirteenth image
identity nor another ECS service.

## Identity, data, and secrets

Identity is the only human authentication and canonical patient/HID authority.
The supported runtime modes are local imported credentials with atomic
bcrypt-to-Argon2id upgrade, or approved OIDC. Supabase and legacy HTTP identity
proxies are migration sources/history only, never production runtime paths.

Nine non-owner PostgreSQL LOGIN secrets are isolated by service. The migration
administrator is separate. Only Identity receives auth signing/login-pepper,
NIN, OTP-HMAC, Turnstile and platform MFA key material. Notification provider
configuration is injected only into Notification API/Worker as required: in
production the Notification API reads exactly `sesFromAddress`,
`termiiBaseUrl`, `termiiApiKey` and `termiiSenderId`, and the disabled
Notification Worker reads nothing. Gateway
receives no application secrets.

Workload identity is implemented by the regional stack and token agent for
staging and production (ADR-047, accepted 2026-10-13; not deployed). Each
environment's issuer maps exactly six IAM task roles to fixed
`hid:<environment>:<service>` subjects and eleven allowed caller/audience
bindings, listed in the [IAM matrix](AWS_IAM_MATRIX.md#workload-identity). A
caller can request only an audience; IAM request context supplies its identity.
Only the issuer Lambda's role may sign with the exact KMS key: the key policy
keeps the account root statement (key administration stays with the account)
and denies `kms:Sign` to every other principal (`aws:PrincipalArn`), to any
algorithm other than `ECDSA_SHA_256` and to any message type other than `RAW`.
An account administrator can still change that policy or the issuer function;
ADR-047 accepts that same-account custody risk. Tasks receive no KMS signing
authority. A warm issuer re-reads the public key at least every five minutes,
so a disabled key stops being published and stops minting within that time.

The issuer signs ES256 JWTs with `iat = nbf`, a 300-second lifetime and
`token_use: workload`. Receivers (Identity's service and document-scanner
paths, Notification, Lab, Pharmacy and the EHR's OCR caller guard) enforce the
configured issuer, JWKS, subject and audience, accept only ES256, require `exp`
and `iat`, refuse a token older than 300 seconds or issued in the future (5
seconds of clock tolerance) and refuse any other `token_use`. Each receiver
process keeps one remote JWKS set (jose's 10-minute cache, refetched early only
for an unknown `kid`); it does not fetch the JWKS per request. The issuer and
the agent accept only `staging` and `production` and bind that one value to the
issuer path, the subject prefix and the API Gateway stage, so a token of one
environment fails every check of the other.

The six agents run as UID/GID 65532 with read-only root filesystems, validate
the returned JWT signature and claims, and atomically replace mode-0600 files
in an owned mode-0700 task volume. Each application mounts that volume
read-only and starts only once the agent's health check passes (`HEALTHY`).
Agents renew about every 90 seconds, retry failures after 10 seconds, and
remove expiring files. An agent keeps the keys that verified its tokens by
`kid` and fetches the JWKS only at start, for an unknown `kid` and after a
cached key stops verifying, at most once every 30 seconds once a token has
verified, so a JWKS outage or flood does not stop renewal. Until its first
token verifies it may fetch the JWKS on each 10-second retry, so a JWKS
failure at task start leaves about six attempts before its health check
(start period 30 seconds, interval 10 seconds, three retries) turns it
`UNHEALTHY` at about 60 seconds. The agent
is not essential and has an ECS container restart policy (D2): its health
check keeps running, but an unhealthy agent no longer stops the task. During an
issuer outage longer than a token's lifetime, the task's service-to-service
calls fail closed (`503`) while Identity password sign-in and session reads
keep working; Identity logs and counts each OTP or alert it could not send
for want of a usable token (`notification_workload_token_unavailable`). ECS
restarts an agent only if it exits after running for at least 60 seconds. One
that exits sooner is not restarted: the task runs on without a token writer until it is
replaced, and the files the agent last wrote stay after their tokens expire.
Identity's Notification client treats an expired token as missing; other
callers send it and their receivers refuse it (`401`). This renews
tokens; it does not rotate the retained KMS signing key.

The issuer's only callers are the agents and the receivers, and all of them
reach it through the VPC's NAT gateways (there is no `execute-api` interface
endpoint). Where NAT gateways exist, the issuer stage's web ACL therefore
blocks by default and allows only the NAT gateway Elastic IPs (D3). Any future
caller outside the VPC, such as a document scanner (D5), must leave through
the NAT gateways or be added to the allowlist by a reviewed change.

Neither staging nor production has external issuer/JWKS/subject parameters.
Development retains those external inputs and delivery requirements and has no
token writer. ADR-047 changes the production template (its issuer, web ACL,
six agents and eight fewer parameters) and the staging templates (key policy,
method throttles, web ACL in economy and fidelity, agent restart policy and the
issuer Lambda asset); its production execution plan
([runbook](AWS_DEPLOYMENT_RUNBOOK.md) §12) still needs a separate deployment
authorization and the staging proof (I5). The template baseline recorded for `main` is in the
[deployment runbook](AWS_DEPLOYMENT_RUNBOOK.md#1-freeze-the-release-inputs) §1.
Local tests do not establish deployed token delivery.
Live profiles encode their reviewed recommended defaults, but the guarded
staging operations require readiness, migration, queue/outbox, billing, diff,
account/region and exact-SHA
acknowledgements before any deployment.

## Migration and release

Migrations `0001`–`0028` are immutable. Migration `0028` introduced the
identity/notification migration state needed for OTP, progressive KYC, legacy
mapping, encrypted device registration, and delivery reconciliation. The
current release applies all 34 migrations through `0034`: additive migrations
`0029`–`0033` implement governed OTP recovery, patient self-service, emergency
notification/rate controls, governed patient account enrollment, and Supabase-to-AWS
cutover identity controls. Migration `0034` adds append-only minimal QoreID
verification evidence and security-definer commands without adding raw NIN/CAC
or provider-response storage.
Migration is a controlled ECS RunTask operation: snapshot/PITR gate, plan,
fixture/source dry run, apply once, reconciliation, runtime-role verification,
then progressive service rollout.

Every ECS image parameter must be `repository@sha256:<digest>`. The release
gate requires all twelve component records, SBOMs, vulnerability decisions,
registry digest comparison, and an exact Git SHA. Frontend releases have their
own Cloudflare build/asset/host evidence and are not fabricated as ECR images.

## Local evidence and external gates

Local CDK assertions and offline synthesis prove the declared template shape;
they do not prove AWS IAM behavior, DNS, certificates, WAF propagation,
provider delivery, queue consumption, migrations against HID 1.0, or production
availability. Those remain explicitly external and require authorized staging
evidence before production.
