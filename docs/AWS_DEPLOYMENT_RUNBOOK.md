# HID AWS and Cloudflare Deployment Runbook

Status: local contracts implemented; every live account, provider, DNS,
credential, data-migration, staging, and production step is externally pending.

Do not interpret successful tests or synthesis as deployment success. This
runbook requires authorized operators and records evidence without putting PHI,
OTP values, tokens, provider credentials, or database URLs in logs.

## Staging NIN deferral

MetaMap NIN integration is prepared but deferred. Activation requires version-specific provider contract confirmation and authorized trial/test access.

All staging profiles set `NIN_PROVIDER_MODE=deferred` and omit NIN provider and
cryptographic-key injection. Existing stored NIN keys remain preserved. Missing
MetaMap credentials do not block task startup, deployment or acceptance. Follow
[staging patient journeys](STAGING_PATIENT_JOURNEYS.md) for approved synthetic
account/patient preparation; keep real authentication, OTP delivery, TLS, RLS,
consent, workload identity and audit controls active.

## Staging email acceptance profile

Staging selects `NOTIFICATION_DELIVERY_PROFILE=email-only`. Its Notification API
requires only `sesFromAddress` from `/hid/staging/notification-provider`; the
Notification Worker separately requires `novuApiKey`. SES remains live, workload
authentication and TLS remain required, and SES failures are preserved. Termii,
Meta and Infobip fields must not be filled with placeholders. Their accounts and
full-channel profile are deferred unless explicitly included in a later reviewed
acceptance scope. Production retains the existing full profile.

Novu also needs the configured workflow, canonical synthetic patient subscriber
mapping and approved delivery integration. See
[provider accounts and activation](STAGING_PROVIDER_ACCOUNTS.md) and
[read-only external preflight](STAGING_EXTERNAL_PREFLIGHT.md). No key-presence or
health check substitutes for actual delivery evidence.

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
- staging workload issuer/JWKS stack outputs, the admitted Identity API image
  used by all six token agents, and the fixed IAM caller/audience map; for
  development and production, the external issuer/JWKS/subjects and token
  delivery mechanism;
- nine non-owner database secrets plus a separate migration administrator;
- Identity auth/OTP/Turnstile secret material; NIN material is excluded from
  current staging requirements and retained for later integration;
- for staging email acceptance, SES sender and Novu secret material only; the
  existing full profile additionally uses Termii, Meta and Infobip. FCM is not
  instantiated by the current worker and is outside this acceptance scope; and
- one independently generated origin secret per environment, stored only in
  that environment's Cloudflare Worker secret binding and its matching AWS WAF
  parameter; staging and production values must differ.

Do not reuse local, historical Vercel, Supabase, or Brevo credentials. Any
previously exposed live-looking credentials must be rotated/revoked by their
external owners before cutover.

For staging, `RdsCaBundleBase64` accepts at most 4096 base64 characters, the
CloudFormation parameter-value limit. Independently verify the staging region
and the database's actual CA identifier, select its matching public root CA
from the official AWS RDS trust store, and retain its source URL and checksum.
Register the root certificate only; do not pass the global bundle or truncate
a certificate to fit. The complete regional bundle may also exceed the limit.
Prove TLS hostname and chain validation against the actual staging database,
and repeat CA selection when changing its CA. No TLS verification exception
is permitted. See [AWS CloudFormation quotas](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-limits.html)
and [AWS RDS trust roots](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html).

Staging no longer accepts external `WorkloadIssuerUrl`, `WorkloadJwksUrl`, or
service-subject parameters. Its regional stack supplies the issuer and JWKS
URLs and binds six exact task roles to eleven allowed caller/audience pairs.
Record the output URLs and signing-key ARN with the release evidence; do not
record tokens. All staging modes retain the same issuer and P-256 key. Confirm
the production template still matches its recorded baseline byte for byte;
production and development keep their external workload-identity inputs.

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
Every staging mode additionally has the stable workload issuer API Gateway,
Lambda, and fourth KMS key. Six API task definitions include token agents from
the Identity API image; they add no new image identity or ECS service.

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

**Current hold:** the owner has submitted quota request
`53cf4fecbdee43808970dadf399dce15KHtG3UD0` for 32 Fargate On-Demand vCPUs in
`eu-west-1`. Do not resubmit or deploy while it is pending, including an empty
foundation. Run `python3 scripts/check-staging-fargate-quota.py` from the repository
root; read both request status and applied quota, then verify available account
capacity and the remaining release gates. A zero exit code only means the read
succeeded. Staging also requires the confirmed `StagingNovuApiUrl` parameter;
there is no default or production change.

Before runtime launch, compare the account's applied Fargate quota with the exact
parameter plan, including scaling ceilings, per-service rolling replacement bounds
and the standalone migration task. The offline
[`assess-staging-capacity.mjs`](../infra/aws/scripts/assess-staging-capacity.mjs)
performs this calculation without credential access or deployment. The
[September 14 AWS checkpoint](STAGING_AWS_CHECKPOINT.md) records the actual 6-vCPU
quota and prepared worker-active acceptance plan; that plan requires 6.5 vCPUs
before rollover headroom. Missing usage datapoints are not evidence of zero usage.

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
economy. `staging:sleep` first deploys zero ECS tasks, no application ingress,
no NAT, and no interface endpoints, then stops the exact RDS instance from an expected
state. AWS can restart a stopped instance after its bounded stop period; the
sleep profile's exact-resource Scheduler rule reissues one daily stop with zero
retries. It cannot target production. Sleep continues to bill for protected
storage/backups, S3/KMS, secrets, ECR, logs, queues/events and metadata.
The workload issuer Lambda/API and retained P-256 key remain stable across
sleep and wake. This fourth staging KMS key retains its fixed cost, and issuer
requests remain metered. Zero ECS tasks means no running token agents; sleep
does not disable the IAM-protected token endpoint or public JWKS endpoint.

Teardown is distinct from sleep. It destroys the staging stack only after its
second confirmation; retention/snapshot policies preserve the declared data
evidence but the operator must independently verify snapshots and exports.
Never run any of these commands for production.

## 6. Migrate identity and data

Never edit migrations `0001`–`0028`. Apply all 32 ledger migrations through
`0032` using the one-shot migration task. First record snapshot/PITR readiness
and run `--plan`.
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

Verify all six staging token agents use the admitted Identity API digest and
the exact role/subject/audience bindings in the
[IAM matrix](AWS_IAM_MATRIX.md#workload-identity). Each agent must run as
UID/GID 65532 with a read-only root filesystem and write only its owned token
volume. Confirm mode 0700 on the directory, atomic mode-0600 token files, a
read-only application mount, and application startup gated by the agent's
one-shot `health.mjs` check. Inspect readiness and sanitized outcomes without
printing token contents.

With synthetic service requests, verify ES256 signatures and the exact issuer,
subject, audience, and 300-second lifetime. Observe renewal at about 90 seconds,
bounded 10-second retry after failure, removal before expiry, and failed
readiness once usable credentials are unavailable. Verify the mapped caller
can request only its allowed audiences and cannot sign directly with KMS.
These local contracts still require live staging proof of ECS IAM credentials,
network reachability, API Gateway authorization, KMS signing, and receiver
validation; successful synthesis alone is insufficient.

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
