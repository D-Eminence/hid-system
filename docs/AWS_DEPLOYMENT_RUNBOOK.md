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

NIN holder routes (ADR-062, D-Eminence/hid-system#84): the synth
inputs `HID_NIN_HOLDER_SMS_ENABLED`, `HID_ASSISTED_REGISTRATION_ENABLED` and
`HID_QOREID_PATIENT_SELF_NIN_BINDING_ENABLED` all default to `false` and set
the Identity variables of the same names without `HID_`. Synthesis refuses
NIN-only enrollment without a holder route, the online route on staging
(email only), the online route in production without
`HID_ASSISTED_REGISTRATION_ENABLED=true` (ADR-063, below), and the signed-in
NIN binding in production. Enabling any of them is an operator step after
the release checklist P23 to P27, and P33 for either holder route.

Facility route (ADR-063, D-Eminence/hid-system#85):
with it, synthesis accepts `HID_NIN_HOLDER_SMS_ENABLED=true` in production
only with `HID_ASSISTED_REGISTRATION_ENABLED=true`, and `verify-synth`
checks the same. The flag alone opens nothing: the route opens while a
facility is designated through the admin API. In production Identity also
keeps the online route closed while no facility takes part. The in-person budgets
(`ASSISTED_VERIFICATION_STAFF_DAILY_MAX`, `_FACILITY_DAILY_MAX`) keep
Identity's defaults (20 and 100); they are not synth inputs. Enabling the
facility route is an operator step after release checklist P29 to P33.

Imported legacy medical history (ADR-067, migration 0099): the synth inputs
`HID_EHR_PATIENT_RELEASE_IMPORTED_HISTORY` and
`HID_EHR_STAFF_IMPORTED_HISTORY_ENABLED` set ehr-api's
`EHR_PATIENT_RELEASE_IMPORTED_HISTORY` and `EHR_STAFF_IMPORTED_HISTORY_ENABLED`,
and `HID_IMPORTED_HISTORY_SHARING_ENABLED` sets identity-api's
`IMPORTED_HISTORY_SHARING_ENABLED`. Each defaults to `false`; synthesis and
`verify-synth` refuse any of them outside staging, and in staging the sharing
switch without the patient read and the staff read without the sharing
switch. Set them on staging only after release checklist P38 (1), the written
sign-off, in the order patient read, sharing, staff read, and turn them off in
reverse. The EHR and Identity production profiles refuse them as well.

## Staging email acceptance profile

Staging selects `NOTIFICATION_DELIVERY_PROFILE=email-only`. Its Notification API
requires only `sesFromAddress` from `/hid/staging/notification-provider`; the
Notification Worker separately requires `novuApiKey`. SES remains live, workload
authentication and TLS remain required, and SES failures are preserved. Termii,
Meta and Brevo fields must not be filled with placeholders. Their accounts and
full-channel profile are deferred unless explicitly included in a later reviewed
acceptance scope.

## Production OTP profile (ADR-053)

Production (and development) select `NOTIFICATION_DELIVERY_PROFILE=otp-email-sms`
(D-Eminence/hid-system#66): email OTP through SES and SMS OTP through
Termii. The Notification API reads exactly `sesFromAddress`, `termiiBaseUrl`,
`termiiApiKey` and `termiiSenderId` from `/hid/production/notification-provider`,
and the secret must hold exactly those four fields: no Meta, WhatsApp, Brevo or
Novu field (the production preflight, §13, fails on any other). Production
refuses the `full` and `email-only` profiles, any WhatsApp configuration and a
local service token. The Notification Worker (Novu) is off in production
(`HID_NOTIFICATION_WORKER_ENABLED` is fixed to `false`) and reads no
`novuApiKey`. Every OTP send writes one PHI-free `notification.otp.outcome` log
line, and `OtpDefinitiveFailures` alarms on its `definitive_failure` count. The NIN holder code (ADR-062, purpose `NIN_HOLDER_VERIFY`) goes by SMS
only, through Termii, and counts there too. Before `NIN_HOLDER_SMS_ENABLED`
is set, add the holder SMS volume and failure ratio alerts of the release
checklist §10; Termii's sender ID (P18) and QoreID's written confirmation of
`nin.phone` (P23) come first.
When the fallback ran, the line also names the primary provider and its safe
code (`primaryProvider`, `primarySafeCode`); read those for why SES or Termii
failed. Migration 0047 seeds Brevo as an enabled email and SMS fallback, and
production gives it no key, so it answers `not_configured`: before ingress a
platform administrator pauses it (§13 step 5, release checklist P21).

Novu also needs the configured workflow, canonical synthetic patient subscriber
mapping and approved delivery integration. The synth input
`HID_NOVU_SUBSCRIBER_SYNC_ENABLED` (default `false`, staging only, refused in
production; ADR-064) makes the worker map the subscriber's verified login email
itself; set it only after release checklist P35. See
[provider accounts and activation](STAGING_PROVIDER_ACCOUNTS.md) and
[read-only external preflight](STAGING_EXTERNAL_PREFLIGHT.md). No key-presence or
health check substitutes for actual delivery evidence.

## 1. Freeze the release inputs

Record and approve:

- exact Git SHA and release ID;
- AWS account/region and `development`, `staging`, or `production` profile;
- Cloudflare account/zone and one selected profile. At launch (ADR-052,
  `infra/cloudflare/launch-deployment.json`) production deploys only `www`,
  `admin`, the apex redirect and `api.healthidentitydirectory.com`; staging
  deploys only `staging`, `admin.staging` and
  `api.staging.healthidentitydirectory.com`. The other application hosts are
  configured but not deployed;
- for each deployed frontend host, the Health-id commit and its staged
  `apps/patient-web` build with `provenance.json` (`infra/cloudflare/README.md`),
  verified by `npm --prefix infra/cloudflare run verify:launch:<environment>`;
- regional ACM certificate covering that API origin and the internal wildcard
  certificate;
- RDS CA bundle and regional S3 managed prefix-list ID;
- staging workload issuer/JWKS stack outputs and signing-key ARN, the admitted
  Identity API image used by all six token agents, and the fixed IAM
  caller/audience map; the same production outputs under ADR-047 (§12); for
  development, the external issuer/JWKS/subjects and token delivery
  mechanism;
- nine non-owner database secrets plus a separate migration administrator;
- Identity auth/OTP/Turnstile secret material and the platform MFA key
  `mfaSecretKeyB64` (below); legacy NIN material remains
  excluded from current staging requirements. If QoreID staging activation is
  separately approved, add its distinct `clientId`/`secret` envelope only;
- for staging email acceptance, SES sender and Novu secret material only; for
  production the four `otp-email-sms` fields only (SES sender and Termii base
  URL, key and approved sender ID; above). FCM is not instantiated by the
  current worker and is outside this acceptance scope;
- the exact ARN of the environment's operator-created alarm topic
  `hid-<env>-operational-alerts` (synth input `HID_OPERATIONAL_ALARM_TOPIC_ARN`,
  required for production, ADR-053, §13) and the on-call recipients the
  operations owner names for it;
- for production, the reviewed I6 parameter file: every `*DesiredCount` is 0 by
  default and is raised there, enabled services only, to at least the live
  minimum in its description; Lab, Pharmacy, OCR (API and worker), Outreach and
  the Notification Worker are pinned at 0 (launch module set D17); and
- one independently generated origin secret per environment, stored only in
  that environment's Cloudflare Worker secret binding and its matching AWS WAF
  parameter; staging and production values must differ.

Do not reuse local, historical Vercel, Supabase, or Brevo credentials. Any
previously exposed live-looking credentials must be rotated/revoked by their
external owners before cutover.

The Identity task reads `MFA_SECRET_KEY_B64` from the `mfaSecretKeyB64` field of
the `IdentitySensitiveSecretArn` secret and runs with `MFA_KEY_VERSION=aws-v1`
in every environment (D-Eminence/hid-system#49). Before deploying that task
definition, add `mfaSecretKeyB64` to the environment's secret: 32 bytes from a
cryptographically secure generator in canonical padded base64 (44 characters),
written without printing it and keeping every other field. Generate it
separately for each environment; never copy it from staging or any other
environment. ECS resolves every referenced JSON field before it starts a task:
while the field is missing no Identity task starts, so on a first deployment
every patient, staff and platform sign-in is down, and an update fails and is
rolled back by the deployment circuit breaker. A malformed value stops Identity
at start-up. The key and version are fixed at the first authenticator
enrolment; changing either invalidates every enrolled authenticator (release
checklist P3).

The same applies to every other field the Identity task reads from that
secret. The `IdentitySensitiveSecretArn` parameter description names exactly
those fields for the environment being deployed, from the same list the task
definition is built from; read it from the synthesized template rather than
from memory. Staging reads `ninLookupHmacKeyB64` and `ninEncryptionKeyB64` only
when QoreID is enabled (`HID_QOREID_ENABLED=true`), so a QoreID activation must
add both, each 32 bytes in canonical padded base64, before its first deployment.
For staging, the [external preflight](STAGING_EXTERNAL_PREFLIGHT.md) reports
whether `otpHmacKeyB64`, `contactLookupHmacKeyB64` and `mfaSecretKeyB64` are
present and whether each has the format Identity accepts
(`canonical_32_byte_base64`); with `--qoreid` it also checks
`ninLookupHmacKeyB64`, `ninEncryptionKeyB64` and the QoreID credential field
names. It reports `google_sign_in_enabled` and accepts an empty
`googleOidcClientIds`. It is staging-only; production uses
`scripts/production-external-preflight.py` (§13).

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
Under ADR-047 (accepted 2026-10-13, not deployed) production takes its own
issuer from its own stack in the same way, with its own key, API, `/production`
stage and `hid:production:<service>` subjects, and no longer accepts these
parameters. That changes the production template: record a new production
template baseline (§12) instead of comparing with an earlier one. Development
keeps its external workload-identity inputs.

**Recorded template baseline.** Offline synthesis of D-Eminence/hid-system#49
(with `main` at `6b49a06` merged, which changes nothing under `infra/aws`)
with `npm --prefix infra/aws run synth:prod` (and `synth:dev`), no
`HID_AWS_ACCOUNT`/`HID_AWS_REGION`, no AWS credentials, `aws-cdk-lib` 2.273.0 and
CDK CLI 2.1144.0:

| Profile | Template SHA-256 | Bytes |
| --- | --- | --- |
| Production | `b4cdde915ac7e4775fba43a477f4870ccae7130f24c6180625cc409a510218bb` | 524,141 |
| Development | `20f16446bca81a8e601c76fa2fd072b5d40c8466448e2a7bdc8ddee751a603c7` | 523,711 |

Why it changed: this branch gives the Identity task its MFA key secret
reference and `MFA_KEY_VERSION`, and rewrites the `IdentitySensitiveSecretArn`
description to name every field the task reads from that secret (release
checklist P3). A structural comparison with its base `05df685` finds exactly
those three differences in production, development and each staging mode. The
earlier record, the September 14 synthesis in the
[staging execution report](TUF-STAGING-EXECUTION.md) (production
`f05320072901de1b34d0004a3d9b95f6b16a88b31bff0c6682bf2d7cb1d6b2b6`, 464,453
bytes; development
`42cadadc0cda9ef7f13c86f27937b066662f417e5e5925fc2a46a1bb708db73c`, 517,254
bytes), was already stale: `05df685` synthesizes to
`3c69a5b608eae12f0617822c0225eeec1c7c3058eace9fe257dc5c6854dc9c4a` (523,299
bytes) and `a0709512071047ffca3cfd41f88fc2718334565ac61723b4a17e1a98a2b4cf1b`
(522,869 bytes). Nine later commits touch `infra/aws/src` or its CDK
dependencies, among them the QoreID and enrolment changes and the
`aws-cdk-lib` 2.273.0 upgrade; together they changed both templates without
updating the record. Every later change to a template replaces its row here,
with the reason.

**Under ADR-047 (D-Eminence/hid-system#54).** The same offline
synthesis of this branch, with `main` at `bbc6e89` merged, with the AWS
credential variables removed from the environment and `AWS_CONFIG_FILE` and
`AWS_SHARED_CREDENTIALS_FILE` pointing at no file, gives production
`8e9a06321042bcbc0cbe474cfbf51388c6791913c47b45e59319d5665026d7a2` (574,128
bytes, 438 resources, 54 parameters): its own issuer with the signing-key Deny
statements, per-method throttles and the NAT-allowlist web ACL, six token
agents that are not essential and have a restart policy, and eight fewer
parameters (§12). It replaces the draft's earlier
`030830a5a6b6018eb349fb606a547eaf98c5a4b3255386f52cb751895b64d960` (568,579
bytes), which had none of the DEP-4-KEY, DEP-4-DOS and DEP-4-RES changes.
Development is unchanged
(`20f16446bca81a8e601c76fa2fd072b5d40c8466448e2a7bdc8ddee751a603c7`, 523,711
bytes). The staging templates are sleep
`54057bff8ec55bd6d616ff4f714bdf76c7ef05b4340e6aceabc99b469c01bc44` (319,501
bytes), economy
`3b1e2597b44074e2889a7a4bd509188a44db39570d0c02e3901c4b2a674d4a12` (565,406
bytes) and fidelity
`445b52324d22f9cde3ae4d105379033e0bca9960cfcd610ecc5c31e98db587de` (569,255
bytes). `verify:synth` and `verify:policy` pass for all five. The production
row above stays `main`'s until this branch merges; then this hash replaces it.

**Under ADR-053 (D-Eminence/hid-system#66).** The same offline
synthesis (AWS credential variables removed, `AWS_CONFIG_FILE` and
`AWS_SHARED_CREDENTIALS_FILE` pointing at no file, no `HID_AWS_ACCOUNT`, no
`HID_ENABLED_API_ROUTES`) gives production
`86d181b0f1a33d418148e5392e1c5cdd2b63a227a6b02b42fbf90399cf148c94` (547,992
bytes, 407 resources, 54 parameters, 31 alarms, 16 metric filters), development
`5aa6316de24a67c36ccd3572023f352dd879d5fbd3c8de764340976b3b9e5be1` (478,747
bytes), staging sleep
`c1c018c79f403100bb221774d80eba07ec3c7822b508ac6a8d3467247c2c88e9` (325,081
bytes), economy
`58e7ebad9bb1eccb598771a3771fb3ee244f63f8a88afaeeb246174c76749018` (529,196
bytes) and fidelity
`4bba6856bdf2acbbfcaa6a4540c6162376f7c1d768bdae2c41d7b14220dde5d8` (533,045
bytes). Production was synthesized with a synthetic
`HID_OPERATIONAL_ALARM_TOPIC_ARN`; the template does not contain it (the alarm
action is built from the deploying account, region and partition), so any
valid input gives the same template. Why it changed: every production
`*DesiredCount` defaults to 0; the modules that are off are pinned at 0 with
no scaling policy and lose their alarms; every production alarm has the topic
as its alarm and OK action; the issuer, renewal and OTP alarms and their metric
filters are new; notification-api runs `otp-email-sms` with four provider
fields; Identity gets `QOREID_NIN_ONLY_ENROLLMENT_ENABLED=false`. The base
templates after D-Eminence/hid-system#65 were not re-recorded here. Record the
production baseline again from the approved SHA (§12 step 2).

**Under ADR-055 (D-Eminence/hid-system#72).** The same offline synthesis
on `main` `cf5a14f` plus this branch (with its review follow-up) gives
production
`6e0300ce7fd7f083759d419208b83a70cd515075c68859055b7926fcf6af4609` (550,607
bytes, 407 resources, 54 parameters), development
`190f915e24bcd841c973198fb15d0e952e7851668d4012e108d6cd72115594ea` (481,364
bytes), economy
`d2cc1e696d4f6cf1aefd5e867c7b209b5c6ce50c20e7e289b4818b52c34e8a8b` (531,805
bytes) and fidelity
`b5d3962f7864c03bc3cd35c7eb5ddc44cd677ea9e3a0a8b5f24a59692279ea08` (535,654
bytes); sleep, which has no public web ACL, is unchanged
(`c1c018c79f403100bb221774d80eba07ec3c7822b508ac6a8d3467247c2c88e9`). The base
`cf5a14f` synthesizes production to the ADR-053 hash above, and a structural
comparison finds exactly one changed resource, `ApiOriginWebAcl`, whose rules
change and nothing else: the Core Rule Set's `SizeRestrictions_BODY` override
to count, the new `AwsCommonRulesBodySize` and `ApiOriginEdgeRateLimit` rules,
and `ApiOriginRateLimit` keyed on `X-HID-Client-Network` (`FORWARDED_IP`), the
client network the Worker derives from `CF-Connecting-IP`. Deploy the Workers
that send that header before this web ACL: behind a Worker that does not,
requests are counted only by the backstop. `verify:synth` and `verify:policy`
pass for all five profiles.

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
HID_OPERATIONAL_ALARM_TOPIC_ARN=<exact production topic ARN> npm --prefix infra/aws run synth:prod
HID_INFRA_ENV=production npm --prefix infra/aws run verify:synth
npm --prefix infra/aws run verify:policy
```

A production synth refuses to run without `HID_OPERATIONAL_ALARM_TOPIC_ARN`
(ADR-053). For an offline check with no topic yet, any ARN of the form
`arn:aws:sns:<region>:<12 digits>:hid-production-operational-alerts` gives the
same template; a deployment must use the real topic's ARN with
`HID_AWS_ACCOUNT` and `HID_AWS_REGION` set, so that a topic in another account
or region is refused at synth. `verify:synth` checks that every production
`*DesiredCount` defaults to 0, that the modules that are off are pinned at 0
with no scaling policy or alarm, that every alarm notifies the topic on ALARM
and OK, the issuer, renewal and OTP alarms, and the notification-api provider
fields.

Expected topology is one regional stack, eleven ECS services, eleven ECR
repositories, twelve task definitions/image inputs including migration, the
notification queue/DLQ/rule, and zero CloudFront distributions.
Every staging mode additionally has the stable workload issuer API Gateway,
Lambda, and fourth KMS key, and so does production under ADR-047, with its
own; staging economy and fidelity and production also have the issuer's
NAT-allowlist web ACL (two web ACLs in all). Six API task definitions include
token agents from the Identity API image; they add no new image identity or
ECS service.

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
leakage, and released independently per host. At launch the only frontend is
Health-id `apps/patient-web`, built once per host and staged with
`infra/cloudflare/scripts/stage-health-id-build.mjs`, which refuses a build
bound to another origin or environment, carrying Google sign-in, source maps,
a service worker, a manifest or unexpected files, or an `index.html` other
than the allow-listed Vite shell, and records the source commit and every
file's SHA-256 in `provenance.json`. It replaces an existing staged directory
only when that is an earlier artefact of the same Worker and environment. The signed release
bundle's frontend section still describes the legacy builds (ADR-052); until
it carries the Health-id artefact, the staged artefact's provenance is the
frontend release record.

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

Migrate and provision as `MIGRATION_RUNBOOK.md` §6 describes: the RDS master
grants the migration administrator `SET ON PARAMETER
plpgsql.variable_conflict` only for a migration run that applies 0015 and
revokes it after 0083; the migration administrator, a `NOSUPERUSER NOBYPASSRLS
CREATEROLE` LOGIN, applies `runtime-grants.sql` with `npm run db:bootstrap`
and `db:verify-roles`. As that administrator, which alone may grant the
aggregate roles (the RDS master is refused), create one LOGIN per runtime
secret (the EHR secret's `scannerUrl` is a second, scanner-only LOGIN) and
verify every one with `npm run db:verify-logins`, which connects with each
secret's own URL and refuses a superuser, `BYPASSRLS`, owner or
migration-administrator login, an extra role and a shared login. In production
each service also refuses to start over such a connection.

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

This staging proof (launch plan I5) is also a precondition of the production
issuer of ADR-047 (accepted 2026-10-13); production's own checks are in §12.
Running it needs a staging deployment authorization; accepting ADR-047 is not
one.

Verify all six staging token agents use the admitted Identity API digest and
the exact role/subject/audience bindings in the
[IAM matrix](AWS_IAM_MATRIX.md#workload-identity). Each agent must run as
UID/GID 65532 with a read-only root filesystem and write only its owned token
volume. Confirm mode 0700 on the directory, atomic mode-0600 token files, a
read-only application mount, and application startup gated by the agent's
`health.mjs` check (`HEALTHY` dependency). Confirm in the registered task
definitions that the agent is `essential: false` with a restart policy
(`RestartAttemptPeriod` 60) and the application is essential. Inspect
readiness and sanitized outcomes without printing token contents.

With synthetic service requests, verify ES256 signatures and the exact issuer,
subject, audience, `token_use: workload` and 300-second lifetime. Observe
renewal at about 90 seconds with one JWKS fetch per agent after start (the
agent caches the verified key by `kid`), bounded 10-second retry after failure
(until its first token verifies, the JWKS fetch is retried with it; afterwards
at most every 30 seconds), removal before expiry, and an `UNHEALTHY` agent once
usable credentials are unavailable while its task keeps running. Verify the
mapped caller can request only its allowed audiences and cannot sign directly
with KMS. Run the caller-refusal checks from inside the VPC (for example a
one-off task in the application subnets whose role is not in the caller map);
the web ACL refuses them from anywhere else. These local contracts still require live staging
proof of ECS IAM credentials, network reachability, API Gateway authorization,
KMS signing, and receiver validation; successful synthesis alone is
insufficient.

Issuer hardening (ADR-047 D1-D3), each with recorded evidence:

- **Key policy.** `aws kms get-key-policy` shows the root statement and the
  three Deny statements. Grant a staging test role `kms:Sign` on the key by IAM
  and confirm `kms:Sign` is refused (`AccessDeniedException`); then remove the
  grant. CloudTrail shows `Sign` on the key only from the issuer role, with
  `ECDSA_SHA_256` and `RAW`.
- **Edge allowlist.** In economy or fidelity, a `GET` of the JWKS and an
  unsigned `POST /token` from an operator workstation answer `403` from the web
  ACL (its `BlockedRequests` metric counts them), while every agent stays
  `HEALTHY`. The IP set lists exactly the VPC's NAT gateway Elastic IPs.
- **Flood.** From a source that is not on the allowlist, flood both the JWKS
  `GET` and `POST /token` for at least 30 minutes, longer than the 300-second
  token lifetime and the receivers' 10-minute JWKS cache. Expect WAF blocks,
  no `Workload token renewal unavailable` line, no task replacement, and
  successful EHR-to-Identity, EHR-to-Lab, EHR-to-Pharmacy and OCR-to-EHR calls
  throughout. Scale one token task out during the flood and confirm it becomes
  `HEALTHY`.
- **Issuer outage (D2).** Deny one task role's `execute-api:Invoke` for six
  minutes, longer than a token's lifetime. Expect its agent to turn
  `UNHEALTHY` and its task to keep running; that task's service-to-service
  calls answer `503`; Identity password sign-in keeps working (when the denied
  role is Identity's, each OTP it cannot send logs
  `notification_workload_token_unavailable` with a running count). Restore the
  grant and confirm renewal resumes within about 10 seconds, without a task
  replacement.
- **Receivers.** A token without `exp`, older than 300 seconds, issued in the
  future, signed with another algorithm or with another `token_use` is refused
  `401`. Only the issuer role can sign with the key, so staging cannot mint
  such a token; the unit suites prove the refusals against real tokens, and
  staging confirms that the Identity, Notification, Lab, Pharmacy and EHR
  tasks run the admitted digests built from this change.

Agent stopped (D2), in any environment: ECS restarts an agent only if it
exited after running for at least 60 seconds. When `aws ecs describe-tasks`
shows a task `RUNNING` with its `workload-token-agent` container still
`STOPPED` a minute later, ECS did not restart it (it exited within 60 seconds
of its last start). The task has no token writer and its token files stay
after they expire: Identity's Notification client logs
`notification_workload_token_unavailable` with `reason=expired`, and other
callers' requests are refused `401`. Stop that task so its service starts a
new one, and record the agent's exit code and last log lines (never a token).

Before raising task counts, prove in staging:

- missing, expired, wrong-audience, wrong-subject, bad-signature, and rotated
  workload JWT behavior, including the key-disable drill of §12 (Rollback) on
  the staging key;
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

Deploy only the launch Workers of `infra/cloudflare/launch-deployment.json`
(ADR-052): `hid-web` and `hid-admin` in each environment, and the production
apex redirect. `hid-ehr`, `hid-lab`, `hid-pharmacy`, `hid-ocr`,
`hid-ocr-redirect` and `hid-outreach` are not deployed; their APIs stay closed
by the gateway's `HID_ENABLED_API_ROUTES`. Before deploying, stage the Health-id
build for each host and run
`npm --prefix infra/cloudflare run verify:launch:<environment>` and
`dry-run:<environment>` (after `npm --prefix infra/cloudflare ci`; they need no
hid-system frontend build, since the legacy builds belong to Workers that are
not deployed).

For each deployed frontend, bind the exact selected-environment custom hostname,
the staged asset directory (`staged/<environment>/site`), compatibility date,
and matching Worker origin secret. Validate apex redirect where applicable,
TLS, security headers, application-specific camera/geolocation permissions,
direct refresh (single-page fallback), cache rules, and `/api/v1/*` proxy
behavior. The Health-id artefact has no service worker or web app manifest:
`/service-worker.js` and `/manifest.webmanifest` must answer with the
application shell, not a script or manifest. The AWS origin must reject a
direct request without the origin secret.

Release and roll back each application independently. A frontend rollback must
not change an API image or database schema.

The Workers set `X-Real-IP` from `CF-Connecting-IP`, and the gateway of
staging and production refuses API requests without it
(`403 CLIENT_ADDRESS_REQUIRED`). Every deployed Worker that proxies `/api/v1`
(at launch web and admin) must send the header before a gateway that requires
it is deployed: deploy them, and once that gateway runs confirm on each
deployed host that a request carrying its own `X-Real-IP` reaches Identity with
the client's public address instead. A Worker built
before this change deletes a caller's `X-Real-IP` and sets none, so behind it,
or behind a Worker rolled back to such a build, the gateway answers `403` to
every API request (it does not trust a caller-chosen address). Do not roll a
Worker back while such a gateway runs.

## 9. Progressive runtime rollout

Raise minimum dependencies first: Identity and Notification API, then owner
APIs and Gateway, then OCR Worker, Event Dispatcher, and Notification Worker.
Use small desired counts and alarms before reaching the environment profile.
In production every `*DesiredCount` defaults to 0 and is raised only through
the reviewed I6 parameter file, each enabled service to at least the live
minimum in its description (ADR-053); the modules that are off (Lab, Pharmacy,
OCR API and worker, Outreach and the Notification Worker at launch) are pinned
at 0, and a parameter file that raises one fails CloudFormation validation.
Every production alarm notifies the operational topic (§13); confirm a
recipient received the topic's test message before scaling up. While an
enabled service runs 0 tasks its running-task alarm (missing data is
breaching) is in `ALARM`: on the first production deploy
`GatewayRunningTaskAlarm`, `IdentityApiRunningTaskAlarm`,
`EhrApiRunningTaskAlarm`, `NotificationApiRunningTaskAlarm` and
`EventDispatcherRunningTaskAlarm` each notify the topic, and notify again on
`OK` once the service runs its live minimum. Tell the on-call recipients
before the deploy; a running-task alarm still in `ALARM` after its service
was scaled is a real failure.

The gateway proxies only the modules in its `HID_ENABLED_API_ROUTES`
(`identity,ehr` unless a staging synth sets the synth input of that name; a
production synth refuses more) and resolves upstream names per request, so it
starts and keeps serving Identity and EHR while a module runs no task, and it
follows Identity and EHR redeploys without its own redeploy. When upgrading a
running environment, deploy Identity with the client-network change only after
the gateway that forwards the client address: behind an earlier gateway, every
public IP-keyed Identity request in production answers `503`.
Run clinical, identity, OCR, notification, offline/reconnect, and administrative
smoke tests with synthetic data. Lab, Pharmacy, OCR and Outreach checks through
the edge need a staging synth whose `HID_ENABLED_API_ROUTES` names those
modules; with the default the gateway answers `404 API_ROUTE_NOT_FOUND`.

Observe RDS connections/storage, ALB/WAF results, task health/restarts, queue
age/DLQ, event terminal failure, provider outcomes, OCR failures, S3/KMS denies,
and sanitized telemetry. Stop on unexplained authentication, duplicate patient,
OTP, notification, or migration behavior.

With ADR-059 (D-Eminence/hid-system#76) a fault no longer
signs users out: it answers `503` with a stable code and Health-id retries, so
an outage shows up as `503` rates, not as a wave of sign-ins. Watch for
`AUTHENTICATION_UNAVAILABLE` and `PLATFORM_CONTROL_UNAVAILABLE` from Identity
(database, OIDC key set or runtime-control reads),
`WORKLOAD_IDENTITY_UNAVAILABLE` from Identity (the workload issuer's JWKS
cannot be fetched), and `IDENTITY_SERVICE_AUTH_UNAVAILABLE` and
`IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE` from EHR (Identity refused EHR's
workload token, or the token file EHR reads has expired). Each expired token
EHR refuses to send is logged as `identity_workload_token_expired`: the token
agent has stopped renewing (ADR-047 D2); restart the agent or its task. No
alarm is defined on that log yet. `403 ORIGIN_DENIED` from any service means a
browser origin outside `CORS_ORIGINS`; before ADR-059 it was a `500`.

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
Frontend rollback selects the previous per-host Cloudflare artifact: restage
the previous accepted Health-id commit's build for that host, re-verify it
(`verify:launch:<environment>`) and redeploy that Worker only. Database
rollback is not a down migration: use additive correction or the approved
PITR/incident path. Preserve deployment parameters, manifest, approvals,
redacted test evidence, reconciliation totals, and rollback decision.

Local implementation leaves every operation in sections 3–13 externally
pending; no account, DNS, provider, database, or production state is mutated by
repository acceptance.

## 12. Production workload issuer (ADR-047): operator plan, not approved

**NOT APPROVED. Do not execute.** ADR-047 is accepted (2026-10-13), with D1
(an independent production key, API, stage and `hid:production:<service>`
subjects behind a key policy that lets only the issuer role sign), D2 (the
agent is not essential and has a restart policy) and D3 (a NAT-allowlist web
ACL on the issuer stage). Accepting the decision authorizes no deployment.
This plan has not been run: no account was read and nothing was deployed or
applied. It adds no authority to the production lock.

Preconditions:

- A separate deployment authorization for this rollout (I6).
- Staging redeployed from the same approved SHA, with this change's issuer
  Lambda and Identity API image, and its §7 live proof recorded, including the
  key-policy, edge-allowlist, 30-minute flood and issuer-outage checks (I5).
- The production unlock approval and a production change approval.
- Sections 1–4 complete for the release, with every image admitted.

Steps:

1. Build and admit (§3, ADR-035) the Identity API image that contains this
   change's `services/workload-token-agent`; every production token agent runs
   from `IdentityApiImageUri`. Record its digest. An earlier image's agent
   refuses `production`, so a token task with it never starts its application.
2. From the approved SHA, run the §2 gates, including
   `HID_OPERATIONAL_ALARM_TOPIC_ARN=<exact ARN of the §13 topic> HID_AWS_ACCOUNT=<approved account> HID_AWS_REGION=<approved region> npm --prefix infra/aws run synth:prod`
   (a production synth without the topic ARN fails, ADR-053, so §13 step 1
   comes first),
   `HID_INFRA_ENV=production npm --prefix infra/aws run verify:synth`,
   `npm --prefix infra/aws run verify:policy` and
   `npm --prefix infra/aws run cost:inventory:check`. Record as a new evidence
   entry, without replacing any earlier baseline:
   - the production template's SHA-256, size, resource and parameter counts;
   - the issuer asset hash (the `S3Key` of `ProductionWorkloadIdentityIssuer*`
     and its `cdk.out/asset.<hash>` directory) and the Git SHA it was built
     from; the issuer code is a CDK file asset, not an admitted image;
   - the staging template diff against the staging template last deployed,
     which must be the issuer asset key, the signing-key Deny statements, the
     two per-method settings replacing the `/*/*` setting, the agent's
     `Essential`/`RestartPolicy` and, in economy and fidelity, the IP set, web
     ACL and association.
3. In the production account and region, read-only:
   - confirm the CDK bootstrap version (`/cdk-bootstrap/hnb659fds/version`)
     and its asset bucket; the deploy publishes the issuer asset there;
   - run §13 first: the production preflight's launch profile must pass, which
     includes the operational alarm topic; synthesize with that topic's exact
     ARN in `HID_OPERATIONAL_ALARM_TOPIC_ARN` and with `HID_AWS_ACCOUNT` and
     `HID_AWS_REGION` set;
   - run `cdk diff Hid-production-Regional --no-lookups` with the reviewed
     parameter file. Expect exactly:
     - additions: the `ProductionWorkloadIdentity` key (`Retain`, with the
       root statement and the three `kms:Sign` Deny statements), alias, log
       group (`Retain`), issuer role and policy, function, REST API, three
       resources, two methods, deployment, stage `production` (two per-method
       settings, no `/*/*` setting), two Lambda permissions, the issuer IP set
       (the two NAT gateway Elastic IPs), web ACL (default block) and its
       association with the stage, the three `ProductionWorkloadIdentity*`
       outputs, and five task-role default policies (Identity, Lab, Pharmacy,
       OCR API and Outreach) granting `execute-api:Invoke` on
       `/production/POST/token`;
     - a modification of the EHR task role's existing default policy, which
       gains the same `execute-api:Invoke` statement and nothing else;
     - new revisions of the six token task definitions (the agent added, not
       essential, with a restart policy) and of the Notification API and OCR
       worker task definitions (issuer, JWKS and subject values now from the
       stack), eight in all;
     - `DependsOn` changes on services, scaling targets and policies and
       service-discovery services;
     - removal of the eight workload parameters;
     - under ADR-053 (D-Eminence/hid-system#66), if the stack was
       last deployed without it: the alarm and OK actions on every alarm, the
       four issuer alarms, the renewal and OTP metric filters and alarms, the
       removal of the alarms and scaling policies of the modules that are off,
       new `*DesiredCount` defaults and ranges, new Notification API and
       Identity API task-definition revisions (the `otp-email-sms` profile and
       four provider fields; `QOREID_NIN_ONLY_ENROLLMENT_ENABLED=false`), and
       the `OperationalAlarmTopicArn` output.
   - Stop on any replacement or deletion of RDS, S3, the data KMS keys, ECR
     repositories or log groups, or on any other change.
4. Deploy with every `*DesiredCount` at `0` and the eight workload parameters
   removed from the parameter file. Record the `IssuerUrl` and `JwksUrl`
   outputs and the signing key ARN. Never record a token. Expect the five
   running-task alarms of the enabled services to enter `ALARM` and notify the
   on-call recipients, who were told beforehand (§9); each returns to `OK` in
   steps 6 and 7 or in §9.
5. With no task running, verify the issuer:
   - from an operator workstation, `GET <JwksUrl>` and an unsigned
     `POST <IssuerUrl>/token` answer `403` from the web ACL, and its
     `BlockedRequests` metric counts them;
   - the web ACL's IP set lists exactly the two production NAT gateway Elastic
     IPs, its default action is block, and it is associated with the
     `production` stage;
   - `aws kms get-key-policy` shows the root statement and the three Deny
     statements naming the issuer role; `aws kms get-public-key` shows
     `ECC_NIST_P256` and `SIGN_VERIFY`;
   - the function's environment has `HID_DEPLOYMENT_ENV=production`, six role
     ARNs, eleven bindings and only `hid:production:` subjects;
   - CloudTrail shows `kms:Sign` on the key only from the issuer role;
   - the staging issuer's key ID, and so its `kid`, differs from production's.
   The JWKS content and the caller refusals were proved in staging (§7); in
   production the first agent to become `HEALTHY` (step 6) proves the JWKS
   serves the key, because the agent verifies every token against it.
6. Scale the Notification API, then the Identity API, to their minimum. Each
   task's `workload-token-agent` must be `HEALTHY` before its application
   starts; no `Workload token renewal unavailable` or
   `notification_workload_token_unavailable` line may appear; an OTP start for
   a synthetic account must not end with `safeCode` `http_401` or
   `workload_token_unavailable`.
7. Scale the EHR API. On synthetic data an EHR request authenticates through
   Identity's service session. Lab, Pharmacy, OCR and Outreach are off at
   launch (D17) and pinned at 0 tasks (ADR-053); their checks (Lab accepts an
   EHR order, OCR publishes to EHR, Lab and Pharmacy) belong to the reviewed
   change that enables each module.
8. Watch renewals (about every 90 seconds), task health (including any
   `workload-token-agent` container `STOPPED` in a running task, §7 "Agent
   stopped"; no alarm covers it), issuer Lambda errors and API `5XX` for at
   least 15 minutes before continuing with §9. The issuer, renewal and OTP
   alarms (ADR-053) must stay `OK`, the running-task alarms of the services
   scaled so far must have returned to `OK`, and their notifications must
   have reached the on-call recipients. The running-task alarms of the
   services not yet scaled stay in `ALARM` until §9.

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
- Key disable, on suspected key misuse (and as a staging drill, §7):
  1. Set the issuer function's reserved concurrency to `0`. This stops both
     `POST /token` and the JWKS `GET` at once and leaves no warm container.
  2. Disable the key (`aws kms disable-key`), so that no principal can sign
     with it. Disabling alone also works, more slowly: a warm issuer re-reads
     the public key at least every five minutes, then answers `503` for the
     JWKS and for minting.
  3. Wait at least 10 minutes. Receivers keep their cached JWKS for up to 10
     minutes and accept, until then, an ES256 token signed with the key that
     is at most 300 seconds old (5 seconds of clock tolerance) and carries
     `token_use: workload`. A token pre-signed with a future `iat` by whoever
     misused the key becomes valid when its `iat` arrives, so only removing the
     key from the JWKS ends that exposure.
  4. Every service-to-service call now fails closed, and Identity logs each OTP
     or alert it cannot send. Recovery is a new key (new `kid`) through an
     approved change and redeploy; re-enabling a key you suspect is not
     recovery. In a drill, re-enable the staging key, remove the reserved
     concurrency, and confirm renewal resumes.
  Do not schedule key deletion without a separate approval; it is
  irreversible after its waiting period.
- The key and the issuer log group are retained if the construct or stack is
  removed. Deleting them is a separate, approved action.

## 13. Production launch preflight and alarm topic (ADR-053): operator plan, not approved

**NOT APPROVED. Do not execute.** Prepared in D-Eminence/hid-system#66.
Nothing here has been run: no production account was read, no topic, key,
subscription or secret exists, and nothing was deployed. Each step needs the
production deployment authorization of §12.

External dependencies: the operations owner names the on-call recipients of
`hid-production-operational-alerts`; SES production access and a DKIM-verified
domain in the production account; a Termii account with an approved Nigerian
sender ID; the security owner's production keys (launch plan I1).

1. **Alarm topic.** In the production account and region, create a
   customer-managed KMS key whose key policy keeps the account root statement
   and lets `cloudwatch.amazonaws.com` call `kms:GenerateDataKey*` and
   `kms:Decrypt` (CloudWatch cannot publish through the AWS-managed
   `alias/aws/sns` key), then the standard SNS topic
   `hid-production-operational-alerts` encrypted with it. Subscribe each named
   recipient and have each confirm. Publish one test message and record that
   every recipient received it. Record the topic ARN for
   `HID_OPERATIONAL_ALARM_TOPIC_ARN`; it is not a secret.
2. **Identity sensitive secret** (launch plan I1, REC-GOOGLE): five independent
   32-byte keys (`mfaSecretKeyB64`, `otpHmacKeyB64`, `contactLookupHmacKeyB64`,
   `ninLookupHmacKeyB64`, `ninEncryptionKeyB64`) in canonical padded base64,
   `turnstileSecretKey`, and `googleOidcClientIds` present with an empty value
   (Google sign-in off), merged through `jq` from standard input. Never print a
   value or reuse a staging value.
3. **Notification provider secret:** exactly `sesFromAddress` (an address on
   the DKIM-verified domain), `termiiBaseUrl`, `termiiApiKey` and
   `termiiSenderId` (the approved sender ID), and nothing else.
4. **Preflight.** With an existing read-only session in the production
   account:

   ```bash
   HID_AWS_ACCOUNT=<approved production account> HID_AWS_REGION=<approved region> \
     python3 scripts/production-external-preflight.py --cloud-read-only \
     --output release/local/production-external-preflight.json
   ```

   It refuses the staging account, reads only (`sts get-caller-identity`,
   `secretsmanager get-secret-value` for the three production secrets,
   `sesv2 get-account`, `sesv2 get-email-identity`,
   `sns get-topic-attributes`, `kms describe-key` and `kms get-key-policy` for
   the topic's key; the session needs `kms:DescribeKey` and
   `kms:GetKeyPolicy` on it) and writes a value-free receipt: field presence,
   a canonical-format boolean per key, `google_sign_in_enabled`, whether the
   notification secret holds exactly the four fields, SES production access,
   sending and DKIM, and for the topic whether its key is customer managed,
   enabled and in the topic's account and region, whether the key policy
   lets `cloudwatch.amazonaws.com` call `kms:Decrypt` and
   `kms:GenerateDataKey`, and the confirmed subscriptions. Any spelling of
   the AWS-managed `alias/aws/sns` key (alias, alias ARN, key id or key ARN)
   fails. It exits 1 unless `launch_profile.passed` is true. The Termii
   sender-ID approval and the recipients' receipt are not readable from AWS:
   record them separately (release checklist P18, P16).
5. **Brevo fallback paused** (release checklist P21). After migration 0047
   is applied in production (it seeds Brevo enabled as the email and SMS
   fallback) and before ingress, a platform administrator with
   `platform.integration.manage` pauses Brevo with the audited
   `POST /api/v1/admin/integrations/brevo/pause` (a critical action: MFA
   platform session, TOTP step-up, a reason, `If-Match` and
   `Idempotency-Key`), which records the actor in the integration audit. Identity then plans no fallback, and a definitive SES
   or Termii failure is reported as the primary's. `GET /api/v1/admin/integrations/brevo`
   must show it paused.
6. Synthesize with `HID_OPERATIONAL_ALARM_TOPIC_ARN`, `HID_AWS_ACCOUNT` and
   `HID_AWS_REGION` (§2) and continue with §12.

After deployment, confirm in CloudWatch that every alarm of the stack lists the
topic as its alarm and OK action, then run a synthetic signup OTP over email
and over SMS and a recovery OTP, and check that each wrote one
`notification.otp.outcome` line with outcome `accepted` and no recipient, code
or message. A line with `fallbackUsed: true` means Brevo was not paused (step
5); its `primaryProvider` and `primarySafeCode` give the primary's result.

Rollback: the topic, key and subscriptions are retained; removing them makes
alarms notify nothing. To stop notifications without hiding alarm state,
unsubscribe a recipient rather than editing the stack.
