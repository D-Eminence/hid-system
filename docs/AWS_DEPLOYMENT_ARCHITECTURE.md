# HID AWS Deployment Architecture

Status: locally implemented and synthesized; live AWS, Cloudflare, DNS, TLS,
provider, migration, and production behavior remain external acceptance.

## Production boundary

The production model has one regional AWS stack. It deliberately contains no
CloudFront distribution and no AWS-hosted frontend artifacts.

```text
browser
  -> Cloudflare DNS/TLS/WAF
  -> one of seven Workers Static Assets applications
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
  -> SES / Termii / Meta, with bounded Infobip fallback
```

Authentication OTP never enters EventBridge, SQS, Novu, or ordinary delivery
history. The Cloudflare-to-AWS request carries an independent
`x-hid-origin-authorization` secret. The regional WAF rejects a missing or
incorrect value before the ALB target path. This is defense in depth and does
not replace browser authentication, CSRF, authorization, or owner-service
checks.

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

Cloudflare publishes seven independent static applications:

| Host | Application | Root |
|---|---|---|
| `www.healthidentitydirectory.com` | Web/patient | `/` |
| `ehr.healthidentitydirectory.com` | EHR | `/` |
| `lab.healthidentitydirectory.com` | Lab | `/` |
| `pharmacy.healthidentitydirectory.com` | Pharmacy | `/` |
| `ocr.healthidentitydirectory.com` | OCR Operations | `/` |
| `outreach.healthidentitydirectory.com` | Outreach | `/` |
| `admin.healthidentitydirectory.com` | Admin | `/` |

The apex host performs an originless redirect to `www`. Each Worker serves only
its own build, applies its own service-worker scope and permissions policy, and
proxies only `/api/v1/*` to the fixed AWS API hostname. HTML, service workers,
and API responses are not cached as durable PHI. Gateway contains no static
frontend output and returns `API_ONLY_ORIGIN` for non-API paths.

Staging has the exact parallel namespace: `staging`, `ehr.staging`,
`lab.staging`, `pharmacy.staging`, `ocr.staging`, `outreach.staging`, and
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
- CloudWatch logs, focused runtime/data alarms, and bounded metrics; and
- S3 gateway plus ECR, Logs, Secrets Manager, KMS, EventBridge, SQS, and
  Textract interface endpoints.

Staging additionally has a regional API Gateway and Lambda workload-token
issuer backed by a retained P-256 KMS signing key. `POST /token` requires AWS
IAM authentication; `GET /.well-known/jwks.json` publishes only the public key.
This issuer is present in every staging mode, including sleep. Development and
production retain their external workload-identity contract and have no issuer
API Gateway or Lambda. There is no SNS, Redis, search cluster, Bedrock resource,
CloudFront distribution, or duplicate frontend host in the regional design.

## Cost-safe staging modes

Staging has no implicit configuration. `HID_STAGING_MODE` must be exactly one
of:

- `sleep`: all ECS desired counts zero; no ALB, WAF association, NAT gateway,
  interface endpoint, public load-balancer IPv4, or autoscaling target. RDS is
  single-AZ and retained with deletion protection, backups and storage; the
  controlled operation stops compute and a staging-only daily schedule re-stops
  the exact instance after AWS automatic restart. S3/KMS, secrets, ECR, logs,
  EventBridge/SQS and DNS metadata remain, as do the stable workload issuer,
  public JWKS endpoint, and fourth KMS key. Token-agent task definitions remain
  present, but zero ECS tasks means no running token agents.
- `economy`: two AZs, one NAT, ECR API/Docker, Logs, Secrets Manager,
  EventBridge, SQS, and Textract endpoints in one AZ plus S3 gateway, two ALBs
  and regional WAF, one Gateway/
  request API replica, workers default zero, bounded worker/API scaling, and a
  single-AZ `db.t4g.small` database with 100 GiB initial storage.
  ECR and Logs endpoints let Gateway and restricted workers bootstrap without
  public HTTPS egress. The live staging migration task can reach only its
  database, the endpoint security group on HTTPS, and the S3 managed prefix
  list for image layers; sleep keeps those migration HTTPS paths closed.
- `fidelity`: two AZs, two NAT gateways, all eight interface endpoints in both
  AZs, two ALBs/WAF, multiple request replicas, live workers, Multi-AZ RDS, and
  release/failover/load/migration/provider/rollback parity testing.

Persistent data/security resources and ephemeral ingress/runtime resources are
selected independently by the profile. A sleep transition removes application
ingress while retaining protected data and the workload issuer. It is never
described as zero cost.
Production remains three AZs, Multi-AZ RDS, two NAT gateways, full endpoints,
two ALBs/WAF, and at least two replicas per service. The current 3-AZ/2-NAT
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
duplicates avoided. Event Dispatcher scales on PHI-free outbox depth and emits
oldest age/drain rate without weakening at-least-once delivery.

Typed database pool sizes are part of this contract. Synthesis sums each
service's maximum task count times its pool size and fails if it exceeds the
normal or separately reviewed emergency budget. RDS uses the currently
supported Database Insights Standard mode; the design does not raise
PostgreSQL `max_connections` to make an unsafe scale plan appear viable.

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
| Notification API | 3007; internal only | none | regional `ses:SendEmail`; other providers through HTTPS |
| Notification Worker | 3008; internal health only | Notification Worker LOGIN | consume the exact notification queue; providers through HTTPS |
| Event Dispatcher | 3010; internal health only | Dispatcher LOGIN | `PutEvents` to the exact HID bus |
| Gateway | 3000; `/api/v1/*` only | none | none |
| Database migration | one-shot task | migration administrator | no steady-state service or business authority |

The migration target shares EHR's repository but has its own required image
digest, giving twelve governed image identities for eleven repositories.
Six staging API task definitions also run a token-agent sidecar from the same
admitted Identity API image digest. This adds neither a thirteenth image
identity nor another ECS service.

## Identity, data, and secrets

Identity is the only human authentication and canonical patient/HID authority.
The supported runtime modes are local imported credentials with atomic
bcrypt-to-Argon2id upgrade, or approved OIDC. Supabase and legacy HTTP identity
proxies are migration sources/history only, never production runtime paths.

Nine non-owner PostgreSQL LOGIN secrets are isolated by service. The migration
administrator is separate. Only Identity receives auth signing/login-pepper,
NIN, OTP-HMAC, and Turnstile material. Notification provider configuration is
injected only into Notification API/Worker as required. Gateway receives no
application secrets.

Staging workload identity is implemented by the regional stack and token agent.
The issuer maps exactly six IAM task roles to fixed `hid:staging:<service>`
subjects and eleven allowed caller/audience bindings, listed in the
[IAM matrix](AWS_IAM_MATRIX.md#workload-identity). A caller can request only an
audience; IAM request context supplies its identity. Only the issuer Lambda can
sign with the exact KMS key, using `ECDSA_SHA_256`. Tasks receive no KMS signing
authority. The issuer signs ES256 JWTs with a 300-second lifetime, and receivers
enforce the configured issuer, JWKS, subject, and audience.

The six agents run as UID/GID 65532 with read-only root filesystems, validate
the returned JWT signature and claims, and atomically replace mode-0600 files
in an owned mode-0700 task volume. Each application mounts that volume read-only
and waits for the agent's one-shot readiness check to pass. Agents renew about
every 90 seconds, retry failures after 10 seconds, and remove expiring files.
This renews tokens; it does not rotate the retained KMS signing key.

Staging has no external issuer/JWKS/subject parameters. Development and
production retain those external inputs and delivery requirements; the staging
implementation preserves the production template byte for byte against the
recorded baseline. Local tests do not establish deployed token delivery.
Live profiles encode their reviewed recommended defaults, but the guarded
staging operations require readiness, migration, queue/outbox, billing, diff,
account/region and exact-SHA
acknowledgements before any deployment.

## Migration and release

Migrations `0001`–`0028` are immutable. Migration `0028` introduced the
identity/notification migration state needed for OTP, progressive KYC, legacy
mapping, encrypted device registration, and delivery reconciliation. The
current release applies all 32 migrations through `0032`: additive migrations
`0029`–`0032` implement governed OTP recovery, patient self-service, emergency
notification/rate controls, and governed patient account enrollment.
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
