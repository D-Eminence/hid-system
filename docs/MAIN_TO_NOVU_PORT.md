# Fixes ported from main to the production Novu branch

`staging-novu-ci-20261005` serves production. `main` recorded that branch as
merged (`7c88f0b`, "main supersedes it") without keeping its files, so Git
treats it as part of `main` and `git merge main` here would replace this
branch's applied migrations 0061–0072 with `main`'s different files of the same
numbers. Fixes therefore come over one pull request at a time, onto this
branch's own code, and every schema change is a new migration numbered after
0072.

Production admits only new migration files under `services/ehr-api/database/`,
plus `runtime-grants.sql` (below), each declared with its SHA-256 in
`config/production-schema-compatibility.json` and a named reviewer
(`scripts/production_deployment_core.py`, `schema_contract`). So these ports
leave every other existing file there unchanged: database suites ported from
`main` run from `services/ehr-api/test/database/`, which the container database
acceptance script runs after the suites in `services/ehr-api/database/tests/`.

## Ported

| main | What it fixes here | Migration here |
| --- | --- | --- |
| #40 | EHR clinical lists page at the sort key's full microsecond precision | — |
| #44 | EHR sends Lab the order's exact microsecond `created_at` as `requestedAt`; 0018 already compares them exactly | — |
| #51 | A Lab result history read without `lab.execution.read` returns released revisions only; adds `GET /lab/ehr-orders/:id/released-results` | — |
| #53 | Lab, Pharmacy and EHR reuse one remote JWKS set per process | — |
| #34 | Fourteen row locks in Identity, Lab, OCR, Outreach and Pharmacy needed UPDATE privileges their runtime roles lack (42501); SERIALIZABLE retry per service | 0073 (main 0078) |
| #33 (grant) | Every Outreach runtime write failed: its RLS policies call `auth.account_id_for_subject`, which the runtime could not execute | 0074, runtime-grants.sql |
| #56 | EHR can send a saved active lab request to Lab again; Lab answers acceptance refusals 4xx | — |
| #59 | Only the account that created a document upload intent completes it | — |
| #60 | A missing purpose of use is 400, not 500; an owning service refusing OCR's workload identity is 503 | — |
| #35, #36 | OCR stores transient publication failures as retryable, flags the last attempt, refuses unpublishable validations; the OCR app creates Textract jobs | — |
| #46 | EHR and OCR answer and audit a refusal made before a facility is bound instead of 503 | — |
| #38 | EHR, OCR, Lab and Pharmacy cookie GETs pass Identity's delegated check without a CSRF token | — |
| #43 | Outreach cookie reads pass without CSRF; Identity authorizes `outreach.campaign.read`; campaign writes stay refused | — |
| #45 | A correct patient PIN no longer clears the staff member's PIN failure window | 0075 (main 0079) |
| #55 | Recovery starts answer alike whether or not the account exists; wrong recovery codes share one budget per account | 0076 (main 0081), runtime-grants.sql |
| #61 | Wrong public-enrollment contact codes share one budget per recipient | — |
| #33 | Lab, Pharmacy, OCR and Outreach write guards fail closed on an unresolved session; OCR worker leases | 0077 (main 0077) |
| #31 | Lab authorizes the patient before listing a specimen's executions | — |
| #18 | The admin console's Platform controls page: the Identity runtime may run both control commands, and `platform.admin_set_control` no longer fails with 42702; its refusals answer 409/403/400 | 0078 (main 0071), runtime-grants.sql |
| #18 | The admin console's Audit page: `audit.list_platform_events` returns `patient_id` in its declared column instead of failing with 42804 | 0079 (main 0067) |
| #88 | CAC sign-up reads the Java-printed registration date that QoreID's CAC Basic v2 returns in production | — |
| #88 | Termii receives the SMS recipient as international digits without `+`, as its API documents | — |
| — | This branch only: OCR publication answers 503 `OCR_PUBLICATION_PAUSED` until `OCR_PUBLICATION_ENABLED=true` on ocr-api. It ships before the migration that lets publication commit, so no running ocr-api (during a rollout or after a rollback) can publish before the owner decides | — |
| #32 (7B) | The OCR patient-confirmation and validation guards refuse a missing source, extraction, account or membership, and bind the confirming account and membership to the session | 0080 (main 0076) |
| #30 | OCR patient confirmation and publication can write their outbox events (every one failed with 42501); a repeated confirmation answers 409 `OCR_PATIENT_ALREADY_CONFIRMED` | 0081 (main 0075) |
| #30 | The OCR worker reports queue depth and age through `ocr.worker_queue_metrics()`, owned like `ocr.claim_worker_job` (main's dedicated owner role is not ported) | 0082 (main 0075), runtime-grants.sql |
| #30 | Every OCR audit event names the source document's patient; finding a job, listing validations and listing publications are audited | — |
| #75 (PSELF-RLS) | Patient-self reads, index writes and chat history are bound to the patient's own live session; a context naming another patient or a revoked, expired or made-up session reads nothing. The session check is inline (main's nested call costs about 500 µs per row) | 0083 (main 0091 section 3) |
| #69 (PSEARCH-1, create answer) | Creating an access request no longer returns the patient id to the clinician before the patient consents. The staff request list (`GET /identity/access-requests`) still names the patient of a pending request; withholding it there needs main's 0086 list function, not ported | — |
| #76 (LOGIN-DETAIL-ORACLE) | Every credential refusal at sign-in answers 401 "Invalid credentials", so the detail never confirms a correct password; a Google refusal while issuing the session is 401 `GOOGLE_SIGN_IN_DENIED`, audited as denied | — |
| #76 (A18) | A delegated browser read cannot authorize `write_records` (403 `CSRF_VALIDATION_FAILED`) | — |
| #79 (TS-2, TS-3, TS-8) | Turnstile retries Siteverify once (same idempotency key), answers its configuration errors as 503 `TURNSTILE_UNAVAILABLE`, logs one safe line per refusal, and a missing token answers 400 `TURNSTILE_REQUIRED` on enrollment, organization application and completion, and demo requests | — |
| #41 | Staff password recovery: Identity accepts `staff-reset` on the production portal (app.), where /provider/recover is served; www only redirects to the public site. health sends staff recovery to app. (D-Eminence/health, "Send staff password recovery to the portal"). The portal's own staff sign-in (`staff-login` on app.) stays refused, as on main: an owner decision | — |
| #68 (ENR-4, FE-4) | Public enrollment checks the QoreID gate (QoreID and NIN-only enrollment on, QoreID not paused at runtime) before it reads the registry, so while the gate is closed a registered, a pending and an unknown NIN get the same 503 and no rate bucket is charged. Availability answers `{ open: false }`, not 503, when QoreID is paused or the enrollment keys are missing. `main`'s boot-time refusal of NIN-only enrollment in production is not ported | — |
| #84 (adapter) | A QoreID NIN record with no usable phone, a null photo or a partial residence enrolls; what is unusable is left out instead of answering 502. Such records were refused only by this parsing, so more NINs can now enroll without the NIN holder proof, which is not ported (owner decision) | — |
| #84 (signed-in NIN binding) | `POST /identity/me/verification/nin` binds a NIN on a name and date-of-birth match, without proof of holding it. It now answers 503 `QOREID_PATIENT_NIN_BINDING_DISABLED` before any lookup, quota charge or evidence write unless `QOREID_PATIENT_SELF_NIN_BINDING_ENABLED=true`. No production screen calls it. `main`'s production refusal of the flag is not ported: turning it on is the owner's decision | — |
| #86 (Integrations page) | The admin Integrations page shows NIN enrollment open only with its gate, the enrollment keys and a ready enrollment database, and existing-patient NIN binding only with its own flag | — |
| #50 (enrollment) | Activation is budgeted per enrollment (`OTP_RATE_MAX_REQUESTS` × 3 per window, then 429 `ENROLLMENT_RATE_LIMITED`) once the cookie has proved it. A replay of an active enrollment never hashes the presented password; the placeholder hash the command needs is computed once per process | — |
| — | This branch only (owner decision): a public enrollment's start, and `GET /identity/patient-enrollments/current` until activation, answer `recordName`, the full name on the NIN record (first, middle and last), so the person can check that the NIN they typed is theirs. Only the start's answer and the browser holding that enrollment's cookie receive it; it is never logged and is stored only in the encrypted profile. health shows it under "NIN verified" | — |
| #68 (N2(b), service half) | The enrollment cookie shows the new HID (`GET /current`, an activation replay) for 15 minutes after activation only, then answers 404 as an unknown enrollment. Before, a shared device showed it to the next person for up to 24 hours. A start with the key of an activated enrollment answers 409 `IDEMPOTENCY_KEY_REUSED`, as on `main`, so the page says the registration was completed. Not ported: `main`'s 0085 check of the same in the activation command (the service refuses before it calls the command), and `main`'s expiry of the cookie in the activation response, so a reload within the 15 minutes still shows the HID, which a patient who verified only a phone needs to sign in and to recover the account | — |

## Not ported, and why

- Already on this branch: #26 (0071 grants the list), #58 (0071 seeds `direct-care`).
- Does not apply: #52. This branch's record summary reads only encounters,
  notes and imported records, and imported attachments are scan-gated.
- Needs `main`'s Phase 4 platform administration (0061–0072 on `main`), which
  this branch replaces with its own (0064): the rest of #18 (its control and
  audit repairs are ported above), #24, #32 7A (its OCR guards are ported
  above), #49, #81, #76 A24, #80 A20, and the platform branches of #25, #27 and
  #39 (`admin_revoke_session_family`, `PlatformSecurityService`,
  `platformSessionEnded`). Platform administrator MFA would bring them back as
  its own change.
- Would lock out people production serves: #76 A10 (403
  `NO_ACTIVE_FACILITY_MEMBERSHIP` at the password step) and A16 (only a
  platform session is exempt from runtime controls), because this branch's
  administrators sign in as staff sessions without a membership, and A16 would
  lock out the administrator who must switch maintenance off. #79 TS-6 (refuse
  `admin-login` on `POST /auth/login`): the production admin console signs in
  there with that action.
- Would stop services production runs: #66 INFRA-COUNT, NOTIF-PROD
  (`otp-email-sms` required), REC-GOOGLE (empty Google client IDs) and the
  refusal of `HID_QOREID_NIN_ONLY_ENROLLMENT_ENABLED`, #68's boot-time NIN-only
  refusal and #84's production refusal of the binding flag. Production runs one
  task per service, `email-brevo`, Google sign-in and NIN-only enrollment, so
  each refusal would crash-loop a service or switch off a live sign-in.
- #65: the Dockerfile default `HID_ENABLED_API_ROUTES=identity,ehr` would take
  the Lab, Pharmacy, Migrate and Outreach portals down. The client address
  header and its per-request resolution already exist here and in health, as
  `X-Hid-Client-IP`, so the Worker's switch to `X-Real-IP` is not needed.
- #63 0083, `hid_platform_control_reader` and 0098's owner swap: this branch's
  `rds-compat/0015` already gives the function its local `variable_conflict`,
  and production's control reads work without the reader role.
- #88's CDK changes in `infra/aws` (exec-form health checks, the migration
  task's `--plan` and `DATABASE_ADMIN_URL`, Identity budget synthesis inputs),
  and #72 and #49 as implemented in CDK: CDK is not the production source (see
  Infrastructure below). #88's `db:provision` and the `PLATFORM_ADMIN_EMAILS`
  bootstrap: production's logins and administrators exist, and the bootstrap
  depends on `main`'s platform model.
- #93 (Terraform copied into this repository): `dev` holds the Terraform that
  runs production and is newer. A copy here would be a second, stale source.
- #92 Meta WhatsApp webhook: WhatsApp is not a production channel and
  notification-api is not publicly routed, so it would be inert code that
  redeploys notification-api.
- #29, #57, #62, #77 and #78 documents (and #57's comment-only lab-api edits):
  they describe `main`'s own chain and decisions, and the comment edits would
  redeploy lab-api for nothing.
- #18 a486a23/dfb87dd (every section in `GET /ehr/me/records`): superseded by
  #91's per-category release, which is to be ported switched off.
- `main`'s 0091 section 1 (launch controls switched off by migration): it lifts
  FORCE RLS on `platform.control_settings`, records no control event and
  changes live behaviour at deploy. A control is switched off with the audited
  admin command instead. 0084 section 1 and 0091 section 2 (withdrawing the
  Lab, Pharmacy, OCR, Outreach, break-glass, document-write and lab-order
  permissions): production serves these portals, and staff chat reads Lab
  results. Their fixes are ported instead.
- #50's expiry of the enrollment cookie at every sign-in, refresh and
  sign-out: here a second start for a NIN is refused while its first
  enrollment is pending (on `main` each start key makes its own, since #84 and
  #85), so expiring the cookie before activation could lock that NIN out of
  enrollment for up to 24 hours. After activation, #68's 15-minute window
  (above) covers what it protects. health's enrollment copy says that a
  sign-in or sign-out in the browser ends an enrollment; here it does not,
  before this port or after it.
- Rewrites Identity's sign-in, refresh and sign-out on `main`'s token service:
  #39, #42, the rest of #50, and #76 apart from the items ported above. Port
  each onto this branch's token service as its own change.
- Edits a suite in `services/ehr-api/database/tests/`, which production
  refuses: #48 as `main` made it (0080 also restates `main`'s 0077 bodies). A
  port orders its guards so the suite needs no edit.
- The other launch features and their infrastructure (#63–#98) are not ported
  yet. Each waits on the owner decision recorded below, where it needs one.

## Owner decisions

Decided by the owner, D-Eminence:

- Production stays in automatic mode (`PRODUCTION_APPROVAL_MODE=automatic`):
  a merge into this branch deploys the backend, and a merge into health `main`
  deploys the frontend. Each is merged only on green CI and watched until the
  release reads back.
- Each migration wave is signed on its own (`reviewed_by` and SHA-256 in
  `config/production-schema-compatibility.json`), after its container
  acceptance and rehearsal. Nothing is signed ahead: a held wave changes the
  numbers and hashes after it.
- health is re-pinned after every backend release, and the owner signs each pin
  (below).
- OCR patient confirmation is live; publication stays paused
  (`OCR_PUBLICATION_ENABLED` is not `true`) until a synthetic-patient test.
- Staff password recovery runs on the portal (#41, ported above), and staff
  sign-in on the portal sends staff to ehr.

Still open, with what each one holds back:

- The live task definitions (read only): `QOREID_NIN_ONLY_ENROLLMENT_ENABLED`,
  `CORS_ORIGINS`, no static AWS keys, no
  `NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN`, and whether
  `NIN_ENCRYPTION_KEY_B64` and `OTP_HMAC_KEY_B64` are set; also whether
  `audit.events` shows use of `POST /identity/me/verification/nin`. Holds the
  database role guard, NIN holder proof and emergency contacts. The enrollment
  port did not wait for it: without the keys a start already refused and
  availability now says closed, and no production screen calls the NIN
  binding route it switches off.
- #48: accepted, undispensed pharmacy work whose prescription has since changed
  becomes undispensable at once. Needs the read-only count first.
- Accounts disabled before the admin transition fix, with no recorded prior
  status: re-enabled as `pending_reset` (`main`'s rule) or backfilled. Needs
  the count first.
- Break-glass: confirm `break_glass_enabled` before Identity enforces it, and
  whether the `emergency` purpose launches before staff MFA.
- D7: patients see signed notes only once their encounter is completed.
- Patients see the requesting clinician's name and role, and get an inbox
  notice on every Access-PIN use.
- Encounter rules: refusing records on cancelled encounters, the
  completed-encounter order rule, `ehr.vitals.status` as a column, and when to
  enable the retraction cascade.
- Record release per category, and the patient-chat policy.
- Enabling the recovery and sign-in flags, clinician search budgets and uniform
  refusals, the public enrollment protections, the facility selection mode, and
  each enforcement flip after its report window.
- Edge and gateway policy: the WAF clinical exemption list, per-network
  thresholds, report-only CSP and its endpoint, and rotating the Cloudflare
  origin secret.
- Platform administrator MFA, two-person approval, governed clinician
  provisioning, staff MFA and clinician sign-up.
- Patient features held behind controls: revoking access, emergency contacts,
  account deletion and hospital self-activation.
- Duplicate active memberships for one account and facility: the read-only
  query decides whether one-membership enforcement can ship.

A default-off switch is turned on through `dev`'s Terraform for a tunable, or
by a later commit for a one-way enforcement flip; a database control through
the audited admin command. Never edit an ECS task definition by hand: the next
release stops with `LIVE_BASELINE_DIFFERS_FROM_INDEX`.

## Frontend pin after each backend release

health's production release (`config/production-release-dependencies.json` in
D-Eminence/health) names the backend commit each of its eight services was
built against, with a reviewer. It releases, and rolls back, only while the
production release index shows that commit as each service's `source_commit`;
otherwise it refuses with `REQUIRED_BACKEND_NOT_DEPLOYED`. A backend release
sets `source_commit` only for the components it deployed, and a push here
deploys (`selectComponents` in `scripts/production-backend-build.mjs`):

- every one of the 13 components, for any change under `packages/`, `scripts/`
  or `.github/workflows/production-backend-*`, or to
  `security/production-runtime-assessment.json`. Every migration wave adds its
  file to `scripts/verify-migration-ledger.mjs`, so it deploys them all;
- the service, for a change under `services/<service>/`, plus
  `database-migration` under `services/ehr-api/database/` or
  `services/ehr-api/scripts/`;
- the gateway, for a change under `gateway/`;
- nothing, for a change only under `docs/` or `infra/`, which the workflow does
  not watch.

So after every backend release, health is re-pinned to the commits it
deployed, signed by the owner, before the next frontend release. Until then
health can neither release nor roll back.

## Infrastructure

Production AWS (account `659225405023`, `eu-west-1`) is the Terraform on this
repository's `dev` branch: `infra/terraform`, which converted the regional CDK
design, with state key `health-identity/production/terraform.tfstate`. Its
changes go through `infra/terraform/scripts/production_release_infrastructure.py`,
which holds the release lease and re-baselines the release index; the operator
guide is `infra/DEVOPS_HANDOVER.md` there. The old staging stack was promoted
to production, so some production names still say staging, and there is no
separate staging stack.

A release from this branch changes only the image of each component's primary
container in its live task definition (`task_payload` in
`scripts/production_deployment_core.py`). Infrastructure changes, alarms, WAF
rules and environment switches among them, are made in `dev`'s Terraform, not
here. `infra/aws` (CDK) is not the production source, and
`infra/cloudflare`'s application and redirect Workers are not the production
frontend, which health releases; each says so in its README.

## Grants and the role bootstrap

0074 and 0076 grant to roles that already exist, which repairs production: a
release runs only `scripts/apply-migrations.mjs`. `runtime-grants.sql` revokes
every runtime grant before it applies its own, so it carries the same three
grants too, or a later role bootstrap, and every new installation (the
container acceptance and the CI migration rehearsal bootstrap after the
migrations), would remove them.

The production release used to refuse any change under
`services/ehr-api/database/` other than a new migration. It now also accepts a
modified `runtime-grants.sql` when the compatibility declaration lists it with
its SHA-256 next to at least one new migration
(`scripts/production_deployment_core.py`, `RUNTIME_GRANTS`). The release still
never applies that file, and its pending-migration check compares the plan with
the declared migrations only. Every other file there, database test suites
included, is still refused.

## Release recovery after the first deploy attempts

Both deploys of 568967b stopped at the approval step, before cloud credentials.
GitHub Actions was degraded, and its jobs API still showed finished jobs as
queued or in progress. The follow-up changes the release so this cannot block
it again, and so the reviewed migrations still deploy from a later commit:

- The approval step waits up to 20 minutes for every required job to show a
  conclusion. Any concluded job that is not a success still fails at once. The
  second check inside the deploy waits only 2 minutes.
- When a release's diff has no schema change but it includes the migration
  image, it carries the reviewed declaration in
  `config/production-schema-compatibility.json` forward. Migrations run only if
  production's pending set equals the declared files, by name and SHA-256, as
  printed by the migration plan. So 0073–0077 deploy from a commit after
  568967b, and a release that failed before migrating can be retried.
- Declared migration paths must be `migrations/NNNN_name.sql` with no
  subdirectories, and the plan is read only once all its lines have arrived.
