# Phase 3 launch decisions and operator plans

Date: 2026-10-12. Status: open. D1, D2 and D3 were decided on 2026-10-13 with
the proposed owner defaults (ADR-047, D-Eminence/hid-system#54), D4 with
the owner policy defaults (ADR-053, D-Eminence/hid-system#66), FE-HOST
(§1, ADR-052, D-Eminence/hid-system#67) with the owner's defaults, and
ENC-RETRACT-1, ENC-RETRACT-2 and ALLERGY-1 (§2) with the owner policy defaults
(ADR-056, BRANCH:launch/ehr-retraction-integrity);
nothing else in this document has been decided, and nothing has been deployed
or executed.

The Phase 3 launch review (workload tokens, identity and recovery, patient
records, Pharmacy, Lab, OCR and purpose of use, document completion and
workforce management) found defects that engineering could fix without a
product or security decision, and questions it could not answer alone. The
fixes are in pull requests (§4). This document records the open questions:
for each, the question, the default engineering proposes, the risks of that
default, and the work that waits on the answer. A default here is a proposal,
not a decision. Where a pull request already implements a proposed default,
it says so, and that pull request is the place to change it.

The infrastructure plans in §3 are written to be run by an operator after a
separate deployment authorization. None of them has been run.

## 1. Decisions the launch brief names

### N1. NIN ownership (ENR-1)

- **Question.** Must a person prove they hold a NIN before enrolling as its
  holder? Today anyone who knows a NIN can enroll as its holder, receive
  `NIN_VERIFIED` assurance and see the registry name. The NIN lookup proves the
  number exists, not that the caller owns it.
- **Proposed default.** Do not enable public NIN-only enrollment
  (`QOREID_NIN_ONLY_ENROLLMENT_ENABLED` stays unset, as in every deployment
  today, DEP-1) until ownership is bound to something the holder controls: an
  OTP to the phone number the NIN registry holds for that NIN, or an assisted
  check at a facility. Enrollment that verifies only the patient's own phone or
  email records contact assurance, never `NIN_VERIFIED`.
- **Risks.** Patients without a reachable registry phone cannot self-enroll
  with a NIN. A registry phone OTP depends on what the provider contract
  exposes (`QOREID_VERIFICATION_CONTRACT.md`), which nobody has confirmed.
- **Waits on it.** DEP-1 (NIN-only enrollment), ENR-4 (enrollment reveals
  whether a NIN already has a Health ID), the registry-name display.

### N2. Enrollment assurance and HID recovery (ENR-2, ENR-3 Part B, ENR-3b, FAC-2/REG-1)

- **Questions.** (a) How does a phone-only patient recover a lost HID? Today
  the HID is shown only on screen at activation (ENR-2). (b) How long may the
  enrollment cookie re-display the HID after activation (ENR-3 Part B)? (c)
  How long may a verified contact wait before the password step (ENR-3b)? (d)
  Is facility-assisted registration in launch scope? It is unavailable in
  every deployed environment (FAC-2, REG-1).
- **Proposed defaults.** (a) Send the HID to the verified contact at
  activation and offer HID lookup by verified contact plus OTP. (b) Clear the
  cookie at activation, with a 15-minute replay window. (c) 30 minutes, then
  verify again. (d) Out of launch scope; walk-in patients self-enroll.
- **Implemented now (D-Eminence/hid-system#50).** The enrollment cookie is
  expired at every sign-in, refresh and sign-out, and activation is limited
  per enrollment. The post-activation window itself is unchanged until (b) is
  answered.
- **Risks.** (b) and (c) need Health-id copy for new errors. Without (a), a
  phone-only patient who loses the HID cannot reach the account.

### N3. OCR purpose of use (OCR-1, OCR-READ-PURPOSE)

- **Question.** Which purpose of use authorizes the OCR commands? The OCR job
  DTOs accept only `healthcare-operations` and publication only `direct-care`,
  while a patient PIN grants only `read_records` for `direct-care`
  (`0079_patient_access_pin_actor_window.sql`, three hard-coded scopes). So no
  clinician can start OCR on a PIN grant, and retry, validate, confirm and
  publish all need `write_records`. Second question: may a break-glass
  emergency grant read EHR documents and OCR output? Today it can read both;
  the docs are silent.
- **Proposed default.** OCR commands accept `direct-care` as well as
  `healthcare-operations`; creating a job needs `write_records` (so a
  read-only PIN cannot start paid Textract work); break-glass keeps today's
  reads until EHR documents and OCR reads are decided together.
- **Implemented now, independent of this decision.**
  D-Eminence/hid-system#58 (migration 0082) seeds the purpose-of-use
  vocabulary with `direct-care` only: before it, no migration inserted any
  code, so `has_active_consent_grant` failed closed in every environment
  without hand-inserted rows. `healthcare-operations` and `emergency` are not
  seeded: seeding `emergency` would make break-glass live at once
  (`break_glass_enabled` defaults on), and `healthcare-operations` belongs to
  this decision. D-Eminence/hid-system#60 answers a missing or unknown
  `X-Purpose-Of-Use` with `400 PURPOSE_OF_USE_REQUIRED` instead of `500`; its
  allow-list is unchanged. The OCR DTOs still accept only the purposes above,
  and break-glass reads are unchanged, until this is decided.
- **Risks.** Accepting `direct-care` for OCR blurs the separation between
  operations and clinical authority. Refusing break-glass reads of documents
  removes the source scan from emergency care.

### N4. Outreach campaign governance (ADR-045)

- **Question.** Who may create campaigns, change their status and add
  members? The routes have no campaign-level governance: any holder of
  `outreach.campaign.write` at a facility can add themselves to any campaign
  as `admin` and read its linked registration cases.
- **Current state (D-Eminence/hid-system#43).** `outreach.campaign.write`
  stays refused at the Outreach authorization, so the campaign create, status
  change and member add answer `400` and no campaign can be created through
  the API. Campaign reads work.
- **Proposed default.** Option B of ADR-045: per-campaign governance first
  (only the campaign's own `admin` members may change it), in
  `OutreachService` and in row-level security by a new migration, with
  failing-first SQL and HTTP tests. Then authorize the permission.
- **Risks.** Option A (authorize the permission as 0038 designed it) is a
  one-line change but makes every campaign readable by any facility campaign
  writer. Option B is a migration and a service change.

### N5. Facility selection semantics (WF-3, FAC-4, D-Eminence/hid-system#47)

- **Question.** When an account has two active memberships at the same
  facility (different roles), which one does a session bind? And is the
  selected facility stored per session family? #47 (open, not part of this
  launch work) stores the selection per session family and proposes ADR-046.
- **Proposed default.** Bind to #47's stored selection; when none is stored,
  pick deterministically (oldest active membership) and record which.
- **Blocker on #47.** It adds `0080_session_facility_selection.sql`, and 0080
  is now `0080_pharmacy_source_prescription_guards.sql` on `main`
  (D-Eminence/hid-system#48), and 0081 and 0082 are taken too
  (D-Eminence/hid-system#55, D-Eminence/hid-system#58). #47 must be renumbered
  to the next free number, 0083 today, before it can merge. It also overlaps
  #50 on `auth.controller.ts` and `token.service.ts`.
- **Data check.** Run I4 (§3) before deciding: whether such memberships exist.

### FE-HOST. Launch frontend hosting (FE-HOST, MOD-EDGE)

- **Question.** Which frontend serves www, staging and admin.* at launch, and
  which product hosts are deployed? hid-system's legacy `apps/web` (about 30
  retired `/api/v1/functions/*` calls that answer `404`) and `apps/admin`
  (staff sign-in refused by the platform-scoped admin endpoints) were the
  configured assets; Health-id, the only frontend with the governed access
  loop, had no deployment definition, and `verify-config.mjs` required a
  manifest and service worker it deliberately lacks.
- **Decided (2026-10-13, owner defaults: deny by default, least privilege;
  ADR-052, D-Eminence/hid-system#67, not merged).** Health-id
  `apps/patient-web` is the single launch frontend for www, staging and
  admin.*, one build per host with `VITE_HID_API_BASE_URL` and
  `VITE_HID_APP_ORIGIN` equal to the host's origin, the environment's
  Turnstile site key, and no `VITE_HID_GOOGLE_CLIENT_ID` (REC-GOOGLE) or
  `VITE_HID_SENTRY_DSN`. A build is served only after
  `infra/cloudflare/scripts/stage-health-id-build.mjs` accepts it and records
  its provenance. Under the launch module set (D17) the product hosts for
  deferred modules are not deployed: `hid-lab`, `hid-pharmacy`, `hid-ocr`,
  `hid-ocr-redirect` and `hid-outreach`, and also `hid-ehr`, whose legacy
  build is not the launch frontend (clinicians use `/provider/clinical` on www
  or staging). `infra/cloudflare/launch-deployment.json` records the subset;
  the deferred APIs stay closed at the gateway (`HID_ENABLED_API_ROUTES`,
  D-Eminence/hid-system#65).
- **Risks.** Each host needs its own Health-id build. Serving a build on ehr.*
  later needs its own decision. www serves the portal (`noindex`), not
  Health-id's public site (`apps/public-web`), which is not deployed at
  launch. The signed release bundle cannot yet carry the Health-id artefact
  (ADR-052 consequences).
- **External.** Cloudflare and AWS operator authorization,
  `ORIGIN_AUTH_TOKEN` per environment, the Turnstile widget site and secret
  keys, the Cloudflare account and zone identifiers, a staging environment
  (none exists yet), and the Health-id builds (release checklist P14, S4l).

## 2. Other open decisions

| # | Decision | Proposed default | Risks | Waits on it |
| --- | --- | --- | --- | --- |
| D1 | Production workload issuer and key custody (DEP-4, DEP-4-KEY; ADR-047 accepted 2026-10-13, D-Eminence/hid-system#54) | **Decided (default):** the staging mechanism with an independent production key, API, stage and `hid:production:` subjects; the key policy keeps the root statement and denies `kms:Sign` to every principal but the issuer role, to any algorithm but `ECDSA_SHA_256` and to any message type but `RAW`; receivers accept only ES256 tokens with `exp`, `iat` at most 300 s old and `token_use: workload`; no local-secret fallback | Same-account key custody (an administrator can still change the key policy or the function); a single issuer for six services; receivers trust a withdrawn key for up to 10 minutes | Every service-to-service call in production; deployment still needs I5 and I6 |
| D2 | Behaviour during an issuer outage (DEP-4-RES) | **Decided (default):** the agent is `essential: false` with an ECS container restart policy and keeps the `HEALTHY` start gate (ADR-047) | During an outage longer than a token's lifetime, service-to-service calls fail closed (OTP delivery, EHR records, Lab, Pharmacy, OCR, Outreach) while sign-in keeps working; nothing pages anyone until D4 | DEP-4 rollout |
| D3 | Edge protection for the issuer (DEP-4-DOS) | **Decided (default, deny by default):** separate method throttles for `POST /token` and the JWKS `GET`, a REGIONAL web ACL on the issuer stage that blocks every source except the VPC's NAT gateway Elastic IPs (none in staging sleep), and an agent that caches its verified JWKS by `kid` (ADR-047) | A future caller outside the VPC (such as a D5 scanner) must leave through NAT or be allowlisted by a reviewed change; per-request WAF charges during a flood | DEP-4 rollout |
| D4 | Alert routing | **Decided (owner policy default, ADR-053, D-Eminence/hid-system#66):** every production alarm notifies, on ALARM and on OK, an operator-created SNS topic `hid-<env>-operational-alerts` encrypted with a customer-managed KMS key and named by its exact ARN (synth input `HID_OPERATIONAL_ALARM_TOPIC_ARN`, required in production, in the stack's own account and region). New alarms: issuer Lambda errors and throttles, issuer stage `5XXError` and `4XXError` (429s count there), token renewal (`Workload token renewal unavailable`) and OTP `definitive_failure`. "Dashboards only" is rejected: the CDK defines no dashboard, so it would mean nobody is told | The operations owner must name the on-call recipients, and an operator must create the topic and confirm each subscription (release checklist P15, P16) before production. A stopped token agent and Identity's `notification_workload_token_unavailable` line still raise no alarm. The five enabled services' running-task alarms are in ALARM, and notify, while production runs zero tasks before the I6 scale-up (P20); the recipients are told beforehand | Every mitigation that relies on an alarm |
| D5 | Malware scanner engine and credential (DOC-3, DEP-4-SCAN) | An in-account scanner role as a seventh issuer rule with subject `hid:<env>:document-scanner`, and a governed provisioning step for the `document_scanner` account | Until decided, no document becomes downloadable and no OCR job can start | Documents, OCR |
| D6 | Recovery and enrollment code guess budgets (REC-4, ENR-6) | 5 failures per 15 minutes per account or recipient, never per IP (the budget holds whatever network a guess comes from; until D-Eminence/hid-system#65 the edge also discarded client IPs); no daily cap | A daily cap makes denial of recovery cheap | Implemented as the default in D-Eminence/hid-system#55 (recovery codes) and D-Eminence/hid-system#61 (enrollment contact codes); thresholds are environment values |
| D7 | Patient record release categories (PREC-1 Phase B) | Completed-encounter items only; never draft or entered in error; confirmed diagnoses only; documents only once a patient download route exists | Docs are silent | Phase B of the record summaries |
| D8 | Vital correction semantics (CLIN-1, VIT-1) | The current correction is the whole current set, as Health-id renders it | API clients that send partial corrections lose omitted values | Held out of D-Eminence/hid-system#52 |
| D9 | Break-glass detailed reads (PREC-4 scope, OCR-READ-PURPOSE) | The emergency summary returns only categories the reader may read (D-Eminence/hid-system#52); EHR document and OCR reads unchanged until decided together | The seeded clinical roles hold every read permission, so the summary stays wide in practice | Emergency summary narrowing |
| D10 | Pharmacy and Lab lifecycle after acceptance (CLIN-2-POLICY, CLIN-3b) | Strict version equality for dispensing (D-Eminence/hid-system#48); Lab refuses new accession and execution for cancelled or entered-in-error orders; released results stay | Stranded queue items: a changed prescription leaves its work item `accepted` and undispensable | Queue cleanup, re-acceptance |
| D11 | Lab result detail for clinicians | No "unreleased correction pending" flag (D-Eminence/hid-system#51) | Clinicians cannot see that a correction is coming | Result retraction API |
| D12 | OCR publication after an authorization lapse | Terminal, as today | — | — |
| D13 | Upload completion actor (DOC-1) | Only the uploader's account may complete an upload (implemented in D-Eminence/hid-system#59) | No delegated completion | — |
| D14 | Workforce administration (WF-1, WF-2, MFA-1) | Decide which roles hold `workforce.manage` (legacy `admin` holds it), how existing staff are attached, whether pending access requests close when a membership ends, and whether staff MFA is a launch gate, by ADR before WF-1 | Invites and offboarding stay manual | Workforce management |
| D15 | Launch scope of EHR-to-Lab ordering and in-system result return | In scope (the EHR already sends orders) | If in scope, the Lab handoff is launch-blocking; it merged as D-Eminence/hid-system#56 | Lab handoff |
| D16 | Health-id OCR publication retry | Persist the publication key per validation; offer Retry for retryable failures | Frontend change | OCR publication retry |
| ENC-RETRACT-1 | Who may cancel or retract an encounter's records through the encounter | **Decided (owner policy default, least privilege, ADR-056, BRANCH:launch/ehr-retraction-integrity):** only a member holding the write permission of every kind of record the close changes (`ehr.note.write`, `ehr.diagnosis.write`, `ehr.vital.write`, `ehr.prescription.write`, `ehr.lab-request.write`, `ehr.document.write`); an encounter holding none of them needs `ehr.encounter.write` alone. Refused with `403 ENCOUNTER_RETRACTION_NOT_PERMITTED`, nothing written, audited; the database refuses it too (0090). The proposed `ehr.encounter.retract` permission was not taken | A nurse or receptionist who opened an encounter on the wrong patient must ask a doctor or clinician once it holds a diagnosis or prescription. No role holds `ehr.lab-request.write` (0084), so an encounter holding a lab request cannot be closed until Lab ordering returns. The rule follows record kinds, not authorship | Health-id offering the actions by permission (frontend follow-up) |
| ENC-RETRACT-2 | Retraction of wrong-patient vitals, completed orders and documents | **Decided (owner policy default, ADR-056, BRANCH:launch/ehr-retraction-integrity):** completed orders, final vitals and linked documents of an encounter entered in error become `entered_in_error` with it; a vital can be entered in error on its own (versioned, audited, with a reason) and then takes no change; the emergency summary leaves retracted vitals out; nothing is deleted | Health-id `82b474e` shows a retracted vital without a marker (frontend follow-up) | — |
| ALLERGY-1 | Allergies at launch | **Decided (owner policy default, ADR-056, BRANCH:launch/ehr-retraction-integrity): allergies are not recorded at launch.** No allergy table, route or prescribing check; a clinician records an allergy as a diagnosis (ICD-10 `Z88.x`) or in a note. `DATABASE.md` §7 now lists only implemented tables | Prescribers get no structured allergy check: a prescription for a drug the patient is allergic to is not flagged | Structured allergy capture (table with forced row-level security, versioning, the open-encounter guard, routes and audit; effort L) and Health-id saying so on the prescription form |

## 3. Operator plans (prepared, not executed)

Each needs a separate deployment authorization. None changes AWS,
Cloudflare, DNS, IAM, secrets or live data until an operator runs it.

### I1. Identity MFA key (D-Eminence/hid-system#49)

1. Per environment, separately: `openssl rand -base64 32`. Never reuse a key
   across environments.
2. Merge it into the environment's Identity sensitive secret JSON as
   `mfaSecretKeyB64` through `jq` from standard input, then
   `aws secretsmanager put-secret-value`. Never put the value on a command line
   or in a log.
3. Confirm the field is present and in canonical 32-byte base64 with the
   environment's own preflight. `scripts/staging-external-preflight.py` is
   staging-only: it is fixed to the staging account and refuses any other. In
   production run `scripts/production-external-preflight.py --cloud-read-only`
   with the approved `HID_AWS_ACCOUNT` and `HID_AWS_REGION` (it refuses the
   staging account): its launch profile must pass, which also requires the
   NIN lookup and encryption, OTP and contact lookup keys canonical,
   `googleOidcClientIds` present and empty (REC-GOOGLE), the notification
   secret to hold exactly the `otp-email-sms` fields, SES production access
   and the operational alarm topic (release checklist P15).
4. Only then deploy the task definition with `MFA_KEY_VERSION=aws-v1`. If the
   field is missing, no Identity task starts.
5. Verify platform-admin TOTP enrolment answers without `503 MFA_UNAVAILABLE`.

### I2. Migration window for 0080 onwards

- **Before:** P1 (the ledger shows the expected last migration), P2 (a
  restore-tested backup), the purpose-code check
  `select code, active, source_system from identity.purpose_of_use_codes order by code`
  (record any hand-inserted rows), and the `break_glass_enabled` control
  state.
- **Apply in order:** 0080 (Pharmacy guards, `CREATE OR REPLACE` of two
  functions, no table lock), 0081 (recovery start cooldown table, no lock on
  existing tables), then 0082 (the purpose-of-use seed, one insert under
  `ROW EXCLUSIVE` that keeps an existing `direct-care` row as it is). Then
  `db:bootstrap` and `db:verify-roles`.
- **Deploy order:** the Pharmacy API at or before 0080; the Identity image
  after 0081 and the bootstrap (otherwise every recovery start fails).
- **After:** rerun the purpose-code check; expect `direct-care` active (or
  as an operator left it before the window) and no other new row.

### I3. RDS owner attributes (OCR-P8, release checklist P8, ADR-041)

Before staging S1, as the RDS master: record
`select rolname, rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname in (current_user, '<migration administrator>')`
and the master's own role memberships, then grant
`SET ON PARAMETER plpgsql.variable_conflict` to the migration administrator
for the migration run. As that administrator, migrate 0001 to the latest
migration, run the role bootstrap twice and `db:verify-roles`, and verify
every runtime credential with `db:verify-logins`; then, as the master, revoke
the grant, which 0083 makes unnecessary after the run (`MIGRATION_RUNBOOK.md`
§6). Do not try or grant `BYPASSRLS`. If RDS refuses the grant, take a
reviewed ledger exception for 0015 rather than waiting on AWS. Then confirm
that OCR claims, patient confirmation, scan events and job events work.

The impact of an owner without `BYPASSRLS` was understated here. Besides
documents, OCR and Outreach, `platform.control_enabled`, which the Identity,
EHR and Outreach guards call on every patient and provider request, raised
`PLATFORM_CONTROL_UNAVAILABLE` (`503`) under such an owner, and the role
bootstrap needed a superuser. Both are fixed by
D-Eminence/hid-system#63, with 0083 for the OCR claim's setting.
Owner `BYPASSRLS` is not relied on: document scanning, OCR and Outreach
campaign registration stay out of the release unless they pass under a
non-bypass owner (ADR-041).

### I4. Duplicate-membership data check (N5)

Read-only, as the migration administrator:

```sql
select account_id, facility_id, count(*)
from identity.staff_facility_memberships
where active and facility_id is not null and migration_hold_reason is null
group by 1, 2
having count(*) > 1;
```

### I5. Staging issuer acceptance (D1 to D3 decided)

Staging is not deployed, and this needs a staging deployment authorization.
After redeploying it: admit the Identity image that carries the agent; run
`AWS_DEPLOYMENT_RUNBOOK.md` §7 (ES256, issuer, subject, audience,
`token_use`, 300-second lifetime, renewal about every 90 seconds with one
JWKS fetch per agent, refusal of a wrong audience, subject or signature);
prove that a role granted `kms:Sign` by IAM is refused by the key policy;
confirm the web ACL answers `403` to any source but the NAT addresses; flood
the JWKS endpoint and `POST /token` from a non-allowlisted source for at least
30 minutes, scaling one task out during it, and confirm no renewal fails; deny
one task role's invoke for 6 minutes and confirm the task keeps running with
its service-to-service calls failing closed and sign-in working; then a real
enrollment OTP, a recovery OTP and an EHR read.

### I6. Production issuer rollout (after I5, the production unlock and a deployment authorization)

Follow `AWS_DEPLOYMENT_RUNBOOK.md` §12 on D-Eminence/hid-system#54: synth and
verify; record the new template SHA as a new evidence entry; `cdk diff` must
show additions and the removed workload parameters only, with no RDS, S3 or
data-key replacement; deploy with every desired count at zero; check the
issuer; scale Notification, then Identity, then the rest, with synthetic
checks between; rollback is scaling to zero, never local-secret mode.

### I7. Malware scanner (after D5, the issuer change and I3)

Deploy the chosen engine; wire S3 object-created events on the documents
bucket; provision the `document_scanner` account under change control; post
`scan_started` then `clean`, `rejected` or `failed` per object version; in
staging, a PDF becomes downloadable and can start OCR, and an EICAR file is
refused.

### I8. Key rotation freeze

Do not rotate the NIN or OTP HMAC keys until a keyring for the three decrypt
sites ships (REC-2 Phase 1).

## 4. Where the engineering work is

See the release checklist (`PHASE_4_STAGE_5_RELEASE_READINESS.md`) §2 and §8
for each merged change and its evidence. Pull requests from this review:

| Finding | Change | State |
| --- | --- | --- |
| CLIN-2, CLIN-2-TIME (Pharmacy accepts and dispenses cancelled or changed prescriptions) | D-Eminence/hid-system#48, migration 0080 | merged |
| MFA-INFRA-P3 (Identity MFA key missing from the task definition) | D-Eminence/hid-system#49 | merged; operator plan I1 not run |
| LAB5-A, LAB5-RELEASED-LEAK (released Lab results) | D-Eminence/hid-system#51 | merged |
| ENR-5, ENR-3 Part A, SES-4 (enrollment and session hardening) | D-Eminence/hid-system#50 | merged |
| DEP-4 throttle exposure (per-request JWKS fetch) | D-Eminence/hid-system#53 | merged |
| REC-1, REC-3, REC-4 (recovery enumeration and code budget) | D-Eminence/hid-system#55, migration 0081 | merged |
| PREC-1 Phase A, PREC-2, PREC-3, PREC-4 (record summaries) | D-Eminence/hid-system#52 | merged; CLIN-1 held (D8) |
| LAB-3, CLIN-3a, LAB-REACCEPT, LAB5-23514, LAB5-DTO (EHR to Lab handoff) | D-Eminence/hid-system#56 | merged |
| This document | D-Eminence/hid-system#57 | merged |
| PURPOSE-SEED (no purpose-of-use code seeded; every consent check fails closed) | D-Eminence/hid-system#58, migration 0082 | merged; `emergency` and `healthcare-operations` held (N3) |
| DOC-1 (any facility member could complete a colleague's upload) | D-Eminence/hid-system#59 | merged (D13) |
| Missing purpose header answered `500`; OCR stored a workload-identity refusal as terminal | D-Eminence/hid-system#60 | merged; Identity's own workload refusal codes are a follow-up (release checklist §2) |
| ENR-6 (enrollment contact codes had no budget across challenges) | D-Eminence/hid-system#61 | merged (D6) |
| DEP-4, DEP-4-RT, DEP-4-KEY, DEP-4-DOS, DEP-4-RES (production workload tokens and issuer hardening) | D-Eminence/hid-system#54, ADR-047 accepted (D1-D3) | ready for review; deployment waits on I5 and I6 |
| ENC-RETRACT-1 (launch blocker), ENC-RETRACT-2, RX-FINAL, ORDER-CLOSED-EDIT, A9-EHR, A17-EHR-AUDIT, ALLERGY-1 (EHR retraction integrity) | BRANCH:launch/ehr-retraction-integrity, migration 0090, ADR-056 | local only; not pushed |
