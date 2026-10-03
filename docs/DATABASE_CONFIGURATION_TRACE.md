# Configuration trace from the developer branch

Implementation update, 2026-10-04: the integration checkout now connects public
pricing and six supported controls to native APIs, including a controls page in
the separate admin app. Exact-match mapping generation and read-only target
capture are implemented. See `SUPPORTED_CONFIGURATION_MIGRATION.md` for results
and live execution dependencies. The trace below describes the original
developer commit; its supported consumer gaps have been corrected locally.

Date: 2026-10-03  
Developer branch: `hid-local-pre-softbridge-snapshot`  
Inspected commit: `c4b5445ed589217bb8b4529d69e268ca56842609`  
Working checkout: `staging-c4b5445-integration`

## Scope and conclusion

This traces source field contracts, target SQL, server readers/writers, browser
callers and gateway routes. It includes existing local migration/preservation
additions, labelled below. It does not establish the current remote branch or
live AWS state. No application code, database, image or AWS resource was changed
by this trace.

The earlier statement that all five areas require the developer to supply
mappings was too broad. The branch already defines product/price fields,
six working platform controls, membership-role aliases and the current
permission vocabulary. Those rules should come from code.

Three operational counterparts are absent from this commit: the old billing
settings service, editable legacy staff-policy behavior, and dynamic AI
workload routing. Additional product fields and signup/Migrate controls also
lack equivalent runtime behavior. The source values can still be preserved.

The complete protected source input is also needed. Counts alone do not reveal
actual product slugs, contexts, flag values or model references. Eight source
products versus seven seeded products is not proof that eight ambiguous
developer decisions are required.

## 1. Products and prices: target contracts are defined

Target SQL: `services/ehr-api/database/migrations/0043_authoritative_product_pricing.sql:18`.
Reader/writer: `services/identity-api/src/admin/pricing.service.ts:54`.
Admin routes: `services/identity-api/src/admin/admin.controller.ts:148`.
Public route: `services/identity-api/src/admin/public-pricing.controller.ts:5`.
Browser vocabulary: `apps/web/src/features/commercial/catalog.ts:17`.

| Source field | Defined target / rule |
| --- | --- |
| Product `slug` | `platform.commercial_products.slug`; match an identical supported slug first |
| Product `name`, `status` | Same fields; status is `active`, `coming_soon`, `draft` or `retired` |
| Price `product_id` | Resolve the exact source product UUID to its matched product slug; write `commercial_prices.product_slug` |
| Price `context` | Same field: `core`, `addon`, `standalone`, `usage`, `setup`, `migration_project`, `enterprise` |
| `visibility` | Same field: `fixed`, `starting_from`, `contact_sales`, `custom_quote`, `hidden` |
| `amount_minor`, `currency` | Same units and fields; preserve the exact amount, respecting the target safe-integer range and amount/visibility constraint |
| `billing_period`, `unit`, `active` | Same target fields, respecting target null/length constraints |

The developer SQL seeds `identity`, `ehr`, `laboratory`, `pharmacy`, `migrate`,
`outreach` and `api`, and eleven price coordinates. SQL validates generic slug
syntax; it does not constrain the product table to exactly seven rows. The
current presentation catalogue and local migration mapper support the seven
listed products. An unmatched eighth product must be inspected before deciding
whether additional application support is needed.

Product description, standalone/addon availability, public visibility, trial
eligibility, subscription type, default billing cycle, setup fee and display
order have no equivalent columns in this target product table. Presentation
copy and available contexts are partly static in the browser catalogue. Do not
equate an old visibility/availability flag to a different status or discard it.

Local implementation:
`services/ehr-api/scripts/customer-configuration-mapping.mjs:1` already handles
supported product/price changes, UUID relationships, exact source hashes,
target baselines, authorization, audit and safe repeats. The complete source
rows and target baseline are needed to prepare the real mapping entries.
No developer restatement is required for exact matching fields and slugs.

## 2. Platform controls: six conversions are defined and enforced

Target SQL: `services/ehr-api/database/migrations/0039_platform_control_settings.sql:12`.
Runtime accessor: `services/ehr-api/database/migrations/0040_platform_control_enforcement.sql:1`.
Reader/writer: `services/identity-api/src/admin/admin.service.ts` methods
`platformControls` and `setPlatformControl`.
Admin routes: `services/identity-api/src/admin/admin.controller.ts:34`.

| Source flag | Target `control_key` | Runtime consumer |
| --- | --- | --- |
| `patient_portal_enabled` | `patient_portal_enabled` | Identity and EHR security guards for patient requests |
| `hospital_portal_enabled` | `provider_portal_enabled` | Identity and EHR security guards for workforce requests |
| `outreach_portal_enabled` | `outreach_portal_enabled` | Outreach security guard |
| `maintenance_mode` | `maintenance_mode` | Identity, EHR and Outreach guards; platform administrators are exempt |
| `uploads_enabled` | `uploads_enabled` | EHR document service |
| `break_glass_enabled` | `break_glass_enabled` | EHR consent service emergency-access command |

Consumer evidence:

- `services/identity-api/src/auth/security.guard.ts:137`.
- `services/ehr-api/src/auth/remote-security.guard.ts:56`.
- `services/outreach-api/src/auth/outreach-security.guard.ts:59`.
- `services/ehr-api/src/documents/document.service.ts` upload checks and
  `requirePlatformControl` method.
- `services/ehr-api/src/consent/consent.service.ts:66`.

The local mapper already contains these six conversions. Actual source
booleans and exact target baselines remain to be imported and reconciled.

The remaining `patient_signup_enabled`, `hospital_signup_enabled`,
`outreach_signup_enabled` and `migrate_portal_enabled` flags are sent by the
older web admin screen, but are absent from the six-key target constraint and
its accessor. No equivalent source-flag consumer was found in the current
runtime. A portal switch must not be substituted for a separate signup switch.
Preserve these four flags until the application supports or explicitly defers
their behavior.

## 3. Staff roles: role assignment exists; editable flag policies do not

Target vocabulary:
`services/ehr-api/database/migrations/0002_auth_and_canonical_identity.sql:44`
and `0006_phase1_authorization_vocabulary.sql`.
Runtime authority reader:
`services/identity-api/src/auth/current-staff-context.service.ts:96`.
Existing role importer:
`services/ehr-api/scripts/promote-legacy-identity.mjs:276` and `:1069`.

The importer already keeps identical doctor/clinician/nurse/pharmacist/
receptionist/admin/org_admin roles and maps `laboratory` and `lab_technician`
to `lab`. Assignments are scoped to the exact facility membership. Missing
facility and privileged legacy platform assignments receive migration holds.
This assignment mapping is not an unresolved developer input.

The old six flags are still represented in
`apps/web/src/types/admin.ts:323` and sent by
`apps/web/src/services/adminDashboard.ts:815`:

- `can_open_dashboard`
- `can_use_standard_access`
- `can_view_patient_records`
- `can_create_records`
- `can_use_break_glass`
- `can_view_history`

Current controllers enforce action permissions, rather than these flags. For
example, emergency access requires both `identity.consent.write` and
`identity.break-glass.write`; note writing requires `ehr.note.write`; audit
reading requires `audit.read`. These are traceable from the controllers, but
do not define a complete old-flag-to-permission conversion, especially for
dashboard access and broad record/upload writing.

No current backend implements the legacy `update_staff_role_policy` action or
reads those six flags to restrict access. Assigning seeded role permissions
does not prove that all existing false/deny flags are honored. An active-policy
port needs explicit enforcement and denial tests before staff acceptance.
The local configuration archive preserves the original five policies without
granting permissions.

## 4. Billing: old screen contract exists, operational backend is absent

`apps/web/src/pages/admin/AdminBilling.tsx:18` requests `admin-billing` and
expects products, prices, plans, subscriptions, invoices, payments, organization
records, metrics and settings. Line 31 displays `default_trial_days` and
`grace_period_days`. Its actions include `save_product`, `save_price` and
`set_subscription_status`.

The current Identity backend provides product/pricing endpoints, but no
corresponding billing-settings table/service/controller was found for the
source currency, trial/grace, proration, late-fee and restriction-policy fields.
Sending the old billing response through the pricing endpoint would not
satisfy the expected response or implement subscriptions.

`apps/web/HID_COMMERCIAL_BILLING_UPDATE.md:26` refers to
`20260722220000_platform_billing_subscriptions.sql` and `admin-billing`.
Neither the dated SQL file nor that server function is tracked in this commit.
The document describes the retired implementation; it is not evidence of an
operational RDS counterpart.

Decision needed only for application activation: port the existing feature
and its original contract, or record its release deferral. Exact source
preservation does not require a new billing engine.

## 5. AI routes: old screen contract exists; OCR uses a different runtime

`apps/web/src/types/admin.ts:468` defines workload, processing strategy,
primary/fallback model UUIDs and configuration version. The screen writes
those fields in `apps/web/src/pages/admin/AdminAiProcessing.tsx:318` and calls
`admin-ai-processing` through `apps/web/src/services/adminDashboard.ts:340`.

The current production OCR worker selects Textract from runtime configuration:
`services/ocr-worker/src/config.ts:18` and `services/ocr-worker/src/main.ts:14`.
It claims jobs through `ocr.claim_worker_job` and records extraction provenance.
It does not read `hid_ai_workload_routes`, a replacement model registry, or
those primary/fallback UUIDs. These old routes do not configure the patient
chatbot or establish Bedrock model access.

`apps/web/HID_PLATFORM_ADMIN_AI_PROCESSING_UPDATE.md:38` refers to
`20260722100000_admin_ai_processing_infrastructure.sql`, `admin-ai-processing`
and retired worker functions. Those operational counterparts are not tracked
in this commit. Preserve the eight existing routes. Activating their old
behavior requires an application implementation or an explicit release
deferral; it cannot be achieved by inventing a model-ID conversion.

## 6. Concrete browser/API integration gap

The shared browser client sends function invocations to
`/api/v1/functions/<name>` by default:
`packages/identity-browser-client/src/identityApiConfig.ts:6` and
`packages/identity-browser-client/src/identityClient.ts:567`.
The staging frontend build permits the documented public inputs and does not
set a custom function-path override.

`gateway/nginx.conf.template` proxies the REST namespaces auth, identity,
admin, commercial, EHR, OCR, outreach, laboratory and pharmacy. Other `/api/`
requests receive `API_ROUTE_NOT_FOUND`. No function compatibility controller
or gateway rewrite for the following traced requests exists in this commit:

| Browser request | Existing native equivalent / remaining gap |
| --- | --- |
| `functions/public-pricing` from `apps/web/src/pages/Pricing.tsx:11` | `GET /api/v1/commercial/pricing` exists, but this browser caller is not connected to it; its failure path displays contact-sales fallback |
| `functions/admin-platform-controls` | `GET/POST /api/v1/admin/controls` exists for the six supported keys; old object-shaped payload/response needs adaptation |
| `functions/admin-billing` | Pricing endpoints cover catalogue fields only; full billing response/actions have no equivalent |
| `functions/admin-role-management` policy actions | Modern platform account-role commands exist, but do not implement the old editable staff-policy contract |
| `functions/admin-ai-processing` | No equivalent dynamic routing/provider admin service found |

The billing/AI pages are still registered in `apps/web/src/App.tsx:238`.
The separate `apps/admin` frontend has governance and integration screens,
plus the local preserved-settings reader. Its route list does not implement
the old billing/AI screens or native pricing/control editors. Building the
frontends successfully does not prove these functions work after deployment.

Acceptance for this application gap: connect supported consumers to their
existing REST endpoints with exact response/payload handling and cross-role
checks; implement or explicitly defer the genuinely absent features. No AWS
credential or database dump fixes an unserved application route.

## Next implementation order derived from this trace

1. Obtain the complete protected source rows and target baselines; prepare
   exact product/price matches and the six defined control conversions.
   Escalate only unmatched values or unsupported behavior.
2. Connect the existing public pricing and supported control consumers to the
   existing APIs. Record exact differences rather than creating unused rows.
3. Resolve the absent billing, editable staff-policy and AI admin features,
   plus the four unmatched controls and unsupported product behavior, using
   the developer's original implementation or explicit release dispositions.
4. Keep every original setting preserved while those activation gaps remain.
   Run the accepted import and actual reconciliation once its existing release,
   recovery and rehearsal gates are met.

## Validation performed

Read-only searches covered the tracked browser packages, apps, gateway,
Identity/EHR/OCR runtime source and SQL migrations. Relevant callers and target
code were read directly. Git verified the integration HEAD and locally stored
developer branch at the commit above. The pricing/control schemas, old browser
callers, gateway and role reader are unchanged from that commit; the additional
archive/import code is existing local work. No live source values were printed,
and no runtime or AWS tests were performed for this documentation trace.
