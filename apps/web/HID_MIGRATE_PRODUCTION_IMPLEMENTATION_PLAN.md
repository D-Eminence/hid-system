# HID Migrate production implementation plan

Status: planning baseline for approval  
Date: 20 July 2026  
Scope: audit and plan only; no production implementation is authorized by this document.

## Executive decision

HID Migrate should be delivered as a protected module of the existing `hid-unified`
application and retired hosted identity backend project, not as a separate application or patient database.
It should reuse HID authentication, organizations, facilities, staff memberships,
patients, patient identifiers, medical records, record versions, private storage,
notifications, append-only audit events, observability and deployment workflows.

Migration workflow data should live in a dedicated set of tenant-scoped
`hid_migration_*` tables. Only approved, matched and import-ready data crosses the
boundary into canonical HID Patient and Medical Record entities. Original scans,
derived images, OCR, extraction, validation, QA and import lineage remain linked and
immutable where appropriate.

The current UI is a valuable product prototype. It is not a production backend.
The production frontend should preserve its workflow and responsive scanning
experience while replacing fixtures and simulated actions with typed APIs and
explicit loading, offline, failure, retry and permission states.

## 1. Current-state audit

### 1.1 Original HID Migrate ZIP

The ZIP is a React 18/Babel-in-browser prototype with no build step. `HID Migrate.html`
loads `primitives.jsx`, `migrate-data.jsx`, `migrate-scan.jsx`,
`migrate-sheets.jsx`, and `migrate-app.jsx`, using `tokens.css` and
`ehr-theme.css`.

Existing product surfaces:

| Area | Existing experience | Current behavior |
|---|---|---|
| Shell | HID bar, desktop rail, mobile bottom navigation and More drawer | Functional local navigation |
| Dashboard | Progress hero, KPI cards, quick actions, current scan CTA | Fixture values; local navigation |
| Projects | Project cards, statuses, progress and new-project sheet | Creation only emits a toast |
| Scanning | Camera-style capture, page thumbnails, quality warnings, retake, folder detection | Simulated capture; no camera, files or image processing |
| Folder detection | Extracted patient/folder fields and confirmation | Hardcoded AI result |
| Validation | Scan preview, OCR text, classification, confidence, approve/correct/reject | In-memory queue index only |
| Matching | Candidate cards, confidence and create/use HID actions | Hardcoded candidates; no identity search or write |
| Bulk import | Summary, rows, errors and confirmation sheet | Toast-only import/export |
| Patient folders | Folder list and physical-folder-inspired category view | Fixture records; category buttons show toasts |
| Team | Members, roles and output | Fixtures; invite sends a toast |
| QA | Accuracy and exception widgets | Static metrics |
| Reports | Report cards | “Generating” toast only |
| Search | Patient/folder filtering | In-memory fixture filtering |
| Modals/sheets | Project, invite, search and import confirmation | Local state only |
| Responsive UI | Mobile bottom navigation, drawers and bottom sheets; desktop side rail | Implemented at 640/860px breakpoints |
| Motion | Fast fade, slide and progress transitions | UI-only CSS animation |

Existing data fixtures include projects, role permissions, scans, OCR text,
classification, candidates, imports, team performance, folders, QA metrics and
reports. All are hardcoded in `migrate-data.jsx`.

Functional today:

- Screen navigation and local route-like state.
- Page capture simulation, retake and folder-stage transitions.
- Local validation queue progression.
- Local patient-match decisions.
- Form validation for basic project and invite sheets.
- Responsive desktop/mobile layouts and lightweight toasts.

UI-only or mocked:

- Camera access, uploads, edge detection and image enhancement.
- OCR, handwriting recognition, AI extraction and classification.
- Project, team, assignment, validation, QA and import persistence.
- Patient search, duplicate detection, HID creation and EHR writes.
- File storage, source preservation, audit, reports and notifications.
- Authentication, authorization, tenant isolation and role switching.

Incomplete or non-functional actions:

- Rotate, merge, rescan, correct, reject, export, generate report, invite,
  create project and import only update local state or show toasts.
- Project cards do not open persistent project details.
- Folder categories do not open canonical HID patient records.
- No pagination, virtualization, server search or resumable uploads.
- No real loading, offline, rate-limit, permission or dead-letter states.

Existing integrations and state:

- No API calls, backend, authentication or persistent storage.
- React `useState` plus window globals; no state library.
- CDN React/Babel/fonts; unsuitable for production CSP/offline guarantees.
- The standalone compiled HTML is an artifact and should not become source.

Preserve:

- Scan → detect folder → review → queue flow.
- Split scan/structured-data validation concept.
- Explicit human patient-match decision.
- Project, batch, team, QA and bulk-import information architecture.
- Mobile capture focus, desktop operational density and physical-folder metaphor.
- Fast, functional motion and HID typography/identifier treatment.

Refactor:

- Move routes into React Router and lazy route modules.
- Replace globals/fixtures with generated API types and query hooks.
- Replace hand-built duplicate controls with shared HID UI primitives.
- Use canonical repository breakpoints, error handling and accessibility.
- Point completed records to the existing patient record experience.

> Historical HID 1.0 planning evidence only. Provider, runtime, and deployment
> statements below do not describe the canonical target architecture. The
> authoritative migration process is `docs/MIGRATION_RUNBOOK.md`.

### 1.2 Current repository Migrate prototype

The current branch contains `/migrate/*`, `Migrate.tsx`, `Migrate.css`,
`types/migrate.ts` and an initial data dictionary. These are useful interaction
scaffolding, not production implementation. They remain fixture-driven and have no
authorization or backend. Production work should incrementally connect and split
these screens rather than presenting them as functional.

## 2. HID repository reuse audit

### 2.1 Architecture

- React 18 + TypeScript + Vite 8.
- React Router with lazy route preloading and error boundaries.
- retired hosted identity backend Auth, PostgreSQL, Storage, Realtime and Deno Edge Functions.
- Vercel frontend deployment and GitHub Actions build/audit/deploy workflows.
- Sentry error/performance monitoring and PostHog analytics with protected-route
  capture disabled by default.

### 2.2 Directly reusable

| Capability | Reuse |
|---|---|
| Authentication | retired hosted identity backend sessions, staff login/onboarding, MFA assurance and account lock/deletion checks |
| Tenant model | `hid_organizations`, `hid_facilities`, `hid_staff_memberships` |
| Staff | `hid_staff_accounts`, invites and active membership checks |
| Identity | `hid_patients`, HID code generation, normalization helpers and `hid_patient_identifiers` |
| Records | `hid_medical_records`, versions, `structured_data`, `info_type` and health events |
| Files | Private `medical-record-files` bucket, signed upload/download pattern, SHA-256 metadata |
| Audit | `hid_audit_events`, `hid_log_audit_event`, mutation-prevention trigger |
| Notifications | `hid_notifications` and realtime watchers |
| API style | Deno Edge Functions, `requireUser`, `requireRole`, validation helpers, JSON envelopes and sanitized errors |
| Security controls | RLS, platform feature controls, role policies, Turnstile, MFA and signed URLs |
| UI | `Button`, `Input`, `Select`, `Textarea`, `Card`, `Badge`, `Spinner`, `PageLoader`, `EmptyState`, `Modal`, `BottomSheet`, chips and selection cards |
| Clinical UI | `RecordSummaryCard`, `MedicalRecordMarkdownView`, health-information types and patient record pages |
| Design | Inter, JetBrains Mono, global color/radius/shadow tokens and responsive shell patterns |
| Observability | Sentry redaction, PostHog controls, structured Edge Function logs |
| Delivery | GitHub CI, npm audit, Vercel preview and production workflows |

### 2.3 Reuse with extension

- `hid_patient_identifiers` currently allows only HID code, phone and email.
  Add tenant-qualified hospital and legacy identifier types without weakening global
  HID uniqueness.
- `hid_staff_role` contains clinical roles only. Migration duties should be
  project-scoped assignments/capabilities, not global replacements for a clinician’s
  primary staff role.
- Medical records support generic category, `info_type` and JSON structured data.
  Canonical clinical schemas and controlled categories require strengthening before
  bulk import.
- Existing signed uploads are record-centric. Migrate needs pre-patient,
  project/folder/document-scoped uploads and multipart/resumable support.
- Current audit is append-only and suitable, but needs migration resource types,
  before/after hashes, job correlation and privileged document-view events.
- Current patient rows require `auth_user_id` and `user_profile_id`. Imported archive
  patients may have no portal account. Extend canonical Patient to support
  unclaimed identities and later account claiming; do not fabricate Auth users.
- Facility currently has no explicit branch/department hierarchy. Add canonical
  branch/department entities or a documented facility-parent strategy before Migrate
  invents local strings.

### 2.4 Not currently present

- Migration projects, roles, assignments, scan sessions and batches.
- Resumable pre-patient uploads and original/derived asset lineage.
- Image processing, OCR/AI provider adapters and durable job queues.
- Validation/QA tasks and adjudication.
- Deterministic/probabilistic identity matching and merge-correction workflow.
- Idempotent patient/record import orchestration.
- Production test suite; current CI only audits and builds.

## 3. Gap analysis

### Critical before production

- Canonical unclaimed-patient lifecycle and safe later portal claiming.
- Organization/facility/project RLS on every migration row and storage object.
- Real authentication, project-role RBAC and access revocation.
- Private resumable upload with malware/type/size validation and checksums.
- Durable job queue for image, OCR, AI, matching and imports.
- Original scan preservation and immutable lineage.
- Human validation, QA and audited state transitions.
- Duplicate-safe patient matching; no uncertain auto-merge.
- Idempotent per-patient import and partial-failure recovery.
- Canonical record schemas/categories and patient-folder integration.
- Audit coverage for document access and every privileged decision.
- Automated permission, tenant-isolation, import and matching tests.
- Backup/restore, monitoring, alerting and incident runbooks.

### High priority

- Offline-tolerant mobile capture and resumable synchronization.
- Configurable quality thresholds and sampling.
- Pagination, server search, bulk actions and large-project performance.
- Operational notifications and dead-letter/retry interfaces.
- Cost attribution per project/provider/page.
- Correction workflows for wrong match, attachment and imported clinical data.
- Data retention, legal hold and secure-deletion policy.

### Medium priority

- Advanced handwriting/table extraction.
- Operator productivity forecasting and configurable reports.
- Cross-project template libraries.
- Native mobile wrapper if browser/PWA camera limitations prove material.
- Automated form-template detection and mapping suggestions.

### Future enhancement

- On-device quality models and offline OCR.
- Active-learning feedback for hospital-specific forms.
- External interoperability exports such as FHIR where HID core adopts them.
- Human-in-the-loop model evaluation dashboards.

### 3.1 Canonical entity mapping

| Required concept | Repository state | Production decision |
|---|---|---|
| Patient / HID Identity | `hid_patients`, auth-linked profile and HID code | Reuse and extend for unclaimed identities; never duplicate |
| Hospital / Organization | `hid_organizations` | Reuse as tenant boundary |
| Facility | `hid_facilities` | Reuse |
| Branch | No canonical entity | Add organization-scoped branch or approved facility hierarchy |
| Department | No canonical entity | Add canonical facility department; reference by ID |
| Staff | `hid_staff_accounts` and memberships | Reuse; add project-scoped Migrate role |
| Encounter / Consultation | Generic medical record and health event only | Define canonical structured schema/entity before structured import |
| Diagnosis / Vitals | JSON health-information structures, no dedicated tables | Reuse controlled structured schema initially; normalize later with HID-wide approval |
| Laboratory Result | `info_type=lab_result` with limited fields | Extend canonical schema for analyte, value, unit, range, flag, specimen and verification |
| Prescription | `info_type=medication` with limited fields | Extend canonical schema for drug, dose, frequency, route, duration and prescriber |
| Admission / Discharge | Generic medical records | Add controlled schemas; avoid Migrate-only clinical tables |
| Radiology Report | Generic medical record | Add controlled category/schema |
| Referral | Outreach referral exists only in outreach scope | Define HID-wide referral entity/schema before direct structured import |
| Insurance / HMO | Patient coverage fields and generic record | Reuse coverage fields; preserve source form as record |
| Document / Attachment | Medical record, version and private record file | Reuse after import; stage originals in migration assets before matching |
| Consent | Generic medical record/share model, no clinical consent entity | Preserve as controlled consent document until HID-wide consent model exists |
| Invoice / Payment | Legacy prototype concepts only; no canonical production tables | Import as source documents until HID-wide billing entities are approved |
| Audit Event | Immutable `hid_audit_events` | Reuse with migration action/resource taxonomy |

Clinical values should retain original OCR and source spans even when a structured
target does not yet exist. Lack of a canonical entity is not permission to invent an
isolated Migrate entity; import the source document and defer structured promotion.

## 4. Naming and data dictionary

Repository convention is snake_case in database/Edge Function payloads and
snake_case TypeScript response types. Some write APIs currently use camelCase.
For new Migrate APIs, use snake_case wire fields and adapt to camelCase only in view
models. Existing core names are not renamed.

| Display name | Frontend property | API/database field | Entity | Type | Req. | Example |
|---|---|---|---|---|---|---|
| Patient ID | `patientId` | `patient_id` | Patient | UUID | system | `b6…` |
| HID Number | `hidCode` | `hid_code` | Patient | text | after identity creation | `HID-00018291` |
| First Name | `firstName` | `first_name` | Patient | text | yes | `Abdulrahman` |
| Middle Name | `middleName` | `middle_name` | Patient extension | text | no | `Tunde` |
| Last Name | `lastName` | `last_name` | Patient | text | yes | `Bello` |
| Full Name | `fullName` | `full_name` | Patient | text | derived/stored | `Abdulrahman Bello` |
| Date of Birth | `dob` | `dob` | Patient | date | no | `1984-03-12` |
| Gender | `gender` | `gender` | Patient | text | no | `male` |
| Phone Number | `phoneE164` | `phone_e164` | Patient | text | no | `+234803…` |
| Email Address | `email` | `email` | Patient | citext | no | `a@example.org` |
| NIN | never expose raw in lists | `nin_hash`, `nin_ciphertext`, `nin_last4` | Patient | encrypted/hash | no | `••••1234` |
| Organization | `organizationId` | `organization_id` | Organization | UUID | yes | UUID |
| Facility | `facilityId` | `facility_id` | Facility | UUID | yes | UUID |
| Branch | `branchId` | `branch_id` | Branch (new canonical entity) | UUID | no | UUID |
| Department | `departmentId` | `department_id` | Department (new canonical entity) | UUID | no | UUID |
| Hospital Number | `hospitalNumber` | `hospital_number` | Patient identifier | text | no | `H-220041` |
| Legacy Folder Number | `legacyFolderNumber` | `legacy_folder_number` | Patient identifier | text | no | `UI-04471` |
| Card/File/Registration Number | `legacyIdentifierValue` | `identifier_value` plus `identifier_type` | Patient identifier | text | no | `CARD-19` |
| Migration Project ID | `migrationProjectId` | `migration_project_id` | Migration project | UUID | yes | UUID |
| Project Reference | `projectReference` | `project_reference` | Migration project | text | yes | `MIG-PRJ-2041` |
| Migration Batch ID | `migrationBatchId` | `migration_batch_id` | Migration batch | UUID | yes | UUID |
| Scan Batch ID | `scanBatchId` | `scan_batch_id` | Scan batch | UUID | yes | UUID |
| Folder Reference | `folderReference` | `folder_reference` | Source folder | text | yes | `UI-04471` |
| Source Document ID | `sourceDocumentId` | `source_document_id` | Migration document | UUID | yes | UUID |
| Import Job ID | `importJobId` | `import_job_id` | Import job | UUID | yes | UUID |
| OCR Confidence | `ocrConfidence` | `ocr_confidence` | OCR result | decimal | no | `0.962` |
| Classification Confidence | `classificationConfidence` | `classification_confidence` | Classification | decimal | no | `0.88` |
| Validation Status | `validationStatus` | `validation_status` | Validation task | enum | yes | `approved` |
| QA Status | `qaStatus` | `qa_status` | QA task | enum | yes | `required` |
| Import Status | `importStatus` | `import_status` | Import item | enum | yes | `ready` |

Identifier rule: HID code is globally unique. Hospital and legacy identifiers are
unique only within an organization/facility/source system; enforce composite
uniqueness. Never store them as HID codes.

Canonical document mapping:

| Source label | Canonical category | HID target |
|---|---|---|
| Consultation note | `consultation` | Medical record / encounter extension |
| Lab report | `laboratory_result` | Medical record now; laboratory entity when available |
| Drug sheet | `prescription` | Medical record now; prescription entity when available |
| Admission sheet | `admission` | Medical record / admission extension |
| Discharge note | `discharge_summary` | Medical record |
| X-ray report | `radiology_report` | Medical record / radiology extension |
| Referral letter | `referral` | Medical record / referral extension |
| Insurance/HMO form | `insurance_document` / `hmo_document` | Medical record and coverage extension |
| Bill/receipt | `billing_document` | Medical record until invoice/payment entities exist |
| Consent form | `consent` | Medical record until consent entity exists |
| Unknown | `unclassified` | Migration staging only; cannot import as structured clinical data |

## 5. Proposed system architecture

### Frontend

- Existing Vite/React app and `/migrate/*` lazy module.
- Route-level authorization loader and active organization/facility/project context.
- Typed API client, server pagination and query caching.
- PWA capture where browser capability is sufficient; IndexedDB encrypted-at-rest
  queue for pending metadata/blobs only if threat modelling approves.
- Service worker must not cache PHI responses or documents.
- Shared HID components and canonical patient-record route for completed imports.

### Backend

- retired hosted identity backend Edge Functions for authenticated commands and read models.
- PostgreSQL functions for atomic state transitions and imports.
- A small dedicated worker service for long-running CPU/provider jobs. Do not run
  heavy OCR or image work in request/response Edge Functions.
- Transactional outbox in PostgreSQL feeding a durable queue. Start with a managed
  queue compatible with deployment operations; use one job contract regardless of
  provider.

### Database

- Existing PostgreSQL remains system of record.
- New tenant-scoped migration schema/tables with RLS.
- Core writes only through idempotent import functions.
- JSONB may retain provider payloads, but searchable/decision fields are typed
  columns with constraints.

### Storage

- Private buckets separated by environment.
- Migration path:
  `organizations/{org}/projects/{project}/folders/{folder}/documents/{document}/`.
- Separate immutable original and derived object keys.
- Signed upload/download URLs with 1-5 minute access, content length/type policy,
  checksum, object metadata and audit.
- Lifecycle rules move originals to lower-cost storage only after policy approval;
  never delete solely because import completed.

### OCR and AI

- Provider adapters with normalized requests/results, version, latency, page count,
  confidence, cost and raw-result reference.
- OCR, extraction/classification and matching are separate jobs.
- Model/provider/version and prompt/schema version stored with every result.
- No AI output writes canonical clinical records without validation policy.

### Queues

- States: `queued`, `leased`, `running`, `succeeded`, `retry_scheduled`,
  `dead_letter`, `cancelled`.
- Exponential backoff with jitter; provider-aware retry classification.
- Idempotency key per operation and payload version.
- Heartbeats and lease expiry recover abandoned work.
- UI reads aggregate progress from job and item tables, never waits synchronously.

### Authentication/authorization

- Reuse retired hosted identity backend Auth and MFA.
- Migrate roles are project assignments attached to active staff membership.
- Every request derives organization/facility from membership and project, never
  trusts client-supplied tenant scope alone.
- Platform admins require explicit support access with reason and audit; they do not
  implicitly browse all patient documents.

### Audit and monitoring

- Reuse immutable audit events, adding migration resource/action taxonomy,
  correlation ID, job ID, before/after hashes and actor/project context.
- Sentry for application/worker errors with PHI redaction.
- Structured logs with IDs, never OCR text or patient names.
- Metrics: queue age/depth, throughput, failure/retry/dead-letter rate, OCR/AI
  confidence drift, provider latency/cost, import success and storage consumption.

## 6. Database and data-model plan

### Existing entities to reuse

`hid_organizations`, `hid_facilities`, `hid_user_profiles`, `hid_staff_accounts`,
`hid_staff_memberships`, `hid_staff_invites`, `hid_patients`,
`hid_patient_identifiers`, `hid_medical_records`,
`hid_medical_record_versions`, `hid_medical_record_files`, `hid_health_events`,
`hid_notifications`, `hid_audit_events`, `hid_platform_controls`.

### Existing entities to extend

- Patient: make portal auth linkage nullable or introduce a canonical identity/portal
  account separation; add `identity_status` (`unclaimed`, `claimed`, `restricted`,
  `merged`) and claim workflow.
- Patient identifiers: add source/organization/facility, issuer and legacy types.
- Facility hierarchy: canonical branch/department tables or parent facility model.
- Medical record/category: controlled category and structured-schema version.
- Record file: source provenance and immutable content hash.
- Platform/role policies: Migrate feature flag and capabilities.

### New migration-specific entities

| Table | Purpose |
|---|---|
| `hid_migration_projects` | Tenant/facility project scope, estimates, dates, policy and status |
| `hid_migration_project_members` | Staff assignment, project role, dates and active state |
| `hid_migration_work_assignments` | Folder/batch/task ownership and priority |
| `hid_migration_batches` | Logical bulk source/import batch |
| `hid_migration_scan_sessions` | Operator/device/session/offline sync state |
| `hid_migration_source_folders` | Physical folder and legacy identifiers |
| `hid_migration_documents` | Logical multi-page source document and classification state |
| `hid_migration_pages` | Ordered page, original/processed object references and quality |
| `hid_migration_assets` | Immutable original/derived object metadata, checksum and lineage |
| `hid_migration_jobs` | Durable async job state, attempts, idempotency and provider |
| `hid_migration_ocr_results` | Versioned OCR output, page spans and confidence |
| `hid_migration_extractions` | Versioned structured candidate data and schema |
| `hid_migration_classifications` | Candidate category, confidence and model provenance |
| `hid_migration_validation_tasks` | Assignment, decision, corrected payload and history |
| `hid_migration_qa_tasks` | Sampling reason, reviewer, decision and disagreement |
| `hid_migration_match_candidates` | Patient candidate, feature scores and explanation |
| `hid_migration_match_decisions` | Human/system decision, reason and patient target |
| `hid_migration_mapping_templates` | Source-to-HID field mapping by facility/template |
| `hid_migration_import_jobs` | Import orchestration and aggregate status |
| `hid_migration_import_items` | Per-folder/patient idempotent import result |
| `hid_migration_cost_events` | Provider/page/token/storage cost attribution |

Important constraints:

- Every migration row carries `organization_id`; facility/project foreign keys must
  agree via trigger or composite FK.
- Unique project reference per organization.
- Unique folder reference per project/source system where configured.
- Unique page order per source folder/document; unique asset SHA-256 within project
  may flag duplicates but must not silently deduplicate originals.
- One active validation/QA lease per task.
- One final match decision per source folder version.
- Unique import idempotency key and one canonical target per import item.
- Approved/ imported rows are append-versioned, not overwritten.
- Core patient/record writes and import-item completion occur transactionally.

## 7. API plan

All list endpoints require cursor pagination, bounded page size, tenant filters and a
consistent `{ data, page, error }` envelope. Commands accept `Idempotency-Key`.

### Projects/team

- `GET/POST /migration-projects`
- `GET/PATCH /migration-projects/:id`
- `POST /migration-projects/:id/pause|resume|complete`
- `GET/POST/PATCH /migration-projects/:id/members`
- `GET/POST/PATCH /migration-projects/:id/assignments`

### Batches/scanning/uploads

- `GET/POST /migration-projects/:id/batches`
- `POST /migration-scan-sessions`; `PATCH /:id/heartbeat|finish`
- `POST /migration-folders`; `GET/PATCH /migration-folders/:id`
- `POST /migration-documents`; `PATCH /:id/reorder|split|merge`
- `POST /migration-assets/sign-upload`
- `POST /migration-assets/complete-upload`
- `POST /migration-assets/:id/sign-download`
- `POST /migration-pages/:id/process|retry`

### OCR/AI/jobs

- `GET /migration-jobs`; `GET /migration-jobs/:id`
- `POST /migration-documents/:id/ocr|extract|classify|retry`
- `GET /migration-documents/:id/ocr-results|extractions|classifications`
- Admin-only provider/cost/queue endpoints.

### Validation/QA

- `GET /migration-validation-tasks`
- `POST /migration-validation-tasks/:id/claim|release`
- `POST /migration-validation-tasks/:id/approve|correct|reject|send-back`
- `GET /migration-qa-tasks`
- `POST /migration-qa-tasks/:id/approve|return|escalate`

### Matching

- `POST /migration-folders/:id/find-patient-matches`
- `GET /migration-folders/:id/match-candidates`
- `POST /migration-folders/:id/match-decisions`
- `POST /migration-match-decisions/:id/revoke` with correction workflow.

### Imports

- `GET/POST /migration-mapping-templates`
- `POST /migration-import-jobs`
- `GET /migration-import-jobs/:id`
- `GET /migration-import-jobs/:id/items`
- `POST /migration-import-items/:id/retry|cancel`
- `POST /migration-import-jobs/:id/verify`

### Search/reports/audit/notifications

- `GET /migration-search`
- `GET /migration-reports`; `POST /migration-reports`
- `GET /migration-audit-events`
- Reuse notification list/read APIs; add migration notification preferences.

## 8. Security and privacy plan

Primary risks:

- Cross-tenant access through guessed IDs or storage paths.
- Staff over-privilege and stale project assignments.
- Public/long-lived file URLs and PHI in caches/logs/analytics.
- Wrong-patient attachment or duplicate identity creation.
- Malicious uploads, decompression bombs and embedded PDF content.
- Offline device loss and shared-device sessions.
- Provider retention/training of OCR/AI data.
- Bulk exfiltration through search/export/report functions.

Controls:

- RLS plus server-side membership/project checks on all tables and commands.
- Private buckets; signed URLs; object path scope; no public CDN.
- TLS, provider encryption at rest, key rotation and managed secrets.
- MFA for privileged roles; short idle sessions on shared scanning devices.
- Capability-based project roles and immediate revocation.
- MIME sniffing, extension allowlist, size/page limits, antivirus and PDF sanitizing.
- Encrypt sensitive offline cache, minimize retention and provide remote session
  revocation; do not cache documents in service worker.
- Mask NIN/phone in queues unless permission and task require full values.
- Audit view/download/export, matches, overrides and permission changes.
- Vendor BAAs/data-processing terms, regional processing and “no training” settings.
- Rate limits and anomaly detection for search, downloads and exports.
- Backups encrypted and restore-tested; legal retention and secure-delete workflows.
- Threat model and privacy impact assessment before staging with real data.

## 9. OCR and AI integration plan

### OCR

- Provider interface: `submit`, `poll/callback`, `normalize`, `estimate_cost`.
- Store raw provider output privately and normalized page/block/table output.
- Printed text is baseline; handwriting is a separately measured capability.
- Retry provider/transient errors automatically; quality failures return to scanning
  or validation. Never retry an invalid/corrupt source indefinitely.

### Image processing

- Deterministic pipeline before OCR: orientation, edges, perspective, deskew,
  contrast/shadow normalization and compression.
- Generate quality metrics for blur, blank, duplicate, crop and resolution.
- Preserve original bytes and record every derived asset’s parent/hash/algorithm
  version.
- Prefer on-device previews/quality hints, but repeat trusted processing server-side.

### AI extraction

- Schema-constrained output per document category.
- Separate demographic, clinical, lab and prescription schemas.
- Field-level value, source span/page and confidence.
- Preserve OCR text; corrections produce a new extraction version.

### Classification

- Controlled category list and explicit `unclassified`.
- Store top candidates and model version, not only final label.
- Low confidence, conflicts and sensitive categories route to validation.

### Patient matching

- Deterministic normalization first: HID code, tenant-qualified hospital identifier,
  verified phone/email and NIN hash where lawful.
- Probabilistic features: names, DOB, gender, address and identifier agreement.
- Explain every candidate score and conflicting field.
- Suggested initial bands, calibrated on representative data:
  exact = verified unique identifier with no conflict;
  strong ≥ 0.95; possible 0.75-0.949; weak 0.50-0.749; no match < 0.50.
- Strong is a recommendation, not an automatic merge, until governance approves a
  narrowly defined exact-match rule. Possible/weak always require manual decision.
- Maintain “review later”, “create new”, “link existing” and “escalate” outcomes.

## 10. Migration pipeline and state machine

Main states:

`draft → capturing → uploaded → image_processing → ocr_queued → ocr_processing →
ocr_complete → extraction_processing → needs_validation → validating → validated →
qa_required/qa_reviewing → qa_approved → matching → match_review →
ready_for_import → importing → verification → imported → completed`

Exceptional states are explicit: `upload_failed`, `processing_failed`,
`needs_rescan`, `validation_rejected`, `qa_returned`, `match_blocked`,
`import_failed`, `correction_required`, `cancelled`.

Rules:

- State transitions are server-authorized, transactional and audited.
- Every async transition has a durable job and idempotency key.
- Failed pages/items do not fail unrelated folders or an entire project.
- Import creates/links Patient, creates versioned records, attaches source files,
  verifies targets, then marks the item imported in one orchestration.
- Wrong match after import creates a correction case: freeze affected item, preserve
  history, detach through compensating versioned actions, rematch and re-import.
  Never delete audit/source evidence.
- Duplicate discovered later enters identity-resolution governance; no direct hard
  merge from Migrate UI.

## 11. Role and permission matrix

`✓` allowed, `A` assigned scope only, `R` read only, `-` denied.

| Capability | Migration Admin | Project Manager | Records Officer | Scanner | Validator | QA Reviewer |
|---|---:|---:|---:|---:|---:|---:|
| Create/manage project | ✓ | ✓ | R | - | - | - |
| Manage members/roles | ✓ | ✓ | - | - | - | - |
| Assign work | ✓ | ✓ | ✓ | - | - | - |
| Scan/upload | ✓ | ✓ | ✓ | A | - | - |
| Delete unsubmitted capture | ✓ | ✓ | A | A | - | - |
| View original documents | ✓ | ✓ | A | A | A | A |
| Run/retry processing | ✓ | ✓ | ✓ | A | - | - |
| Correct extraction | ✓ | ✓ | ✓ | - | A | A |
| Approve validation | ✓ | ✓ | A | - | A | - |
| Override classification | ✓ | ✓ | A | - | A | A |
| QA approve/return | ✓ | R | - | - | - | A |
| Decide patient match | ✓ | ✓ | A | - | A if assigned | A if escalated |
| Start import | ✓ | ✓ | - | - | - | - |
| Retry import item | ✓ | ✓ | R | - | - | R |
| View reports | ✓ | ✓ | R | own | own | QA scope |
| View audit | ✓ | project | own/project limited | own | own | assigned |
| Configure thresholds/providers | ✓ | - | - | - | - | - |

Separation of duties should be configurable: a scanner should not validate their own
work for regulated projects; QA should be independent for sensitive fields.

## 12. Testing plan

- Unit: normalization, scoring, state transitions, permissions, mapping, retry
  classification, schemas and cost calculation.
- Component: scan session, upload recovery, validation editor, conflict display,
  role navigation and accessible keyboard/touch flows.
- API: auth, validation, idempotency, pagination, rate limits and safe errors.
- Database: constraints, RLS for every role/tenant, audit immutability and atomic
  import functions.
- Storage: signed URL expiry, path isolation, checksum mismatch, malware, MIME,
  size/page limits and unauthorized download.
- Pipeline integration: image → OCR → extraction → validation → QA → match → import.
- Matching: exact, conflicting unique IDs, transliteration/name variance, missing DOB,
  twins/shared phones and false-positive/negative evaluation.
- Import: existing patient, new unclaimed identity, duplicate race, retry, partial
  batch failure, verification and compensating correction.
- E2E: each role’s critical path on desktop and mobile; offline/reconnect capture.
- Performance: concurrent operators, 10k+ folders, hundreds of thousands of pages,
  queue saturation, server pagination and search latency.
- Security: cross-tenant IDOR, RLS bypass, privilege escalation, signed URL replay,
  export abuse, session revocation and dependency scanning.
- Recovery: provider outage, dead-letter replay, database restore and storage restore.
- UAT: hospital records staff using representative de-identified records.

Release gates include zero critical/high security findings, zero tenant-isolation
failures, measured matching false-positive acceptance, restore test success and
signed clinical/data-governance approval.

## 13. Deployment plan

### Environments

- Local: retired hosted identity backend CLI, emulated storage, fake OCR/AI adapters and synthetic records.
- Test/CI: ephemeral database per run and deterministic provider fixtures.
- Staging: separate retired hosted identity backend project/buckets/queues/provider credentials; only
  de-identified or approved test data.
- Production: isolated database, storage, queue, secrets and monitoring.

### Configuration/secrets

Frontend retains public retired hosted identity backend, Turnstile, Sentry and PostHog variables. Server
adds queue credentials, upload signing secret, OCR/AI provider keys, webhook secrets,
cost tables and KMS references. Secrets live in provider/GitHub secret stores, never
Vercel client variables or repository files.

### CI/CD

- Extend CI with lint, unit, integration, migration verification, generated-type
  drift, RLS tests, E2E smoke and dependency/container scans.
- Preview deployments use fake providers and isolated backend.
- Database changes use forward-only migrations with expand/migrate/contract rollout.
- Workers deploy independently with versioned job schemas.
- Production requires approval, backup checkpoint, migration dry run and smoke test.
- Feature flag by organization/project enables a controlled pilot.

### Rollback

- Frontend/worker rollback to previous immutable artifact.
- Disable new jobs via platform control while existing leases drain.
- Database migrations remain backward compatible during rollout; corrective forward
  migration is preferred.
- Provider adapter fallback can reroute queued jobs.
- Import items use compensating, audited corrections rather than destructive rollback.

## 14. Implementation phases

### Phase 1 - Foundation and architecture alignment

- Objective: freeze contracts and convert the prototype into a clearly labelled
  protected module boundary.
- Reuse: routes, shared UI, types, Edge Function helpers and CI.
- Implement: architecture decisions, OpenAPI/schema generation, canonical statuses,
  feature flag and synthetic fixtures.
- Backend/database: migration schema namespace and base enums only.
- Frontend: split Migrate screens/routes; remove claims of functionality.
- Security: threat model and privacy impact assessment.
- Dependencies: product, clinical, legal and platform sign-off.
- Acceptance: approved data dictionary/state machine and no duplicate core entity.
- Tests: build, route, schema and status-contract tests.

### Phase 2 - Authentication, RBAC and multi-tenancy

- Objective: secure every Migrate route and resource.
- Reuse: retired hosted identity backend Auth/MFA, memberships, RLS and role-policy patterns.
- Implement: project-role assignments and active tenant context.
- Backend/database: project/member tables, RLS and capability functions.
- Frontend: protected routes, permission states and role-aware navigation.
- Security: IDOR/RLS tests, revocation and support-access governance.
- Dependencies: Phase 1.
- Acceptance: no cross-org/facility/project access; revoked user loses access.
- Tests: matrix API/RLS/E2E tests.

### Phase 3 - Projects, teams and work assignment

- Objective: persistent operational setup.
- Reuse: organizations, facilities, staff and invitations.
- Implement: projects, batches, team assignment, estimates and progress.
- Backend/database: project/batch/assignment tables and read models.
- Frontend: replace project/team fixtures and add pagination.
- Security: manager-only mutations and audited assignment changes.
- Dependencies: Phase 2.
- Acceptance: a manager can create, staff, pause and monitor a project.
- Tests: lifecycle, permission and concurrency tests.

### Phase 4 - Scanning, upload and file storage

- Objective: securely capture original pages at scale.
- Reuse: signed URL/token/checksum pattern and private storage.
- Implement: camera/file/PDF capture, resumable uploads, scan sessions and page order.
- Backend/database: folder/document/page/asset/session tables.
- Frontend: real camera APIs, device upload, retry, offline queue and quality states.
- Security: malware/MIME/size checks, short URLs, no PHI cache.
- Dependencies: Phase 3 and storage/vendor decisions.
- Acceptance: interrupted multi-page folder resumes without losing originals.
- Tests: device, offline, checksum, storage isolation and upload load tests.

### Phase 5 - Image processing and OCR

- Objective: produce versioned, reviewable OCR from preserved originals.
- Reuse: job/error/observability patterns.
- Implement: image worker, quality scoring, OCR adapter and retries.
- Backend/database: jobs, derived assets and OCR result tables.
- Frontend: progress, failures, rescan and provider-neutral confidence.
- Security: worker least privilege and PHI-safe logs.
- Dependencies: Phase 4, queue and OCR provider.
- Acceptance: printed multi-page documents process asynchronously and recover.
- Tests: poor scan, tables, duplicate/blank, timeout and provider outage.

### Phase 6 - AI extraction and classification

- Objective: generate schema-bound candidates, never silent clinical truth.
- Reuse: structured record JSON and health-information taxonomy.
- Implement: extraction/classification adapters, schemas and confidence routing.
- Backend/database: extraction/classification versions and model provenance.
- Frontend: field confidence and source-span display.
- Security: vendor retention controls and prompt-injection-safe document handling.
- Dependencies: Phase 5 and canonical clinical schemas.
- Acceptance: every field is traceable to source/model/version.
- Tests: schema validity, adversarial content, category and confidence evaluation.

### Phase 7 - Human validation and QA

- Objective: auditable human approval and configurable quality controls.
- Reuse: staff, audit and shared form/modal components.
- Implement: leases, correction versions, approvals, returns, sampling and escalation.
- Backend/database: validation/QA task and history tables.
- Frontend: production split view, keyboard workflow and conflict handling.
- Security: assignment scope and separation of duties.
- Dependencies: Phase 6.
- Acceptance: no required record bypasses validation/QA policy.
- Tests: concurrent claims, stale lease, disagreement and audit completeness.

### Phase 8 - Patient matching and duplicate resolution

- Objective: safely link/create canonical identities.
- Reuse: patients, normalization and identifiers.
- Implement: candidate generation, scoring, explanations and manual decisions.
- Backend/database: extended identifiers, candidates and decisions.
- Frontend: comparison, conflicts, review-later and escalation.
- Security: masked candidate data and restricted NIN use.
- Dependencies: Phase 7 and unclaimed-patient design approval.
- Acceptance: uncertain identities never auto-merge; races cannot duplicate exact IDs.
- Tests: matching corpus, duplicate races and wrong-match correction.

### Phase 9 - Bulk import and HID/EHR integration

- Objective: idempotent per-patient canonical writes.
- Reuse: HID creation, records, versions, files and audit.
- Implement: mapping templates, import orchestration and verification.
- Backend/database: import jobs/items and atomic core-write functions.
- Frontend: mapping review, item progress, errors and retries.
- Security: privileged import capability and source-to-target audit.
- Dependencies: Phase 8 and core schema extensions.
- Acceptance: one failed item does not fail the batch; retry creates no duplicates.
- Tests: partial failure, existing/new patient, attachment and rollback cases.

### Phase 10 - Patient Folder integration

- Objective: show imported data in existing patient experience.
- Reuse: patient records, health events, record cards and attachments.
- Implement: canonical category rendering and source/validation badges.
- Backend/database: read-model improvements only where necessary.
- Frontend: link Migrate completion to existing patient folder; no duplicate folder.
- Security: existing patient access rules and signed files.
- Dependencies: Phase 9.
- Acceptance: imported records appear in correct categories with source scan.
- Tests: category rendering, permissions and source download audit.

### Phase 11 - Audit, security and observability

- Objective: operational and forensic readiness.
- Reuse: audit, Sentry, PostHog, logs and platform controls.
- Implement: migration audit taxonomy, dashboards, alerts, costs and runbooks.
- Backend/database: cost events, aggregates and retention jobs.
- Frontend: actionable failure/queue/cost views by permission.
- Security: redaction verification and anomaly alerts.
- Dependencies: Phases 4-10.
- Acceptance: every critical action is attributable and failures are diagnosable.
- Tests: audit coverage, alert simulation and PHI log scanning.

### Phase 12 - Testing and production hardening

- Objective: meet all release gates.
- Reuse: GitHub Actions/Vercel.
- Implement: full automated suite, load/security testing, backup restore and DR drill.
- Backend/frontend/database: performance and accessibility fixes.
- Security: penetration test and dependency/container SBOM.
- Dependencies: Phases 1-11.
- Acceptance: readiness checklist passes with evidence.
- Tests: all Section 12 suites.

### Phase 13 - Staging deployment and UAT

- Objective: validate real workflows without production exposure.
- Reuse: preview/deployment workflows and staging retired hosted identity backend.
- Implement: de-identified pilot project, training and support procedures.
- Security: production-equivalent controls and access review.
- Dependencies: Phase 12.
- Acceptance: hospital UAT sign-off, measured accuracy and no severity-1 defects.
- Tests: end-to-end pilot, failover and operational drill.

### Phase 14 - Production launch

- Objective: controlled launch and monitored scale-up.
- Implement: one-organization feature-flag pilot, migration support desk, daily review
  and staged capacity increases.
- Security: final access/secret/vendor review.
- Dependencies: Phase 13 and formal go-live approval.
- Acceptance: stable SLOs, successful restore checkpoint, signed clinical/security
  approval and zero unresolved critical findings.
- Tests: production smoke, synthetic monitoring and first-batch reconciliation.

## 15. Production-readiness checklist

- Shared authentication and MFA enforced.
- Project RBAC and tenant/facility isolation proven by tests.
- Unclaimed patient lifecycle approved and claim-safe.
- Real private resumable uploads and original preservation work.
- Image, OCR and AI adapters are versioned, observable and retryable.
- Validation, QA, matching and duplicate prevention work.
- Imports are idempotent, per-item, recoverable and verified.
- New/existing HID paths and canonical EHR writes work.
- Existing patient folder displays imported records and sources.
- Audit includes uploads, views, edits, decisions, imports and access changes.
- No PHI in public URLs, analytics, logs or service-worker cache.
- Monitoring, queue/dead-letter, provider cost and storage alerts work.
- Backups and restore are tested.
- Desktop/tablet/mobile scanning are accessible and field-tested.
- Pagination/search/load performance meet agreed SLOs.
- No critical mocks, placeholder actions or dead ends remain.
- Security, privacy, clinical governance and hospital UAT approvals are recorded.

## Approval gates and unresolved decisions

Implementation must not begin until owners approve:

1. Canonical unclaimed Patient/account-claim architecture.
2. Branch and department canonical model.
3. Controlled clinical category and structured-data schemas.
4. Queue/worker hosting and OCR/AI providers, regions and data terms.
5. Retention/legal-hold/deletion policy for original medical records.
6. Matching thresholds and whether any exact-match case may bypass manual review.
7. QA thresholds, sampling and separation-of-duty policy.
8. Pilot organization, data volume, success metrics and support model.
