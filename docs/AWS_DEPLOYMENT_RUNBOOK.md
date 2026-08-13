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
- Cloudflare account/zone and one selected profile: production uses the seven
  approved production hostnames, apex redirect, and
  `api.healthidentitydirectory.com`; staging uses its seven `.staging`
  hostnames and `api.staging.healthidentitydirectory.com`;
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
- one independently generated origin secret per environment, stored only in
  that environment's Cloudflare Worker secret binding and its matching AWS WAF
  parameter; staging and production values must differ.

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
npm --prefix infra/aws run cost:inventory:check
```

Synthesize and policy-scan every environment without deploying:

```bash
npm --prefix infra/aws run synth:dev
HID_INFRA_ENV=development npm --prefix infra/aws run verify:synth
npm --prefix infra/aws run synth:staging:sleep
HID_INFRA_ENV=staging HID_STAGING_MODE=sleep npm --prefix infra/aws run verify:synth
npm --prefix infra/aws run synth:staging:economy
HID_INFRA_ENV=staging HID_STAGING_MODE=economy npm --prefix infra/aws run verify:synth
npm --prefix infra/aws run synth:staging:fidelity
HID_INFRA_ENV=staging HID_STAGING_MODE=fidelity npm --prefix infra/aws run verify:synth
npm --prefix infra/aws run synth:prod
HID_INFRA_ENV=production npm --prefix infra/aws run verify:synth
npm --prefix infra/aws run verify:policy
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

## 4. Provision the regional foundation

Bootstrap and deploy only after change approval. Live profiles default to the
typed recommended counts. For a first foundation-only change, explicitly pass
every `*DesiredCount=0` through reviewed `HID_CDK_EXTRA_ARGS_JSON`; never rely
on an implicit zero or a shared count. Validate:

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

## 5. Guarded staging operations

The following commands are the only repository staging-mode entry points:

```bash
npm run staging:start
npm run staging:sleep
npm run staging:fidelity:enable
npm run staging:fidelity:disable
npm run staging:teardown
```

Their names alone never deploy. Every command refuses to proceed unless all of
these are present and consistent:

- exact 12-digit `HID_AWS_ACCOUNT`, region, clean checked-out 40-character
  `HID_RELEASE_SHA`, and non-`main` branch;
- caller identity matching the account and an exact operation/account/region/
  SHA `HID_CONFIRM` value printed by the command contract;
- `HID_OPERATION_EXECUTE=true` plus explicit readiness, migration, drained
  queue, drained outbox, and billing-summary acknowledgements;
- current RDS state, an offline synth, and a visible CDK diff before deploy;
- digest-qualified image/secret/certificate parameters supplied as a reviewed
  JSON string array in `HID_CDK_EXTRA_ARGS_JSON`; and
- the additional exact teardown confirmation for `staging:teardown`.

`staging:start` selects economy and starts the exact staging RDS instance before
runtime deployment. Fidelity enable/disable transitions between fidelity and
economy. `staging:sleep` first deploys zero ECS/no-ingress/no-NAT/no-interface-
endpoint topology and only then stops the exact RDS instance from an expected
state. AWS can restart a stopped instance after its bounded stop period; the
sleep profile's exact-resource Scheduler rule reissues one daily stop with zero
retries. It cannot target production. Sleep continues to bill for protected
storage/backups, S3/KMS, secrets, ECR, logs, queues/events and metadata.

Teardown is distinct from sleep. It destroys the staging stack only after its
second confirmation; retention/snapshot policies preserve the declared data
evidence but the operator must independently verify snapshots and exports.
Never run any of these commands for production.

## 6. Migrate identity and data

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

## 7. Provider and workload preflight

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

## 8. Cloudflare rollout

For each frontend, bind the exact selected-environment custom hostname, static
asset directory, compatibility date, and matching Worker origin secret.
Validate apex redirect where applicable, TLS,
security headers, application-specific camera/geolocation permissions,
root-scoped service worker, direct refresh, cache rules, and `/api/v1/*` proxy
behavior. The AWS origin must reject a direct request without the origin secret.

Release and roll back each application independently. A frontend rollback must
not change an API image or database schema.

## 9. Progressive runtime rollout

Raise minimum dependencies first: Identity and Notification API, then owner
APIs and Gateway, then OCR Worker, Event Dispatcher, and Notification Worker.
Use small desired counts and alarms before reaching the environment profile.
Run clinical, identity, OCR, notification, offline/reconnect, and administrative
smoke tests with synthetic data.

Observe RDS connections/storage, ALB/WAF results, task health/restarts, queue
age/DLQ, event terminal failure, provider outcomes, OCR failures, S3/KMS denies,
and sanitized telemetry. Stop on unexplained authentication, duplicate patient,
OTP, notification, or migration behavior.

Normal scaling ceilings are not million-user capacity evidence. Any move above
a normal ceiling must use the separately bounded emergency parameter, have an
external approval record, and confirm representative load/soak, latency/error,
backlog/drain, RDS connections/I/O, restoration and dated cost evidence. Do not
raise PostgreSQL `max_connections` to bypass the synthesized connection budget.

Use CloudWatch Logs Insights only with narrow time and log-group bounds; record
bytes scanned. Do not query or emit PHI, OCR text, raw NIN, tokens, or patient/
request IDs as dimensions. Validate Database Insights Standard, log-volume
alarms, OCR pages/retries/duplicate-avoidance, notification visible/oldest/
deleted signals, and dispatcher outbox age/drain signals.

## 10. Optional billing alerts

The cost-governance stack is opt-in and separate:

```bash
HID_COST_GOVERNANCE_ENABLED=true HID_INFRA_ENV=development \
  npm --prefix infra/aws run synth
```

Before an authorized deployment, supply a reviewed `CostNotificationEmail`,
optional existing SNS ARN, cash/gross monthly limits, and anomaly threshold
equal to at least `max($10, 2% of reviewed monthly gross)`. Inspect both
templates and policy output. The stack contains notifications only—no Budget
Action and no automatic production shutdown.

## 11. Rollback and evidence

Application rollback selects an earlier accepted digest/task-definition.
Frontend rollback selects the previous per-host Cloudflare artifact. Database
rollback is not a down migration: use additive correction or the approved
PITR/incident path. Preserve deployment parameters, manifest, approvals,
redacted test evidence, reconciliation totals, and rollback decision.

Local implementation leaves every operation in sections 3–11 externally
pending; no account, DNS, provider, database, or production state is mutated by
repository acceptance.
