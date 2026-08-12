# HID Current-State Assessment

| Field | Value |
|---|---|
| Status | **Assessment complete for the available source snapshot; live-environment discovery remains required** |
| Assessment date | 2026-07-30 |
| Scope | Root repository, EHR source, HID Identity/retired hosted identity backend source, HID Migrate, Outreach, build/deployment configuration, and migration history |
| Change policy | Read-only assessment of legacy applications; no legacy application or database code was changed |

This document records what exists today and what may safely influence the AWS
target architecture. It is not proof that a corresponding hosted environment is
configured identically, that migrations were applied in order, or that the
current applications are production-safe.

## 1. Assessment method and evidence limits

The full workspace tree was inventoried. All material first-party application
source, architecture and operations documentation, package/build configuration,
retired hosted identity backend function boundaries, and migration history were reviewed. Generated
build output, installed dependencies, binary assets, archives, and secret values
were deliberately excluded because they are not authoritative source and
reviewing secret contents would create unnecessary exposure.

At assessment time, the available source had an important custody limitation:

- `ehr/` and `identity/` were untracked by the root repository.
- `identity/hid-unified-package/` was a nested Git repository at commit
  `eb6214f` on branch `codex/auth-api-resilience`.
- No equivalent source revision was found for `ehr/`.

This repository-structure issue was remediated on 2026-08-04. The EHR,
Identity, API, and documentation trees now share the root repository boundary.
The former Identity branch and tag tips are retained under namespaced legacy
refs in the root repository, while its current working tree is maintained at
`identity/hid-unified-package/`.

Static source can establish design and implementation risk. It cannot establish
the live retired hosted identity backend PostgreSQL version, applied migration set, policies and grants,
object counts, data quality, extensions, database drift, active secrets,
external provider configuration, traffic, availability, or audit completeness.
Those require read-only live-environment discovery under an approved access
process.

## 2. Executive conclusion

The workspace contains two materially different systems:

1. **HID Identity** is a substantial React/Vite and retired hosted identity backend application with
   patient and workforce accounts, access grants, records, administration,
   Outreach, and a document digitization subsystem called HID Migrate. Its
   migrations and workflow definitions are useful source evidence. It is not a
   safe target architecture to lift unchanged.
2. **HID EHR** is a UI prototype whose own documentation says its state and data
   contracts are scaffolded. Its active source mixes fixtures, direct retired hosted identity backend
   queries, a mock client that can report success, and client-side role and
   emergency-access state. It must be treated as a design prototype only.

There is currently no NestJS core API, Next.js patient application, Python OCR
service, AWS infrastructure definition, RDS deployment, durable message
boundary, or production test suite in this workspace.

The most consequential finding is an identity semantic conflict:

- The current technical patient primary key is `hid_patients.id UUID`.
- The user-facing `hid_code TEXT` is unique but is not the primary key.
- Existing clinical, access, document, and migration rows reference the UUID as
  `patient_id`.
- Product language often calls the shorter `HID-XXXXXX` value the HID number.

The target cannot honestly claim “HID is the primary key everywhere” until this
is resolved by an approved identity ADR. The recommended resolution is in
section 6. The proposed replacement model and physical constraints are in the
[target platform architecture](../ARCHITECTURE.md) and the current
[database architecture](../DATABASE.md).

## 3. Current system inventory

### 3.1 HID Identity application

The nested repository describes a React/Vite application backed by retired hosted identity backend
PostgreSQL, Storage, Auth, and Edge Functions, hosted through Vercel with
Cloudflare, Brevo, Sentry, PostHog, and Turnstile integrations
([README](../../identity/hid-unified-package/README.md)).

The source migration history currently contains:

- 66 SQL migration files;
- 75 distinct application table definitions across the migration history;
- 89 distinct PostgreSQL function names across the migration history;
- 59 Edge Function source directories plus a shared function library; and
- domains covering patient identity, accounts, organizations/facilities,
  workforce membership, access requests and grants, medical record
  versions/files, notifications, audit, Outreach, mobile laboratory data,
  vaccination data, subscriptions/billing, OCR/document migration, and AI
  configuration.

These counts describe source artifacts, not confirmed live objects.

The current backend is a retired hosted identity backend-centered application boundary:

- browser code uses retired hosted identity backend Auth and, for some paths, direct table operations;
- Edge Functions implement privileged workflows with service-role access;
- PostgreSQL functions and RLS implement a significant part of business
  authorization;
- retired hosted identity backend Storage holds record and migration objects; and
- retired hosted identity backend Realtime publications support selected UI updates.

This is operationally a distributed database-function/Edge-Function application,
not the proposed NestJS modular core.

### 3.2 retired hosted identity backend platform dependencies

The tracked retired hosted identity backend configuration exposes `public`, `storage`, and
`graphql_public` through the data API and configures a 15-minute JWT lifetime
([`config.toml`](../../identity/hid-unified-package/retired_identity_backend/config.toml)).
Authentication includes email/password, Google identity, password recovery,
email OTP, TOTP MFA, admin user operations, PostgreSQL Auth hooks, and an Edge
Function email hook.

Two private Storage buckets are declared:

- `medical-record-files`, with a 10 MiB limit; and
- `migration-source-files`, with a 50 MiB limit.

Access is mediated by service-role-created signed operations rather than
tracked `storage.objects` policies. The browser uploads migration-source objects
directly with a signed token.

Realtime publishes changes from seven PHI-bearing tables: access requests,
access grants, audit events, notifications, medical records, record versions,
and record files. The browser subscribes directly to those database changes.
No tracked scheduled job was found.

The OCR worker polls an Edge Function configured without retired hosted identity backend JWT
verification and authenticates with a shared worker token. This must become an
IAM-authenticated SQS worker boundary; the shared token and direct database
change feed are not carried forward.

### 3.3 HID Migrate

“HID Migrate” is the existing document capture, OCR, classification,
validation, matching, QA, import, correction, cost, and AI-provider workflow. It
is not the retired hosted identity backend-to-AWS platform migration.

Its local design has valuable workflow states, custody evidence, immutable
source hashes, review roles, and import concepts. Its own implementation status
states that SQL migrations and tests have not run against an approved
environment, workers have not been exercised against a live provider/queue, no
staging or production environment was changed, and UAT, penetration, load,
device, restore, vendor, and governance evidence remains pending
([implementation status](../../identity/hid-unified-package/HID_MIGRATE_IMPLEMENTATION_STATUS.md)).

The target documentation will call this bounded context **Document
Digitization/OCR** and reserve **platform migration** for retired hosted identity backend-to-AWS
cutover work.

### 3.4 Outreach

Outreach already has campaigns, workers, encounters, referrals, invites, OTP,
role policies, authentication logs, and frontend API paths. It is coupled to
the current retired hosted identity backend account, table, and policy model. The domain concepts can
be migrated, but contact resolution, consent/opt-out, message minimization,
provider callbacks, delivery idempotency, and external-provider isolation must
be rebuilt against the unified identity and authorization boundary.

### 3.5 EHR application

The EHR repository describes itself as a clickable, in-memory prototype and
states that its record shapes are not a backend contract
([README](../../ehr/README.md), [architecture](../../ehr/ARCHITECTURE.md)).

The active source is internally inconsistent with that documentation:

- `src/main.tsx` loads `ehr-app.jsx`.
- `ehr-app.jsx` holds active role, configuration, patient grant, and
  break-glass state in the browser.
- `src/components/clinical/PatientsModule.tsx` selects all rows from a legacy
  `patients` table.
- `src/components/clinical/RegistrationModule.tsx` inserts directly into that
  table and hardcodes an assigned provider.
- `src/ehr-ops.jsx` directly reads legacy lab, radiology, drug, billing,
  hospital metric, and staff tables.
- `src/retired_identity_backendClient.ts` substitutes a mock client when environment variables
  are absent, including successful-looking authentication and data operations.
- fixture modules contain patient, clinical, provider, facility, and dashboard
  data consumed by active views.

The interface contract first states that the app performs no network requests,
then retains a detailed retired hosted identity backend contract and claims files are absent that are
present elsewhere in the workspace
([interface contract](../../ehr/INTERFACE_CONTRACT.md)). It is not an
authoritative integration contract.

The EHR is therefore suitable for workflow discovery, information architecture,
and visual reuse only. No fixture, mock fallback, direct query, client-side role
selection, or current data shape is production logic.

### 3.6 Laboratory and Pharmacy

The workspace contains laboratory and pharmacy prototype views and some
retired hosted identity backend tables for mobile lab samples, commercial products, and prices. It
does not contain a production laboratory information system with accessioning,
specimen custody, analyzer integration, result verification/amendment, critical
result acknowledgement, or quality-control evidence.

It also does not contain a production pharmacy system with prescribing versus
dispensing separation, lot/expiry inventory, append-only stock movement,
reconciliation, recalls, or controlled-drug governance.

Lab needs a real bounded context in the first target release. Pharmacy remains
planned until jurisdiction and workflow requirements are approved.

### 3.7 Build, test, and deployment evidence

The Identity CI installs dependencies, runs a dependency audit, performs a
static HID Migrate contract check, type-checks only the Migrate/AI Edge
Functions, and builds the frontend
([CI workflow](../../identity/hid-unified-package/.github/workflows/ci.yml)).
The package has no unit or integration `test` script. A separate static API
response verifier exists but is not called by CI.

The EHR package exposes only development, build, and preview scripts. It has no
test, security, database, or deployment pipeline in the available source.

There is no evidence here of:

- migration tests against a clean and upgraded PostgreSQL database;
- authorization matrix or cross-tenant negative tests;
- patient-match/merge/split safety tests;
- durable audit failure tests;
- clinical state-machine tests;
- end-to-end workflows;
- backup/restore or disaster-recovery drills;
- penetration or load testing; or
- AWS infrastructure validation.

## 4. Material findings and risk register

Severity reflects patient safety, privacy, integrity, or migration risk. It does
not assert that a vulnerable code path is reachable in a particular live
deployment; that must be verified. IDs are stable evidence references, not
priority or sort order.

| ID | Severity | Finding | Evidence | Required disposition |
|---|---|---|---|---|
| HID-01 | **Blocker** | Patient creation is account-bound and can issue a new HID for each authenticated account without a master-patient match/adjudication workflow. A person using another contact can become a duplicate. | `hid_patients.auth_user_id` and `user_profile_id` are `NOT NULL UNIQUE` in [`20260407130000_secure_backend_foundation.sql`](../../identity/hid-unified-package/retired_identity_backend/migrations/20260407130000_secure_backend_foundation.sql); the current registration function inserts a new patient in [`20260723010000_defer_google_patient_registration.sql`](../../identity/hid-unified-package/retired_identity_backend/migrations/20260723010000_defer_google_patient_registration.sql). | Decouple identity from login; put every issuance behind deterministic search plus governed candidate adjudication. |
| HID-02 | **Blocker** | The public “HID” and actual database primary key have different meanings. | `hid_patients.id UUID PRIMARY KEY` and `hid_code TEXT UNIQUE`; dependent rows reference `patient_id UUID` in the foundation migration. | Approve the identity-key ADR before target DDL or migration mapping. |
| HID-03 | **Blocker** | A permanent-account purge disables the audit immutability trigger and deletes audit, health events, grants, requests, medical records, identifiers, the patient, and the auth user. For staff it can delete organization-wide audit events and a whole record if that staff member authored any version. A later guard requires soft deletion first but preserves the destructive behavior. | [`20260723000000_add_controlled_permanent_account_purge.sql`](../../identity/hid-unified-package/retired_identity_backend/migrations/20260723000000_add_controlled_permanent_account_purge.sql) and [`20260724140000_enforce_soft_delete_before_permanent_purge.sql`](../../identity/hid-unified-package/retired_identity_backend/migrations/20260724140000_enforce_soft_delete_before_permanent_purge.sql). | Disable production use pending retention/legal policy; migrate clinical/audit history as retained evidence; replace erasure with approved de-identification or record-class workflow. |
| HID-04 | **Blocker** | Some sensitive reads/exports continue when semantic audit insertion fails. | The admin export logs a warning and returns the file in [`admin-user-export/index.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/admin-user-export/index.ts); patient record access also logs an audit warning and continues in [`patients-records/index.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/patients-records/index.ts). | Sensitive operations must require a durable primary audit commit; archive delivery can be asynchronous and monitored. |
| HID-29 | **Blocker** | The source likely permits whole-row self-update privilege escalation if live table grants match normal retired hosted identity backend browser access. A patient profile can change `app_role`, `mfa_required`, and account state; a staff row can change role, verification, and active state. Privileged Edge Functions trust these fields. | Whole-row self-update policies in the foundation migration and role loading in [`_shared/auth.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/_shared/auth.ts). | Immediately inspect live table/column ACLs and attempt adversarial tests; revoke browser updates to privileged columns and move changes behind audited commands. |
| HID-30 | **Blocker** | A tracked `SECURITY DEFINER` share activation helper accepts caller-supplied patient, staff, membership, permission, and duration records without internal caller validation, and no tracked execute revocation was found. | `hid_activate_share` in [`20260613150000_share_invites.sql`](../../identity/hid-unified-package/retired_identity_backend/migrations/20260613150000_share_invites.sql). | Verify live ACLs immediately; revoke direct execution and rebuild share/grant issuance as a narrow authorized server transaction. |
| HID-31 | **Blocker** | Outreach permits broad self-created campaigns/worker roles and whole-row worker self-update, while invite codes are publicly readable. Its signup stores the submitted password in base64 inside OTP metadata. | [`20260530120000_outreach_self_signup.sql`](../../identity/hid-unified-package/retired_identity_backend/migrations/20260530120000_outreach_self_signup.sql), [`20260602171000_purge_screenshot_users_and_fix_outreach_rls.sql`](../../identity/hid-unified-package/retired_identity_backend/migrations/20260602171000_purge_screenshot_users_and_fix_outreach_rls.sql), and [`outreach-signup/index.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/outreach-signup/index.ts). | Suspend unsafe signup/invite paths, remove stored passwords, rotate affected credentials, verify campaign isolation, and rebuild Outreach authorization. |
| HID-32 | **Blocker** | Patient contact update triggers delete all identifier rows and recreate only HID/phone/email, which can erase later-added hospital and legacy identifiers. It also marks self-supplied contacts verified without re-verification. | `hid_refresh_patient_identifiers` in the foundation migration and the later identifier expansion in [`20260721143000_migrate_phase_8_patient_matching.sql`](../../identity/hid-unified-package/retired_identity_backend/migrations/20260721143000_migrate_phase_8_patient_matching.sql). | Stop destructive refresh, recover/compare identifier history, version bindings independently, and require proof before verified state. |
| HID-21 | **Blocker** | OTP and record-upload signing code has hardcoded development-secret fallbacks when production variables are absent; legacy Outreach signup repeats the OTP fallback. | [`_shared/otp.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/_shared/otp.ts), [`_shared/upload-token.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/_shared/upload-token.ts), and [`outreach-signup/index.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/outreach-signup/index.ts). | Verify deployed secrets and affected token windows; production must fail startup on missing secrets and rotate all related keys. |
| HID-05 | **Blocker** | EHR production behavior can silently fall back to a success-looking mock, while authorization, role choice, grants, and break-glass are browser state. | [`retired_identity_backendClient.ts`](../../ehr/src/retired_identity_backendClient.ts) and [`ehr-app.jsx`](../../ehr/src/ehr-app.jsx). | Quarantine as prototype; integrate only through authenticated, authorized, audited server APIs. |
| HID-06 | **High** | Current grant lookup proves user, patient, status, time, and scope but not the grant membership's current active state, tenant/facility scope, care relationship, purpose, credential, or resource sensitivity. | `hid_has_active_grant` in the foundation migration. | Central policy decision with tenant/facility/relationship/purpose/legal-basis inputs, plus RLS defense in depth. |
| HID-07 | **High** | A patient-record RPC serializes the entire patient row and record/file rows with `to_jsonb`, which prevents field-level minimum-necessary control. | `hid_get_patient_records` in the foundation migration. | Introduce explicit response DTO/projection per role, action, purpose, and resource. |
| HID-08 | **High** | Patient identifiers, including normalized phone and email, are stored as directly searchable raw/plaintext values. | `hid_patient_identifiers` and `hid_refresh_patient_identifiers` in the foundation migration. | Use encrypted values plus versioned keyed HMAC lookup; isolate PII privileges. |
| HID-09 | **High** | Patient demographics and clinical-summary fields can be directly overwritten in the browser without an immutable identity version, expected-version check, or atomic semantic audit. | `updateMyPatientProfile` in [`src/lib/hidApi.ts`](../../identity/hid-unified-package/src/lib/hidApi.ts). | Server command, validation, compare-and-swap, immutable version, provenance, audit, and outbox in one transaction. |
| HID-10 | **High** | Break-glass defaults to enabled for doctor, nurse, lab, pharmacist, and admin roles. The Edge Function checks the mutable role policy but does not establish a care role or other clinical eligibility. | [`20260526113000_admin_controls_and_staff_rbac.sql`](../../identity/hid-unified-package/retired_identity_backend/migrations/20260526113000_admin_controls_and_staff_rbac.sql) and [`break-glass/index.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/break-glass/index.ts). | Default deny; approved clinical roles only, narrow data scope, short expiry, reason, step-up authentication, alerts, and retrospective review. |
| HID-11 | **High** | Existing HID generation uses six calls to PostgreSQL `random()` over a short alphabet and treats uniqueness retry as the main control. | `hid_generate_hid_code` in the foundation migration. | Preserve existing codes as aliases; issue canonical opaque keys with a cryptographically appropriate generator. Display-code issuance needs a separate namespace/check-digit ADR. |
| HID-12 | **High** | A legacy repair script stores password hashes and data URLs in application tables and ends by disabling RLS on legacy staff, request, and notification tables. | [`retired_identity_backend/fix-schema.sql`](../../identity/hid-unified-package/retired_identity_backend/fix-schema.sql). | Determine whether any of this exists live; quarantine or transform it and never run the script against the target. |
| HID-13 | **High** | The EHR makes direct broad selects/inserts against legacy tables and uses hardcoded clinical/provider values. | [`PatientsModule.tsx`](../../ehr/src/components/clinical/PatientsModule.tsx), [`RegistrationModule.tsx`](../../ehr/src/components/clinical/RegistrationModule.tsx), and [`ehr-ops.jsx`](../../ehr/src/ehr-ops.jsx). | Retain UI requirements only; replace every path with typed platform APIs and explicit states. |
| HID-14 | **High** | The source lacks adequate automated clinical, identity, authorization, migration, and security test evidence. | Identity and EHR `package.json` files and Identity CI. | Establish test pyramids and deployment gates before production traffic. |
| HID-15 | **High** | Repository documentation reports production repair/schema drift and conflicting EHR access models. | [`retired_identity_backend/PRODUCTION_REPAIR.md`](../../identity/hid-unified-package/retired_identity_backend/PRODUCTION_REPAIR.md), EHR architecture, interface contract, and decision log. | Treat source DDL as hypotheses; introspect live state and have clinical/product owners resolve contradictions. |
| HID-16 | **High** | External hosting, CDN/bot, email, analytics, error reporting, and retired hosted identity backend services receive or may observe regulated traffic/data, but their target disposition is undecided. | Identity README and runtime configuration references. | Inventory PHI/metadata flows, contracts, region, retention, subprocessors, and replace/approve each dependency. |
| HID-17 | **High** | Tracked migrations enable but never `FORCE` RLS, and multiple `SECURITY DEFINER` helper functions have no tracked `PUBLIC` execute revocation or internal authorization. Candidate functions can resolve patient identifiers, rebuild identifiers, create notifications, insert caller-described audit events, or activate shares. | Foundation migration functions `hid_resolve_patient_identifier`, `hid_refresh_patient_identifiers`, `hid_create_notification`, and `hid_log_audit_event`, plus `hid_activate_share`. PostgreSQL grants new functions `PUBLIC` execute by default unless it is revoked ([official guidance](https://www.postgresql.org/docs/current/sql-createfunction.html)). | Verify live ACLs immediately; revoke public execution, expose only narrow commands, remove owner/BYPASSRLS runtime paths, and use `FORCE ROW LEVEL SECURITY` in the target. |
| HID-18 | **High** | The EHR lets a user choose a fixture role before login, switch among facility-enabled roles afterward, and explicitly skips session enforcement. Logout only clears local state. | [`ehr-auth.jsx`](../../ehr/src/ehr-auth.jsx), [`ehr-shell.jsx`](../../ehr/src/ehr-shell.jsx), and [`ehr-app.jsx`](../../ehr/src/ehr-app.jsx). | Never deploy; derive roles only from verified server-side membership and assurance. |
| HID-19 | **High** | EHR registration creates a subsystem-owned patient with empty HID/MRN, raw NIN, and no identity match, while pharmacy sales store patient name rather than HID. | [`RegistrationModule.tsx`](../../ehr/src/components/clinical/RegistrationModule.tsx) and [`ehr-ops.jsx`](../../ehr/src/ehr-ops.jsx). | Reject these rows as a target model; reconcile any live legacy data to Identity and quarantine ambiguity. |
| HID-20 | **High** | Active EHR consultation views can attach the same global fixture allergies/problems to every selected patient, and fixture shape mismatches can crash consultation. | [`hospital-consult.jsx`](../../ehr/src/hospital-consult.jsx), [`hospital-data.jsx`](../../ehr/src/hospital-data.jsx), and [`ehr-data.jsx`](../../ehr/src/ehr-data.jsx). | Treat all EHR clinical fixtures as non-data; rebuild and clinically validate patient-scoped read models. |
| HID-22 | **High** | The OCR worker endpoint disables retired hosted identity backend JWT verification and uses a shared bearer token. It can return decrypted AI provider credentials to the token holder. | [`config.toml`](../../identity/hid-unified-package/retired_identity_backend/config.toml) and [`migration-worker-jobs/index.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/migration-worker-jobs/index.ts). | Replace with private worker networking, IAM task roles, Secrets Manager, constrained egress, and no credential-returning API. |
| HID-23 | **High** | Permanent account deletion removes stored objects before the database purge, so a later database failure can leave an irreversible partial deletion. | [`admin-user-management/index.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/admin-user-management/index.ts). | Freeze this flow; use retention-governed orchestration, durable state, legal-hold checks, and compensatable sequencing. |
| HID-24 | **High** | Current transactional email templates can send patient name, HID code, hospital/provider, and record-access context to Brevo. | [`_shared/notifications.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/_shared/notifications.ts). | Minimize messages to generic notices and approve the provider, contract, region, retention, and subprocessor flow before use. |
| HID-25 | **High** | Outreach stores `patient_hid` and `provisional_patient_id` as free text, creating another path for provisional/shadow identity. | [`20260501120000_create_outreach_module.sql`](../../identity/hid-unified-package/retired_identity_backend/migrations/20260501120000_create_outreach_module.sql). | Resolve every enrollment/referral through Identity; no Outreach-owned patient or provisional identifier in the target. |
| HID-33 | **High** | MFA enforcement blocks only when an enrolled factor advertises `nextLevel=aal2`; an MFA-required privileged account without an enrolled factor can proceed. | [`_shared/auth.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/_shared/auth.ts). | Require enrolled phishing-resistant/approved MFA for privileged activation and deny when required assurance cannot be proven. |
| HID-34 | **High** | A 4-8 digit patient access PIN can create a long-lived write grant, but the source has no PIN failure ledger, lockout, actor/IP rate limit, or step-up authentication. | [`20260413113000_access_pin_and_secure_identity_helpers.sql`](../../identity/hid-unified-package/retired_identity_backend/migrations/20260413113000_access_pin_and_secure_identity_helpers.sql) and [`access-request-create/index.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/access-request-create/index.ts). | Do not migrate PIN access as designed; require approved proofing, attempt controls, narrow scope, short expiry, and audit/alerts. |
| HID-35 | **High** | Medical and migration file completion trusts client metadata or object-name existence rather than independently checking bytes, signature, media type, checksum, malware, or PDF safety. | [`files-register-upload/index.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/files-register-upload/index.ts) and [`migration-capture/index.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/migration-capture/index.ts). | Enforce quarantine, HEAD/stream verification, server checksum, signature/size/decompression limits, malware scan, and safe publication. |
| HID-36 | **High** | Public-site compliance and encryption claims exceed the available implementation and test evidence. | [`Landing.tsx`](../../identity/hid-unified-package/src/pages/Landing.tsx) and HID Migrate implementation status. | Remove or legally substantiate claims; the target is described only as compliance-ready pending controls, contracts, evidence, and independent review. |
| HID-26 | **Moderate** | Patient identifiers are passed as a GET query parameter to the patient-record Edge Function, creating avoidable exposure in URL/access telemetry. | [`patients-records/index.ts`](../../identity/hid-unified-package/retired_identity_backend/functions/patients-records/index.ts). | Use a POST search/access command body with no-store behavior and scrubbed telemetry. |
| HID-27 | **Moderate** | Generated Vercel output, installed dependencies, and ignored local environment files are present in the source snapshot. No values were inspected. | Workspace inventory and `.gitignore`. | Rebuild from pinned source in CI; exclude generated/local material; rotate credentials if custody cannot be proven. |
| HID-28 | **Moderate** | Tracked Auth/Turnstile documentation and configuration disagree, and six Edge Function directories have no explicit tracked JWT setting. | [`config.toml`](../../identity/hid-unified-package/retired_identity_backend/config.toml), [`retired_identity_backend/README.md`](../../identity/hid-unified-package/retired_identity_backend/README.md), and [`PRODUCTION_REPAIR.md`](../../identity/hid-unified-package/retired_identity_backend/PRODUCTION_REPAIR.md). | Treat repository settings as non-authoritative; inspect the deployed control plane and make all target authentication settings explicit and tested. |

## 5. What can be retained

“Retain” means preserve semantics or migrate evidence after validation. It does
not mean copy the current implementation into production.

| Current asset | Target disposition |
|---|---|
| `hid_patients.id` UUID values | Preserve one-to-one in the identity crosswalk; recommended canonical HID candidate. Never regenerate during migration. |
| `hid_code` values | Preserve as active legacy/display aliases with issuer, provenance, and validity. Do not use as authentication secrets. |
| Existing external identifiers | Normalize with a versioned algorithm, encrypt, create keyed-HMAC lookup, and retain source provenance; resolve collisions before serving. |
| retired hosted identity backend Auth users/identities | Map issuer/subject to target principals independently of patient HID; migrate/reset credentials and MFA only through an approved provider path. |
| Organizations, facilities, staff, memberships | Transform into explicit tenant/facility scope; revalidate membership, credentials, and roles. |
| Access requests/grants and consent evidence | Preserve historical evidence; do not treat expired/current rows as proof that the target authorization policy is correct. |
| Medical records, versions, and files | Preserve immutable versions and timestamps where valid; validate version chains; checksum every object; attach provenance and canonical HID. |
| Existing audit events | Import as historical evidence with source and known-completeness metadata; never manufacture missing history. |
| HID Migrate assets/jobs/reviews | Map useful custody and review states into Document Digitization/OCR; preserve hashes and decisions; reimplement runtime boundaries. |
| Outreach domain records | Migrate only after identity/contact, consent, opt-out, provider, and retention mapping is approved. |
| EHR screens and domain vocabulary | Use for clinical workflow workshops and UX reconstruction. Do not migrate fixture data or direct-query code. |
| retired hosted identity backend RLS/functions | Convert into explicit policy requirements and negative tests. Reimplement through NestJS plus PostgreSQL RLS rather than mechanically copying. |
| Realtime subscriptions | Inventory user-visible needs and replace with authorized API notifications, bounded polling, or a justified realtime channel. Do not expose database change feeds directly. |

## 6. Required identity ADR

### 6.1 Current facts

The source currently has two identifiers with different roles:

```text
hid_patients.id        UUID, primary key, referenced as patient_id
hid_patients.hid_code  TEXT, unique, user-visible HID-XXXXXX code
```

Changing every existing patient foreign key to the short text code would add
risk without improving identity integrity. Generating new UUIDs would violate
the rule that identities are never duplicated or silently re-keyed.

### 6.2 Recommendation

Approve the existing immutable UUID value as the canonical machine HID:

- preserve every `hid_patients.id` unchanged as
  `identity.patient.hid`, without assuming every source row represents a
  distinct active person;
- classify each registry record through reconciliation: active when no
  duplicate is established, or merged with an immutable pointer to the
  adjudicated survivor when it is a confirmed duplicate;
- use `patient_hid` of the same type as the foreign key in every target domain;
- retain each current `hid_code` in
  `identity_private.patient_identifier_binding` as a verified HID display alias;
- preserve UUIDv4 values already issued; use a separately approved issuance
  algorithm for new identities;
- never expose lookup success as authorization and never treat either value as
  a secret; and
- do not reuse a retired HID or display code.

This is the lowest-risk path because it preserves every existing UUID-based
relationship and fulfills the invariant that the HID itself is the patient
primary key.

### 6.3 Alternative requiring explicit rejection/approval

If governance requires the visible `HID-XXXXXX` string to be the canonical
primary key, the team must approve:

- a larger, collision-resistant issuance namespace and transcription controls;
- whether existing short codes remain valid forever;
- a complete foreign-key re-key and reversible crosswalk;
- impact on logs, URLs, integrations, and enumeration;
- merge/split and code-retirement semantics; and
- a migration rehearsal proving that no patient-scoped row changes ownership.

No target schema should be generated until one option is approved.

## 7. Immediate containment before AWS migration

These are recommendations for the current-system owner, not changes made by
this assessment:

1. Prevent the EHR prototype from connecting to or being promoted as a
   production clinical system.
2. Inspect live grants/ACLs and immediately contain whole-row self-update and
   unrevoked `SECURITY DEFINER` execution, including share activation.
3. Suspend unsafe Outreach self-signup/invite/role paths; remove recoverable
   passwords from OTP metadata and rotate affected credentials.
4. Suspend or tightly gate the permanent purge function until legal, clinical,
   privacy, and retention owners approve record-class behavior.
5. Make sensitive export and PHI-access audit failures fail closed at the
   durable primary audit boundary.
6. Restrict break-glass defaults to approved clinical roles and require review.
7. Put new HID issuance behind duplicate search and manual adjudication for
   ambiguity.
8. Stop direct browser mutation of patient identity/clinical-summary rows and
   stop identifier refresh from deleting legacy/hospital bindings.
9. Verify that all signing/encryption/OTP/upload secrets are configured; remove
   deployable fallback keys and rotate affected material.
10. Suspend or tightly gate PIN-based access grants until attempt limits,
    reauthentication, scope, expiry, and alerting are safe.
11. Route medical/document uploads into quarantine and independently verify
    object bytes, signature, size, checksum, and malware state before
    registration or processing.
12. Confirm live RLS, grants, functions, publications, buckets, and migration
   state from database catalogs rather than assuming the repository matches.
13. Preserve an immutable source snapshot and rotate any credentials whose
   custody cannot be established.

These containment actions require a separately approved change plan because
they can alter current clinical and account workflows.

## 8. Live discovery required before executable migration design

The following evidence is still missing:

- authoritative retired hosted identity backend project and organization ownership;
- exact PostgreSQL version, applied migration ledger, schema dump, roles,
  grants, RLS, functions, triggers, extensions, publications, and scheduled jobs;
- Auth users, identity providers, MFA factors, recovery methods, sessions, and
  patient/principal linkage counts;
- table row counts, sizes, update rates, orphan counts, null rates, duplicate
  identifier clusters, and actual HID collision/format distribution;
- Storage buckets, policies, object counts/bytes, duplicate paths, missing
  objects, media types, and SHA-256 coverage;
- Edge Function deployment versions, secrets, logs, invocation rates, retries,
  and outbound providers;
- Realtime clients/channels and acceptable replacement behavior;
- live audit coverage and known gaps;
- current Vercel/Cloudflare/Brevo/Sentry/PostHog/Turnstile data flows and
  contracts;
- data residency, retention/legal hold, destruction, and breach requirements;
- clinical workflow ownership and patient-safety sign-off; and
- traffic, concurrency, latency, RTO, RPO, availability, and downtime limits.

Until these are obtained, the platform architecture can be approved as a target
direction, but the migration schedule, capacity, cutover window, and
decommission date cannot be credibly committed.

## 9. Tracked retired hosted identity backend application-table catalog

This catalog is a migration-discovery aid, not a target schema and not proof
that every table exists live.

**Identity and tenancy (12):**

`hid_allowed_staff_domains`, `hid_organizations`, `hid_facilities`,
`hid_user_profiles`, `hid_patients`, `hid_patient_identifiers`,
`hid_patient_access_secrets`, `hid_staff_accounts`, `hid_staff_memberships`,
`hid_staff_invites`, `hid_platform_controls`, `hid_staff_role_policies`.

**Authentication/security state (3):**

`hid_auth_challenges`, `hid_password_failed_verification_attempts`,
`hid_mfa_failed_verification_attempts`.

**Access, sharing, notification, and audit (5):**

`hid_access_requests`, `hid_access_grants`, `hid_share_invites`,
`hid_notifications`, `hid_audit_events`.

**Clinical records/events (5):**

`hid_medical_records`, `hid_medical_record_versions`,
`hid_medical_record_files`, `hid_health_events`, `hid_health_event_records`.

**Outreach/mobile activity (11):**

`hid_outreach_campaigns`, `hid_outreach_workers`,
`hid_outreach_encounters`, `hid_sync_queue`, `hid_outreach_referrals`,
`hid_vaccinations`, `hid_mobile_lab_samples`, `hid_outreach_invites`,
`hid_outreach_otp`, `hid_outreach_auth_log`, `hid_outreach_role_policies`.

**HID Migrate/document digitization (26):**

`hid_migration_projects`, `hid_migration_project_members`,
`hid_migration_batches`, `hid_migration_work_assignments`,
`hid_migration_command_receipts`, `hid_migration_scan_sessions`,
`hid_migration_source_folders`, `hid_migration_documents`,
`hid_migration_pages`, `hid_migration_assets`, `hid_migration_jobs`,
`hid_migration_page_quality`, `hid_migration_ocr_results`,
`hid_migration_classifications`, `hid_migration_extractions`,
`hid_migration_validation_tasks`, `hid_migration_validation_decisions`,
`hid_migration_qa_tasks`, `hid_migration_qa_decisions`,
`hid_migration_match_candidates`, `hid_migration_match_decisions`,
`hid_migration_mapping_templates`, `hid_migration_import_jobs`,
`hid_migration_import_items`, `hid_migration_correction_cases`,
`hid_migration_cost_events`.

**AI configuration/usage (5):**

`hid_ai_providers`, `hid_ai_models`, `hid_ai_workload_routes`,
`hid_ai_budgets`, `hid_ai_usage_events`.

**Commercial/billing (8):**

`hid_commercial_products`, `hid_commercial_prices`,
`hid_subscription_plans`, `hid_organization_subscriptions`,
`hid_subscription_entitlements`, `hid_platform_invoices`,
`hid_platform_payments`, `hid_platform_billing_settings`.

The legacy `retired_identity_backend/fix-schema.sql` also describes unprefixed `patients`,
`medical_records`, `medical_record_files`, `patient_notes`, `staff_accounts`,
`access_requests`, `access_logs`, and `notifications`. These are a separate
drift/quarantine question and are not included in the 75-table catalog.
