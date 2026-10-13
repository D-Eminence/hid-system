# Phase 3 launch decisions and operator plans

Date: 2026-10-12. Status: open. D1, D2 and D3 were decided on 2026-10-13 with
the proposed owner defaults (ADR-047, D-Eminence/hid-system#54), D4 with
the owner policy defaults (ADR-053, D-Eminence/hid-system#66), and FE-HOST
(§1, ADR-052, D-Eminence/hid-system#67), N1 and N2 (ADR-048,
D-Eminence/hid-system#68), and N5 and the workforce part of D14
(ADR-049, D-Eminence/hid-system#70) with the owner's defaults,
and the facility a sign-in keeps (N5, E7; ADR-046 as ported in
D-Eminence/hid-system#73), and ENC-RETRACT-1, ENC-RETRACT-2 and ALLERGY-1
(ADR-056, D-Eminence/hid-system#74), and the launch module
permissions and patient access transparency (§1, ADR-058,
BRANCH:launch/launch-permission-withdrawal) with the owner's defaults,
and NO-MEMBERSHIP-SIGN-IN (§2, ADR-059, BRANCH:launch/identity-error-hardening)
with owner default (a);
nothing else in this document has been decided, and nothing has been deployed
or executed.

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
  staging profile): it does not start (D-Eminence/hid-system#68,
  CFG-PROD). The change that adds the holder step lifts that refusal; staging
  may run NIN-only enrollment for acceptance.
- **Implemented now (D-Eminence/hid-system#68), ENR-4 step 1.**
  Enrollment start checks the QoreID gate (`QOREID_ENABLED`,
  `QOREID_NIN_ONLY_ENROLLMENT_ENABLED` and the runtime pause of
  `qoreid`/`patient_nin`) before it reads whether the NIN is bound or pending,
  so while the gate is closed every NIN gets the same `503`. Once the gate is
  open the `409 NIN_ALREADY_REGISTERED` answer remains until step 2 ships;
  each probe of an unbound NIN then costs a QoreID lookup, bounded by the
  lookup quota (N2, below).
- **Implemented now (D-Eminence/hid-system#68), FE-4.** While
  the gate is closed by configuration, start answers its `503` with "New
  Health ID registration is not open yet. If you already have a Health ID,
  sign in." instead of the generic 5xx detail (the gateway on main still
  replaces it with `503 UPSTREAM_UNAVAILABLE` until ADR-055), and
  `GET /api/v1/identity/patient-enrollments/availability` answers
  `{ "open": boolean }` from the same gate, so Health-id can say so before it
  asks for a NIN (ADR-057; `INTERFACE_CONTRACT.md`). Health-id
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
  enrollment. D-Eminence/hid-system#68 implements (b) and (c)
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
  #50 on `auth.controller.ts` and `token.service.ts`. **Resolved:** ported as
  0089, after the launch migrations 0085-0088, in
  D-Eminence/hid-system#73 (below).
- **Data check.** Run I4 (§3) before deciding: whether such memberships exist.
- **Decided (2026-10-13, owner defaults: deny by default, least privilege;
  ADR-049).** One active, unheld membership per account and facility, not
  "pick the oldest": migration 0087
  (D-Eminence/hid-system#70) adds a unique partial index on
  `identity.staff_facility_memberships (account_id, facility_id)` where
  active, with a facility and no migration hold. If duplicates exist, 0087
  stops and changes nothing; I4 resolves them first (§3). Identity's staff
  context fails closed with `409 FACILITY_MEMBERSHIP_AMBIGUOUS` if two
  memberships of one facility are ever read, and orders by membership id
  last, which fixes every guard at once (they all read Identity's facility
  list). The legacy promotion refuses duplicates before it writes. Which
  facility a session family binds by default (#47) stays separate.
- **Decided, the facility a sign-in keeps (launch items C1 and FE-20,
  decision E7; 2026-10-13, owner defaults: deny by default, least privilege;
  ADR-046 as ported).** #47 is ported as migration 0089 in
  D-Eminence/hid-system#73 (merged, not deployed): the facility a staff
  sign-in chooses is kept per session family and reported on a reload or
  refresh as `facilitySelection: 'selected'`; it is only the default the
  session reports, and `X-Facility-ID` still authorizes every facility-scoped
  request. Every new staff sign-in (the session issued after the second
  factor, ADR-054) reports `default`, so the portal asks anyone who works at
  more than one facility at every sign-in, as Health-id `82b474e` already
  does; no Health-id change. A chosen facility the person no longer holds is
  `reselect` (asked again, never moved silently). A refresh whose stored
  choice cannot be read answers `200` with `facilitySelection: 'unavailable'`
  (asked, never reported as chosen) rather than #47's `503`, which the
  gateway's interception of upstream `5xx` (A8, removed by
  D-Eminence/hid-system#72) would have stripped of the rotated cookies, as any
  edge that replaces a `5xx` would. With 0087 a stored facility names one membership.
- **Risks.** One extra question at sign-in for multi-facility staff, and at a
  refresh while the selection store cannot be read. Release order: 0089, then
  the role bootstrap, then the Identity build (release checklist §5 step 22,
  §6); without the table every staff session read answers `503`.

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

### Account recovery and patient search (REC-AUDIENCE, REC-UNVERIFIED-CONTACT, REC-GOOGLE, SIGNIN-LOCKOUT, PSEARCH-1, REC-NOTIFY)

Implemented as proposed defaults in D-Eminence/hid-system#69
(migration 0086; release checklist §2, "Account recovery and patient search
hardening"; `INTERFACE_CONTRACT.md`; `DATABASE.md`). Each default is a
proposal; that change is the place to alter it.

- **Questions.** (a) Which accounts may each recovery page reach (REC-AUDIENCE)?
  (b) Where may a recovery code be sent (REC-UNVERIFIED-CONTACT)? (c) What
  happens to Google links when a password is recovered (REC-GOOGLE)? (d) Is
  the sign-in failure budget per identifier or per account (SIGNIN-LOCKOUT)?
  (e) What may a clinician's search by HID reveal, and how often (PSEARCH-1,
  ENUM-1), and which patient rows may a registration member read
  (DB-RLS-PATIENTS)? (f) What must a patient do again before approving
  access, and what is held after a recovery (REC-NOTIFY)?
- **Proposed defaults (implemented).**
  (a) The patient reset page and legacy activation reach only an account with
  an active patient record; the staff reset page only one with an active
  staff record; the administrator reset page only a platform administrator.
  Any other start is answered as an unknown identifier. An account that is
  both patient and staff recovers from either page.
  (b) A patient's code goes to the account email only once it is verified,
  else to the verified phone of the account's active public enrollment, else
  nowhere. Staff and administrator codes go to the provisioned work email.
  (c) A completed recovery revokes every external sign-in identity of the
  account (today Google links); the legacy importer's provenance record is not
  a sign-in and is kept. The revoked row stays, and the Google link commands
  (0059) refuse any subject that was ever linked, so the owner cannot link the
  same Google account again, only a different one.
  (d) Both: five failures within 15 minutes lock the identifier and, shared
  by its email and HID, the account, for 15 minutes; while the account is
  locked the correct password is refused too, with the same `401`.
  (e) Every refused lookup is one `404 PATIENT_NOT_AVAILABLE`; an access
  request for an unknown HID is answered like a recorded one; neither answer
  names a patient id, and the clinician's own request list names the patient
  only while a grant made from the request is active (otherwise a
  non-identifying `withheld-…` string, so Health-id's list keeps rendering). Budgets per actor and
  per facility: 60 and 600 refused lookups per 5 minutes (a lookup that
  returns a granted patient is not counted, FE-10), 20 and 200 access requests
  per 15 minutes (environment values). A registration member reads only
  patients linked to a case or candidate at its facility; duplicate checks go
  through two functions that return minimum fields.
  (f) Approving an access request needs a sign-in within 10 minutes, as the
  access PIN does. For 24 hours after any OTP recovery of the account,
  approvals, access-PIN set and emergency-contact add or update are refused
  (`403 PATIENT_RECENT_RECOVERY_HOLD`); denials, revocations, PIN removal and
  contact deactivation stay available so the owner can shut access.
- **Risks.**
  (a) An account with no active patient, staff or administrator record
  cannot recover by code from any page.
  (b) Imported legacy patients whose source never confirmed their email and
  who have no verified enrollment phone can no longer activate by code; the
  release checklist §10 counts them. They need an approved route (for
  example assisted verification) before launch. Facility-assisted (governed)
  enrollment, `POST /identity/registration-cases/:caseId/enroll`
  (`identity.enroll_registered_patient`, 0032), creates a `pending_reset`
  account whose email is not verified and that has no public enrollment
  phone, so its owner can never receive an activation or recovery code. It
  is off at launch (D17); enabling it needs an email verification step
  before activation.
  (c) After a recovery the patient cannot link the same Google account
  again, only a different one, until a later change lets the owner re-link a
  subject that the owner's own recovery revoked. Google sign-in is off at
  launch (D17).
  (d) Anyone who knows a patient's email or HID can keep the account locked,
  15 minutes at a time, as they already could per identifier; there is no
  per-IP budget because the edge discards client IPs (D6).
  (e) A busy facility can reach its facility budget; the values are
  environment settings. A clinician can still tell a known HID from their
  own request list (a recorded request appears there, without the patient
  id, and an unknown HID's does not) and from a repeated request (the
  pending request comes back), bounded by the budgets and audited. The
  candidate search still reads names and dates of birth across facilities
  for verified registry demographics, as registration did before.
  (f) A patient who has just recovered cannot approve access for 24 hours;
  clinicians use the access PIN the patient already set, or break-glass
  (when enabled).
- **Waits on it.** The owner notice of REC-NOTIFY: telling the owner, on every
  verified contact and in the inbox, that the password was changed. Identity
  offers each completed recovery to `ACCOUNT_RECOVERY_NOTICE_SINK` after
  commit; the notification route change binds a sink and sends the notice.
  Health-id copy and error handling for the new answers (release checklist
  §3). Before Google sign-in is enabled: a way to re-link a Google subject
  revoked by the owner's own recovery (risk (c)). Before facility-assisted
  enrollment is enabled: verifying the enrollment email before activation
  (risk (b)).

### Staff MFA (MFA-1, D14 MFA part)

Decided under the owner default "verified identity for sensitive
operations", and implemented in D-Eminence/hid-system#71 (migration 0088;
ADR-054; release checklist §2, "Staff MFA"; `INTERFACE_CONTRACT.md`, "Staff
sign-in with an authenticator"; `PHASE_4_STAGE_2A_BACKEND_SECURITY.md` §10).

- **Question.** Is staff MFA a launch gate, and for which staff?
- **Decision.** Yes, for every staff session that can reach patient data, with
  no permission or role allowlist. Staff sign-in is two-step like platform
  sign-in: the password yields only a challenge; the session comes after a
  TOTP code or a one-time recovery code. A first enrolment needs a fresh
  proof (a code emailed to the account address, or the provider enrollment
  activation that opened it), never the password alone; the factor records
  the proof, and only such a factor verifies a staff sign-in. A platform
  first enrolment (still trust on first use) is refused for an account with
  a staff membership, which enrols at staff sign-in; a factor enrolled at
  platform sign-in is refused at staff sign-in until a two-person reset. The
  email code goes to the account address without requiring it to be marked
  verified, because no staff flow verifies one. A staff session
  without live MFA assurance is refused everywhere (`403
  STAFF_MFA_REQUIRED`) and ended on refresh, so every existing staff session
  is invalidated at deploy. Google sign-in is for patients only. OTP password
  recovery keeps the authenticator; a lost authenticator is reset only by the
  two-person MFA reset, which now names staff targets.
- **Risks.** Every staff member signs in again at deploy and enrols on first
  sign-in; the Health-id staff portal must ship the new steps first (release
  checklist §3). For an account without a factor the mailbox alone is
  enough: staff password recovery and the enrolment code use the same
  address, and accounts provisioned without a password (0046, 0087) set their
  first one by that recovery. Mitigation at launch (release checklist P22):
  enrol existing clinical accounts before clinical roles are enabled, and
  review every enrolment that followed a recovery. Staff sign-in needs
  `MFA_SECRET_KEY_B64` (operator plan I1).
- **Open (needs a product and security decision).** A second enrolment
  channel that does not rest on the mailbox, for example a one-time code that
  the provisioning administrator hands over in person, so that an account
  without a factor is no longer as strong as its mailbox. It would extend the
  workforce provisioning commands (0087).
- **Waits on it.** Owner notices of enrolment, recovery-code use and an MFA
  reset (audited now; offered to `MFA_NOTICE_SINK`, delivered once a
  notification route exists). A notice to the account's mailbox cannot warn
  of that mailbox's compromise.

### Launch module permissions and patient access transparency (MOD-PERM-OCR-OUTREACH, FE-17, FE-15, UPLOADS-DEFAULT-ON, PSELF-RLS, CONSENT-GRANTEE, NOTIF-PIN-NOTICE, ACCESS-REQ-STALE)

Decided under the owner defaults (deny by default, least privilege, explicit
and informed consent, auditable actions) and implemented in
`BRANCH:launch/launch-permission-withdrawal` (migration 0091; ADR-058; release
checklist §2, "Launch module permissions"; `INTERFACE_CONTRACT.md`, "Launch
module set").

- **Question.** Should roles keep the permissions of modules that are off
  (Lab, Pharmacy, OCR, Outreach, break-glass, document uploads), and must an
  operator turn the launch controls off by hand?
- **Decision.** No role holds a permission of a module that is off: every
  `lab.*`, `pharmacy.*`, `ocr.*` and `outreach.*` permission,
  `identity.break-glass.write` and `ehr.document.write` are withdrawn from
  every role (reversing 0084's choice to keep the reads); Health-id 82b474e
  then hides those surfaces and disables emergency access. The launch
  database starts with `uploads_enabled`, `outreach_portal_enabled` and
  `break_glass_enabled` off where they are still as seeded, so P11 becomes a
  check, not a manual step. Re-enabling a module, on staging too, takes its
  own reviewed migration that grants its permissions again and changes the
  bootstrap's role assertions with it, because the bootstrap refuses any role
  holding a withdrawn permission. A ledger migration applies in every
  environment, so that migration is a production decision as well:
  production then stays closed for Lab, Pharmacy, OCR and Outreach by the
  gateway route switches and desired counts of 0 (and the Outreach control),
  and for uploads and break-glass only by their controls (and, for
  break-glass, the absent `emergency` purpose). No staging-only exception is
  made in the assertion: it would be a production bypass carried by
  configuration.
- **Also decided.** The patient-self database context is bound to the
  patient's own live session (PSELF-RLS). Patients see the requesting
  clinician's display name and role next to the facility when they approve
  and review access (CONSENT-GRANTEE), and the history says when it is
  truncated. The patient is told in the app inbox each time their PIN is used
  (NOTIF-PIN-NOTICE); SMS and email notices wait for an approved notification
  channel.
- **Deferred.** Pending access requests do not lapse yet (ACCESS-REQ-STALE,
  default 7 days when done): request creation reuses a pending request, so a
  lapse needs 0086's creation command, the approval and both lists changed
  together. Risk: a patient can approve an old request and grant current
  access; mitigated by the named clinician, the recent sign-in needed to
  approve, the expiry of an ended membership's pending requests (0087) and
  patient revocation.
- **Risks.** Lab and Pharmacy data become unreadable through Health-id until
  re-granted (a launch database holds none). Staff display names are shown
  to patients for requests and grants about them. The patient's request list
  answers `403` between 0091 and the role bootstrap that follows it. With
  0090 (ADR-056, D-Eminence/hid-system#74), which requires
  `ehr.document.write` to mark an encounter entered in error while it holds
  an initiated or uploaded document, no role can do so until uploads are
  re-enabled; cancelling such an encounter is unaffected. A database on which
  no upload was ever started, as the launch production database is expected
  to be, holds no such document; a staging database might.
- **Waits on it.** Enabling any of the off modules; a specific Health-id
  title for `PATIENT_ACCESS_PIN_USED` and showing the clinician's name
  (optional Health-id changes, release checklist §3).

## 2. Other open decisions

| # | Decision | Proposed default | Risks | Waits on it |
| --- | --- | --- | --- | --- |
| D1 | Production workload issuer and key custody (DEP-4, DEP-4-KEY; ADR-047 accepted 2026-10-13, D-Eminence/hid-system#54) | **Decided (default):** the staging mechanism with an independent production key, API, stage and `hid:production:` subjects; the key policy keeps the root statement and denies `kms:Sign` to every principal but the issuer role, to any algorithm but `ECDSA_SHA_256` and to any message type but `RAW`; receivers accept only ES256 tokens with `exp`, `iat` at most 300 s old and `token_use: workload`; no local-secret fallback | Same-account key custody (an administrator can still change the key policy or the function); a single issuer for six services; receivers trust a withdrawn key for up to 10 minutes | Every service-to-service call in production; deployment still needs I5 and I6 |
| D2 | Behaviour during an issuer outage (DEP-4-RES) | **Decided (default):** the agent is `essential: false` with an ECS container restart policy and keeps the `HEALTHY` start gate (ADR-047) | During an outage longer than a token's lifetime, service-to-service calls fail closed (OTP delivery, EHR records, Lab, Pharmacy, OCR, Outreach) while sign-in keeps working; nothing pages anyone until D4 | DEP-4 rollout |
| D3 | Edge protection for the issuer (DEP-4-DOS) | **Decided (default, deny by default):** separate method throttles for `POST /token` and the JWKS `GET`, a REGIONAL web ACL on the issuer stage that blocks every source except the VPC's NAT gateway Elastic IPs (none in staging sleep), and an agent that caches its verified JWKS by `kid` (ADR-047) | A future caller outside the VPC (such as a D5 scanner) must leave through NAT or be allowlisted by a reviewed change; per-request WAF charges during a flood | DEP-4 rollout |
| D4 | Alert routing | **Decided (owner policy default, ADR-053, D-Eminence/hid-system#66):** every production alarm notifies, on ALARM and on OK, an operator-created SNS topic `hid-<env>-operational-alerts` encrypted with a customer-managed KMS key and named by its exact ARN (synth input `HID_OPERATIONAL_ALARM_TOPIC_ARN`, required in production, in the stack's own account and region). New alarms: issuer Lambda errors and throttles, issuer stage `5XXError` and `4XXError` (429s count there), token renewal (`Workload token renewal unavailable`) and OTP `definitive_failure`. "Dashboards only" is rejected: the CDK defines no dashboard, so it would mean nobody is told | The operations owner must name the on-call recipients, and an operator must create the topic and confirm each subscription (release checklist P15, P16) before production. A stopped token agent and Identity's `notification_workload_token_unavailable` line still raise no alarm. The five enabled services' running-task alarms are in ALARM, and notify, while production runs zero tasks before the I6 scale-up (P20); the recipients are told beforehand | Every mitigation that relies on an alarm |
| D5 | Malware scanner engine and credential (DOC-3, DEP-4-SCAN) | An in-account scanner role as a seventh issuer rule with subject `hid:<env>:document-scanner`, and a governed provisioning step for the `document_scanner` account. The scanner posts its callback to ehr-api's private service name: the public gateway answers `/api/v1/ehr/documents/scan-events` with `404` (ADR-055, SCAN-EDGE). Switching uploads on also adds the documents bucket's S3 origin to the portal `connect-src` in the same release (ADR-055; I7) | Until decided, no document becomes downloadable and no OCR job can start | Documents, OCR |
| D6 | Recovery and enrollment code guess budgets (REC-4, ENR-6) | 5 failures per 15 minutes per account or recipient, never per IP (the budget holds whatever network a guess comes from; until D-Eminence/hid-system#65 the edge also discarded client IPs); no daily cap | A daily cap makes denial of recovery cheap | Implemented as the default in D-Eminence/hid-system#55 (recovery codes) and D-Eminence/hid-system#61 (enrollment contact codes); thresholds are environment values |
| D7 | Patient record release categories (PREC-1 Phase B) | Completed-encounter items only; never draft or entered in error; confirmed diagnoses only; documents only once a patient download route exists | Docs are silent | Phase B of the record summaries |
| D8 | Vital correction semantics (CLIN-1, VIT-1) | The current correction is the whole current set, as Health-id renders it | API clients that send partial corrections lose omitted values | Held out of D-Eminence/hid-system#52 |
| D9 | Break-glass detailed reads (PREC-4 scope, OCR-READ-PURPOSE) | The emergency summary returns only categories the reader may read (D-Eminence/hid-system#52); EHR document and OCR reads unchanged until decided together. Break-glass itself is off at launch: since 0091 (ADR-058, `BRANCH:launch/launch-permission-withdrawal`) no role holds `identity.break-glass.write` and `break_glass_enabled` starts off; re-enabling it is a reviewed migration with this decision, the `emergency` purpose and the control | The seeded clinical roles hold every read permission, so the summary stays wide in practice | Emergency summary narrowing |
| D10 | Pharmacy and Lab lifecycle after acceptance (CLIN-2-POLICY, CLIN-3b) | Strict version equality for dispensing (D-Eminence/hid-system#48); Lab refuses new accession and execution for cancelled or entered-in-error orders; released results stay | Stranded queue items: a changed prescription leaves its work item `accepted` and undispensable | Queue cleanup, re-acceptance |
| D11 | Lab result detail for clinicians | No "unreleased correction pending" flag (D-Eminence/hid-system#51) | Clinicians cannot see that a correction is coming | Result retraction API |
| D12 | OCR publication after an authorization lapse | Terminal, as today | — | — |
| D13 | Upload completion actor (DOC-1) | Only the uploader's account may complete an upload (implemented in D-Eminence/hid-system#59). Uploads are off at launch: since 0091 no role holds `ehr.document.write`, `uploads_enabled` starts off and completion also checks the control (ADR-058) | No delegated completion | Re-enabling uploads (D5, I7, and a reviewed migration granting `ehr.document.write` again, which applies to production too) |
| D14 | Workforce administration (WF-1, WF-2, MFA-1) | Decided for the workforce part on 2026-10-13 (ADR-049, D-Eminence/hid-system#70, migration 0087): clinical facility roles are granted only by platform-governed commands under the new `platform.workforce.manage` (`platform_super_admin` only), with step-up, `If-Match`, `Idempotency-Key` and a reason; a grant needs a current professional-credential attestation by another platform reviewer who is neither the target nor working at that facility (so not its `org_admin`); `org_admin` stays non-clinical and has no role-granting route; ending a membership revokes its roles and consent grants, expires its pending access requests and revokes the account's staff sessions; a role lapses with its attestation and is renewed by a new attestation and a second administrator's grant, never by the attestation alone. Facility self-service is deferred. **Staff MFA: decided, yes** (MFA-1, "Staff MFA" in §1, ADR-054, D-Eminence/hid-system#71, migration 0088): every staff session that can reach patient data is TOTP-verified, with no permission allowlist; a second enrolment channel (beyond the account mailbox) is open | An unenrolled staff account is as strong as its mailbox until it enrols. Which credential source counts (regulator registry or documented manual review) and who may review are product and legal decisions; until then the only method is documented manual review | Workforce management; the Health-id staff sign-in (release checklist §3) |
| D15 | Launch scope of EHR-to-Lab ordering and in-system result return | In scope (the EHR already sends orders) | If in scope, the Lab handoff is launch-blocking; it merged as D-Eminence/hid-system#56 | Lab handoff |
| NO-MEMBERSHIP-SIGN-IN | Staff sign-in of an account with no active facility membership (A10) | **Decided (owner default (a), deny by default and least privilege; ADR-059, BRANCH:launch/identity-error-hardening, no migration):** the right password of an active account that has a staff record or a facility membership, none of them eligible, is refused at the password step with `403 NO_ACTIVE_FACILITY_MEMBERSHIP` ("Ask your organization administrator for access"): no MFA challenge, no session, a denied `login_failed` session event, not counted as a failed sign-in (like any right password it ends the account's own failure window). An account with neither keeps the uniform `401`. A live session whose membership ends stays `401`. Option (b), a session that authorizes nothing, is not taken: it issues a token to an account with no workforce authority, and Health-id's "No facility assignment" screen has no sign-out | The `403` tells someone holding the password that the account exists and has a workforce record (no more than the right password already proves); Health-id `82b474e` shows the detail on sign-in, the dedicated screen is unused | Nothing |
| D16 | Health-id OCR publication retry | Persist the publication key per validation; offer Retry for retryable failures | Frontend change | OCR publication retry |
| IP-THRESHOLDS | Per-network limits now that they key on the real client network (A7) | **Decided (owner default, deny by default; ADR-055):** keep Identity's 5 recovery starts and 5 enrollment starts per 15 minutes per IPv4 address or IPv6 /64, and the WAF's 2,000 requests per 5 minutes per client network (an IPv4 address or IPv6 /64, `X-HID-Client-Network` from the Worker), at launch; if the `ip`-scope 429 rate or the WAF metric `hid-<env>-origin-rate` shows carrier-grade or facility NAT collisions, raise Identity's by configuration and the WAF's by a reviewed CDK change to `API_ORIGIN_CLIENT_RATE_LIMIT` (a code constant). Per-account and per-recipient budgets and Turnstile stay the primary guards | Patients behind a busy carrier NAT address, or clinicians behind one facility NAT, can be refused at peak; Identity logs no `ip`-scope 429 event yet, so a collision shows only in the WAF metric and support reports. Traffic spread over many client networks that passes the 50,000-per-5-minutes backstop through one Cloudflare egress address blocks every user behind it for the rest of the window (ADR-055) | Identity limits, WAF rate rule |
| ENC-RETRACT-1 | Who may cancel or retract an encounter's records through the encounter | **Decided (owner policy default, least privilege, ADR-056, D-Eminence/hid-system#74):** only a member holding the write permission of every kind of record the close changes (`ehr.note.write`, `ehr.diagnosis.write`, `ehr.vital.write`, `ehr.prescription.write`, `ehr.lab-request.write`, `ehr.document.write`); an encounter holding none of them needs `ehr.encounter.write` alone. Refused with `403 ENCOUNTER_RETRACTION_NOT_PERMITTED` and a fixed detail (the missing permissions go to the audit row only, so the refusal does not reveal which kinds of record the encounter holds), nothing written, audited; the database refuses it too (0090). Cancelling changes only open orders, so it needs only the order write permissions; retracting needs every kind's. Records already entered in error and cancelled orders block nothing. The proposed `ehr.encounter.retract` permission was not taken | A nurse or receptionist who opened an encounter on the wrong patient must ask a doctor or clinician to retract it once it holds a diagnosis or an open or completed prescription, and to cancel it once it holds an open prescription. No role holds `ehr.lab-request.write` (0084), so an encounter holding an open (or, to retract, completed) lab request cannot be closed until Lab ordering returns. The rule follows record kinds, not authorship | Health-id offering the actions by permission (frontend follow-up) |
| ENC-RETRACT-2 | Retraction of wrong-patient vitals, completed orders and documents | **Decided (owner policy default, ADR-056, D-Eminence/hid-system#74):** completed orders, final vitals and linked documents of an encounter entered in error become `entered_in_error` with it; a vital can be entered in error on its own (versioned, audited, with a reason) and then takes no change or correction; a retracted document takes no change, so it is never served again; the database enforces both (0090); the emergency summary leaves retracted vitals out; nothing is deleted | Health-id `82b474e` shows a retracted vital without a marker (frontend follow-up) | — |
| ALLERGY-1 | Allergies at launch | **Decided (owner policy default, ADR-056, D-Eminence/hid-system#74): allergies are not recorded at launch.** No allergy table, route or prescribing check; a clinician records an allergy as a diagnosis (ICD-10 `Z88.x`) or in a note. `DATABASE.md` §7 now lists only implemented tables | Prescribers get no structured allergy check: a prescription for a drug the patient is allergic to is not flagged | Structured allergy capture (table with forced row-level security, versioning, the open-encounter guard, routes and audit; effort L) and Health-id saying so on the prescription form |

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
select account_id, facility_id, count(*),
  array_agg(id order by id) as membership_ids,
  array_agg(membership_role || '/' || app_role order by id) as membership_roles
from identity.staff_facility_memberships
where active and facility_id is not null and migration_hold_reason is null
group by 1, 2
having count(*) > 1;
```

Migration 0087 (N5) refuses to apply while this returns rows. For each row,
the facility confirms which membership to keep; the extras are deactivated
(`active = false`) by a reviewed, audited change, never deleted, and their
consent grants are never moved to the kept membership (that would change whom
a patient's consent covers; those patients consent again). Then apply 0087.

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
`scan_started` then `clean`, `rejected` or `failed` per object version to
ehr-api's private service name (the public gateway refuses the callback,
ADR-055); in the same reviewed release that switches uploads on, add the
documents bucket's exact S3 origin (`https://<bucket>.s3.<region>.amazonaws.com`)
to the portal `connect-src` of `hid-web` and `hid-admin`
(`infra/cloudflare/src/frontend-worker.mjs`): Health-id `PUT`s the file
straight to the presigned URL, which the launch policy blocks (ADR-055); in
staging, a PDF uploads with no CSP violation, becomes downloadable and can
start OCR, and an EICAR file is refused.

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
| ENR-4 step 1, ENR-3 Part B, ENR-3b, IP-1 QoreID quota, CFG-PROD NIN-only refusal (enrollment gate, re-display and re-verify windows, lookup quota); FE-4 (enrollment availability read, registration-not-open answer) | D-Eminence/hid-system#68, migration 0085 (FE-4 adds none) | merged to `main` 2026-10-13, not deployed (N1, N2); FE-4's Health-id follow-up open |
| DEP-4, DEP-4-RT, DEP-4-KEY, DEP-4-DOS, DEP-4-RES (production workload tokens and issuer hardening) | D-Eminence/hid-system#54, ADR-047 accepted (D1-D3) | ready for review; deployment waits on I5 and I6 |
| REC-AUDIENCE, REC-UNVERIFIED-CONTACT, REC-GOOGLE (database part), SIGNIN-LOCKOUT, PSEARCH-1 (with ENUM-1 and DB-RLS-PATIENTS), REC-NOTIFY (recent sign-in and recovery hold) | D-Eminence/hid-system#69, migration 0086 | merged to `main` 2026-10-13, not deployed; REC-NOTIFY owner notice waits on the notification route; Health-id changes listed in the release checklist §3 |
| WF-1 (no governed way to provision clinicians), N5 (two memberships at one facility) | D-Eminence/hid-system#70, migration 0087, ADR-049 | merged to `main` 2026-10-13, not deployed (D14 workforce part, N5) |
| MFA-1 (staff sessions without MFA; D14 MFA part) | D-Eminence/hid-system#71, migration 0088, ADR-054 | merged to `main` 2026-10-13, not deployed; owner notices wait on the notification route; Health-id staff and platform sign-in changes listed in the release checklist §3; release checklist P22 (enrolment before clinical roles, review of enrolments after a recovery) is an operator gate; a second enrolment channel is an open decision |
| WAF-CRS-BODY (long clinical notes refused by the WAF's 8 KB body rule), A7 WAF part (rate limit per Cloudflare egress address), A8 (gateway replaced upstream 5xx), D6 (no CSP or HSTS on the portal hosts), D7 (query strings in the gateway access log), SCAN-EDGE/EDGE-DOCS (scanner callback public) | D-Eminence/hid-system#72, ADR-055 | merged to `main` 2026-10-13, not deployed; IP-THRESHOLDS decided above; staging checks S4p |
| C1, FE-20 (a clinician's chosen facility was not kept across a reload; D-Eminence/hid-system#47 unmerged and numbered 0080) | D-Eminence/hid-system#73, migration 0089, ADR-046 (as ported) | merged to `main` 2026-10-13, not deployed (N5, E7); D-Eminence/hid-system#47 stays open with its own owner; no Health-id change |
| ENC-RETRACT-1 (launch blocker), ENC-RETRACT-2, RX-FINAL, ORDER-CLOSED-EDIT, A9-EHR, A17-EHR-AUDIT, ALLERGY-1 (EHR retraction integrity) | D-Eminence/hid-system#74, migration 0090, ADR-056 | local only; not pushed |
| MOD-PERM-OCR-OUTREACH, FE-17, FE-15, UPLOADS-DEFAULT-ON, PSELF-RLS, CONSENT-GRANTEE, NOTIF-PIN-NOTICE (launch module permissions, launch controls, patient-self binding, named grantee, PIN-use notice); ACCESS-REQ-STALE deferred | `BRANCH:launch/launch-permission-withdrawal`, migration 0091, ADR-058 | local commits, not pushed; numbered after 0089 and 0090 on other branches (the release contract reports the gap until they land); optional Health-id changes listed in the release checklist §3 |
| A4, A5, A6, A9, A10, A16, A18, A19, A24, LOGIN-DETAIL-ORACLE (faults answered as sign-outs, workload refusals relayed as the user's, refresh clearing cookies on a fault, patient-only routes failing their audit, no-membership sign-in, administrators' clinical sessions exempt from maintenance, a write decision on a reported read, `500` for a disallowed origin, names and reasons in admin URLs, sign-in details confirming a password) | `BRANCH:launch/identity-error-hardening`, no migration, ADR-059 | local commits, not pushed (NO-MEMBERSHIP-SIGN-IN decided); the workload refusal mapping of Lab, Pharmacy, OCR and Outreach, the OCR guard `catch` (all off at launch), and the Health-id move to the `POST` admin search and export are follow-ups |
