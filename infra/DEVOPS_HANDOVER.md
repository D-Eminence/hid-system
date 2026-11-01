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

### If a helper apply stops part-way

If `apply` fails once Terraform has started changing resources (for example
`TERRAFORM_FAILED`), the helper rolls nothing back and keeps the release lease
on purpose. Until the lease is released, the next helper `plan` or `apply` and
every backend release stop when they try to take it
(`AWS_ConditionalCheckFailedException`). Running the apply again does not help:
the lease is still held, and the reviewed plan no longer matches what is left
(`INFRASTRUCTURE_PLAN_CHANGED_REVIEW_REQUIRED`). Recover in the same PowerShell
session, from `infra/terraform`:

1. Make safe what the stopped apply left half done. For the ECR clean-up, first
   do "If the apply stops part-way" under item 2 of "AWS cost" below.
2. Make sure nothing is still running: no `terraform` or `python` process of
   the helper on your machine (`Get-Process terraform, python -ErrorAction
   SilentlyContinue`) and no other operator running the helper. Wait three
   minutes after the helper stopped: the release below refuses a lease that is
   still being renewed.
3. Read the lease. Release it only if the Terraform helper holds it
   (`terraform-` and 32 hex characters). The condition removes exactly that
   holder and generation, and only once its renewal has run out:

   ```powershell
   '{"environment":{"S":"hid-production"}}' | Set-Content -Encoding ascii lease-key.json
   $lease = (aws dynamodb get-item --table-name hid-staging-deployment-leases --key file://lease-key.json --consistent-read --region eu-west-1 --output json | ConvertFrom-Json).Item
   'holder {0}, generation {1}, status {2}, renewed until {3}' -f $lease.holder.S, $lease.generation.N, $lease.status.S, $(if ($lease.expires_at) { [datetimeoffset]::FromUnixTimeSeconds([long]$lease.expires_at.N).ToString('u') })
   if (-not $lease.holder) { 'Not held: nothing to release' } elseif ($lease.holder.S -notmatch '^terraform-[0-9a-f]{32}$') { 'STOP (held by a release or the bootstrap, not the Terraform helper)' } else {
     @{ ':h' = @{ S = $lease.holder.S }; ':g' = @{ N = $lease.generation.N }; ':now' = @{ N = [string][datetimeoffset]::UtcNow.ToUnixTimeSeconds() }; ':ready' = @{ S = 'ready' } } | ConvertTo-Json -Depth 3 -Compress | Set-Content -Encoding ascii lease-values.json
     '{"#s":"status"}' | Set-Content -Encoding ascii lease-names.json
     aws dynamodb update-item --table-name hid-staging-deployment-leases --key file://lease-key.json --update-expression 'REMOVE holder, expires_at SET #s = :ready' --condition-expression 'holder = :h AND generation = :g AND expires_at < :now' --expression-attribute-names file://lease-names.json --expression-attribute-values file://lease-values.json --return-values ALL_NEW --region eu-west-1 --output json
   }
   Remove-Item lease-key.json, lease-values.json, lease-names.json -ErrorAction SilentlyContinue
   ```

   Expect the returned item to show `status` `ready`, the same `generation` and
   no `holder`: the same release the helper makes itself after a successful
   apply. `ConditionalCheckFailedException` means the holder is still renewing
   the lease or another run has taken it: go back to step 2, and never remove a
   holder whose renewal has not run out. On `STOP`, do not touch the lease: a
   backend release holds it and its own recovery applies.
4. Plan again with the helper above and review the new plan. It shows only what
   the stopped apply did not finish; what it finished shows no change. If the
   plan says `Error acquiring the state lock`, the stopped run left Terraform's
   state lock behind: after step 2, run `terraform force-unlock <lock ID from
   the message>` and plan again. If the helper stops with `LIVE_INDEX_DIFFERS`,
   the stopped apply changed a running service: report it, and do not edit the
   release index by hand. Otherwise apply the new review manifest's SHA256 as
   usual.

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

### Monitoring cost

The owner approved turning off CloudWatch Container Insights "enhanced" on the
`hid-production` cluster (about USD 104 a month; AWS budget USD 400 a month).
`ecs_container_insights` (`enhanced`, `enabled` or `disabled`) is `disabled` in
production.tfvars. Its default is `enhanced`, so the Insights level changes
only in an environment that sets it.

The 12 `hid-production-<service>-running-tasks` alarms used Container Insights'
`RunningTaskCount`, which stops when Insights is off; with missing data
treated as breaching they would all fire. The running-task alarms now read the
free `AWS/ECS` `LiveTaskCount` metric in every environment, not only
production, with the same names, thresholds (each service's task count),
Minimum over 1 minute, 3 of 3 periods, missing data breaching, and the same SNS
topic for alarm and OK. A plan with the retired staging inputs would therefore
re-point its `hid-staging-*-running-tasks` alarms too, while its Insights stays
`enhanced`; the metric works either way. `LiveTaskCount` also counts tasks
still starting or draining (30 s, 60 s for event-dispatcher), so an alarm can
fire up to about a minute later than before. Autoscaling and the other alarms
do not use Insights, and there are no dashboards.

Before applying (read-only), dry-run the new alarms on the last 3 hours of
`LiveTaskCount`, just before the apply and outside a deployment. The script
reads the 12 live alarms, whose names, services and thresholds this change
keeps, and prints one line per service:

```powershell
$n = [datetime]::UtcNow; $end = [datetimeoffset]::new($n.Year, $n.Month, $n.Day, $n.Hour, $n.Minute, 0, [timespan]::Zero).AddMinutes(-5); $start = $end.AddHours(-3)
$alarms = @((aws cloudwatch describe-alarms --alarm-name-prefix hid-production- --region eu-west-1 --output json | ConvertFrom-Json).MetricAlarms | Where-Object { $_.AlarmName -like '*-running-tasks' })
"$($alarms.Count) alarms (expect 12)"
foreach ($a in $alarms) {
  $svc = ($a.Dimensions | Where-Object { $_.Name -eq 'ServiceName' }).Value
  $rows = @(aws cloudwatch get-metric-statistics --namespace AWS/ECS --metric-name LiveTaskCount --dimensions "Name=ClusterName,Value=hid-production" "Name=ServiceName,Value=$svc" --statistics Minimum --period 60 --start-time ($start.UtcDateTime.ToString('s') + 'Z') --end-time ($end.UtcDateTime.ToString('s') + 'Z') --region eu-west-1 --query "Datapoints[].[Timestamp,Minimum]" --output text | Where-Object { $_ })
  $p = @($rows | ForEach-Object { $f = $_ -split "`t"; [pscustomobject]@{ T = [datetimeoffset]::Parse($f[0], [cultureinfo]::InvariantCulture); V = [double]$f[1] } } | Sort-Object T)
  $t = @($start.AddMinutes(-1)) + @($p | ForEach-Object T) + @($end)
  $gap = 0; for ($i = 1; $i -lt $t.Count; $i++) { $gap = [math]::Max($gap, ($t[$i] - $t[$i - 1]).TotalMinutes) }
  $low = if ($p.Count) { ($p | Measure-Object -Property V -Minimum).Minimum } else { 'none' }
  $verdict = if ($p.Count -eq 0 -or $gap -ge 4 -or $low -lt $a.Threshold) { 'STOP' } elseif ($gap -gt 1) { 'note' } else { 'ok' }
  '{0} {1}: {2} points, longest gap {3} min, lowest {4}, threshold {5}' -f $verdict, $svc, $p.Count, $gap, $low, $a.Threshold
}
```

Expected: `12 alarms (expect 12)`, then 12 lines starting `ok`, each with 180
points (one a minute), longest gap 1 min and lowest at or above the threshold.
Do not apply if there are fewer than 12 alarms or any line starts `STOP`: no
data, a gap of 4 min or more (3 missing minutes in a row, which fires the
alarm), or a minute below the threshold (look at that service first). A `note`
line (a gap of 2 or 3 min) would not have fired; record it and go on.

Expected plan from this change, all updated in place, nothing added, replaced
or destroyed: `module.application.aws_ecs_cluster.production[0]`
(containerInsights `enhanced` to `disabled`) and the 12
`module.operations.aws_cloudwatch_metric_alarm.runtime_tasks[...]` (namespace
and metric name only), plus a `container_insights` field in the
`ecs_migration_configuration` output. That is 13 resources changed in place,
0 added, 0 destroyed (`Plan: 0 to add, 13 to change, 0 to destroy` when no
other dev change is pending). The retired legacy cluster has count 0 in
production, so it is not in the plan. Plan and apply with the section 4 helper,
which reads the committed production.tfvars; other changes in the plan come
from other dev commits not yet applied. A plan from the Terraform CI workflow
replaces production.tfvars with the `TFVARS` secret, so it shows the 12 alarm
updates but not the Insights change unless that secret also has
`ecs_container_insights = "disabled"`; update the secret first if you use it.

After applying, within a few minutes all 12 alarms should be `OK` on
`AWS/ECS`/`LiveTaskCount`, and the cluster setting `disabled`:

```powershell
aws cloudwatch describe-alarms --alarm-name-prefix hid-production- --region eu-west-1 --query "MetricAlarms[?ends_with(AlarmName,'-running-tasks')].[AlarmName,StateValue,Namespace,MetricName]" --output table
aws ecs describe-clusters --clusters hid-production --include SETTINGS --region eu-west-1 --query "clusters[0].settings"
```

Stopping one service's task to see the alarm is optional: only in a
non-business window and only if the owner agrees (ECS usually replaces it
within the 3 minutes, so no alarm is not a failure). Otherwise rely on the
plan and the alarm states.

Rollback: set `ecs_container_insights = "enhanced"` and apply; Insights
restarts from then (cost returns, no data for the gap). The alarms work either
way. To re-point them to `ECS/ContainerInsights` `RunningTaskCount`, revert the
metric in `modules/operations/runtime.tf` in a second apply, once that metric
appears again, or they breach while it is missing.

Found while checking, already broken before this change and not fixed by it:
the alerts topic policy and its KMS key policy (`modules/operations/main.tf`)
let CloudWatch publish only for alarms named `hid-staging-*` (`name_prefix`),
but these 12 alarms are named `hid-production-*`. Their state changes, before
and after this change, probably never reached the alert email. This change
keeps the alarm states working; it does not fix the emails. Check first:
"Failed to execute action" entries in this history confirm it.

```powershell
aws cloudwatch describe-alarm-history --alarm-name hid-production-gateway-running-tasks --history-item-type Action --region eu-west-1
```

The fix is item 4 of "AWS cost" below, a separate commit on this branch.

### AWS cost

Further cost items the owner approved on 1 November 2026, each a reviewed
setting in this Terraform. Plan and apply them with the section 4 helper,
together with the Monitoring cost change above. The helper reads the committed
`production.tfvars`; a plan from the Terraform CI workflow uses the `TFVARS`
secret instead and shows the Bedrock and ECR changes only if that secret also
has the `bedrock_endpoint_az_count` line and the two `ecr_` lines. That workflow
only plans; nothing in it applies, so the secret cannot undo these settings.

#### Expected plan for this branch

| Change | Resources | Action |
| --- | --- | --- |
| Monitoring cost (above) | `module.application.aws_ecs_cluster.production[0]` and 12 `module.operations.aws_cloudwatch_metric_alarm.runtime_tasks[...]` | 13 updated in place |
| 1. Bedrock endpoint in one zone | `module.ai[0].aws_vpc_endpoint.bedrock_runtime` | 1 updated in place |
| 2. ECR clean-up | 12 `module.application.aws_ecr_lifecycle_policy.workload["<service>"]` | 12 replaced (the provider cannot edit a lifecycle policy; see item 2) |
| 3. Worker scaling on dead metrics | `module.application.aws_appautoscaling_policy.ocr_backlog["ocr-worker"]` and `module.application.aws_appautoscaling_policy.outbox_backlog["event-dispatcher"]` | 2 destroyed |
| 4. Alerts from the production alarms | `module.operations.aws_kms_key.alerts` and `module.operations.aws_sns_topic_policy.alerts` | 2 updated in place (policy only) |

Total: `Plan: 12 to add, 16 to change, 14 to destroy` when no other dev change
is pending: the 12 added are the 12 replaced lifecycle policies, which with the
2 scaling policies make the 14 destroyed. The 12 replaced lifecycle policies
are the one exception to "every change in place": the AWS provider cannot
update a lifecycle policy in place (item 2), no image is touched, and the owner
accepts this before the apply. Nothing else is replaced or destroyed: no
service, task definition, database, bucket, key, topic or endpoint. Other
changes in the plan come from dev commits not yet applied; review them as part
of the same plan.

#### 1. Bedrock endpoint in one zone

The record assistant (the EHR patient-record chat) reaches Bedrock for Titan
embeddings through the interface endpoint
`module.ai[0].aws_vpc_endpoint.bedrock_runtime` (tag
`hid-staging-bedrock-runtime`). It had a network interface in both application
subnets, and each costs USD 0.011 an hour (about USD 8 a month).
`production.tfvars` now sets `bedrock_endpoint_az_count = 1`: the endpoint
keeps only the first application subnet (`hid-staging-application-0`,
eu-west-1a), where production's other interface endpoints (ECR, logs, Secrets
Manager, EventBridge, SQS, Textract) already are. The variable defaults to
null (every application subnet) and no other environment's inputs set it, so
staging (including the retired staging inputs, which share production's economy
profile) and development do not change. The endpoint policy (EHR task role
only, approved models only), its security group and private DNS do not change.

- Plan: `module.ai[0].aws_vpc_endpoint.bedrock_runtime` updated in place;
  `subnet_ids` loses the eu-west-1b subnet and `network_interface_ids` shows
  "known after apply". Nothing is replaced.
- Effect: AWS removes the eu-west-1b network interface and the endpoint's DNS
  name then answers with the eu-west-1a address only. EHR tasks in eu-west-1b
  reach it across zones (a millisecond or two; cross-zone data is USD 0.01 per
  GB each way, negligible for chat text). A chat request on a connection to the
  removed interface can fail once while it goes, so apply outside clinic
  hours. If eu-west-1a is down, the chat cannot reach Bedrock until it returns,
  as production's images, logs and secrets already depend on that zone.
- Before applying (read-only), record the endpoint as it is (two subnets, two
  interfaces, `available`):

  ```powershell
  aws ec2 describe-vpc-endpoints --filters Name=tag:Name,Values=hid-staging-bedrock-runtime --region eu-west-1 --query "VpcEndpoints[].[VpcEndpointId,State,SubnetIds,NetworkInterfaceIds]"
  ```

- After applying: the same command shows one subnet, one interface and
  `available` (AWS takes a minute or two). Then ask the record assistant about a
  fictional patient at Demo Hospital; it answers as before.
- Rollback: delete the `bedrock_endpoint_az_count` line from `production.tfvars`
  in a reviewed commit on dev and apply; the endpoint gets its eu-west-1b
  interface back in place within a few minutes.

#### 2. ECR clean-up

Each of the 12 repositories `staging/hid/<service>` has three lifecycle rules.
Rule 1 keeps every image with a `retain-` tag. Before every production
deployment the release helper tags the image the service runs and the image
that replaces it `retain-<digest hex>` (and the token agent image, and the
migration image before a migration), never removes those tags, and refuses to
deploy unless rule 1 keeps every `retain-` image. That is `protect_image` in
`scripts/production_deployment.py` on the release branch
`staging-novu-ci-20261005`; the bootstrap inventory did the same with `retain`
in `scripts/production_release_inventory.py` here. So the image each service
runs, the previous release and every earlier production release are never
expired. Rule 1 does not change. The second check below confirms the tags
before the apply.

| Rule | Before | Production from this change |
| --- | --- | --- |
| 1 | keep every `retain-` image | unchanged |
| 2 | untagged images 7 days after push | untagged images 14 days after push (`ecr_untagged_image_expiry_days = 14`) |
| 3 | any other image beyond the newest 25, at any age | any other image older than 90 days (`ecr_tagged_image_expiry_days = 90`) |

- The owner asked to keep the newest 10 releases per repository and expire
  only images older than 90 days beyond those. ECR never expires an image that
  an image index still references, and decides each image by the first rule
  its tags match, one count type per rule, so "beyond the newest 10 and older
  than 90 days" cannot be one rule. What this change does instead, in the words
  the owner is asked to accept before the apply: **every deployed release is
  kept, and every other image is kept for 90 days after push.** Every release
  stays by its `retain-` tag (all of them, not only the newest 10; trimming
  releases would need a release helper change), and rule 3 uses the age, so no
  image younger than 90 days expires. The one difference from the request: a
  build that never ran in production can expire once older than 90 days even
  if its repository has fewer than 10 newer builds. The dry run below marks
  those `note`; they are in the backup and can be rebuilt (rollback below).
- Cost: ECR storage is USD 0.10 per GB a month. Busy repositories can now keep
  more than 25 images (every build of the last 90 days); the gain is that no
  image a rollback might want is lost. The dry run totals what would go now.
- Other environments keep today's rules (the two inputs default to 7 and
  null). Terraform refuses age-based expiry where rule 1 is absent.
- Plan: the 12 `module.application.aws_ecr_lifecycle_policy.workload["<service>"]`
  "must be replaced". The AWS provider (6.66.0) cannot edit a lifecycle policy:
  for each repository it deletes the policy and puts the new one straight after,
  seconds apart. No image is touched by this. While a repository has no policy
  nothing expires, and a deployment would stop at its check of rule 1; none
  can start, because the section 4 helper holds the release lease during the
  apply. If the apply stops between a delete and a put, running it again does
  not work: follow "If the apply stops part-way" below.

Before applying, back up, check and dry-run from `infra/terraform`, in the same
PowerShell session as section 4 (it needs `$env:RELEASE_KMS_KEY_ARN`). All
three steps are read-only for ECR. First, the inventory of every repository's
images, and today's rules, to the private release bucket:

```powershell
$date = [datetime]::UtcNow.ToString('yyyy-MM-dd'); $dir = "ecr-inventory-$date"
New-Item -ItemType Directory -Force $dir | Out-Null
$repos = @((aws ecr describe-repositories --region eu-west-1 --output json | ConvertFrom-Json).repositories.repositoryName | Where-Object { $_ -like 'staging/hid/*' } | Sort-Object)
"$($repos.Count) repositories (expect 12)"
foreach ($r in $repos) {
  $n = $r -replace '/', '-'
  aws ecr describe-images --repository-name $r --region eu-west-1 --output json | Set-Content -Encoding ascii "$dir/ecr-$n-$date.json"
  aws ecr get-lifecycle-policy --repository-name $r --region eu-west-1 --query lifecyclePolicyText --output text | Set-Content -Encoding ascii "$dir/lifecycle-$n-$date.json"
}
aws s3 cp $dir "s3://hid-staging-releases-659225405023-eu-west-1/ecr-inventory/$date/" --recursive --sse aws:kms --sse-kms-key-id $env:RELEASE_KMS_KEY_ARN --region eu-west-1
aws s3 ls "s3://hid-staging-releases-659225405023-eu-west-1/ecr-inventory/$date/" --region eu-west-1
```

Expect 24 files (an `ecr-staging-hid-<service>-<date>.json` inventory and a
`lifecycle-...` rules file per repository). The inventory records every digest,
tag, push date and size. Keep the local folder until the clean-up has run.

Second, every image production runs or can roll back to must carry a
`retain-` tag: the images of the 12 running task definitions (with the token
agent), the latest migration task definition, the images in `production.tfvars`,
the release index (`production/current.json`) and every backend release receipt
in the release bucket (`production/releases/<release>/complete.json`, both its
`before` and its `after`; a rollback re-deploys a release's `after`). The tags
come from the inventory saved in the first step:

```powershell
$used = @{}
foreach ($s in (aws ecs list-services --cluster hid-production --region eu-west-1 --output json | ConvertFrom-Json).serviceArns) {
  $td = aws ecs describe-services --cluster hid-production --services $s --region eu-west-1 --query "services[0].taskDefinition" --output text
  (aws ecs describe-task-definition --task-definition $td --region eu-west-1 --output json | ConvertFrom-Json).taskDefinition.containerDefinitions.image | ForEach-Object { $used[$_] = $td }
}
$mig = aws ecs list-task-definitions --family-prefix hid-staging-database-migration --status ACTIVE --sort DESC --region eu-west-1 --query "taskDefinitionArns[0]" --output text
(aws ecs describe-task-definition --task-definition $mig --region eu-west-1 --output json | ConvertFrom-Json).taskDefinition.containerDefinitions.image | ForEach-Object { $used[$_] = $mig }
[regex]::Matches((Get-Content environments/production.tfvars -Raw), '(?m)^\s*("[a-z-]+"|migration_image_uri|production_workload_token_agent_image_uri)\s*=\s*"([^"]+@sha256:[a-f0-9]{64})"') | ForEach-Object { if (-not $used.ContainsKey($_.Groups[2].Value)) { $used[$_.Groups[2].Value] = 'production.tfvars' } }
$bucket = 'hid-staging-releases-659225405023-eu-west-1'
$add = { param($uri, $from) if ($uri -and -not $used.ContainsKey($uri)) { $used[$uri] = $from } }
$index = aws s3 cp "s3://$bucket/production/current.json" - --region eu-west-1 | Out-String | ConvertFrom-Json
if (-not $index.backend) { 'STOP (could not read production/current.json)' }
foreach ($row in @($index.backend.PSObject.Properties.Value)) { & $add $row.image_uri 'production/current.json' }
& $add $index.migration_image_uri 'production/current.json'
$receipts = @((aws s3api list-objects-v2 --bucket $bucket --prefix production/releases/ --region eu-west-1 --query "Contents[?ends_with(Key, '/complete.json')].Key" --output json | ConvertFrom-Json) | Where-Object { $_ })
$backend = 0
foreach ($k in $receipts) {
  $receipt = aws s3 cp "s3://$bucket/$k" - --region eu-west-1 | Out-String | ConvertFrom-Json
  if (-not $receipt) { "STOP (could not read $k)"; continue }
  if ($receipt.kind -ne 'backend') { continue }
  $backend++
  foreach ($side in 'after', 'before') { foreach ($row in @($receipt.$side.PSObject.Properties.Value)) { & $add $row.image_uri $k } }
}
"$backend backend release receipts read of $($receipts.Count) listed; $($used.Count) images in use or kept for rollback"
$tagsOf = @{}
foreach ($r in $repos) { foreach ($d in @((Get-Content "$dir/ecr-$($r -replace '/', '-')-$date.json" -Raw | ConvertFrom-Json).imageDetails)) { $tagsOf["$r@$($d.imageDigest)"] = @($d.imageTags) } }
foreach ($i in $used.Keys) {
  $repo, $digest = ($i -replace '^[^/]+/', '') -split '@'
  $verdict = if (-not $digest) { 'STOP (not pinned to a digest)' } elseif (-not $tagsOf.ContainsKey("$repo@$digest")) { 'STOP (not in the inventory)' } elseif (@($tagsOf["$repo@$digest"] | Where-Object { $_ -like 'retain-*' }).Count) { 'ok' } else { 'STOP (no retain- tag)' }
  "$verdict $i ($($used[$i]))"
}
```

Expect at least one backend release receipt, no `could not read` line and every
line `ok`. A `could not read` line is a receipt whose read failed (for example a
throttled S3 or KMS call), so its images were not checked: run the block again,
and if the same receipt still cannot be read, treat it as a `STOP`. On a
`STOP`, do not apply this item: drop the two `ecr_` lines from the commit (the
other items can go ahead) and report it. An image a service runs now gets its
tag at that service's next release through the helper. An earlier release's
image without the tag (for example one deployed before the helper tagged
images) is for the owner to decide: keep it as a rollback target by tagging it
`retain-<digest hex>` as the helper does, or accept that this release can no
longer be rolled back to once its image is 90 days old (it stays in the backup
and can be rebuilt). An image `not in the inventory` is already gone from ECR:
that release cannot be rolled back to today whatever this change does, and the
owner may accept that and go ahead.

Third, a dry run: ECR's lifecycle preview applies the new rules to today's
images without expiring anything or changing the live rules:

```powershell
@'
{"rules": [
  {"rulePriority": 1, "description": "Protect named live and rollback digests from lower priority cleanup",
   "selection": {"tagStatus": "tagged", "tagPrefixList": ["retain-"], "countType": "imageCountMoreThan", "countNumber": 1000000},
   "action": {"type": "expire"}},
  {"rulePriority": 2, "description": "Expire untagged build residue",
   "selection": {"tagStatus": "untagged", "countType": "sinceImagePushed", "countUnit": "days", "countNumber": 14},
   "action": {"type": "expire"}},
  {"rulePriority": 3, "description": "Expire images older than 90 days that carry no retain- tag",
   "selection": {"tagStatus": "any", "countType": "sinceImagePushed", "countUnit": "days", "countNumber": 90},
   "action": {"type": "expire"}}
]}
'@ | Set-Content -Encoding ascii ecr-new-rules.json
$inUse = @($used.Keys | ForEach-Object { ($_ -split '@')[1] }); $bytes = 0
foreach ($r in $repos) {
  $images = @((Get-Content "$dir/ecr-$($r -replace '/', '-')-$date.json" -Raw | ConvertFrom-Json).imageDetails)
  $newest = @($images | Sort-Object { [datetimeoffset]$_.imagePushedAt } -Descending | Select-Object -First 10 | ForEach-Object imageDigest)
  aws ecr start-lifecycle-policy-preview --repository-name $r --lifecycle-policy-text file://ecr-new-rules.json --region eu-west-1 | Out-Null
  do { Start-Sleep -Seconds 5; $p = aws ecr get-lifecycle-policy-preview --repository-name $r --region eu-west-1 --output json | ConvertFrom-Json } while ($p.status -eq 'IN_PROGRESS')
  foreach ($x in @($p.previewResults)) {
    $size = ($images | Where-Object imageDigest -eq $x.imageDigest | Select-Object -First 1).imageSizeInBytes; $bytes += $size
    $verdict = if ($inUse -contains $x.imageDigest -or @($x.imageTags | Where-Object { $_ -like 'retain-*' }).Count) { 'STOP' } elseif ($newest -contains $x.imageDigest) { 'note' } else { 'expire' }
    '{0} {1} {2} {3} pushed {4}, rule {5}, {6:N0} MB' -f $verdict, $r, $x.imageDigest.Substring(7, 12), (@($x.imageTags) -join ','), $x.imagePushedAt, $x.appliedRulePriority, ($size / 1MB)
  }
  '{0}: preview {1}, {2} of {3} images would expire' -f $r, $p.status, @($p.previewResults).Count, $images.Count
}
'At most {0:N1} GB, about USD {1:N2} a month' -f ($bytes / 1GB), ($bytes / 1GB * 0.10)
```

Every repository must say `preview COMPLETE`. `STOP` (an image in use, kept for
rollback or with a `retain-` tag would expire) must never appear: do not apply,
and report it.
`note` is one of the 10 newest images of its repository: older than 90 days,
never run in production, and in the backup; apply only if the owner accepts
losing it. `expire` lines are what ECR removes within a day of the apply. The
total is an upper bound, since images share layers.

After applying, every repository shows the new rules (expect
`1:imageCountMoreThan/1000000 2:sinceImagePushed/14 3:sinceImagePushed/90`):

```powershell
foreach ($r in $repos) { $rules = (aws ecr get-lifecycle-policy --repository-name $r --region eu-west-1 --query lifecyclePolicyText --output text | ConvertFrom-Json).rules; '{0}: {1}' -f $r, (($rules | ForEach-Object { '{0}:{1}/{2}' -f $_.rulePriority, $_.selection.countType, $_.selection.countNumber }) -join ' ') }
```

A day later, `aws ecr describe-images` per repository lists exactly the
inventory minus the `expire` (and accepted `note`) lines. The next backend
release runs as usual: the helper reads rule 1 before tagging.

If the apply stops part-way: a repository whose old policy was deleted before
the stop has no rules. Nothing expires there, so no image is lost, but a backend
release would refuse it (`ROLLBACK_RETENTION_POLICY_REQUIRED`), and none can
start anyway while the helper keeps the release lease. Running the apply again
does not work (section 4, "If a helper apply stops part-way"). From
`infra/terraform`:

1. Read every repository's rules:

   ```powershell
   $repos = @((aws ecr describe-repositories --region eu-west-1 --output json | ConvertFrom-Json).repositories.repositoryName | Where-Object { $_ -like 'staging/hid/*' } | Sort-Object)
   $missing = @()
   foreach ($r in $repos) {
     $out = aws ecr get-lifecycle-policy --repository-name $r --region eu-west-1 --query lifecyclePolicyText --output text 2>&1 | Out-String
     if ($LASTEXITCODE -eq 0) { '{0}: {1}' -f $r, ((($out | ConvertFrom-Json).rules | ForEach-Object { '{0}:{1}/{2}' -f $_.rulePriority, $_.selection.countType, $_.selection.countNumber }) -join ' ') } elseif ($out -match 'LifecyclePolicyNotFoundException') { '{0}: no policy' -f $r; $missing += $r } else { 'STOP {0}: could not read the policy ({1})' -f $r, $out.Trim() }
   }
   ```

   Each of the 12 lines shows the new rules
   (`1:imageCountMoreThan/1000000 2:sinceImagePushed/14 3:sinceImagePushed/90`),
   the old ones (`... 2:sinceImagePushed/7 3:imageCountMoreThan/25`, not reached
   before the stop) or `no policy`. On a `STOP` line, run it again.
2. Put the new rules on every repository with no policy. `ecr-new-rules.json`
   is the file the dry run wrote (the third check above; if it is gone, run that
   block's first command again). It holds exactly the rules Terraform puts (a
   test checks this):

   ```powershell
   foreach ($r in $missing) { aws ecr put-lifecycle-policy --repository-name $r --lifecycle-policy-text file://ecr-new-rules.json --region eu-west-1 --query repositoryName --output text }
   ```

   Run step 1 again: no repository may show `no policy`.
3. Release the lease and plan again: section 4, "If a helper apply stops
   part-way", steps 2 to 4. In the new plan, a repository whose rules you put
   back shows no change, or `will be created` with the same rules where
   Terraform had already dropped the old policy from its state (putting the
   same rules again changes nothing). A repository not reached before the stop
   still "must be replaced". The items this branch already finished show no
   change. Review that plan and apply it.

Rollback:

- Rules: delete the two `ecr_` lines from `production.tfvars` in a reviewed
  commit on dev, plan (the same 12 policies replaced, back to 7 days and the
  newest 25) and apply. In an emergency, put a repository's backed-up rules
  back at once with `aws ecr put-lifecycle-policy --repository-name <repository>
  --lifecycle-policy-text file://<folder>/lifecycle-<repository with dashes>-<date>.json --region eu-west-1`,
  then make the same Terraform change, or the next apply puts the new rules
  back.
- Images: ECR cannot restore an expired image. Rebuild it from its code
  version: its `ci-<commit>-<run>-<attempt>-<target>` tag in the inventory
  names the commit. Put that version of the service's code on the release
  branch `staging-novu-ci-20261005` in a reviewed commit and run "Production
  backend candidates" for that component (it publishes only from that branch).
  The rebuilt image has a new digest and goes through the normal release
  review. The live and previous releases never need this: they keep their
  `retain-` tags.

#### 3. Worker scaling on dead metrics

ocr-worker and event-dispatcher each had a third target tracking policy:
`ocr_backlog` on `HID/OCR` `QueueDepth` (target 10) and `outbox_backlog` on
`HID/EventDelivery` `PendingCount` (target 25). Nothing publishes those
metrics. The workers only log the values (`ocr.job.claimed` with `queueDepth`,
`event_dispatcher.backlog` with `pendingCount`, both only when they claim
work); the old CDK stack's metric filters are gone and this Terraform has
none. The 4 alarms AWS created for the two policies
(`TargetTracking-service/hid-production/hid-production-<service>-AlarmHigh-...`
and `-AlarmLow-...`) therefore sit in `INSUFFICIENT_DATA`. AWS scales a service
in only when every target tracking policy on it is ready to scale in, and a
policy without data never is: after the CPU or memory policy adds a second
task, neither service goes back to one.

This change removes the two policies (AWS deletes their 4 alarms with them)
rather than adding metric filters for those log lines. Filters would publish
only while there is work, so idle periods would still have no data and still
block scale-in, and a total backlog does not fall as tasks are added, which
target tracking needs. They would also cost USD 0.60 a month (2 custom metrics
at USD 0.30). Without the policies both services scale on CPU and memory, 1 to
2 tasks, as every scale-out already did, and scale back in again. This saves
the 4 alarms (USD 0.40 a month) and, whenever a second task was stuck, that
task (0.5 vCPU and 1 GB on Fargate ARM, about USD 14 a month each). The
notification-worker keeps its SQS backlog policy, which AWS publishes. The
policies go in every environment; nothing publishes the metrics anywhere.

- Plan: `module.application.aws_appautoscaling_policy.ocr_backlog["ocr-worker"]`
  and `module.application.aws_appautoscaling_policy.outbox_backlog["event-dispatcher"]`
  destroyed. The services and their CPU and memory policies do not change.
- Before applying (read-only): each service shows three policies, the 4 alarms
  are in `INSUFFICIENT_DATA` and both metrics are absent. A desired count of 2
  while the service is idle is a second task stuck this way. Stop if
  `list-metrics` returns `QueueDepth` or `PendingCount` (something then
  publishes them):

  ```powershell
  foreach ($svc in "ocr-worker", "event-dispatcher") {
    aws ecs describe-services --cluster hid-production --services "hid-production-$svc" --region eu-west-1 --query "services[0].[serviceName,desiredCount,runningCount]" --output text
    aws application-autoscaling describe-scaling-policies --service-namespace ecs --resource-id "service/hid-production/hid-production-$svc" --region eu-west-1 --query "ScalingPolicies[].PolicyName" --output text
  }
  aws cloudwatch describe-alarms --alarm-name-prefix "TargetTracking-service/hid-production/" --region eu-west-1 --query "MetricAlarms[?Namespace=='HID/OCR' || Namespace=='HID/EventDelivery'].[AlarmName,StateValue]" --output table
  aws cloudwatch list-metrics --namespace HID/OCR --region eu-west-1
  aws cloudwatch list-metrics --namespace HID/EventDelivery --region eu-west-1
  ```

- After applying: the same commands show two policies per service (`-cpu`,
  `-memory`) and no `HID/` alarms. A service at 2 tasks with low CPU and memory
  returns to 1 within about half an hour (15 low minutes, then the 10-minute
  scale-in cooldown).
- Rollback: revert this commit on dev in a reviewed commit and apply; the two
  policies and their alarms come back, still without data.

#### 4. Alerts from the production alarms

The alerts topic `hid-staging-operations-alerts` is encrypted with its own KMS
key. The topic policy and the key policy let CloudWatch publish only for alarms
named `hid-staging-*` (`aws:SourceArn`, with `aws:SourceAccount` =
`659225405023`), but the 12 running-task alarms are named after the ECS cluster,
`hid-production-<service>-running-tasks`, so AWS refused their notifications
(see "Monitoring cost"). Each policy now has one more statement for CloudWatch:
the same actions (`sns:Publish`; `kms:Decrypt` and `kms:GenerateDataKey*`), the
same account condition, and `aws:SourceArn` like
`arn:aws:cloudwatch:eu-west-1:659225405023:alarm:hid-production-*-running-tasks`,
so only the hid-production cluster's running-task alarms in this account and
region. The `hid-staging-*` statements and the key's account administration
statement stay as they are. Terraform adds the statement only where the
running-task alarm names fall outside the name prefix, which is production;
elsewhere both policies stay unchanged. Every other alarm that notifies the
topic is named `hid-staging-*`.

- Plan: `module.operations.aws_kms_key.alerts` and
  `module.operations.aws_sns_topic_policy.alerts` updated in place, policy
  only. The key keeps its ID, alias and rotation; the topic and its email
  subscription do not change.
- Before applying (read-only), the alarm history shows the refused
  notifications ("Failed to execute action"):

  ```powershell
  aws cloudwatch describe-alarm-history --alarm-name hid-production-gateway-running-tasks --history-item-type Action --max-items 5 --region eu-west-1 --query "AlarmHistoryItems[].[Timestamp,HistorySummary]" --output text
  ```

  Then list every alarm that notifies the topic and print any name neither
  statement admits:

  ```powershell
  $topic = "arn:aws:sns:eu-west-1:659225405023:hid-staging-operations-alerts"
  $names = @(aws cloudwatch describe-alarms --region eu-west-1 --query "MetricAlarms[?contains(AlarmActions, '$topic') || contains(OKActions, '$topic')].AlarmName" --output json | ConvertFrom-Json)
  "$($names.Count) alarms notify the topic"
  $names | Where-Object { $_ -notlike 'hid-staging-*' -and $_ -notlike 'hid-production-*-running-tasks' }
  ```

  Expect the count line only. A name printed below it is an alarm whose
  notifications both policies still refuse after this change; the Terraform
  tests check every alarm defined here, so it was made outside this Terraform.
  Report it before applying.

- After applying, send one test alert: tell the operations mailbox first, then
  set one alarm to `ALARM` by hand. Nothing touches the service, and the alarm
  returns to `OK` at its next one-minute evaluation:

  ```powershell
  aws cloudwatch set-alarm-state --alarm-name hid-production-gateway-running-tasks --state-value ALARM --state-reason "Alert delivery test after the alerts topic policy change" --region eu-west-1
  ```

  `operations@healthidentitydirectory.com` receives an ALARM email and, about a
  minute later, an OK email, and the history command above shows
  "Successfully executed action" for both. If not, look at the topic and key
  policies (`aws sns get-topic-attributes`, `aws kms get-key-policy`) before
  anything else.
- Rollback: revert this commit on dev in a reviewed commit and apply; the
  extra statements go and these 12 alarms' notifications are refused again.

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
the lease for operator recovery (for the infrastructure helper: section 4, "If a
helper apply stops part-way"). A build does not certify untested features.

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
