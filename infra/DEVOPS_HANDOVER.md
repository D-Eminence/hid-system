# Health ID DevOps handover

Last verified: 19 October 2026. This is the operational baseline at handover;
read back current cloud state before any release. Resource identifiers and secret
references below are configuration, not secret values. Do not put credentials,
patient data, Terraform state or deployment plans in Git.

## 1. Repositories and release branches

| Purpose | Repository | Branch |
| --- | --- | --- |
| Infrastructure source for handover | D-Eminence/hid-system | dev |
| Approved backend release source | D-Eminence/hid-system | staging-novu-ci-20261005 |
| Frontend release source | D-Eminence/Health-id | main |

This guide and the selected infrastructure source belong on dev. Backend main is
not the approved production build source. Changing branches requires reviewing
application/database compatibility and updating workflow triggers and admissions.

Backend and frontend source live on their respective branches/repositories;
copying the infrastructure branch does not copy application changes between them.

## 2. Production URLs

| Application | URL |
| --- | --- |
| Public website | https://healthidentitydirectory.com |
| Patient sign-in | https://app.healthidentitydirectory.com/sign-in |
| Patient registration | https://app.healthidentitydirectory.com/enroll |
| Patient records | https://app.healthidentitydirectory.com/records |
| Administration | https://admin.healthidentitydirectory.com/admin/sign-in |
| Hospital/provider | https://ehr.healthidentitydirectory.com/provider |
| Laboratory | https://lab.healthidentitydirectory.com |
| Pharmacy | https://pharmacy.healthidentitydirectory.com |
| Health ID Migrate | https://migrate.healthidentitydirectory.com |
| Outreach | https://outreach.healthidentitydirectory.com |
| Backend API | https://api.healthidentitydirectory.com |

www redirects to the public website, preserving path and query.

## 3. Architecture and ownership

- AWS account: `659225405023`; region: `eu-west-1`.
- ECS Fargate cluster: `hid-production`. Twelve services are named
  `hid-production-<component>`: gateway, identity-api, ehr-api, lab-api,
  pharmacy-api, ocr-api, ocr-worker, outreach-api, notification-api,
  notification-worker, event-dispatcher and support-api.
- Cloudflare hosts eight frontend Workers: `hid-admin-production`,
  `hid-web-production`, `hid-ehr-production`, `hid-lab-production`,
  `hid-pharmacy-production`, `hid-ocr-production`,
  `hid-outreach-production` and `hid-public-production`.
- Cloudflare account: `20c809ffe35ccb2c240d19a664dff97a`.
- Frontend Workers proxy same-origin API requests to the AWS API ingress.
  TLS, origin authentication, WAF, CORS, cookies, CSRF and Turnstile form part
  of the request path; preserve their exact host/action configuration.
- RDS PostgreSQL stores application data; clinical files are in S3. The record
  assistant uses patient-authorized retrieval with pgvector, Titan embeddings
  through Bedrock, and Claude generation through the direct Anthropic API.
- CloudWatch, account audit configuration, alarms and backup resources are
  defined in Terraform. Operational alerts use
  `operations@healthidentitydirectory.com`.

### Retained staging names are production dependencies

The old staging stack was promoted, retaining the database, files, network,
load balancers, secrets, IAM, ECR and workload identity infrastructure. Some
physical names therefore still contain staging. Production images are stored
under ECR repositories such as `staging/hid/identity-api`; this does not make
their running tasks staging tasks.

The gateway uses the retained Cloud Map namespace `services.staging.hid`.
Production services maintain ten discovery registrations through ECS. Preserve
these registrations and workload issuer/subject configuration. Healthy ALB
targets alone do not prove gateway upstream discovery works.

The old `hid-staging` ECS cluster/services have been retired. There is currently
no separate disposable staging stack. Do not apply the historical staging
inputs against the retained production resources. Creating an independent
staging environment requires separate state, ownership and data isolation.

### Capacity

The last verified baseline was one task per service: 3.75 vCPU and 7.5 GiB
aggregate task capacity, including configured sidecars. Automatic shutdown and
startup were explicitly excluded. Inspect autoscaling settings before changing
capacity; task counts alone do not describe the full scaling policy.

## 4. Terraform setup and state

| Path | Purpose |
| --- | --- |
| `infra/bootstrap/` | State backend bootstrap |
| `infra/account/` | Account audit / CloudTrail configuration |
| `infra/github-builds/` | GitHub build identity and permissions |
| `infra/terraform/` | Main application infrastructure root |
| `infra/terraform/environments/production.tfvars` | Current production inputs |
| `infra/terraform/modules/` | Infrastructure modules and runtime helpers |
| `infra/terraform/tests/` | Terraform and supporting tests |

Each Terraform root has its own state ownership. Do not initialize the account,
bootstrap or GitHub build roots with the application state key.

Use an authorized AWS role/profile, AWS CLI v2, Python 3, Node 22 and Terraform
with S3 native lockfile support (1.10 or newer). Keep the committed provider
lockfile. The local operator profile was `hid-softbridge`; another engineer
should use their own authorized credentials.

From the repository root, in PowerShell:

```powershell
$env:AWS_PROFILE = "hid-softbridge" # substitute your authorized profile
aws sts get-caller-identity
Set-Location infra/terraform
terraform init -reconfigure `
  -backend-config="bucket=health-identity-tfstate-a9a5ea0aaedf638c8a164acb43" `
  -backend-config="key=health-identity/production/terraform.tfstate" `
  -backend-config="region=eu-west-1" `
  -backend-config="encrypt=true" `
  -backend-config="use_lockfile=true"
terraform fmt -check -recursive
terraform validate
terraform plan -input=false -var-file="environments/production.tfvars" -out=production.tfplan
terraform show production.tfplan
```

Confirm STS reports the expected account before initialization. The retained
application state lineage is `e7b001cb-6fa9-dad1-c2d0-858eb9aba0d3`. Stop if the
backend is empty, ownership differs, or a routine release proposes replacing
the database/network or replaying promotion. Do not migrate state to a fresh
key or restore an old state snapshot as a normal deployment step.

Current production inputs retain `promote_existing_staging=true`,
`activate_production_runtime=true` and `ecs_migration_phase="retired"`.
These are established ownership settings, not instructions to rerun cutover.

Review the saved plan before applying that exact file:

```powershell
terraform apply production.tfplan
```

Saved plans can contain sensitive data. Store them privately and exclude them
from Git. The environment tfvars are currently ignored by a wildcard; the
publication change must explicitly admit the reviewed files. Secret values
must remain outside those files.

## 5. Build flow and deployment controls

### What runs automatically

Backend `production-backend-images.yml` runs for matching source paths pushed
to `staging-novu-ci-20261005`, relevant pull requests, or manual dispatch.
Its component selection builds affected services, runs configured checks and
scans, then publishes admitted ARM64 images to ECR. An unrelated documentation
push does not necessarily build an image. Pull request checks do not constitute
an approved production publication.

Frontend `production-frontends.yml` runs on main pushes, main pull requests and
manual dispatch. It checks the source, builds production frontend ZIPs and
Worker preparation metadata, and uploads Actions artifacts. Artifact names:

- `production-frontends-<commit SHA>`: build ZIPs and manifests, retained 14 days.
- `production-frontend-candidate-<run ID>-<attempt>`: candidate report, retained
  seven days for eligible main runs.

Artifact expiry does not remove a deployed Worker. Retain the exact release
artifact and metadata privately if a later manual release needs them.

### Current production release policy

Both repositories have `PRODUCTION_DEPLOYMENT_ENABLED=false`.
Terraform also has `enable_deployment_automation=false`,
`deployment_automation_bootstrap=false` and `enforce_release_index=false`.
Builds are automatic; production releases are performed manually by an operator.
The intended native protected-environment approval gate is not activated or
proved. A manual workflow dispatch is not itself an enforced reviewer gate.

The deferred production release helpers still retain the pre-move `hid-staging`
cluster target in `scripts/production_deployment_core.py`, including consumers
such as the release inventory helper. They are not the current manual ECS
deployment procedure. Before activation, reconcile every cluster/service target
with `hid-production` across the infrastructure and application release tooling,
then test admission, deployment and rollback. Do not run bootstrap/release-index
helpers against the live stack merely because their unit tests pass.

The infrastructure `.github/workflows/terraform.yml` validates on relevant pull
requests and can plan through manual dispatch. It does not apply infrastructure.
Its dispatch job expects environment configuration including
`AWS_TERRAFORM_ROLE_ARN`, `AWS_REGION`, `TF_STATE_BUCKET` and `TFVARS`; publishing
local tfvars alone does not configure those GitHub environment values.

Do not enable automatic production deployment until the repository admin and
DevOps engineer configure and verify reviewer protection, branch restrictions,
OIDC trust, release index/lease bootstrap, release storage, deploy credentials
and rollback behaviour. Intended environment names are `production-backend`
and `production-frontend`. Leave the flags off until those controls are proved.

## 6. Manual backend release

1. Select a successful production candidate from the approved backend branch.
   Record commit, Actions run, selected components, tests, scans and schema
   compatibility report. A green build does not replace feature acceptance.
2. Verify each selected ECR image exists and capture its immutable digest.
   Keep a private before-state record of all live task definitions and digests.
3. Update only the selected entries in production.tfvars `image_uris` using
   `<account>.dkr.ecr.eu-west-1.amazonaws.com/<repository>@sha256:<digest>`.
   Do not replace unchanged services with an older batch of images.
4. Keep workload token agent image inputs independent of an Identity API
   update. Change schema runner or agent inputs only when included in the
   reviewed release scope.
5. Review schema requirements before rollout. Run a separately admitted
   migration only if required; do not run schema or legacy import tasks for
   every image update. Stop if backward compatibility is not established.
6. Generate and inspect the production Terraform plan using section 4.
   Apply the exact reviewed plan, then verify rollout and application behaviour.
7. Record deployed image digests, resulting task revisions, operator, time,
   validation and rollback targets in the private release record.

Example service rollout check; run for every updated component:

```powershell
aws ecs wait services-stable --cluster hid-production --services hid-production-identity-api --region eu-west-1
aws ecs describe-services --cluster hid-production --services hid-production-identity-api --region eu-west-1
```

Read the actual running task image digest as well as the service task definition.
Investigate deployment events, container exits and unhealthy targets before
declaring success. Background workers require queue/processing checks too.

## 7. Manual frontend release

1. Select the successful production frontend artifact for the exact approved
   main commit. Inspect its manifests, compiled Worker metadata and backend/
   schema dependency admission. Do not rebuild from a later checkout and call
   it the same release.
2. Record the selected portal's active Worker version and keep the release
   artifact. Check the correct Cloudflare account and custom domain.
3. Use the frontend repository's pinned tooling and inspected Wrangler
   configuration to deploy the selected portal's static assets AND compiled
   Worker to its production Worker name. Preserve API origin settings, bindings,
   route/domain configuration and secrets. Do not upload only the browser ZIP
   or deploy every portal when the release concerns one portal.
4. Confirm the active Worker version, HTML/assets and same-origin API behaviour.
   Test authenticated journeys with an authorized test account, then record
   the new version and validation.

The previous manual rollout helpers and detailed receipts are private local
operational evidence, not a published deployment tool. A fresh workstation
must inspect the admitted artifact and its source configuration; this guide
does not imply a one-command manual frontend release script is already shipped.
The checked-in automatic deployment command remains gated as described above.

### Live source baseline at handover

Live services and portals intentionally have different source versions:

| Component | Deployed source |
| --- | --- |
| Identity API | `e41a35d534cc63301fe3b10dc6931ac811a25f5f` |
| Other eleven backend services | `844935c4e7b42da96f31d8c1229c79925f2b020f` |
| Patient Worker | `51f319705f3ba83d44f826707ef234aa4e5c0c1f` |
| Admin Worker | `7b19a9d902258d5b89db5519e3b008e1455e0a41` |
| Other six frontend Workers | `1c6496222bfcfe262a29065899fa37539bdaf5a6` |

Identity runs task definition `hid-production-identity-api:4` with digest
`sha256:add68ac7e6e64a35872bab9400026082fcc98f51fd697fd2fcd0bb9a6efc1110`.
Patient Worker version is `40475664-c746-453b-9038-c68a8b2ca0f4`; Admin version
is `d9f33306-89e6-4425-8396-69a2a0b97888`. Read back current versions before
using these as rollback targets. A later dependency metadata commit on main
does not mean all eight portals have been redeployed.

## 8. Verification and rollback

After a release, check all affected paths, not only task health:

- ECS desired/running counts, deployment events, logs and actual image digests.
- ALB route destinations and target health; Cloud Map registration and gateway
  upstream connectivity. At handover: twelve stable services, eleven healthy
  target groups and ten ECS-managed discovery registrations.
- Frontend static assets, API session responses, login, logout and CSRF flow.
  An unsigned session request should remain unauthorized, not become a 5xx.
- Patient records, patient chat and provider patient access/chat using authorized
  test accounts. Confirm patient/facility separation after switching patients.
- Relevant queues, worker failures and operations alerts.

### Application rollback

Backend: restore the recorded previous component image digests in the current
production inputs, review a new Terraform plan and apply it. Preserve unrelated
newer releases and workload agents. Verify schema compatibility before rollback.
Using the current production cluster is the normal application rollback; the
retired staging cluster is not a warm standby.

Frontend: restore the recorded previous version of the affected Cloudflare
Worker, then verify assets, configuration and backend compatibility. Retain
rollback versions and bindings; do not assume expired Actions artifacts can
still be downloaded.

Application rollback does not undo a database migration. Do not restore an old
database or state snapshot over live writes as a routine rollback. A database
recovery requires a separately reviewed restore/cutover plan and reconciliation
of writes since the recovery point. Preserve backups and rehearse restoration
on isolated resources before relying on recovery timings.

## 9. Secrets and integrations

Retrieve approved secrets through Secrets Manager with the appropriate role;
do not copy plaintext into Git, CLI arguments, tickets or this guide.
Existing secret paths commonly start `/hid/staging/` and are retained production
dependencies. Relevant references include QoreID, Anthropic, service database
credentials, `/hid/staging/cloudflare-deployment` and
`/hid/staging/cloudflare-origin`. Inspect Terraform for the exact service-to-secret
mapping and expected JSON field names. A secret rotation may require an ECS
redeployment or Worker binding update; storing a new value alone does not prove
all running processes use it.

- Brevo email is the selected notification channel (`email-brevo`). Termii/SMS
  is deferred. Do not re-enable SMS or send real delivery probes without an
  agreed test recipient and scope.
- Claude generation uses direct Anthropic credentials; Titan embeddings remain
  on Bedrock. Preserve the existing processing-region approval/configuration.
- QoreID NIN registration is enabled. Keep provider verification, Turnstile,
  OTP and migration readiness checks; never bypass them to open the form.
- Pierflow integration is deferred because the partner is unavailable.

## 10. Database migration and registration status

The legacy Supabase data was backed up, staged, transformed into the new
application schemas and reconciled. It was not restored over the new schemas.
Preserve imported record provenance, source identifiers, patient/account links
and medical file mappings. Imported historical information is not automatically
a newly signed clinical note or a newly verified identity.

The owner confirmed all 123 migrated patients had no NIN linked. The accepted
19 October reconciliation added 123 LEGACY_MIGRATED assurance baselines,
123 exact identity-link metadata rows, 123 attested-absent NIN crosswalk entries
and one owner attestation. No patient was marked NIN_VERIFIED and no account,
password, HID or clinical record was rewritten.

`qoreid_nin_only_enrollment_enabled=true`. The last verified availability request
was HTTP 200 with `{"open":true}` at:

`https://app.healthidentitydirectory.com/api/v1/identity/patient-enrollments/availability`

NIN crosswalk, contact lookup and combined registration readiness all passed.
Invalid Turnstile proof remained rejected before provider work. A real-person
signup, QoreID request and verification email were not performed during that
validation; do not describe the complete registration journey as tested then.

To close registration, review and apply a scoped change setting the NIN-only
flag false, then verify availability. Keep the truthful owner attestation and
mapping metadata; later registrations or NIN bindings may depend on them.

## 11. Handover acceptance and remaining work

- Publish the reviewed infrastructure source and this guide to dev. Select
  reusable scripts and tests by dependency; exclude historical migration/debug
  tooling, local evidence, plans, exports, caches and credentials.
- Transfer private release receipts, migration attestations, backup inventory
  and recovery evidence through an approved restricted channel. These are not
  included in this Git guide. Local tmp folders must not be the only retained
  copy after the original workstation is handed over.
- Verify the receiving engineer's AWS, Cloudflare and repository access, alert
  ownership, current state access and rollback materials.
- Native production approval/automated deployment activation remains deferred;
  production stays on manual releases. Termii and Pierflow remain deferred.
- Independent staging can be created later with isolated state and a suitably
  protected test database. Do not point disposable tests at production data or
  apply the historical staging inputs as an independent environment.

No infrastructure apply, application release or automatic deployment activation
is authorized or performed merely by publishing this document.
