# Health ID DevOps handover

Last updated: 22 October 2026. Runtime baseline was checked again on 22 October;
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
$env:RELEASE_BUCKET = "hid-staging-releases-659225405023-eu-west-1"
$env:RELEASE_KMS_KEY_ARN = "arn:aws:kms:eu-west-1:659225405023:key/2d4e52a0-14fb-4165-921a-f78b95f4b710"
$env:RELEASE_LEASE_TABLE = "hid-staging-deployment-leases"
$env:TF_VAR_cloudflare_origin_secret = (aws secretsmanager get-secret-value --secret-id /hid/staging/cloudflare-origin --region eu-west-1 --output json | ConvertFrom-Json).SecretString
python scripts/production_release_infrastructure.py plan --var-file environments/production.tfvars --manifest private-release-review.json
```

Confirm STS reports the expected account before initialization. The retained
application state lineage is `e7b001cb-6fa9-dad1-c2d0-858eb9aba0d3`. Stop if the
backend is empty, ownership differs, or a routine release proposes replacing
the database/network or replaying promotion. Do not migrate state to a fresh
key or restore an old state snapshot as a normal deployment step.

Current production inputs retain `promote_existing_staging=true`,
`activate_production_runtime=true` and `ecs_migration_phase="retired"`.
These are established ownership settings, not instructions to rerun cutover.

Review the generated plan and private review manifest. Apply only its accepted SHA256; the helper reacquires the lease, resolves current images and regenerates the saved plan before mutation:

```powershell
python scripts/production_release_infrastructure.py apply --var-file environments/production.tfvars --manifest private-release-review.json --accepted-review-sha256 "<reviewed manifest SHA256>"
```

Deployment plans and review manifests can contain sensitive operational data.
Store them privately and exclude them from Git. The reviewed production tfvars
are tracked configuration; secret values must remain outside those files.
Remove TF_VAR_cloudflare_origin_secret from the operator shell after use.

### Emergency contacts

The owner approved production delivery on 24 October 2026 for every patient
(`emergency_contact_pilot_account_ids = []`), and asked for it without waiting
for an infrastructure apply. The backend (hid-system `staging-novu-ci-20261005`
#109, #112 and #113) therefore switched delivery on through the code defaults:
both services treat an absent `EMERGENCY_CONTACT_DELIVERY_ENABLED` as on, and
Identity dispatches alerts every 60 s by default. Production's task definitions
did not set these keys, so delivery is on without any apply.

This Terraform always writes the flag explicitly, because only `"false"` turns
a service off:

| Switch | Renders on notification-api | Renders on identity-api |
| --- | --- | --- |
| both on (`production.tfvars` today) | `EMERGENCY_CONTACT_DELIVERY_ENABLED=true` | `EMERGENCY_CONTACT_DELIVERY_ENABLED=true`, `EMERGENCY_CONTACT_CHANNELS` (`email` on `email-brevo`), `PATIENT_LIFECYCLE_SWEEP_SECONDS` |
| identity off | `true` | `EMERGENCY_CONTACT_DELIVERY_ENABLED=false` |
| both off | `EMERGENCY_CONTACT_DELIVERY_ENABLED=false` | `EMERGENCY_CONTACT_DELIVERY_ENABLED=false` |

- The next routine apply from dev adds the "on" keys above to both services'
  task definitions. It changes no behaviour: they match the code defaults. The
  plan replaces `aws_ecs_task_definition.production["<service>"]` and the
  retained `aws_ecs_task_definition.workload["<service>"]` and updates
  `aws_ecs_service.production["<service>"]` in place for identity-api and
  notification-api, with no image change. The `emergency_contacts` output
  shows the switch state.
- After an apply, list the keys by name only:

  ```powershell
  foreach ($service in "notification-api", "identity-api") {
    $td = aws ecs describe-services --cluster hid-production --services "hid-production-$service" --region eu-west-1 --query "services[0].taskDefinition" --output text
    aws ecs describe-task-definition --task-definition $td --region eu-west-1 --output text `
      --query "taskDefinition.containerDefinitions[?name=='$service'] | [0].environment[?starts_with(name, 'EMERGENCY_CONTACT_') || name == 'PATIENT_LIFECYCLE_SWEEP_SECONDS'].name"
  }
  ```

  Unauthenticated, `GET https://app.healthidentitydirectory.com/api/v1/identity/me/emergency-contacts/availability`
  must return 401, not a 5xx; a patient session receives
  `{"delivery":true,"channels":["email"]}`.
- Off switch: identity first, then notification, each as its own reviewed
  commit to `environments/production.tfvars` on dev. Commit
  `emergency_contact_delivery_enabled = false`, plan and apply from that commit
  (only identity-api changes, to `EMERGENCY_CONTACT_DELIVERY_ENABLED=false`),
  and push it to dev before the apply or straight after it. Then do the same
  with `emergency_contact_notification_enabled = false`. Never apply the off
  switch from a local edit, a copy of the file or an older commit: dev would
  still say on, and the next routine apply from dev would switch delivery back
  on. Terraform refuses identity delivery while notification-api's is off.
  Without an apply, the backend's own off switch is a release that flips
  Identity's default back.
- While identity delivery is off, emergency access still records an alert for
  each verified contact. Each expires unsent 24 h after the access began;
  switching delivery back on within that window sends the pending alerts late.
- Stored contacts are encrypted with `NIN_ENCRYPTION_KEY_B64` under
  `NIN_KEY_VERSION` (`aws-v1`) and matched with `OTP_HMAC_KEY_B64`. Changing
  `NIN_KEY_VERSION` or the NIN encryption key makes every stored contact
  unreadable; rotating `OTP_HMAC_KEY_B64` breaks contact matching and pending
  verification codes. Do not rotate them without a re-encryption plan.

### Web push (B6)

Patient phone and computer notifications ship with the backend
(hid-system `staging-novu-ci-20261005` `ef81b4f`) but stay off until this
Terraform switch is applied: both services treat absent `WEB_PUSH_` keys as off,
and with `web_push_enabled = false` (the default) the plan changes no task
definition. These steps are the owner's runbook from contract B6 section 13,
which is in neither repository.

0. Generate the VAPID key pair once, on the owner's own computer (Node 22,
   PowerShell or bash; nothing is downloaded):

   ```sh
   node -e "const c=require('node:crypto');const j=c.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'jwk'});console.log('PUBLIC  (production.tfvars web_push_vapid_public_key): '+Buffer.concat([Buffer.from([4]),Buffer.from(j.x,'base64url'),Buffer.from(j.y,'base64url')]).toString('base64url'));console.log('PRIVATE (Secrets Manager webPushVapidPrivateKey only): '+j.d)"
   ```

   It prints an 87-character PUBLIC key and a 43-character PRIVATE key. The
   PRIVATE value goes only into Secrets Manager (step 1), never into Git,
   tfvars, a ticket, chat or a CLI argument. Close the terminal after copying.
1. Store the private key first. Secrets Manager, account `659225405023`,
   `eu-west-1`: `/hid/staging/notification-provider` (production's
   notification-api secret; the staging name is retained), add the key
   `webPushVapidPrivateKey` with the 43-character PRIVATE key from step 0 and
   change nothing else. Never put the private key in Git, tfvars, a ticket,
   chat or a CLI argument. Identity never receives it.
2. Only then, in a reviewed commit on dev, replace the commented web push block
   in `environments/production.tfvars` with:

   ```hcl
   web_push_enabled          = true
   web_push_vapid_public_key = "<the 87-character PUBLIC key>"
   web_push_subject          = "mailto:support@healthidentitydirectory.com"
   ```

   Terraform refuses `web_push_enabled = true` without a public key.
3. From that commit, plan and apply exactly as above: `python
   scripts/production_release_infrastructure.py plan --var-file
   environments/production.tfvars --manifest private-release-review.json`,
   review, then `apply ... --accepted-review-sha256 "<sha256>"`. The plan should
   only replace the task definitions of identity-api and notification-api
   (`WEB_PUSH_VAPID_PUBLIC_KEY` and `WEB_PUSH_SUBJECT` on both, the secret
   `WEB_PUSH_VAPID_PRIVATE_KEY` from `webPushVapidPrivateKey` on
   notification-api only) and update their services in place, with no image
   change.
4. Check it is on, names only:

   ```powershell
   foreach ($service in "notification-api", "identity-api") {
     $td = aws ecs describe-services --cluster hid-production --services "hid-production-$service" --region eu-west-1 --query "services[0].taskDefinition" --output text
     aws ecs describe-task-definition --task-definition $td --region eu-west-1 --output text `
       --query "taskDefinition.containerDefinitions[?name=='$service'] | [0].[environment[?starts_with(name, 'WEB_PUSH_')].name, secrets[?starts_with(name, 'WEB_PUSH_')].name]"
   }
   ```

   Expect notification-api `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_SUBJECT` and
   the secret `WEB_PUSH_VAPID_PRIVATE_KEY`; identity-api the two environment
   names. CloudWatch `/hid/staging/notification-api` and
   `/hid/staging/identity-api` each log `Web push is on (keyId=...)` with the
   same key id. A patient sees "Notifications on this device" in Settings; with
   it on, a test clinician's access request reaches the phone as "Health ID /
   You have a new notification." within about 1-3 minutes.
- Off switch: commit `web_push_enabled = false` on dev, plan and apply as
  above. Identity's web push routes answer 404 (the website hides the section)
  and nothing is sent; subscriptions are erased as their sign-ins end. Remove
  `webPushVapidPrivateKey` from the secret only after that apply, never while
  `web_push_enabled = true`.
- Rotation makes every browser subscription useless until the patient next
  visits Settings; do it only if the private key is exposed (steps 0 to 3
  again with a new pair).

### Document upload (CORS)

Pages upload documents straight to the documents bucket
(`module.data.aws_s3_bucket.documents`, the retained `hid-staging-documents-*`
bucket) with the presigned PUT link from ehr-api. The browser asks S3 first,
so without a CORS rule every upload fails with "The document could not be
uploaded. Please try again." Terraform adds one rule
(`module.data.aws_s3_bucket_cors_configuration.documents[0]`):

- Origins: only the upload hosts the owner approved on 31 October 2026, from
  `production_hosts`: `web` (app.), `ehr`, `lab`, `pharmacy` and `ocr`
  (migrate.). Admin, outreach and the public site get none.
- PUT only, with only the headers ehr-api's `createUpload` asks for. Downloads
  open the signed link as a page and need no rule.

Before applying, read the live rule (read-only). A Terraform-managed rule
replaces any rule set by hand:

```powershell
aws s3api get-bucket-cors --bucket <documents bucket name> --region eu-west-1
```

`NoSuchCORSConfiguration` means there is none. Then plan and apply as in
section 4. The CORS rule itself is one resource to add, with no change to the
bucket. If the plan also shows other changes, they are dev commits not yet
applied (for example new task definition revisions with the same images,
which restart those services). Review them as part of the same plan, and do
not start a backend release between plan and apply, or the helper refuses.
To check afterwards, upload a fictional document at Demo Hospital
(Consultation, Documents, Upload document).

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

Automatic production build and deployment are enabled in both repositories:
`PRODUCTION_APPROVAL_MODE=automatic` and `PRODUCTION_DEPLOYMENT_ENABLED=true`.
The exact branch restrictions and disabled admin bypass are verified for
`production-backend` and `production-frontend`. This mode requires no reviewer
approval. The policy is bound into each candidate; changing it requires a fresh
build. Remote checks, exact current source and immutable candidate verification
remain mandatory.

Successful controlled deployments:

- [Backend gateway deployment](https://github.com/D-Eminence/hid-system/actions/runs/39751158762)
- [Frontend deployment](https://github.com/D-Eminence/health/actions/runs/39752594270)

Both controllers and the infrastructure helper use one persistent DynamoDB lease
and a versioned encrypted release index. Releases cannot mutate concurrently.
Failure restores the release's recorded changes; uncertain reconciliation retains
the lease for operator recovery. A build does not certify untested features.

Release bucket: `hid-staging-releases-659225405023-eu-west-1`. Index: `production/current.json`.
Lease table: `hid-staging-deployment-leases`. Immutable receipts and versioned
frontend archives are encrypted; physical staging names are retained deliberately.
Separate deploy roles use the exact immutable repository/environment OIDC
subjects. Rollback preparation uses a metadata read-only role. Cloudflare
credentials remain in AWS Secrets Manager.

Terraform uses `enable_deployment_automation=true`,
`deployment_automation_bootstrap=false` and `enforce_release_index=true`.
The initial baseline came from actual healthy resources, original source-bound
image receipts and a coordinated frontend release at `2e3c2b2`. Both backend and
frontend healthy bootstrap receipts are preserved. Never rerun bootstrap to
bypass a compatibility or index failure.

### Later approval gates

Disable both deploy flags before changing policy. An authenticated repository
owner/admin can configure supported reviewer protection with:

```powershell
python scripts/configure_production_environments.py --configure --mode protected --github-login D-Eminence
```

Verify reviewer access and exact branch restrictions, then admit fresh candidates
before re-enabling. Automatic mode rejects reviewer/wait/custom protection rules;
protected mode requires run-bound approval. Do not mix candidate policy modes.

The infrastructure `.github/workflows/terraform.yml` validates pull requests and
can plan through manual dispatch; it does not apply infrastructure. Its dispatch
needs separately configured `AWS_TERRAFORM_ROLE_ARN`, `AWS_REGION`,
`TF_STATE_BUCKET` and `TFVARS`. Application activation does not configure those
separate infrastructure credentials. If that dispatch is used, configure
`PRODUCTION_RELEASE_MANAGED=true` and verify its role can read release state and
use the shared lease. Operators use the guarded helper in section 4.

## 6. Backend releases

Push to `D-Eminence/hid-system`, branch `staging-novu-ci-20261005`.
Matching paths select affected components; shared package/build/controller
changes can select all components. The workflow tests, scans and publishes
admitted ARM64 images, prepares an exact candidate, and deploys automatically to
`hid-production`. Unrelated documentation may build nothing. Manual dispatch can
select one component or an explicit supported group.

Watch the deploy job, resulting receipt and actual task/image state. Preserve
unchanged services, agents and configuration. Schema changes require the existing
exact reviewed compatibility contract and migration checks. Routine image updates
do not replay legacy import tasks.

The encrypted index is the live release authority. For infrastructure changes,
resolve and reconcile current digests/task definitions under the shared lease
using section 4. Do not directly apply stale checked-in image pins.

## 7. Frontend releases

Push to `D-Eminence/health` main. The production workflow validates/builds all
eight portals, preserves exact archives, uploads immutable Worker versions,
activates/verifies them, and records the release. Origin secrets, API settings
and domains are preserved. Frontend ZIPs contain static builds, not Docker images.
S3 release archives survive Actions artifact expiry.

`config/production-release-dependencies.json` must match current deployed source
commits for its eight declared backend services. After a backend release, update
those reviewed pins when needed before the next frontend release. Do not invent
provenance or disable this compatibility guard. Undeclared/incompatible candidates
stop before Worker mutation. Only the exact known analytics insertion is admitted
for HTML checks; arbitrary differences remain blocked.

Monitor the deploy job through live byte/deep-link verification and receipt
creation. Signed-in clinical acceptance is a separate feature check. The www
redirect is an existing separately managed Worker.

### Live source baseline at handover

| Component | Deployed source |
| --- | --- |
| Identity API | `e41a35d534cc63301fe3b10dc6931ac811a25f5f` |
| Gateway | `7bb7cdb7360faa556c186af5b363163da324fe07` |
| Other ten backend services | `844935c4e7b42da96f31d8c1229c79925f2b020f` |
| All eight frontend Workers | `c1d851d621e78fb511a3bb8df292135a36c050c7` |

Gateway task: `hid-production-gateway:4`. Image:
`659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/gateway@sha256:1178f584d25a0e5abda59dd2294d940d1b1ef4a09b4ea04ea86e083599af23bc`. Identity remains `hid-production-identity-api:4`.
No database migration accompanied activation. Keep live/rollback image retention
tags and versioned frontend archives. Do not remove `retain-<digest hex>` tags
while images are live or rollback targets.

Initial healthy rollback release IDs:

- Backend: `backend-bootstrap-847c9787da705cd2f95ce158`
- Frontend: `frontend-bootstrap-641e6e542b09e514d2e5082b`

These are verified inventory receipts, not invented GitHub build IDs. Read back
live state and compatibility before rollback. Failure recovery/lease-loss guards
have regression tests; no deliberate production outage was introduced for a
rollback drill. Exact assets, health and unsigned session checks passed; strict image guards
were verified with matching and mismatching Terraform map values. Signed-in
clinical acceptance was not repeated for this packaging/deployment activation.

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

Use the current approved branch and its rollback workflow:

- Backend: `production-backend-rollback.yml` in `hid-system`.
- Frontend: `production-frontend-rollback.yml` in `health`.

Select an exact prior healthy release ID from encrypted receipts. Preparation
reads immutable receipt metadata with the read-only role, creates a fresh
policy-bound candidate, then deployment rechecks live state/configuration,
secret version and compatibility under the shared lease. Frontend rollback
verifies exact archived bytes. The initial bootstrap IDs above provide first
release rollback targets. Backend rollback restores the chosen receipt's complete
backend image set; review all affected components.

Do not roll back schema or restore a database snapshot for an ordinary application
rollback. Resolve changed configuration/compatibility explicitly. If reconciliation
retains a lease, inspect its holder/generation, intent/complete/failed receipts and
live resources before recovery. Never delete a busy lease or blindly replace the
index with an old snapshot.

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

### Validation observation

The final production frontend build/deploy and full CI passed on their first
attempt. The separate staging artifact workflow passed on its second attempt
following an intermittent OCR field-focus test failure. No UI assertions were
weakened. Investigate that test if it recurs; a retry is not a feature acceptance
check.

## 11. Handover acceptance and remaining work

- The reviewed infrastructure source and this guide are published to dev.
  Historical migration/debug tooling, local evidence, plans, exports, caches
  and credentials are excluded from the handover publication.
- Transfer private release receipts, migration attestations, backup inventory
  and recovery evidence through an approved restricted channel. These are not
  included in this Git guide. Local tmp folders must not be the only retained
  copy after the original workstation is handed over.
- Verify the receiving engineer's AWS, Cloudflare and repository access, alert
  ownership, current state access and rollback materials.
- Automatic application deployment is activated. Required-reviewer approval can
  be configured later through the supported protected mode. Termii and Pierflow
  remain deferred.
- Independent staging can be created later with isolated state and a suitably
  protected test database. Do not point disposable tests at production data or
  apply the historical staging inputs as an independent environment.

No infrastructure apply, application release or automatic deployment activation
is authorized or performed merely by publishing this document.
