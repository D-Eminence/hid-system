# HID AWS and Cloudflare Deployment Runbook

Status: local contracts implemented; every live account, provider, DNS,
credential, data-migration, staging, and production step is externally pending.

Do not interpret successful tests or synthesis as deployment success. This
runbook requires authorized operators and records evidence without putting PHI,
OTP values, tokens, provider credentials, or database URLs in logs.

## 1. Freeze the release inputs

Record and approve:

- exact Git SHA and release ID;
- AWS account/region and `development`, `staging`, or `production` profile;
- Cloudflare account/zone, seven application hostnames, apex redirect, and the
  fixed API origin `api.healthidentitydirectory.com`;
- regional ACM certificate covering that API origin and the internal wildcard
  certificate;
- RDS CA bundle and regional S3 managed prefix-list ID;
- workload issuer/JWKS, exact service subjects/audiences, and rotating token
  delivery mechanism;
- nine non-owner database secrets plus a separate migration administrator;
- Identity auth/NIN/OTP/Turnstile secret material;
- Notification provider secret material for SES sender, Termii, Meta, Infobip,
  and Novu; FCM server credentials/token acquisition remain an external
  provider integration; and
- one independently generated origin secret stored only in Cloudflare Worker
  secrets and the AWS WAF parameter.

Do not reuse local, historical Vercel, Supabase, or Brevo credentials. Any
previously exposed live-looking credentials must be rotated/revoked by their
external owners before cutover.

## 2. Local source gates

From a locked checkout:

```bash
npm test
npm run build
npm run verify
npm run verify:migration
npm --prefix infra/aws run lint
npm --prefix infra/aws run typecheck
npm --prefix infra/aws test
```

Synthesize and policy-scan every environment without deploying:

```bash
HID_INFRA_ENV=development npm --prefix infra/aws run synth
HID_INFRA_ENV=development npm --prefix infra/aws run verify:synth
HID_INFRA_ENV=staging npm --prefix infra/aws run synth
HID_INFRA_ENV=staging npm --prefix infra/aws run verify:synth
HID_INFRA_ENV=production npm --prefix infra/aws run synth
HID_INFRA_ENV=production npm --prefix infra/aws run verify:synth
```

Expected topology is one regional stack, eleven ECS services, eleven ECR
repositories, twelve task definitions/image inputs including migration, the
notification queue/DLQ/rule, and zero CloudFront distributions.

## 3. Container and release gate

On an approved release host, build all twelve image identities from locked
dependencies. This is a separate release-stage operation, not implied by local
Docker availability. For each component:

1. inspect final UID, entrypoint, health command, signals, layers, and contents;
2. generate CycloneDX JSON or SPDX JSON;
3. scan dependencies and the final image;
4. fail on unapproved critical/high findings or incomplete evidence;
5. push to its immutable ECR repository;
6. read the registry digest back and compare it with the built artifact; and
7. add exactly one component record to the signed release manifest.

Populate ECS parameters only with digest-qualified URIs. Gateway is API-only.
Cloudflare frontend artifacts are built, hashed, checked for source-map/secret
leakage, and released independently per application.

## 4. Provision the regional foundation at zero tasks

Bootstrap and deploy only after change approval. Keep
`GatewayDesiredCount=0`, `ApiDesiredCount=0`, and `WorkerDesiredCount=0` while
validating:

- private RDS placement, TLS, encryption, backups, deletion behavior, and logs;
- no world database/task ingress and no public task IPs;
- public ALB TLS plus WAF origin-secret, managed-rule, and rate-limit behavior;
- internal ALB certificate/private DNS behavior;
- private document S3/KMS/Textract boundaries;
- EventBridge allowlist and encrypted notification SQS/DLQ;
- exact task/execution-role separation and secret exposure; and
- no CloudFront/static frontend resources.

Provision the database LOGIN roles and apply `runtime-grants.sql`. Verify every
LOGIN is non-owner, non-superuser, non-BYPASSRLS and cannot mutate another
domain.

## 5. Migrate identity and data

Never edit migrations `0001`–`0027`. Apply the ledger through `0028` using the
one-shot migration task. First record snapshot/PITR readiness and run `--plan`.
Exercise the offline fixture path before using an approved read-only HID 1.0
source:

```bash
npm --prefix services/ehr-api run migration:verify
MIGRATION_FIXTURE_PATH=test/fixtures/legacy-identity.sample.json \
  npm --prefix services/ehr-api run migration:stage:dry-run
```

For real migration, preserve source and destination UUID/HID mappings,
checksums, conflicts, batch checkpoints, and reconciliation output. Copy legacy
objects through a controlled private export/import using opaque PHI-free S3
keys. Record source checksum, destination checksum, object version ID, retry
state, and failures. Never make legacy or destination objects public.

Use a controlled single-writer final cutover. Freeze or capture final identity
mutations, take the final snapshot, stage, reconcile, resolve every blocking
conflict, promote idempotently, validate patient/HID continuity, and retain a
rollback/PITR decision point. Do not trust a raw HID 1.0 session token: the
issuer/signature/audience/expiry contract is not proven. Use local/OIDC login
or the six-digit contact-OTP fallback mapped to the existing patient.

## 6. Provider and workload preflight

Before raising task counts, prove in staging:

- missing, expired, wrong-audience, wrong-subject, bad-signature, and rotated
  workload JWT behavior;
- Turnstile success, failure, timeout, replay/hostname/action rejection, and
  fail-closed production configuration;
- SES/Termii/Meta primary OTP delivery and Infobip fallback only after a known
  primary failure; unknown outcomes must not create blind duplicates;
- OTP is exactly six digits, purpose-bound, expiring, attempt-limited,
  resend-invalidated, never plaintext-persisted/logged, and completion is
  single-use;
- ordinary EventBridge events contain minimum-necessary non-credential data;
- SQS redrive/DLQ, Notification Worker idempotency, Novu and FCM boundaries;
- provider callbacks/status reconciliation without sensitive payload logging;
  and
- telemetry redaction with PostHog autocapture/replay disabled.

## 7. Cloudflare rollout

For each frontend, bind the exact custom hostname, static asset directory,
compatibility date, and Worker origin secret. Validate apex redirect, TLS,
security headers, application-specific camera/geolocation permissions,
root-scoped service worker, direct refresh, cache rules, and `/api/v1/*` proxy
behavior. The AWS origin must reject a direct request without the origin secret.

Release and roll back each application independently. A frontend rollback must
not change an API image or database schema.

## 8. Progressive runtime rollout

Raise minimum dependencies first: Identity and Notification API, then owner
APIs and Gateway, then OCR Worker, Event Dispatcher, and Notification Worker.
Use small desired counts and alarms before reaching the environment profile.
Run clinical, identity, OCR, notification, offline/reconnect, and administrative
smoke tests with synthetic data.

Observe RDS connections/storage, ALB/WAF results, task health/restarts, queue
age/DLQ, event terminal failure, provider outcomes, OCR failures, S3/KMS denies,
and sanitized telemetry. Stop on unexplained authentication, duplicate patient,
OTP, notification, or migration behavior.

## 9. Rollback and evidence

Application rollback selects an earlier accepted digest/task-definition.
Frontend rollback selects the previous per-host Cloudflare artifact. Database
rollback is not a down migration: use additive correction or the approved
PITR/incident path. Preserve deployment parameters, manifest, approvals,
redacted test evidence, reconciliation totals, and rollback decision.

Local implementation leaves every operation in sections 3–9 externally
pending; no account, DNS, provider, database, or production state is mutated by
repository acceptance.
