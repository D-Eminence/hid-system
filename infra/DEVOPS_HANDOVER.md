# Health ID DevOps handover

Last updated: 21 October 2026. Runtime baseline was checked again on 21 October;
read back current cloud state before any release. Resource identifiers and secret
references below are configuration, not secret values. Do not put credentials,
patient data, Terraform state or deployment plans in Git.

## 1. Repositories and release branches

| Purpose | Repository | Branch |
| --- | --- | --- |
| Infrastructure source for handover | D-Eminence/hid-system | dev |
| Approved backend release source | D-Eminence/hid-system | staging-novu-ci-20261005 |
| Frontend release source | D-Eminence/health | main |

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

Backend has `PRODUCTION_DEPLOYMENT_ENABLED=false`; the new frontend repository
has an unset deployment flag, which also leaves deployment disabled. Both
`production-backend` and `production-frontend` environments now exist with their
exact branch restrictions and admin bypass disabled. The old Health-id repository is historical
frontend release evidence, not the new production build source.
Terraform also has `enable_deployment_automation=false`,
`deployment_automation_bootstrap=false` and `enforce_release_index=false`.
Builds are automatic; production releases are performed manually by an operator.
The prepared implementation supports `PRODUCTION_APPROVAL_MODE=automatic` or
`protected`, defaulting to protected when unset. Automatic mode requires successful
remote checks, an exact current commit/candidate and one exact deployment branch;
it rejects an environment with reviewer/wait/custom protection rules. Protected
mode retains run-bound reviewer verification. The policy is included in the
candidate hash, so changing policy requires a fresh build. Automatic mode has
been requested; the production pipeline has not been activated.

Production release helpers have been prepared for `hid-production`, retaining
the staging-named schema task, IAM roles, secrets and ECR repositories. The
backend controller also checks that current task IPs are present in Cloud Map.
Prepared code and passing unit tests do not establish a live deployment or
release-index bootstrap. Do not invoke bootstrap simply to bypass an admission
failure.

The infrastructure `.github/workflows/terraform.yml` validates on relevant pull
requests and can plan through manual dispatch. It does not apply infrastructure.
Its dispatch job expects environment configuration including
`AWS_TERRAFORM_ROLE_ARN`, `AWS_REGION`, `TF_STATE_BUCKET` and `TFVARS`; publishing
local tfvars alone does not configure those GitHub environment values.

Do not enable automatic production deployment until the repository admin and
DevOps engineer configure and verify the selected deployment policy, branch restrictions,
OIDC trust, release index/lease bootstrap, release storage, deploy credentials
and rollback behaviour. Intended environment names are `production-backend`
and `production-frontend`. Leave the flags off until those controls are proved.

### Owner setup for automatic mode

Write access is verified for aderojuolabode in the new repository; admin access
is not granted. The owner has created both environments. Verify their current
branch-only configuration from `infra/terraform`:

```powershell
python scripts/configure_production_environments.py --mode automatic --github-login aderojuolabode
```

Verification does not install deployment resources or change enable flags. If
an environment needs reconfiguration, an authenticated repository owner/admin
can run:

```powershell
python scripts/configure_production_environments.py --configure --mode automatic --github-login D-Eminence
```

Use the owner's own authentication; never share credentials. This command checks
admin access to both repositories before writes, creates/configures
`hid-system/production-backend` for `staging-novu-ci-20261005` and
`health/production-frontend` for main, writes the explicit automatic policy and
leaves both deployment enable flags false. It does not install AWS resources,
bootstrap release state or deploy applications. Required role/storage variables
must then be populated from the reviewed Terraform automation outputs.

For reviewer gating later, disable deployments, run the same setup with
`--mode protected`, verify the designated reviewer's access and environment
protection, then admit a fresh candidate before re-enabling deployment.

The new immutable frontend OIDC subject prefix was read back as
`repo:D-Eminence@182018869/health@1428636965`. AWS trust must match it exactly;
repository permissions do not copy from Health-id.

### Initial release baseline needs explicit compatibility review

Seven application portals now use the dependency release `2890789`; the public
site remains on `1c64962`. Original dependency files pin different Identity API
commits, while production runs `e41a35d`. Gateway packaging was patched at
`8ef35c2`, preserving its configuration and API contract from `844935c`. The
manual release recorded that packaging compatibility without rewriting original
source pins. The inventory helper preserves per-portal sources and refuses
duplicate, missing or conflicting baseline groups. Do not replace historical pins
with invented provenance to bootstrap the index. Admit a reviewed compatibility
baseline before activation, retaining the exact existing Worker versions and
archives. The known Cloudflare analytics insertion must also be admitted exactly
for HTTP byte checks; arbitrary HTML differences must remain blocked.

After index activation, production infrastructure changes use
`scripts/production_release_infrastructure.py plan/apply` with the release bucket,
KMS key and lease table configured in the operator environment. Its apply requires
the exact reviewed manifest hash, resolves all live digests and reconciles new
task revisions under the same deployment lease. Set `PRODUCTION_RELEASE_MANAGED`
for the Terraform workflow only after this process is initialized and verified.

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
| Gateway | `8ef35c2aa563e6b7e47ff036c1ef87b4874be6ae` |
| Other ten backend services | `844935c4e7b42da96f31d8c1229c79925f2b020f` |
| Seven application Workers (patient, admin, EHR, lab, pharmacy, migrate, outreach) | `28907892c30e479963e7f1184ac39b902858a7b3` |
| Public website Worker | `1c6496222bfcfe262a29065899fa37539bdaf5a6` |

Identity runs task definition `hid-production-identity-api:4` with digest
`sha256:add68ac7e6e64a35872bab9400026082fcc98f51fd697fd2fcd0bb9a6efc1110`.
Gateway runs `hid-production-gateway:2` with digest
`sha256:a3673c4ec0bba33fe2bc2c5649ed709709aa589155fcf6c35528d51d20ebf4e4`.
Its prior `hid-production-gateway:1` remains active for rollback, with digest
`sha256:b94dfdcfec4d645f6429af8d733d9c427c87baa1ead7abb07f74fad22049f340`.
Both digests carry their `retain-<digest hex>` tags under the existing ECR
retention policy. Preserve those tags while the images are live or rollback
targets; do not rely on the ordinary CI tag retention alone.
No database migration accompanied this dependency release. The eleven other
backend task definitions and the public website version were preserved.

The 21 October dependency release passed frontend CI, all production candidate
checks, native ARM64 image scanning and the complete TUF/workspace gates:

- [Frontend CI](https://github.com/D-Eminence/health/actions/runs/39684462714)
- [Frontend candidate](https://github.com/D-Eminence/health/actions/runs/39684462720)
- [Backend candidate](https://github.com/D-Eminence/hid-system/actions/runs/39684518249)
- [TUF and workspace gates](https://github.com/D-Eminence/hid-system/actions/runs/39684518447)

Application Worker versions for this release:

| Portal | Current version | Previous rollback version |
| --- | --- | --- |
| web | `b5215c5a-4411-4c1c-aab4-7a89c212cf59` | `40475664-c746-453b-9038-c68a8b2ca0f4` |
| admin | `c94580cf-3828-4064-91f8-82a72eeffbf7` | `d9f33306-89e6-4425-8396-69a2a0b97888` |
| ehr | `5add43fc-3610-4c5a-9f9a-0b577a16c91b` | `d1b2bf5c-d018-443b-92f7-e9b07091bf35` |
| lab | `8c63eb8f-cae5-4db1-8bda-ce4b4e5a1de2` | `66dad941-0143-4bc3-b533-3b92c2c3b522` |
| pharmacy | `f041151e-e1b8-48ad-9bae-933b1e7b3a5d` | `bef29850-e443-47d8-8a30-75fa2971962d` |
| ocr | `336d31bf-2f1e-4211-a581-53e1c753e54f` | `f9197181-52b7-41b4-b8a4-0c112fd0c06c` |
| outreach | `d66e2002-6184-4517-9cf5-1b3fa3dfddf3` | `3fb3bcc7-20cc-411c-92da-39777f9979d9` |

Read back current versions and compatibility before using rollback targets.
Live entry assets, canonical deep links, denied unsigned sessions and no-store
headers were verified; signed-in clinical journeys were not repeated for this
packaging release. Automatic deployment remains disabled pending its separate
activation.

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
