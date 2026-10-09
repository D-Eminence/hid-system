# Supabase-to-AWS cutover readiness

Status: implementation preparation only, 2026-09-27. This document authorizes
neither deployment nor a live/source-data migration. upstream_snapshot is
historical, read-only evidence; AWS/RDS is the target architecture.

## Cutover invariants

- Preserve canonical source patient UUIDs and linked source auth UUIDs. Never
  generate replacement patient records during import or sign-in.
- Use an authorized read-only, repeatable-read source snapshot with an ID,
  extraction timestamp, category counts, canonical row hashes, and a final
  delta plan.
- Never export or stage raw PINs, Google ID/refresh tokens, raw passwords, OTP
  material, or client secrets. The controlled ledger currently carries legacy
  password verifiers and approved identity/audit/outreach source payloads;
  those restricted historical records require an explicit data-classification,
  encryption, retention, and operator-access approval before a real export.
- Promotion is additive and idempotent. A count, relationship, hash, or target
  collision mismatch stops cutover; it is not repaired by overwriting target
  data.

## A. Patient access PINs

### Historical behavior and target replacement

The source secret table is public.hid_patient_access_secrets(patient_id,
access_pin_hash, created_at, updated_at), defined in
upstream_snapshot/supabase/migrations/20260413113000_access_pin_and_secure_identity_helpers.sql.
The historical set command strips whitespace, accepts four to eight digits,
and writes a pgcrypto Blowfish/bcrypt hash. The final verification RPC,
hid_access_patient_with_pin, is in
20260429120000_access_display_names_realtime_and_record_alerts.sql. It
resolved a HID and immediately granted up to 24 hours of write_records access.
Its direct Supabase RPC permission could bypass checks made in the Edge Function,
so that entitlement model is intentionally not reproduced.

Historical request trace, retained only as migration evidence:

1. The patient profile calls `patient-access-pin`, an authenticated Edge
   Function, which invokes `hid_set_my_access_pin`. A blank value deletes the
   source row; a 4–8 digit value is whitespace-stripped and hashed with
   `extensions.crypt(pin, extensions.gen_salt('bf'))`. The source did not set
   a bcrypt cost explicitly, so the encoded cost in each existing hash is the
   authoritative compatibility parameter.
2. `DoctorPortal` calls `access-request-create` with HID, PIN, duration, and
   a browser-supplied display name. The Edge Function checks a staff role,
   capability, and coarse patient state, then calls
   `hid_access_patient_with_pin`.
3. The final RPC resolves the HID, checks an active staff membership and the
   bcrypt verifier, then creates/reuses an approved `write_records` request
   and grant for 5–1440 minutes, plus a patient notification and audit event.
   It had a direct `authenticated` execute path, so its Edge-only checks were
   not a reliable security boundary.

Migration 0033_supabase_cutover_identity_controls.sql adds the target
implementation:

- identity.patient_access_pins stores the original bcrypt envelope,
  lifecycle/provenance fields, and timestamps. It is not an authentication
  password table. PostgreSQL pgcrypto compares `$2a$` directly; for an
  imported `$2b$` or `$2y$` PIN, the server makes an in-memory `$2a$`
  comparison copy only. The stored source bytes are never rewritten. This is
  safe for the legacy PIN domain (ASCII digits only), where those bcrypt
  variants have the same semantics.
- identity.access_patient_with_pin is server-side only. It requires an active
  exact staff membership, selected facility, the
  identity.patient-access-pin.verify permission, direct-care, an active
  patient, current consent-directive checks, and a 5–60 minute duration. It
  creates only a read_records grant.
- The command records immutable attempt evidence, semantic audit information,
  and a minimal outbox notification atomically with the governed request/grant.
  It gives every accepted 04–12 bcrypt envelope a bounded cost-12 comparison
  work budget, including absent/disabled/malformed candidates; source hashes
  above cost 12 are rejected at staging rather than creating an unbounded
  verifier workload. It also applies actor/target windows of five failures in
  15 minutes.
- A changed or revoked patient PIN revokes active PIN-derived grants. No raw
  PIN, hash, HID code, provider subject, or patient display name is written to
  the audit payload or sent from the browser as authority.

The canonical access command is:

~~~text
POST /api/v1/identity/standard-access/pin
X-Facility-Id: selected active facility
X-Purpose-of-Use: direct-care
{ "hid": "HID-…", "pin": "1234", "durationMinutes": 15 }
~~~

Failures deliberately produce one generic access-denied result. Patients can
configure or revoke a PIN only through their active cookie session at POST or
DELETE /api/v1/identity/me/access-pin; neither operation returns a secret or
hash. The web adapter retains its existing caller response shape while moving
off the retired /api/v1/functions transport.

### Required Softbridge PIN export

Softbridge must provide an authorized snapshot containing exactly the 39
currently reported secret rows, plus an approved final delta:

| Required field | Target handling |
|---|---|
| hid_patient_access_secrets.patient_id | Must equal the preserved canonical target patient UUID. |
| access_pin_hash | Exact byte-for-byte bcrypt string; do not rehash, normalize, truncate, or change cost/version. Accepted prefixes are $2a$, $2b$, and $2y$ at cost 04–12. `$2b$`/`$2y$` are normalized only in an ephemeral pgcrypto comparison variable, never in storage. Any cost above 12 blocks this cutover path for explicit security review. |
| created_at and updated_at | Preserve as source provenance timestamps. |
| source table/primary key, snapshot ID, extraction time | Immutable migration evidence. |
| canonical JSON SHA-256 per row and category count/checksum | Required staging/reconciliation gate. |
| source deletion/change delta after snapshot | Must be explicitly reconciled before go-live. |

The source lacks historical PIN expiry, disable state, failure history, and
lockout records. Those target controls begin at cutover and must not be
fabricated as source history. The export is blocked until the source snapshot
proves count, patient crosswalk, bcrypt format, and checksum.

## B. Google identities and existing HID accounts

### Canonical matching rule

Supabase historically links app records through auth.users.id; the six actual
Google provider identity rows are not in this repository. Email is not a safe
migration key. The only automatic mapping is:

~~~text
canonical issuer https://accounts.google.com + verified Google sub
  -> auth.external_identities.account_id
  -> existing auth.accounts and identity.patients/workforce context
~~~

auth.external_identities already has a unique issuer/subject constraint in
0002_auth_and_canonical_identity.sql. Migration 0033 adds a narrow
auth.resolve_google_identity(subject) lookup that returns only an active linked
account and subject.

The Identity API verifies Google ID tokens server-side against Google JWKS,
accepted issuer spellings, the configured client-ID audience allowlist, RS256,
expiry, authorized party for multi-audience tokens, and a short-lived
same-site nonce. It creates the normal HID cookie session with OIDC provenance;
it does not decode browser token contents to match email, create an account,
create a patient, issue a HID, or relink an identity.

Configure GOOGLE_OIDC_CLIENT_IDS, a comma-separated allowlist of Web client
IDs, in the Identity API-only `googleOidcClientIds` field of the
`IdentitySensitiveSecretArn` JSON. The matching public browser value belongs
only in the approved frontend `VITE_GOOGLE_CLIENT_ID` build setting; neither
setting is a Google client secret. The server allowlist is valid only with
AUTH_MODE=local because HID issues its own cookie session after federated
verification. Do not set global AUTH_MODE=oidc; that is a different
workload-token mode and would disable local password behavior.

Expected browser protocol:

1. Fetch GET /api/v1/auth/google/nonce from an allowed origin.
2. Give the returned nonce to Google Identity Services when requesting the ID
   token. Its matching value is also retained only in a short-lived HttpOnly
   cookie.
3. POST the credential to /api/v1/auth/oidc/exchange with the appropriate
   patient-login or staff-login Turnstile action/token.

The browser and Identity API must use same-site HID hostnames (for example,
the approved `api.staging.healthidentitydirectory.com` route), not a raw AWS
load-balancer hostname. The nonce and HID session cookies are `SameSite=Strict`
and a cross-site route would prevent the nonce cookie from reaching the exchange
endpoint. `GoogleIdentityButton` is only a secure reusable component at this
point; it is not mounted on an enabled login screen. Before enabling it, the
chosen screen must obtain its own Turnstile token/action, use this nonce flow,
and pass the focused browser/API tests below.

Unknown/revoked mappings, invalid signature/audience/nonce, wrong actor kind,
or inactive accounts/patients receive the same generic denial. A Google email
that belongs to an existing HID account but has no exact provider-subject link
is not silently merged. The user must first prove control of the existing HID
account through password or approved recovery. A future provider-link command
must require fresh Google proof, an authenticated HID session, explicit intent,
conflict checks, and audit review; it is intentionally outside this cutover.

### Required Softbridge Google export

For each of the exact six source provider identities, provide:

| Required field | Why it is required |
|---|---|
| source auth.users.id | Preserved target account UUID/crosswalk. |
| source auth.identities.id | Stable source record provenance/idempotency key. |
| provider google and nonempty `provider_id`; `identity_data.sub` when present | `provider_id` is the authoritative automatic match key; a populated identity-data `sub` must agree with it. |
| issuer/provider metadata | Validate/canonicalize to the target issuer spelling. |
| identity created/updated/revoked state | Target lifecycle evidence. |
| patient/profile/staff links, patient UUID, HID code, and account status | Proves the link reaches the intended existing target context. |
| snapshot ID, timestamps, count six, row/category checksums | Staging/promotion/reconciliation gate. |

Do not include Google ID tokens, refresh tokens, passwords, client secrets, or
email substitutions. Promotion must fail on an absent subject, duplicate
canonical issuer/subject, absent/inconsistent target account/patient link, or
anything other than the exact six authorized mappings.

## C. Outreach preservation

The historical model has campaigns, workers, encounters, an optional sync
queue, referrals, vaccinations, samples, and invites. A queued encounter was
not backed by a reliable server worker; the historical browser simulated sync.
The source dashboard derived counts from capped lists of six campaigns and 200
encounters, so the reported four planned campaigns and two queued encounters
are not established by repository contents alone.

AWS intentionally supports only governed temporary outreach.registration_cases
today. It does not implement source campaigns, workers, queued encounters, or
source queue semantics. Therefore:

- Do not map a planned campaign to registration_case.
- Do not map a queued source encounter to ehr.encounters.
- Do not create workforce identities by email.
- Do not delete, transform, operationally activate, or reinterpret source
  records.

The cutover ledger preserves authorized source rows as restricted append-only
migration.cutover_preservation_holds, including entity/key, status, timestamps,
canonical payload hash, and disposition. A hold is inserted only after the
staging relationship validator succeeds; a failed relationship produces a
blocked run rather than an operational mapping. It is evidence, not a
replacement campaign or clinical system.

Softbridge must export all related records, not only the stated counts:
campaigns, workers, encounters, sync-queue rows, referrals, vaccinations,
mobile lab samples, and invites. Preserve source UUIDs, source user IDs,
statuses, created/updated timestamps, foreign keys, snapshot metadata, and
per-row hashes. Obtain unbounded direct counts within the same repeatable-read
snapshot. An orphan, mismatched relationship, missing account crosswalk,
count/hash mismatch, or unsupported active operational need stops preservation
import.

If HID confirms activities remain active, a separate product/security decision
is required before implementing campaigns, durable offline queue semantics,
worker authorization, clinical encounter conversion, referrals, vaccinations,
or samples. Nothing in this cutover makes historical workflows live.

## Verification before an authorized cutover

Run migration scripts only against an approved staging copy with a
least-privilege migration role. Each stage run is single-snapshot and
single-use: a failed/partial run is retained as evidence and must be replaced
with a fresh run ID from a new repeatable-read snapshot. Once marked staged,
its source rows, category counts, and overall checksum are sealed. Staged
fixture/export validation must prove:

- exactly 39 valid PIN hash rows and a preserved patient UUID crosswalk;
- exactly six Google mappings with no issuer/subject collision;
- unbounded source counts showing exactly four planned campaigns and two queued
  encounters if those figures are confirmed in the approved snapshot;
- complete outreach dependency graph preservation;
- idempotent staging/promotion/reconciliation with no target overwrite;
- representative legacy bcrypt PIN hashes verify unchanged;
- valid/invalid/locked/revoked PIN behavior, purpose/facility/membership
  boundaries, audit/outbox atomicity, and downstream record authorization;
- Google signature, issuer, audience, nonce, unknown mapping, collision,
  inactive link, wrong actor kind, and no-duplicate-patient behavior.

Use `npm --prefix services/ehr-api run migration:verify-cutover-input` as the
read-only inventory gate. It accepts either `MIGRATION_FIXTURE_PATH` or a
staged `DATABASE_URL` plus `MIGRATION_RUN_ID`, recomputes every staged payload
hash, and emits only category counts/checksums. Its default expectations are
39 PINs, six Google identities, four planned campaigns, and two queued
encounters. Overrides are accepted only for a staging run whose recorded source
transaction is a synthetic fixture; a real source snapshot always uses the
39/6/4/2 expectations. The synthetic fixture uses explicit 1/1/4/2 overrides
only for local regression testing and is not cutover evidence. The promotion
script holds a migration lock, invokes the staged-run form of this gate before
its first target write, rechecks the sealed run state in each write
transaction, and marks the run blocked if the gate fails.

No production deployment, DNS change, Supabase configuration change, live data
read, or migration has been performed as part of this work.

## Current cutover blockers

1. The actual 39 PIN rows, six Google identities, and outreach records are not
   in this repository and must not be invented.
2. HID/Softbridge must authorize and provide the consistent source export,
   snapshot evidence, crosswalks, checksums, and final-delta plan.
3. HID must classify the four campaigns/two encounters from direct source
   evidence and decide whether a future operational outreach product is needed.
4. An operator must configure Google client IDs and Google Console allowed
   origins, plus an approved same-site HID API hostname, only in approved
   staging/production configuration after the six mappings pass staging
   reconciliation.
5. A chosen browser login screen still needs an approved Turnstile integration
   before the dormant Google component can be enabled.
6. Staging migration and focused automated/database tests must pass against the
   final migration set before cutover approval.
7. A data steward/security owner must approve the exact restricted source
   fields, encryption, retention, and migration-operator access for the legacy
   password verifier and historical identity/audit/outreach payloads staged in
   the controlled ledger.
