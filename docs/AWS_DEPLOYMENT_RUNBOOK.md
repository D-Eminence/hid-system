# HID AWS and Cloudflare Deployment Runbook

Status: local contracts implemented; every live account, provider, DNS,
credential, data-migration, staging, and production step is externally pending.

Do not interpret successful tests or synthesis as deployment success. This
runbook requires authorized operators and records evidence without putting PHI,
OTP values, tokens, provider credentials, or database URLs in logs.

## Staging NIN deferral and QoreID opt-in

The legacy governed-registration provider remains deferred in staging:
`NIN_PROVIDER_MODE=deferred` still omits NIN encryption/HMAC-key injection and
does not make a provider request. The separately implemented QoreID
self/organization verification adapter is also disabled by default
(`QOREID_ENABLED=false`), so ordinary task synthesis carries no QoreID
credential reference.

An authorized staging activation must explicitly synthesize with
`HID_QOREID_ENABLED=true` and supply `QoreIdCredentialsSecretArn`, a distinct
AWS Secrets Manager JSON secret with `clientId` and `secret`. ECS injects those
values into the Identity API only; they must not be copied to a frontend,
worker, migration task, log, or deployment parameter. Validate synthetic NIN
and CAC outcomes plus timeout/401/5xx privacy behavior before considering any
production change. This repository change did not activate or deploy QoreID.
See [QoreID verification contract](QOREID_VERIFICATION_CONTRACT.md).

## Staging email acceptance profile

Staging selects `NOTIFICATION_DELIVERY_PROFILE=email-only`. Its Notification API
requires only `sesFromAddress` from `/hid/staging/notification-provider`; the
Notification Worker separately requires `novuApiKey`. SES remains live, workload
authentication and TLS remain required, and SES failures are preserved. Termii,
Meta and Brevo fields must not be filled with placeholders. Their accounts and
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
- staging workload issuer/JWKS stack outputs and signing-key ARN, the admitted
  Identity API image used by all six token agents, and the fixed IAM
  caller/audience map; the same production outputs if ADR-047 is accepted
  (§12); for development, the external issuer/JWKS/subjects and token delivery
  mechanism;
- nine non-owner database secrets plus a separate migration administrator;
- Identity auth/OTP/Turnstile secret material; legacy NIN material remains
  excluded from current staging requirements. If QoreID staging activation is
  separately approved, add its distinct `clientId`/`secret` envelope only;
- for staging email acceptance, SES sender and Novu secret material only; the
  existing full profile additionally uses Termii, Meta and Brevo. FCM is not
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
record tokens. All staging modes retain the same issuer and P-256 key.
Under ADR-047 (proposed, pending its decision) production takes its own issuer
from its own stack in the same way, with its own key, API, `/production` stage
and `hid:production:<service>` subjects, and no longer accepts these
parameters. That changes the production template: record a new production
template baseline (§12) instead of comparing with an earlier one. Development
keeps its external workload-identity inputs.

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
Lambda, and fourth KMS key, and so does production under ADR-047 (pending),
with its own. Six API task definitions include token agents from the Identity
API image; they add no new image identity or ECS service.

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

The full regional template requires all twelve digest-qualified `*ImageUri`
parameters even when every `*DesiredCount` is zero. Zero desired counts cannot
bootstrap ECR. Tags, placeholders, fabricated digests, and an incomplete full
template are forbidden.

### ECR bootstrap review

The offline
[`prepare-staging-ecr-bootstrap.mjs`](../infra/aws/scripts/prepare-staging-ecr-bootstrap.mjs)
generator prepares a narrowly scoped review template from a synthesized staging
regional template. It makes no cloud calls and grants no deployment authority.
It reuses the release package's strict JSON loader; install both locked dependency
sets with `npm --prefix infra/aws ci` and `npm --prefix release ci --ignore-scripts`
before running it or the infrastructure tests in a clean checkout.
The review artifact has 11 retained application ECR repositories and their 11
unchanged URI outputs. It preserves each complete ECR resource/output object,
including the default AES-256 behavior, lifecycle policy, immutable tags,
scan-on-push, logical IDs, retention policies, `BootstrapVersion`, and
`CheckBootstrapVersion`.

The generator records the supplied template's hash and derived resource counts;
it does not verify which source checkout produced that template or approve a
source commit. Its receipt always records `reviewed_source_sha: null`,
`source_checkout_verified: false`, and a required source review before execution.
Local review artifacts are unbound preparation. Before any future execution,
synthesize from the exact approved source checkout, compare the resulting full
template SHA-256, and regenerate/review the bootstrap artifact. Do not reuse an
older receipt's resource counts as an expectation for changed source.

This artifact must remain unexecuted while quota request `L-3032A538` is
pending. It creates no runtime, database, IAM, secret, DNS, Cloudflare, image,
release-trust, OIDC, NIN, or signing-broker resource. It is not evidence that a
repository exists or that an image build is authorized.

Only after the quota and every independent gate clear may a separately reviewed,
dedicated executor be introduced. `staging:start` is not that executor: it
requires the database to exist and therefore cannot expand an ECR-only stack.
Do not use an unguarded `create-stack` command as an alternative. The future
executor must first prove that `Hid-staging-Regional` and all eleven named
application repositories are absent in account `659225405023`, region
`eu-west-1`; an unreadable resource or expired session is not proof of absence.
It must create the reviewed subset only under the same stack name and reviewed
CloudFormation service role, build real digest-qualified application images,
then update that same stack with the full reviewed template and its reviewed
source SHA.

After a renewed AWS session, the read-only
[`check-staging-ecr-bootstrap.py`](../scripts/check-staging-ecr-bootstrap.py)
check verifies the fixed account, CDK bootstrap version, stack absence, and all
eleven repository absences. It rejects an unreadable resource, an existing stack
or repository, and an old CDK bootstrap version. Its successful result still does
not clear the quota, provider, custody, source-review, or deployment gates.

The full-stack change set must add exactly the resources derived from that
approved full template after excluding the eleven retained repositories, and
show no ECR modify, replacement, delete, import, or adoption action. A
source/template change requires a new offline artifact and review. Never import,
adopt, delete, replace, empty,
re-create, or automatically reuse retained repositories. The separate
signing-broker repository, OIDC roles, and BuildRole belong to the independently
approved release-trust path and are outside this application-repository subset.

After a reviewed full-stack deployment exists, live profiles default to the
typed recommended counts. Validate:

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

The following commands are the only current repository runtime staging-mode
entry points. They do not create the ECR bootstrap subset or perform its first
full-stack expansion:

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

Never edit migrations `0001`–`0028`. Apply all 34 ledger migrations through
`0034` using the one-shot migration task. First record snapshot/PITR readiness
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

This staging proof is also a precondition of the production issuer proposed in
ADR-047; production's own checks are in §12.

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
- SES/Termii/Meta primary OTP delivery and Brevo fallback only after a known
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

Local implementation leaves every operation in sections 3–12 externally
pending; no account, DNS, provider, database, or production state is mutated by
repository acceptance.

## 12. Production workload issuer (ADR-047): operator plan, not approved

**NOT APPROVED. Do not execute.** This plan applies only if ADR-047 is
accepted. It has not been run: no account was read and nothing was deployed or
applied. It adds no authority to the production lock.

Preconditions:

- ADR-047 accepted, with a decision on DEP-4-KEY, DEP-4-DOS and DEP-4-RES or
  their explicit acceptance as risks.
- Staging redeployed from the same approved SHA, with this change's issuer
  Lambda and Identity API image, and its §7 live proof recorded.
- The production unlock approval and a production change approval.
- Sections 1–4 complete for the release, with every image admitted.

Steps:

1. Build and admit (§3, ADR-035) the Identity API image that contains this
   change's `services/workload-token-agent`; every production token agent runs
   from `IdentityApiImageUri`. Record its digest. An earlier image's agent
   refuses `production`, so a token task with it never starts its application.
2. From the approved SHA, run the §2 gates, including
   `npm --prefix infra/aws run synth:prod`,
   `HID_INFRA_ENV=production npm --prefix infra/aws run verify:synth`,
   `npm --prefix infra/aws run verify:policy` and
   `npm --prefix infra/aws run cost:inventory:check`. Record as a new evidence
   entry, without replacing any earlier baseline:
   - the production template's SHA-256, size, resource and parameter counts;
   - the issuer asset hash (the `S3Key` of `ProductionWorkloadIdentityIssuer*`
     and its `cdk.out/asset.<hash>` directory) and the Git SHA it was built
     from; the issuer code is a CDK file asset, not an admitted image;
   - the staging template diff against the staging template last deployed,
     which must be the issuer asset key only.
3. In the production account and region, read-only:
   - confirm the CDK bootstrap version (`/cdk-bootstrap/hnb659fds/version`)
     and its asset bucket; the deploy publishes the issuer asset there;
   - run `cdk diff Hid-production-Regional --no-lookups` with the reviewed
     parameter file. Expect exactly:
     - additions: the `ProductionWorkloadIdentity` key (`Retain`), alias, log
       group (`Retain`), issuer role and policy, function, REST API, three
       resources, two methods, deployment, stage `production`, two Lambda
       permissions, the three `ProductionWorkloadIdentity*` outputs, and six
       task-role policies granting `execute-api:Invoke` on
       `/production/POST/token`;
     - new revisions of the six token task definitions (the agent added) and of
       the Notification API and OCR worker task definitions (issuer, JWKS and
       subject values now from the stack);
     - `DependsOn` changes on services, scaling targets and policies and
       service-discovery services;
     - removal of the eight workload parameters.
   - Stop on any replacement or deletion of RDS, S3, the data KMS keys, ECR
     repositories or log groups, or on any other change.
4. Deploy with every `*DesiredCount` at `0` and the eight workload parameters
   removed from the parameter file. Record the `IssuerUrl` and `JwksUrl`
   outputs and the signing key ARN. Never record a token.
5. With no task running, verify the issuer:
   - `GET <JwksUrl>` answers `200` with exactly one `EC` `P-256` key, `alg`
     `ES256`, `use` `sig`, whose `kid` is the key ID;
   - an unsigned `POST <IssuerUrl>/token` answers `403`;
   - a SigV4 `POST` signed by an operator role outside the caller map answers
     `403 WORKLOAD_CALLER_DENIED`;
   - the function's environment has `HID_DEPLOYMENT_ENV=production`, six role
     ARNs, eleven bindings and only `hid:production:` subjects;
   - CloudTrail shows `kms:Sign` on the key only from the issuer role;
   - the staging issuer still answers, and its `kid` differs from production's.
6. Scale the Notification API, then the Identity API, to their minimum. Each
   task's `workload-token-agent` must be `HEALTHY` before its application
   starts; no `Workload token renewal unavailable` line may appear; an OTP
   start for a synthetic account must not end with `safeCode` `http_401`.
7. Scale the EHR, Lab, Pharmacy, OCR and Outreach APIs. On synthetic data: an
   EHR request authenticates through Identity's service session, Lab accepts
   an EHR order, and OCR publishes to EHR, Lab and Pharmacy.
8. Watch renewals (about every 90 seconds), task health, issuer Lambda errors
   and API `5XX` for at least 15 minutes before continuing with §9.

Record commands, outputs, the template SHA-256, the asset hash, the image
digest, the key ARN and the time window. Record no token, credential or
patient data.

Rollback:

- Before step 6 nothing depends on the issuer; leave it in place. The previous
  template needs real external issuer, JWKS and subject values, which do not
  exist; never supply placeholders.
- From step 6: set the token-bearing services' `*DesiredCount` back to `0`.
  Without tokens their service-to-service calls fail closed. Never set a
  `*_IDENTITY_MODE` to `local-secret`; production configuration refuses it.
- To stop minting at once, set the issuer function's reserved concurrency to
  `0` or remove a caller's `execute-api:Invoke`. Issued tokens stay valid until
  they expire, at most 300 seconds later.
- On suspected key misuse, disable the key (`aws kms disable-key`): minting and
  JWKS answer `503`, and receivers refuse new tokens once their cached JWKS
  expires, at most 10 minutes later. Do not schedule key deletion without a
  separate approval; it is irreversible after its waiting period.
- The key and the issuer log group are retained if the construct or stack is
  removed. Deleting them is a separate, approved action.
