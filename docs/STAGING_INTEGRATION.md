# Staging integration implementation — 2026-10-02

Baseline: `c4b5445ed589217bb8b4529d69e268ca56842609`, isolated branch
`staging-c4b5445-integration`. The original working checkout is preserved.
This is an implementation candidate, pending Review and Correct. It is not an
approved release or evidence that AWS staging has been upgraded.

## Integrated contracts

- The schema ledger contains 62 full filenames through prefix 0060. Both
  September files 0033/0034 remain unchanged alongside the developer files.
  The runner retains RDS effective SQL/checksums and managed secret inputs,
  rejects missing applied files, and orders 0042 before 0038.
- `promote-staging-cutover-additions.mjs` handles the existing verified run,
  rather than importing the older sealed fixture with the new full importer.
  It verifies every original category seal and reconciliation, decrypts and
  checks all 39 preserved PIN envelopes, checks the six original Google
  associations, and inserts only unchanged PIN hashes plus an additive receipt.
  It never overwrites changed PINs, remaps identities, releases clinical data,
  or promotes legacy outreach. Dry run is the default.
- Run prerequisites: upgraded schema, verified/reconciled parent run, matching
  externally supplied parent checksum, legacy field key and key reference,
  explicit staging environment, migration operator, and TLS verified database
  credentials. The September parent is
  `89b49b78-065b-4598-8bec-dc3fec61f3e0`; do not substitute an earlier failed run.
- `verify-staging-cutover-source.mjs` checks protected fixture byte checksum,
  metadata, transaction snapshot, all categories and supported associations.
  It prints only counts and checksums and never writes to the database.
- Contact rekey and NIN crosswalk accept the existing managed database
  credential inputs. Contact rekey preserves the September logical keys:
  legacy envelopes may decode to 33 bytes and the original migrator used the
  first 32. New runtime contact/NIN/OTP keys remain exactly 32 bytes.
- Notification profile `email-brevo` is staging-only and requires real Brevo
  credentials/sender. SMS and WhatsApp remain unavailable in this profile.
  Fallback occurs only after a definitive delivery failure, never an unknown
  outcome. Identity and Notification must deploy as one compatible release.

## Source table disposition register

These counts are the recorded source inventory, not a final production delta.
"Pending mapping" means archival preservation exists but application use is
blocked. Proposed destinations below require source-value reconciliation;
seeded defaults are not accepted substitutes. Invalid outreach was explicitly
excluded by the user. No additional deletion is authorized by this register.

| Populated source table | Rows | Destination or disposition | Acceptance status |
|---|---:|---|---|
| hid_access_grants | 47 | Existing canonical consent grants | September core reconciliation passed; current runtime acceptance pending |
| hid_access_requests | 47 | Existing canonical access requests | September core reconciliation passed; current runtime acceptance pending |
| hid_ai_workload_routes | 8 | Preserve backup; map reviewed AI route configuration | Pending mapping/owner decision; chatbots separate |
| hid_audit_events | 571 | Existing imported audit evidence | September reconciliation passed; audit read acceptance pending |
| hid_auth_challenges | 74 | Preserve backup; expire obsolete challenges at cutover | Expiry/current challenge disposition pending; do not revive tokens |
| hid_commercial_prices | 8 | Preserve backup; explicit commercial price mapping | Pending value and currency reconciliation |
| hid_commercial_products | 8 | Preserve backup; explicit product mapping | Pending subscription/visibility reconciliation |
| hid_facilities | 13 | identity.facilities and source mapping | September reconciliation passed; timezone map retained |
| hid_medical_record_files | 4 | Existing encrypted preservation plus versioned S3 quarantine | Bytes preserved; native document mapping/access blocked |
| hid_medical_record_versions | 17 | Existing encrypted preservation | Native clinical history mapping blocked |
| hid_medical_records | 17 | Existing encrypted preservation | Native clinical record mapping blocked |
| hid_notifications | 193 | Preserve backup; explicit historical inbox mapping | Pending recipient/type/read-state reconciliation; never resend as new events |
| hid_organizations | 13 | identity.organizations and source mapping | September reconciliation passed; CAC workflow acceptance pending |
| hid_outreach_auth_log | 16 | Preserve backup; operational exclusion with invalid outreach set | No operational import; confirm retention under audit policy |
| hid_outreach_campaigns | 4 | Preserve backup; invalid test campaigns excluded | User decision recorded; zero operational import |
| hid_outreach_encounters | 2 | Preserve backup; invalid test encounters excluded | User decision recorded; zero operational import |
| hid_outreach_invites | 1 | Preserve backup; related invalid outreach excluded | No operational import or replay |
| hid_outreach_otp | 2 | Preserve backup; related invalid outreach excluded | No operational import or token replay |
| hid_outreach_role_policies | 3 | Preserve backup; related legacy test configuration excluded | New operational roles require current policy acceptance |
| hid_outreach_workers | 3 | Preserve backup; related invalid outreach excluded | No operational worker activation; canonical accounts retained separately |
| hid_patient_access_secrets | 39 | Existing encrypted preservation → identity.patient_access_pins | Additive bridge passes synthetic SQL acceptance; actual staging copy required |
| hid_patient_identifiers | 369 | Existing canonical identifiers/source mappings | September reconciliation passed; authoritative NIN inventory still required |
| hid_patients | 123 | identity.patients and clinical quarantine | September reconciliation passed; contact rekey and native clinical visibility pending |
| hid_platform_billing_settings | 1 | Preserve backup; explicit billing configuration mapping | Pending value reconciliation |
| hid_platform_controls | 1 | Preserve backup; explicit feature-control mapping | Pending value reconciliation; safe disabled gates retained |
| hid_staff_accounts | 11 | Existing canonical staff/accounts | September reconciliation passed; runtime/staff MFA acceptance pending |
| hid_staff_memberships | 11 | Existing canonical facility memberships | September reconciliation passed; runtime authorization pending |
| hid_staff_role_policies | 5 | Preserve backup; explicit permission-policy mapping | Pending permission reconciliation; do not widen rights |
| hid_user_profiles | 157 | Existing canonical profile/source mapping | September reconciliation passed; runtime account acceptance pending |

Supabase `auth.users` (157) and `auth.identities` (162) are separate from the 29
public tables. Their canonical accounts and original external identity mappings
were reconciled in September. The bridge checks six Google associations without
creating extra accounts. Storage metadata alone does not establish file access.

## Required clinical contract from the developer/data owner

Provide one reviewed mapping for each retained record/version/file:

1. Patient UUID and legacy record/version IDs; exact source content, title,
   category, structured data, transcription, timestamps and history order.
2. Original author profile/staff ID → canonical account and facility membership,
   with evidence of the originating facility. The exported record schema lacks
   a facility and encounter identifier. Timezone selection cannot supply them.
3. Supported representation for legacy records without a native encounter or
   clinical signing evidence. Supply a migration API/schema contract or an
   explicit archival reader contract. Do not invent encounters, authors or
   signatures, disable clinical triggers, or clear a quarantine flag.
4. File binding: patient/record/version association, exact source and destination
   object versions, media type, size, independently computed SHA-256 and scan
   evidence. Preserve `immutable_source` and original asset provenance.
5. Authorized patient and selected-facility read/download behavior, denial for
   unrelated users, and source/target counts/content checksums.

The developer runbook explicitly states that quarantined fragments are not
native EHR records. This missing contract blocks customer-visible clinical
migration; the code must not manufacture a clinical meaning to unblock it.

## Execution order after Review/Correct and release findings are resolved

1. Commit the accepted integration tree; record its exact SHA. Update the release
   evidence, then build/scan/SBOM all governed targets and frontend artifacts.
   Outer publishing scripts now require an explicit checkout, matching clean
   commit and closed/approved RF-005/RF-006 records before AWS calls.
2. Capture a recovery point, restore a restricted disposable copy of **populated
   current staging**, and rehearse 34→62 there. Synthetic acceptance is not a
   substitute. Rehearse the bridge and contact rekey there too.
3. Provision a new contact lookup key securely in the existing identity-sensitive
   JSON without replacing OTP/Turnstile or old migration keys. Use the same key
   in migration and runtime. Review grants under the RDS security administrator
   role; runtime roles remain NOSUPERUSER/NOBYPASSRLS.
4. Apply the reviewed staging schema through the restricted ECS task, then run
   the new additive bridge with explicit parent evidence, dry run first. The
   promotion task already has the old field/lookup secrets and managed DB
   credentials; its default full importer and the September promotion wrapper
   must **not** be used to replay the old fixture under this new contract.
   Use `infra/terraform/scripts/run-staging-additions-task.ps1` from the outer
   infrastructure checkout. It requires the exact clean source commit, image
   digest, governed populated-copy rehearsal evidence and artifact-set hash;
   Apply additionally requires matching successful DryRun evidence. Its request
   contains no secret values. Review this wrapper before execution.
5. Supply complete attested NIN source coverage for all 123 patients. Rehearse
   and apply the exact/absent crosswalk. Leave NIN-only enrollment off until
   source and QoreID contract acceptance are complete.
6. Complete the pending source-table and clinical mappings, then provider
   configuration, service/frontend deployment and actual user journey checks.

QoreID uses a same-account/region existing secret with `clientId` and `secret`;
optional custom KMS access is limited to Identity's execution role. Google uses
public web client IDs and matching allowed origins. Secrets are never frontend
inputs. SES sender, Brevo, QoreID, Google/Turnstile and Novu account access must
come from their authorized account owners. NIN/CAC entitlement cannot be
created by inventing a sandbox credential or endpoint.

RF-005 remains one high CDK audit finding. RF-006 needs an owner/security
disposition because its draft/unmerged instruction contradicts the already
merged baseline. Staff MFA and the separate chatbot release lane remain open.
No live data migration, image publication, AWS mutation or DNS change was made
during this implementation work.

## Public frontend configuration supplied during credential setup

### Medical history implementation status (2026-10-03)

The previously missing native representation is implemented as immutable imported
medical history. Migration 0061 extends the candidate to 63 files without changing
accepted hashes. The staging-only importer, self/consent reads, patient/EHR screens,
source validation and synthetic PostgreSQL preservation/RLS checks are implemented.
See [IMPORTED_MEDICAL_HISTORY.md](IMPORTED_MEDICAL_HISTORY.md) for exact contracts,
execution and limitations. The protected source check confirms 17/17/4 and 16
patient-provided / one provider-authored records. Local API tests (59), browser
checks (10), import/bridge/release checks (12) and both affected frontend builds
pass. No live staging import occurred. Attachment downloads remain pending exact
S3 binding and genuine clean scan evidence. Final release review and populated-copy
rehearsal remain required before the live additive import.

The operator supplied this public sitekey from the **HID Staging** Turnstile
widget. Our staging release includes frontend build and deployment; supply these
public values at build time:

```dotenv
VITE_TURNSTILE_SITE_KEY=0x4AAAAAAE_uqBcWRLakgoCm
VITE_GOOGLE_CLIENT_ID=690536667193-l90c5cqm86g5pt5o93dpvplms2h507l6.apps.googleusercontent.com
```

Recording the value here does not publish a configured frontend. Compare the
same widget's private secret locally against `turnstileSecretKey` in
`/hid/staging/identity-sensitive`; do not put the secret in frontend inputs.
Validate a real challenge and backend token exchange during staging acceptance.

The widget's listed `staging.healthidentitydirectory.com` hostname covers its
child subdomains, including Migrate, under Cloudflare's hostname-management
rules. Application CORS and token-hostname validation still require the actual
deployment origins.

The supplied Google web client ID is recorded in the local staging backend
`google_oidc_client_ids` allowlist. Our frontend build must use the same
`VITE_GOOGLE_CLIENT_ID` shown above. The operator reports that the
developer confirms `https://staging.healthidentitydirectory.com` is authorized
in Google and the frontend uses this ID. Deployment and live authentication
remain pending. This flow validates ID tokens and does not
require a Google client secret in the backend or frontend build inputs.
