# Identity Backend Extraction Inventory

Date: 2026-08-10

Status: implemented and locally verified; production environment evidence is pending.

## Outcome

The repository had one authoritative Identity backend embedded in
`ehr/server/src`. It has been physically extracted without rewriting its
patient, HID, NIN, authentication, consent, or authorization semantics:

```text
EHR / Lab / Pharmacy / Outreach / OCR / Web
                    |
                    v
         packages/api-client Identity client
                    |
                    v
       services/identity-api :3001
```

`services/identity-api` is the only active application process that registers
canonical patient, HID, identifier, NIN-registration, authentication, consent,
or Identity audit routes. EHR no longer registers the old modules and its old
Identity mutation URL returns 404. The old EHR source files are inert,
classified as obsolete-after-cutover compatibility history, and are not an
active second authority.

## Permanent identity distinctions

```text
authentication principal != canonical patient identity
HID                      != canonical patient primary key
secondary identifier     != canonical patient identity
Outreach temporary ID    != canonical patient identity
```

The existing `identity.patients.id` UUID remains the permanent cross-service
patient key. No migration remaps or regenerates it. Existing `hid_code` values
remain unchanged and the existing `HidCodeGenerator` remains callable only
inside Identity's governed approved-new-registration transaction.

## Inventory classification

| Location | Classification | Disposition |
|---|---|---|
| `services/identity-api/src/identity/**` | IDENTITY OWNED | Active authoritative canonical patient, HID, identifier, resolution, NIN, and registration code. |
| `services/identity-api/src/auth/**` | AUTHENTICATION OWNED | Active account/session/token/workforce authentication. Authentication subjects never become patient UUIDs. |
| `services/identity-api/src/consent/**` | IDENTITY OWNED / FUTURE EXTRACTION CANDIDATE | Kept with Identity because current patient-access decisions and break-glass commands are tightly coupled. A future consent service requires a separate decision and migration. |
| `services/identity-api/src/audit/**` | SHARED SECURITY, IDENTITY HOSTED | Identity hosts the existing audit read endpoint and appends Identity/auth semantic evidence. Other services retain append-only writers. |
| `services/identity-api/src/common/**`, `database/**` | SHARED SECURITY / KEEP IN SERVICE | Same request context, Problem Details, audit interceptor, validation, and transaction-context behavior as before extraction. |
| `packages/api-client/src/identity.ts` | MOVE TO SHARED CONTRACT | Typed actor authentication, patient authorization, Outreach authorization, scanner authorization, timeout, correlation, workload and user delegation, and Problem Details. |
| `services/ehr-api/src/integrations/identity-api.service.ts` | REPLACE WITH IDENTITY CLIENT | Active EHR adapter. |
| `services/ehr-api/src/auth/remote-security.guard.ts` | EHR OWNED / SHARED SECURITY | EHR verifies sessions through Identity, then enforces its own route permission/facility policy. Cookie mutations are revalidated by Identity using Origin and CSRF evidence. |
| `services/lab-api/src/identity/**` | REPLACE WITH IDENTITY CLIENT | Lab domain adapter only; no Identity persistence or issuance. |
| `services/pharmacy-api/src/identity/**` | REPLACE WITH IDENTITY CLIENT | Pharmacy domain adapter only; no Identity persistence or issuance. |
| `services/outreach-api/src/identity/**` | REPLACE WITH IDENTITY CLIENT | Existing-patient authorization only; no new-patient command. |
| `services/ocr-api/src/**` | OCR OWNED | Uses the shared typed Identity client with the independent `ocr-api` workload identity for canonical-patient authorization. It cannot issue patients, HIDs, identifiers, or NIN links. |
| `identity/hid-unified-package/**` | KEEP IN CURRENT LOCATION | Browser application. Public URLs are unchanged and gateway-routed to `:3001`; it is not a patient authority. |
| `services/ehr-api/src/auth/**`, `identity/**`, `consent/**` | OBSOLETE AFTER CUTOVER | Inert compatibility source retained outside active `AppModule`; no controller or provider is registered. |
| legacy promotion/reconciliation scripts | MIGRATION/ADMIN ONLY | Historical controlled migration tools, never runtime consumers. |
| `upstream_snapshot/**` | HISTORICAL EVIDENCE ONLY | Retired hosted/Supabase implementation. It is not restored. |

## Canonical persistence and issuance behavior

Canonical patients remain in `identity.patients`; identifiers remain in
`identity.patient_identifiers`; governed cases/candidates/events remain in
`identity.registration_*`. EHR, Lab, Pharmacy, Outreach, and OCR continue to
store only foreign references to the same UUID.

Canonical creation remains:

```text
protected NIN POST
  -> provider verification
  -> keyed-HMAC exact lookup
  -> bounded duplicate candidates
  -> review_required OR pending_new_identity_approval
  -> explicit approve-new review
  -> one UUID + one governed HID + verified NIN binding
```

Resolution never creates a patient. An existing verified NIN returns the same
patient UUID/HID. Ambiguous candidates remain review-required. Approval and
link retries are bound to the original idempotency key/request digest and
return the same outcome; conflicting reuse fails. There is no patient merge
implementation in active code, so no merge was invented.

## NIN findings

- Raw NIN is accepted only in a protected POST body.
- Equality lookup uses HMAC with a configured 32-byte key.
- Storage uses AES-GCM ciphertext with key version and a four-digit display hint.
- Provider access is abstracted; the deterministic adapter is test-only and
  production fails closed without a real provider.
- Raw NIN is absent from URLs, audit, outbox, and application logging.
- "not found" creates a governed case, not an automatic patient.

## Consumers and contracts

| Consumer | Required Identity operation | Active boundary |
|---|---|---|
| EHR | session actor, facility membership, route permissions, patient read/write authorization, scanner workload authorization | Typed client with `ehr-api` workload identity. |
| Lab | session actor, facility permissions, patient read/write authorization | Typed client with `lab-api` workload identity. |
| Pharmacy | session actor, facility permissions, patient read/write authorization | Typed client with `pharmacy-api` workload identity. |
| Outreach | facility/permission authorization and exact existing-patient write authorization | Typed client with `outreach-api` workload identity. |
| OCR | canonical patient confirmation/access and scanner authorization from the standalone OCR API | Typed Identity client with `ocr-api` workload identity; no creation/link APIs. |
| Web/patient UI | existing auth/session/Identity v1 routes | Same gateway URLs, now routed to `:3001`. |

Service identity and propagated user identity are independent. Local development
uses separate process-generated per-caller secrets. Production rejects those
secrets and requires HTTPS issuer/JWKS, exact audience, signature/expiry
validation, exact caller subjects, and rotating mounted tokens.

## Direct database access findings

Before cutover, the only EHR-domain direct decision was
`ClinicalRepository` calling the constrained security-definer
`identity.has_active_consent_grant`. It now calls Identity HTTP first. Existing
EHR forced-RLS policies retain the constrained function as database
defense-in-depth; EHR has no Identity table privilege. Lab, Pharmacy, Outreach,
and OCR had no canonical Identity mutation grant. Migration/admin scripts and
rollback-only schema tests remain explicitly outside runtime.

## Database ownership

- `hid_identity_api_runtime` composes `hid_identity_runtime` plus append-only
  `hid_audit_writer` and has no EHR/OCR/Lab/Pharmacy/Outreach mutation rights.
- `hid_ehr_api_runtime` composes EHR plus append-only audit and has no Identity
  or OCR mutation rights. `hid_ocr_api_runtime` independently composes OCR plus
  append-only audit and has no Identity or EHR mutation rights.
- Retired `hid_api_runtime` is retained as a privilege-free compatibility role;
  it no longer aggregates Identity and EHR.
- All service group roles are NOLOGIN, non-owner, non-superuser,
  non-`BYPASSRLS`; production LOGIN creation remains environment-specific.

Additive migration `0025_identity_transactional_outbox.sql` creates the forced-
RLS Identity outbox. Governed registration emits minimum `PatientRegistered`,
`PatientIdentifierAdded`, and `PatientIdentityResolved` events in the same
transaction as domain state and semantic audit. Payload constraints forbid raw
identifier/HID fields.

## Cutover and verification

- Identity typecheck/build and 13 suites/38 tests pass.
- EHR build and 29 suites/94 tests pass.
- Lab 10 suites/25 tests, Pharmacy 7 suites/15 tests, and Outreach 6 suites/13
  tests pass; all affected service typechecks/builds pass.
- Shared client typecheck/build passes and tests prove correlation, separate
  user/workload credentials, mutation CSRF delegation, and Problem Details.
- Migration `0025` is applied locally; the final plan reports zero pending.
- Role bootstrap/catalog assertions and the full rollback-only schema/RLS suite pass.
- Standalone Identity live and PostgreSQL readiness returned 200.
- EHR's old Identity route returned 404; the extracted route and gateway paths
  returned Identity-owned 401 Problem Details.
- Dockerfile inputs and secret exclusions were statically inspected. Docker
  execution, real issuer/JWKS/token mounts, environment-specific LOGINs,
  external NIN provider, and deployment remain external verification.
