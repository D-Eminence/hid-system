# Phase 3 launch decisions and operator plans

Date: 2026-10-12. Status: open. N1 and N2 were decided on 2026-10-13 with
the owner's policy defaults (§1); nothing else in this document has been
decided, and nothing has been deployed or executed.

The Phase 3 launch review (workload tokens, identity and recovery, patient
records, Pharmacy, Lab, OCR and purpose of use, document completion and
workforce management) found defects that engineering could fix without a
product or security decision, and questions it could not answer alone. The
fixes are in pull requests (§4). This document records the open questions:
for each, the question, the default engineering proposes, the risks of that
default, and the work that waits on the answer. A default here is a proposal,
not a decision, unless its entry says it was decided. Where a pull request
already implements a proposed default, it says so, and that pull request is
the place to change it.

The infrastructure plans in §3 are written to be run by an operator after a
separate deployment authorization. None of them has been run.

## 1. Decisions the launch brief names

### N1. NIN ownership (ENR-1)

- **Question.** Must a person prove they hold a NIN before enrolling as its
  holder? Today anyone who knows a NIN can enroll as its holder, receive
  `NIN_VERIFIED` assurance and see the registry name. The NIN lookup proves the
  number exists, not that the caller owns it.
- **Decided (owner defaults, 2026-10-13).** Binding a NIN requires proof that
  the caller holds the phone the NIN registry lists for it: a code sent to
  that registry phone, verified before the NIN is bound and before anyone is
  told the NIN already has a Health ID (ENR-4 step 2). Enrollment that
  verifies only the patient's own phone or email records contact assurance,
  never `NIN_VERIFIED`. Until that holder step ships, Identity refuses
  `QOREID_NIN_ONLY_ENROLLMENT_ENABLED=true` in production
  (`HID_DEPLOYMENT_ENV=production`, or `NODE_ENV=production` outside the
  staging profile): it does not start (BRANCH:launch/identity-enrollment-gates,
  CFG-PROD). The change that adds the holder step lifts that refusal; staging
  may run NIN-only enrollment for acceptance.
- **Implemented now (BRANCH:launch/identity-enrollment-gates), ENR-4 step 1.**
  Enrollment start checks the QoreID gate (`QOREID_ENABLED`,
  `QOREID_NIN_ONLY_ENROLLMENT_ENABLED` and the runtime pause of
  `qoreid`/`patient_nin`) before it reads whether the NIN is bound or pending,
  so while the gate is closed every NIN gets the same `503`. Once the gate is
  open the `409 NIN_ALREADY_REGISTERED` answer remains until step 2 ships;
  each probe of an unbound NIN then costs a QoreID lookup, bounded by the
  lookup quota (N2, below).
- **Implemented now (BRANCH:launch/identity-enrollment-gates), FE-4.** While
  the gate is closed by configuration, start answers its `503` with "New
  Health ID registration is not open yet. If you already have a Health ID,
  sign in." instead of the generic 5xx detail, and
  `GET /api/v1/identity/patient-enrollments/availability` answers
  `{ "open": boolean }` from the same gate, so Health-id can say so before it
  asks for a NIN (ADR-048 addendum; `INTERFACE_CONTRACT.md`). Health-id
  82b474e does not read it yet (release checklist §3).
- **Launch consequence (open for the owner to confirm).** With N1 as decided
  and facility-assisted registration out of scope (N2(d), D17), no new
  patient can get a Health ID in production at launch; legacy-migrated
  patients sign in. The owner confirms launching with registration closed,
  or prioritises ENR-4 step 2 (the registry-phone code), which needs a QoreID
  contract that exposes the registry phone (DEP-1, unconfirmed).
- **Risks.** Patients without a reachable registry phone cannot self-enroll
  with a NIN. A registry phone OTP depends on what the provider contract
  exposes (`QOREID_VERIFICATION_CONTRACT.md`), which nobody has confirmed;
  until it is, public NIN-only enrollment stays closed in production (DEP-1).
- **Waits on it.** DEP-1 (NIN-only enrollment in production), ENR-4 step 2
  (existence revealed only to the proven holder) and the contact step's
  non-disclosure, the registry-name display.

### N2. Enrollment assurance and HID recovery (ENR-2, ENR-3 Part B, ENR-3b, FAC-2/REG-1)

- **Questions.** (a) How does a phone-only patient recover a lost HID? Today
  the HID is shown only on screen at activation (ENR-2). (b) How long may the
  enrollment cookie re-display the HID after activation (ENR-3 Part B)? (c)
  How long may a verified contact wait before the password step (ENR-3b)? (d)
  Is facility-assisted registration in launch scope? It is unavailable in
  every deployed environment (FAC-2, REG-1).
- **Decided (owner defaults, 2026-10-13).**
  - (a) The HID is sent to the verified contact after the first activation,
    and a public HID reminder sends it again by SMS only when the phone and the
    NIN match the same active account. It follows in a later change (ENR-2);
    until then a phone-only patient must keep the HID shown at activation.
  - (b) 15 minutes. Every successful activation response expires the
    enrollment cookie; if that response is lost, the cookie can replay the
    activation, and `GET /current` show the HID, for 15 minutes after
    activation. After that both answer `404 ENROLLMENT_NOT_FOUND` without the
    HID, and so does the activation command (0085).
  - (c) 30 minutes. Activation with a contact proved more than 30 minutes
    earlier clears the proof and the contact, sends the enrollment back to the
    contact step and answers `409 ENROLLMENT_CONTACT_REVERIFY_REQUIRED`; the
    activation command refuses it as well (0085).
  - (d) Facility-assisted registration is out of launch scope (D17); walk-in
    patients self-enroll.
- **Implemented now.** D-Eminence/hid-system#50 expires the enrollment cookie
  at every sign-in, refresh and sign-out, and limits activation per
  enrollment. BRANCH:launch/identity-enrollment-gates implements (b) and (c)
  in Identity and in migration 0085, and caps QoreID lookups: each lookup of
  public enrollment is charged, before QoreID is called, to the client network
  (an IPv4 address or an IPv6 /64) at 5 an hour and 15 a day, and to a
  platform-wide cap of 200 a day (`PATIENT_ENROLLMENT_QOREID_*`); the owner
  sets the cap from the QoreID contract. A refusal is `429
  VERIFICATION_QUOTA_EXCEEDED` and is audited.
- **Risks.** (b) and (c) need Health-id handling of the new `409` (route it
  to the contact step). Without (a), a phone-only patient who loses the HID
  cannot reach the account. The per-network quota counts a carrier-grade NAT
  address as one network, so a busy mobile network can reach 15 lookups a day;
  the limits are environment values. The platform cap bounds cost, not
  availability: every lookup counts, whatever QoreID answers, so at the
  defaults 14 networks passing Turnstile can spend it with unregistered NINs
  and close enrollment starts that need a lookup for the rest of the day.
  Operations alert on `platform_day` denials (release checklist §10).

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

## 2. Other open decisions

| # | Decision | Proposed default | Risks | Waits on it |
| --- | --- | --- | --- | --- |
| D1 | Production workload issuer and key custody (DEP-4, ADR-047 Proposed, D-Eminence/hid-system#54 draft) | The staging mechanism with an independent production key, API, stage and `hid:production:` subjects; a key policy that denies `kms:Sign` to anyone but the issuer role | Same-account key custody; a single issuer for six services; the JWKS endpoint shares the stage throttle | Every service-to-service call in production |
| D2 | Behaviour during an issuer outage | Agent stays essential and keeps the `HEALTHY` start gate; decide restart policy with D4 | An outage longer than a token's lifetime takes every token task down | DEP-4 rollout |
| D3 | Edge protection for the issuer | A separate `POST /token` throttle and a WAF rate rule or private API, by ADR | — | DEP-4 rollout |
| D4 | Alert routing | Dashboards only until an alerting workflow exists (ADR-032 forbids an SNS topic without one) | Nothing pages anyone | Every mitigation that relies on an alarm |
| D5 | Malware scanner engine and credential (DOC-3, DEP-4-SCAN) | An in-account scanner role as a seventh issuer rule with subject `hid:<env>:document-scanner`, and a governed provisioning step for the `document_scanner` account | Until decided, no document becomes downloadable and no OCR job can start | Documents, OCR |
| D6 | Recovery and enrollment code guess budgets (REC-4, ENR-6) | 5 failures per 15 minutes per account or recipient, never per IP (the edge discards client IPs); no daily cap | A daily cap makes denial of recovery cheap | Implemented as the default in D-Eminence/hid-system#55 (recovery codes) and D-Eminence/hid-system#61 (enrollment contact codes); thresholds are environment values |
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
3. Run `scripts/staging-external-preflight.py` and confirm the field is
   present and in canonical 32-byte base64.
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

Before staging S1, as the RDS migration administrator: check
`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
try `GRANT SET ON PARAMETER plpgsql.variable_conflict`; run the role bootstrap
without superuser; rehearse 0001 to the latest migration and confirm OCR
claims, patient confirmation, scan events and job events work. If BYPASSRLS
is unavailable, ADR-041 becomes a launch blocker for documents, OCR and
Outreach.

### I4. Duplicate-membership data check (N5)

Read-only, as the migration administrator:

```sql
select account_id, facility_id, count(*)
from identity.staff_facility_memberships
where active and facility_id is not null and migration_hold_reason is null
group by 1, 2
having count(*) > 1;
```

### I5. Staging issuer acceptance (after D1 to D3)

Staging is not deployed. After redeploying it: admit the Identity image that
carries the agent; run `AWS_DEPLOYMENT_RUNBOOK.md` §7 (ES256, issuer,
subject, audience, 300-second lifetime, renewal about every 90 seconds,
refusal of a wrong audience, subject or signature); prove an administrator
cannot sign with the key; flood the JWKS endpoint from outside for 10 minutes
and confirm no renewal fails; deny one task role's invoke for 6 minutes and
observe task health.

### I6. Production issuer rollout (after D1, I5 and the production unlock)

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
| ENR-4 step 1, ENR-3 Part B, ENR-3b, IP-1 QoreID quota, CFG-PROD NIN-only refusal (enrollment gate, re-display and re-verify windows, lookup quota); FE-4 (enrollment availability read, registration-not-open answer) | BRANCH:launch/identity-enrollment-gates, migration 0085 (FE-4 adds none) | local branch (N1, N2); FE-4's Health-id follow-up open |
| DEP-4, DEP-4-RT (production workload tokens) | D-Eminence/hid-system#54, draft, ADR-047 Proposed | waits on D1 |
