# HID Markdown Documentation Audit

| Field | Result |
|---|---|
| Audit date | 2026-08-07 |
| Scope | Every Markdown and MDX file returned by the requested active-tree and upstream_snapshot inventories |
| Initial active-tree count | 1,226 files |
| Audit-report-adjusted active-tree count | 1,227 files, including this report |
| HID-owned active documents | 61 files, including this report |
| Generated/dependency documents | 1,166 files: 892 under `ehr/**/node_modules` and 274 under `identity/**/node_modules` |
| upstream_snapshot documents | 35 reference-only files |
| Markdown deleted | None |
| Runtime code modified by this audit | None |

## 1. Executive conclusion

The current authority set is coherent at the platform level. `CODEX.md` exists
with the exact required case, the named documents under `docs/` are present,
and the EHR and Identity source trees were not moved.

The audit found three kinds of documentation drift:

1. Active links and entry-point text still referred to deleted or superseded
   architecture material.
2. EHR-local AI and historical decision files claimed authority over the
   platform and included an unsafe direct-HID-without-consent instruction.
3. Identity deployment, Migrate, phase, and release documents described the
   retired hosted backend as current implementation.

Only narrow documentation corrections were made. Historical documents were not
deleted, restored, or broadly rewritten. No source from `upstream_snapshot`
was copied into the active tree.

## 2. Classification rules used

- **authoritative**: the exact platform authority set named by the task.
- **specialist/current-state**: implementation state, migration operations,
  review evidence, and this audit.
- **module-specific**: current repository, EHR, Identity, API, workflow, or UI
  documentation that remains subordinate to platform authority.
- **tool-specific**: active AI-agent instruction files.
- **historical/superseded**: obsolete architecture, retired-backend plans,
  release artifacts, or documents whose authority has been replaced.
- **generated/external**: dependency or vendored package documentation.

Every file is assigned exactly one classification.

## 3. HID-owned document matrix

| File | Classification | Purpose | Action | Finding |
|---|---|---|---|---|
| `./CODEX.md` | authoritative | Permanent repository, architecture, safety, migration, and Codex operating rules. | keep unchanged | Correctly names the authority hierarchy and mentions removed architecture files only in a do-not-recreate rule. |
| `./README.md` | module-specific | Concise repository entry point and localhost navigation. | update | Rewritten during this audit to link to root authority instead of duplicating or preserving the retired backend architecture. |
| `./docs/ARCHITECTURE.md` | authoritative | Target platform structure, service boundaries, data ownership, deployment, and integration architecture. | keep unchanged | Primary target-architecture authority. |
| `./docs/CODING_STANDARDS.md` | authoritative | Engineering, testing, security, migration, refactoring, and documentation standards. | keep unchanged | Consistent with the root rules. |
| `./docs/DATABASE.md` | specialist/current-state | Current database model, implemented migration subset, invariants, and pending approval gates. | update | Malformed status text and links to deleted authorities were corrected. |
| `./docs/DECISIONS.md` | authoritative | Accepted platform architecture decision records. | keep unchanged | Current decision authority. |
| `./docs/INTERFACE_CONTRACT.md` | authoritative | Platform API, identity, authorization, EHR, Lab, Pharmacy, OCR, storage, and event contracts. | keep unchanged | Current cross-service interface authority. |
| `./docs/MIGRATION_RUNBOOK.md` | specialist/current-state | Controlled legacy-identity-to-PostgreSQL migration and cutover procedure. | keep unchanged | Valid operational specialist document; does not authorize a live migration by itself. |
| `./docs/OFFLINE.md` | authoritative | Offline-first storage, synchronization, conflict, authentication, audit, and registration rules. | keep unchanged | Current offline authority. |
| `./docs/PRODUCT.md` | authoritative | Platform product definition, domains, operating environment, and product principles. | keep unchanged | Current product authority. |
| `./docs/README.md` | authoritative | Index and reading order for authoritative platform documentation. | keep unchanged | Correct docs-directory entry point. |
| `./docs/REVIEW_FINDINGS.md` | specialist/current-state | Senior-review findings produced against an earlier documentation proposal. | update | Clarified as historical specialist evidence whose reviewed authorities were partly superseded or removed. |
| `./docs/ROADMAP.md` | authoritative | Long-term technical delivery phases and future modules. | keep unchanged | Current roadmap authority. |
| `./docs/SECURITY.md` | authoritative | Authentication, authorization, consent, audit, facility isolation, PHI, NIN, file, and offline security. | keep unchanged | Current security authority. |
| `./docs/TASK.md` | authoritative | Current execution scope and completion requirements. | keep unchanged | Current task authority. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md` | specialist/current-state | Read-only assessment of legacy applications, risks, retained evidence, and discovery gaps. | update | Replaced the deleted target-schema authority link; unresolved legacy-source links remain historical evidence references. |
| `./docs/MARKDOWN_DOCUMENTATION_AUDIT.md` | specialist/current-state | This repository-wide Markdown inventory, classification, conflict, and action report. | keep unchanged | Created by this audit and self-listed so the post-audit inventory is complete. |
| `./ehr/AGENTS.md` | tool-specific | EHR-local AI coding instructions. | update | Now explicitly defers to CODEX.md and platform docs and fixes ambiguous/nonexistent local documentation references. |
| `./ehr/ARCHITECTURE.md` | module-specific | EHR local reference runtime, typed integration path, production boundaries, naming, and build. | keep unchanged | Its source-of-truth language is explicitly scoped to the local visual/runtime bundle, not platform architecture. |
| `./ehr/CLAUDE.md` | tool-specific | Legacy EHR reference-bundle playbook for AI agents and developers. | update | Now defers to root authority, scopes Babel guidance to the reference bundle, and removes the direct-HID-without-consent instruction. |
| `./ehr/DECISIONS (3).md` | historical/superseded | 2026-05-28 EHR privacy, consent, node, offline, billing, and repository decisions. | update | A prominent superseded banner neutralizes claims that this file wins over current platform authority; content is preserved as evidence. |
| `./ehr/INTERFACE_CONTRACT.md` | module-specific | Maintained EHR browser/API contract, identity boundary, clinical resources, onboarding, and gated modules. | keep unchanged | Consistent with Identity ownership and server-side authorization. |
| `./ehr/README.md` | module-specific | EHR localhost flow, reference-bundle scope, onboarding, integration code, and verification. | keep unchanged | Useful current operational knowledge; local canonical wording is scoped to the reference UI. |
| `./ehr/TODO.md` | module-specific | Completed local work and unresolved production gates. | keep unchanged | Useful current delivery boundary; does not override docs/TASK.md. |
| `./ehr/design (1).md` | historical/superseded | Prototype EHR design-system proposal and historical Claude-skill promotion notes. | update | Marked historical and non-authoritative; visual and accessibility claims require re-verification before reuse. |
| `./ehr/server/README.md` | module-specific | NestJS EHR API boundaries, local verification, migrations, storage, identity transition, and production gates. | keep unchanged | Useful current backend operations document. |
| `./ehr/server/src/lab/README.md` | module-specific | Placeholder Laboratory ownership boundary. | keep unchanged | Correctly prevents EHR from owning laboratory execution/results or patient identity. |
| `./ehr/server/src/outreach/README.md` | module-specific | Placeholder Outreach ownership boundary. | keep unchanged | Correctly prevents Outreach from inventing patient identity or clinical records. |
| `./ehr/server/src/pharmacy/README.md` | module-specific | Placeholder Pharmacy ownership boundary. | keep unchanged | Correctly separates prescribing intent from future dispensing/inventory ownership. |
| `./identity/hid-unified-package/.github/PULL_REQUEST_TEMPLATE.md` | module-specific | Pull-request validation, risk, and deployment checklist. | update | Replaced active retired-backend review prompts with PostgreSQL/NestJS authorization, consent, and audit checks. |
| `./identity/hid-unified-package/ADMIN_DASHBOARD_SETUP.md` | historical/superseded | Retired backend admin dashboard deployment, secrets, SQL-editor promotion, and observability setup. | consider deleting later | Unsafe as current setup guidance; retain only until any useful observability requirements are captured in current operations docs. |
| `./identity/hid-unified-package/CONTRIBUTING.md` | historical/superseded | Legacy branch, preview, deployment, backend-path, and secret-handling workflow. | merge useful content elsewhere | Preserve generic review and secret-handling rules in a future root contributing guide, then retire this backend-specific version. |
| `./identity/hid-unified-package/HID_COMMERCIAL_BILLING_UPDATE.md` | historical/superseded | Point-in-time commercial and billing implementation summary. | consider deleting later | Describes retired database/function artifacts and is not current platform authority. |
| `./identity/hid-unified-package/HID_DESIGN_SYSTEM_INVENTORY.md` | module-specific | Identity frontend tokens, shared components, shells, breakpoints, and design QA. | keep unchanged | Useful package-scoped UI inventory; its source-of-truth claim is scoped to implementation files. |
| `./identity/hid-unified-package/HID_MIGRATE_IMPLEMENTATION_STATUS.md` | historical/superseded | Point-in-time phase completion and verification claims for the retired Migrate backend. | consider deleting later | Useful as evidence only; current implementation status must be re-established against the consolidated architecture. |
| `./identity/hid-unified-package/HID_MIGRATE_OPERATIONS_RUNBOOK.md` | historical/superseded | Queue, import, security incident, recovery, and reconciliation procedure. | merge useful content elsewhere | Operational principles are valuable but must be rewritten for the current PostgreSQL/NestJS/worker architecture. |
| `./identity/hid-unified-package/HID_MIGRATE_PRODUCTION_IMPLEMENTATION_PLAN.md` | historical/superseded | Large gate-driven production plan based on the retired application/backend architecture. | merge useful content elsewhere | Retain domain analysis and safety gates only where they agree with docs/ARCHITECTURE.md, docs/ROADMAP.md, and docs/TASK.md. |
| `./identity/hid-unified-package/HID_MIGRATE_PRODUCTION_LAUNCH_RUNBOOK.md` | historical/superseded | Controlled launch, stop, rollback, reconciliation, and first-week review procedure. | merge useful content elsewhere | Useful release-safety content requires adaptation to current services and infrastructure. |
| `./identity/hid-unified-package/HID_MIGRATE_RELEASE_EVIDENCE_REGISTER.md` | historical/superseded | Pending staging and production evidence-gate register. | merge useful content elsewhere | The evidence categories remain useful, but ownership and artifacts need current-platform definitions. |
| `./identity/hid-unified-package/HID_MIGRATE_STAGING_UAT_PLAN.md` | historical/superseded | Synthetic staging pilot, UAT journeys, failure drills, and exit gates. | merge useful content elsewhere | Retain test scenarios after removing retired-backend environment assumptions. |
| `./identity/hid-unified-package/HID_MIGRATE_THREAT_MODEL.md` | historical/superseded | Migrate assets, trust boundaries, threats, controls, and residual risk. | merge useful content elsewhere | Security content is useful input to a current threat model, not current authority. |
| `./identity/hid-unified-package/HID_PLATFORM_ADMIN_AI_PROCESSING_UPDATE.md` | historical/superseded | Point-in-time admin AI/provider processing implementation summary. | consider deleting later | Depends on retired backend deployment artifacts and should not drive new architecture. |
| `./identity/hid-unified-package/HOSTINGER_DEPLOY.md` | historical/superseded | Legacy static-hosting build and infrastructure notes. | consider deleting later | Not the current consolidated localhost or target deployment model. |
| `./identity/hid-unified-package/PHASE_10_CHANGE_SUMMARY.md` | historical/superseded | Historical Migrate patient-folder integration summary. | consider deleting later | Release evidence only. |
| `./identity/hid-unified-package/PHASE_11_CHANGE_SUMMARY.md` | historical/superseded | Historical Migrate audit, security, and observability summary. | consider deleting later | Release evidence only. |
| `./identity/hid-unified-package/PHASE_12_CHANGE_SUMMARY.md` | historical/superseded | Historical testing and hardening summary. | consider deleting later | Release evidence only. |
| `./identity/hid-unified-package/PHASE_13_CHANGE_SUMMARY.md` | historical/superseded | Historical staging/UAT preparation summary. | consider deleting later | Release evidence only. |
| `./identity/hid-unified-package/PHASE_14_CHANGE_SUMMARY.md` | historical/superseded | Historical production-launch preparation summary. | consider deleting later | Release evidence only. |
| `./identity/hid-unified-package/PHASE_7_CHANGE_SUMMARY.md` | historical/superseded | Historical Migrate validation and QA implementation summary. | consider deleting later | Contains retired backend assumptions and even a malformed heading prefix; keep only as evidence. |
| `./identity/hid-unified-package/PHASE_8_CHANGE_SUMMARY.md` | historical/superseded | Historical patient matching and duplicate-resolution summary. | consider deleting later | Safety ideas remain useful but implementation claims are retired-backend-specific. |
| `./identity/hid-unified-package/PHASE_9_CHANGE_SUMMARY.md` | historical/superseded | Historical bulk import and HID/EHR integration summary. | consider deleting later | Implementation claims must not be treated as current canonical-write evidence. |
| `./identity/hid-unified-package/README.md` | module-specific | Current Identity portal runtime, folders, localhost routes, verification, and browser security rules. | keep unchanged | Accurately states the first-party REST/NestJS boundary and rejects the retired browser SDK/backend. |
| `./identity/hid-unified-package/VERCEL_DEPLOY.md` | historical/superseded | Legacy Vercel, retired backend, Turnstile, secret, and absolute-path deployment instructions. | consider deleting later | Contains stale retired service endpoints and an invalid machine-specific link. |
| `./identity/hid-unified-package/src/features/migrate/DATA_DICTIONARY.md` | module-specific | Human-readable Migrate field, naming, status-family, and document-category dictionary. | keep unchanged | Useful module contract; executable implementation remains subordinate to platform identity and clinical ownership. |
| `./identity/hid-unified-package/src/features/migrate/PHASE_1_CHANGE_SUMMARY.md` | historical/superseded | Historical Migrate module-foundation summary. | consider deleting later | Release evidence only. |
| `./identity/hid-unified-package/src/features/migrate/PHASE_2_CHANGE_SUMMARY.md` | historical/superseded | Historical Migrate auth, RBAC, and tenancy summary. | consider deleting later | Retired Edge Function/RLS implementation evidence. |
| `./identity/hid-unified-package/src/features/migrate/PHASE_3_CHANGE_SUMMARY.md` | historical/superseded | Historical Migrate projects, teams, batches, and assignments summary. | consider deleting later | Retired Edge Function/RLS implementation evidence. |
| `./identity/hid-unified-package/src/features/migrate/PHASE_4_CHANGE_SUMMARY.md` | historical/superseded | Historical capture/storage summary. | consider deleting later | Retired storage/backend implementation evidence. |
| `./identity/hid-unified-package/src/features/migrate/PHASE_5_CHANGE_SUMMARY.md` | historical/superseded | Historical processing, OCR, queue, and worker summary. | consider deleting later | Implementation must be revalidated against the current worker and storage architecture. |
| `./identity/hid-unified-package/src/features/migrate/PHASE_6_CHANGE_SUMMARY.md` | historical/superseded | Historical classification and extraction summary. | consider deleting later | Implementation must be revalidated against current OCR and clinical governance. |
| `./identity/hid-unified-package/src/features/migrate/README.md` | module-specific | Migrate module dependency boundary, domain ownership, naming, design integration, and phase claims. | update | Core ownership rules are useful, but phase-completion claims and implementation references should be reconciled with the current platform before active development. |

## 4. Corrections made

- Replaced the root README with a concise repository entry point linking to
  `CODEX.md`, `docs/README.md`, `docs/ARCHITECTURE.md`, and
  `docs/TASK.md`.
- Fixed the malformed status field and deleted architecture links in
  `docs/DATABASE.md`.
- Replaced the deleted target-schema link in
  `docs/architecture/CURRENT_STATE_ASSESSMENT.md` with current architecture
  and database documentation.
- Clarified `docs/REVIEW_FINDINGS.md` as historical specialist evidence for a
  superseded proposal.
- Updated `ehr/AGENTS.md` and `ehr/CLAUDE.md` to defer to root authority.
- Replaced the unsafe EHR tool instruction that allowed direct record access by
  HID without consent with the current server-side authorization rule.
- Added a non-authoritative historical banner to `ehr/DECISIONS (3).md`.
- Marked `ehr/design (1).md` as a historical design proposal.
- Updated the active Identity pull-request checklist from retired-backend
  migration/function checks to PostgreSQL and NestJS authorization, consent,
  and audit checks.

## 5. Architecture conflicts and stale authority statements

| Document | Conflict | Resolution |
|---|---|---|
| `README.md` | Duplicated the docs index and described the repository root as “this directory,” creating a misleading competing entry point. | Rewritten as navigation only. |
| `docs/DATABASE.md` | Linked deleted blueprint/schema documents as governing sources and had malformed status text. | Linked current architecture, decisions, and migration runbook. |
| `docs/REVIEW_FINDINGS.md` | Presented an implementation plan, governing blueprint, and target relational contract as the reviewed authority set. | Marked as evidence for a superseded proposal. |
| `ehr/AGENTS.md` | Told tools to follow an ambiguous local architecture file and a nonexistent local PRODUCT.md. | Added explicit root hierarchy and correct relative links. |
| `ehr/CLAUDE.md` | Said to follow it exactly, treated the prototype as the whole project, and instructed direct record access by HID without consent. | Scoped it to the EHR reference bundle and restored platform consent/authorization rules. |
| `ehr/DECISIONS (3).md` | Called itself the source of truth, said it wins over specifications, and declared retired source roots canonical. | Preserved content but added a superseded, non-authoritative banner. |
| `ehr/design (1).md` | Claimed Figma-canonical status and proposed promotion into a Claude skill despite conflicting current design/runtime instructions. | Marked historical and subject to re-verification. |
| Identity legacy deployment and Migrate documents | Described retired functions, storage, secrets, SQL-editor operations, and old paths as current. | Classified historical/superseded; no retired system was restored. |
| Identity pull-request template | Required active review of Supabase/Edge Function changes. | Updated to current PostgreSQL/NestJS checks. |
| `ehr/ARCHITECTURE.md` and `ehr/README.md` | Use “canonical” for the local visual/runtime bundle. | Accepted as module-scoped language because both explicitly separate the prototype from production authority. |
| Identity design inventory and Migrate data dictionary | Use “source of truth” for implementation tokens or executable field constants. | Accepted only as module-scoped implementation authority; platform identity, security, and clinical ownership still win. |
| `CODEX.md` | Names deleted architecture filenames. | Kept unchanged because the references are an explicit prohibition against recreating those files. |

## 6. Stale and broken links

The three active broken architecture-authority links were corrected. The
remaining 36 broken links are historical evidence pointers to deleted legacy
source paths or one stale machine-specific deployment path. They were not
redirected to unrelated current code and were not restored from the snapshot.

| Location | Missing target | Disposition |
|---|---|---|
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:115` | `../../identity/hid-unified-package/retired_identity_backend/config.toml` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:246` | `../../identity/hid-unified-package/retired_identity_backend/migrations/20260407130000_secure_backend_foundation.sql` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:246` | `../../identity/hid-unified-package/retired_identity_backend/migrations/20260723010000_defer_google_patient_registration.sql` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:248` | `../../identity/hid-unified-package/retired_identity_backend/migrations/20260723000000_add_controlled_permanent_account_purge.sql` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:248` | `../../identity/hid-unified-package/retired_identity_backend/migrations/20260724140000_enforce_soft_delete_before_permanent_purge.sql` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:249` | `../../identity/hid-unified-package/retired_identity_backend/functions/admin-user-export/index.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:249` | `../../identity/hid-unified-package/retired_identity_backend/functions/patients-records/index.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:250` | `../../identity/hid-unified-package/retired_identity_backend/functions/_shared/auth.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:251` | `../../identity/hid-unified-package/retired_identity_backend/migrations/20260613150000_share_invites.sql` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:252` | `../../identity/hid-unified-package/retired_identity_backend/migrations/20260530120000_outreach_self_signup.sql` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:252` | `../../identity/hid-unified-package/retired_identity_backend/migrations/20260602171000_purge_screenshot_users_and_fix_outreach_rls.sql` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:252` | `../../identity/hid-unified-package/retired_identity_backend/functions/outreach-signup/index.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:253` | `../../identity/hid-unified-package/retired_identity_backend/migrations/20260721143000_migrate_phase_8_patient_matching.sql` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:254` | `../../identity/hid-unified-package/retired_identity_backend/functions/_shared/otp.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:254` | `../../identity/hid-unified-package/retired_identity_backend/functions/_shared/upload-token.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:254` | `../../identity/hid-unified-package/retired_identity_backend/functions/outreach-signup/index.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:255` | `../../ehr/src/retired_identity_backendClient.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:260` | `../../identity/hid-unified-package/retired_identity_backend/migrations/20260526113000_admin_controls_and_staff_rbac.sql` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:260` | `../../identity/hid-unified-package/retired_identity_backend/functions/break-glass/index.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:262` | `../../identity/hid-unified-package/retired_identity_backend/fix-schema.sql` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:265` | `../../identity/hid-unified-package/retired_identity_backend/PRODUCTION_REPAIR.md` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:271` | `../../identity/hid-unified-package/retired_identity_backend/config.toml` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:271` | `../../identity/hid-unified-package/retired_identity_backend/functions/migration-worker-jobs/index.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:272` | `../../identity/hid-unified-package/retired_identity_backend/functions/admin-user-management/index.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:273` | `../../identity/hid-unified-package/retired_identity_backend/functions/_shared/notifications.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:274` | `../../identity/hid-unified-package/retired_identity_backend/migrations/20260501120000_create_outreach_module.sql` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:275` | `../../identity/hid-unified-package/retired_identity_backend/functions/_shared/auth.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:276` | `../../identity/hid-unified-package/retired_identity_backend/migrations/20260413113000_access_pin_and_secure_identity_helpers.sql` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:276` | `../../identity/hid-unified-package/retired_identity_backend/functions/access-request-create/index.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:277` | `../../identity/hid-unified-package/retired_identity_backend/functions/files-register-upload/index.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:277` | `../../identity/hid-unified-package/retired_identity_backend/functions/migration-capture/index.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:279` | `../../identity/hid-unified-package/retired_identity_backend/functions/patients-records/index.ts` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:281` | `../../identity/hid-unified-package/retired_identity_backend/config.toml` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:281` | `../../identity/hid-unified-package/retired_identity_backend/README.md` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./docs/architecture/CURRENT_STATE_ASSESSMENT.md:281` | `../../identity/hid-unified-package/retired_identity_backend/PRODUCTION_REPAIR.md` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |
| `./identity/hid-unified-package/VERCEL_DEPLOY.md:88` | `/home/l2e/V1/hid-unified-package/retired_identity_backend/.env.production` | Historical evidence target is absent from the active tree; no current replacement exists. Do not restore it from upstream_snapshot. |

Recommended follow-up: if a durable evidence archive is created, replace these
links with immutable archived-source references. Until then, convert them to
plain code references only if the team wants a zero-broken-link documentation
policy; doing so would be editorial cleanup rather than architectural recovery.

## 7. EHR documentation findings

- Current and useful module documents are `ehr/ARCHITECTURE.md`,
  `ehr/INTERFACE_CONTRACT.md`, `ehr/README.md`, `ehr/TODO.md`,
  `ehr/server/README.md`, and the Lab, Outreach, and Pharmacy boundary
  READMEs.
- These documents correctly preserve Identity as the patient authority, separate
  local demo behavior from production, reject browser database credentials, and
  require server-side facility, purpose, permission, consent, audit, and
  persistence.
- `ehr/AGENTS.md` and `ehr/CLAUDE.md` are the only HID-owned EHR tool
  instruction files. Their hierarchy and consent conflict were corrected.
- `ehr/DECISIONS (3).md` contains valuable early consent and break-glass
  reasoning, but its source roots and authority rules are obsolete.
- `ehr/design (1).md` contains potentially useful visual/accessibility ideas,
  but conflicts internally with the old CLAUDE color restriction and should not
  be treated as verified current design authority.
- The 892 EHR dependency Markdown files are generated/external and were not
  modified.

## 8. Identity documentation findings

- `identity/hid-unified-package/README.md` is current and correctly describes
  the first-party REST API, HttpOnly/CSRF session direction, and PostgreSQL/NestJS
  authority. It explicitly excludes the retired browser SDK/backend.
- The Migrate module README and data dictionary retain useful ownership and
  naming rules: Migrate does not own Patient, HID Identity, Medical Record,
  Facility, Staff, or Audit Event. The module README still needs a future
  reconciliation of its phase-completion claims.
- Admin setup, Vercel/Hostinger deployment, contributing, commercial/admin
  updates, the large Migrate implementation plan, staging/launch artifacts, and
  phase summaries are historical. Many describe retired functions, storage,
  secrets, SQL-editor workflows, or source paths that no longer exist.
- Outside this audit report's inventory of historical filenames and its account
  of the retired repository state, active authored guidance no longer instructs
  engineers to use Supabase. Historical concepts are represented as the
  “retired hosted identity backend”; this rename does not make those workflows
  current.
- Identity remains the sole source of canonical patient identity in current
  platform authority. No current module README grants EHR, Lab, Pharmacy,
  Outreach, or Migrate permission to create a competing patient system.
- The 274 Identity dependency Markdown files are generated/external and were not
  modified.

## 9. AI and tool instruction findings

The requested tool-file search returned eight files:

- `ehr/AGENTS.md`: HID-owned, tool-specific, corrected.
- `ehr/CLAUDE.md`: HID-owned, tool-specific, corrected.
- Six `AGENTS.md` files under Identity dependency packages: generated/external,
  package-local instructions only, not HID authority.

No root-case competitor such as `codex.md`, `Codex.md`, or `CODEX.MD` was
found. The root instruction file is exactly `CODEX.md`.

## 10. Root README and filename-case findings

The old root README either duplicated the docs index in the working tree or
represented the retired standalone Identity/Supabase repository in Git history.
It was not suitable as the consolidated repository entry point.

The replacement is intentionally short. It points engineers to the root rules,
documentation index, architecture, and current task without restating the
architecture.

The Linux filename check found exactly `CODEX.md` at the repository root and no
case variants.

## 11. Secret-file findings

Git ignore checks confirmed:

- root `.env.local` is ignored;
- EHR `.env`, `.env.development`, and server `.env` files are ignored;
- Identity `.env` and `.env.local` files are ignored;
- the existing safe `ehr/.env.example` and `ehr/server/.env.example` files
  are allowed and tracked.

No environment-file contents were printed. The nested Identity ignore rule would
also ignore a future `.env.example` inside that package, but no such example
file currently exists.

## 12. Files to consider deleting later

Nothing was deleted in this audit. After useful content is merged and evidence
retention is agreed, consider removing:

- `ehr/DECISIONS (3).md` and `ehr/design (1).md`;
- legacy Identity setup/deploy docs:
  `ADMIN_DASHBOARD_SETUP.md`, `VERCEL_DEPLOY.md`, and
  `HOSTINGER_DEPLOY.md`;
- the old Identity `CONTRIBUTING.md` after a root contributor guide replaces
  its generic review rules;
- `HID_MIGRATE_PRODUCTION_IMPLEMENTATION_PLAN.md` after accepted domain and
  safety decisions are represented in current platform docs;
- historical commercial/admin update files;
- Migrate phase change summaries, implementation status, staging/launch
  artifacts, and evidence registers after any required evidence is archived.

Do not delete any of these solely because they are old. Confirm that no legal,
security, migration, or release evidence obligation requires retention.

## Appendix A: Generated/dependency Markdown inventory

Each file below is classified **generated/external** with action **keep
unchanged**. These files are present only because the requested `find` command
excludes `./node_modules/*` at the repository root but does not exclude nested
`ehr/**/node_modules` or `identity/**/node_modules`.

- `./ehr/node_modules/@babel/code-frame/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/compat-data/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/core/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/generator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/helper-compilation-targets/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/helper-globals/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/helper-module-imports/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/helper-module-transforms/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/helper-plugin-utils/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/helper-string-parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/helper-validator-identifier/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/helper-validator-option/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/helpers/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/parser/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/plugin-transform-react-jsx-self/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/plugin-transform-react-jsx-source/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/template/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/traverse/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@babel/types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@esbuild/linux-x64/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@hookform/resolvers/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@jridgewell/gen-mapping/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@jridgewell/remapping/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@jridgewell/resolve-uri/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@jridgewell/sourcemap-codec/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@jridgewell/trace-mapping/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@rollup/rollup-linux-x64-gnu/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@rollup/rollup-linux-x64-musl/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@types/babel__core/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@types/babel__generator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@types/babel__template/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@types/babel__traverse/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@types/estree/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@types/node/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@types/prop-types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@types/react-dom/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@types/react/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/@vitejs/plugin-react/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/baseline-browser-mapping/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/browserslist/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/caniuse-lite/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/convert-source-map/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/csstype/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/debug/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/electron-to-chromium/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/esbuild/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/esbuild/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/escalade/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/gensync/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/js-tokens/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/js-tokens/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/jsesc/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/json5/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/json5/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/loose-envify/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/lru-cache/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/lucide-react/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/ms/license.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/ms/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/nanoid/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/node-releases/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/picocolors/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/postcss/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/react-dom/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/react-hook-form/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/react-refresh/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/react/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/rollup/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/rollup/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/scheduler/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/semver/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/source-map-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/typescript/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/typescript/SECURITY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/undici-types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/update-browserslist-db/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/vite/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/vite/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/yallist/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/node_modules/zod/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@angular-devkit/core/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@angular-devkit/core/node_modules/rxjs/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@angular-devkit/core/node_modules/rxjs/CODE_OF_CONDUCT.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@angular-devkit/core/node_modules/rxjs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@angular-devkit/schematics-cli/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@angular-devkit/schematics-cli/blank/project-files/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@angular-devkit/schematics-cli/node_modules/@inquirer/prompts/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@angular-devkit/schematics-cli/schematic/files/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@angular-devkit/schematics/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@angular-devkit/schematics/node_modules/rxjs/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@angular-devkit/schematics/node_modules/rxjs/CODE_OF_CONDUCT.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@angular-devkit/schematics/node_modules/rxjs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/checksums/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/client-s3/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/core/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/credential-provider-env/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/credential-provider-http/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/credential-provider-ini/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/credential-provider-login/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/credential-provider-node/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/credential-provider-process/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/credential-provider-sso/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/credential-provider-web-identity/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/middleware-sdk-s3/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/nested-clients/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/s3-request-presigner/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/signature-v4-multi-region/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/token-providers/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws-sdk/xml-builder/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@aws/lambda-invoke-store/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/code-frame/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/compat-data/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/core/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/core/node_modules/semver/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/generator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/helper-compilation-targets/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/helper-compilation-targets/node_modules/semver/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/helper-globals/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/helper-module-imports/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/helper-module-transforms/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/helper-plugin-utils/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/helper-string-parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/helper-validator-identifier/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/helper-validator-option/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/helpers/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/parser/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-async-generators/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-bigint/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-class-properties/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-class-static-block/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-import-attributes/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-import-meta/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-json-strings/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-jsx/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-logical-assignment-operators/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-nullish-coalescing-operator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-numeric-separator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-object-rest-spread/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-optional-catch-binding/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-optional-chaining/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-private-property-in-object/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-top-level-await/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/plugin-syntax-typescript/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/template/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/traverse/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@babel/types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@bcoe/v8-coverage/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@bcoe/v8-coverage/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@bcoe/v8-coverage/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@bcoe/v8-coverage/dist/lib/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@bcoe/v8-coverage/dist/lib/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@bcoe/v8-coverage/dist/lib/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@borewit/text-codec/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@colors/colors/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@cspotcode/source-map-support/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@cspotcode/source-map-support/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@cspotcode/source-map-support/node_modules/@jridgewell/trace-mapping/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@epic-web/invariant/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@inquirer/ansi/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@inquirer/checkbox/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@inquirer/confirm/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@inquirer/core/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@inquirer/editor/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@inquirer/expand/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@inquirer/external-editor/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@inquirer/input/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@inquirer/number/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@inquirer/password/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@inquirer/prompts/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@inquirer/rawlist/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@inquirer/search/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@inquirer/select/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@isaacs/cliui/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@isaacs/cliui/node_modules/ansi-regex/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@isaacs/cliui/node_modules/ansi-styles/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@isaacs/cliui/node_modules/emoji-regex/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@isaacs/cliui/node_modules/string-width/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@isaacs/cliui/node_modules/strip-ansi/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@isaacs/cliui/node_modules/wrap-ansi/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@istanbuljs/load-nyc-config/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@istanbuljs/load-nyc-config/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@istanbuljs/load-nyc-config/node_modules/argparse/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@istanbuljs/load-nyc-config/node_modules/argparse/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@istanbuljs/load-nyc-config/node_modules/js-yaml/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@istanbuljs/load-nyc-config/node_modules/resolve-from/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@istanbuljs/schema/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@istanbuljs/schema/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jest/core/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jest/diff-sequences/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jest/expect-utils/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jest/expect/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jest/pattern/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jest/reporters/node_modules/brace-expansion/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jest/reporters/node_modules/glob/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jest/reporters/node_modules/lru-cache/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jest/reporters/node_modules/minimatch/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jest/reporters/node_modules/path-scurry/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jest/reporters/node_modules/path-scurry/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jest/schemas/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jest/types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jridgewell/gen-mapping/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jridgewell/remapping/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jridgewell/resolve-uri/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jridgewell/source-map/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jridgewell/sourcemap-codec/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@jridgewell/trace-mapping/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@lukeed/csprng/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@nestjs/cli/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@nestjs/common/PACKAGE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@nestjs/common/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@nestjs/core/PACKAGE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@nestjs/core/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@nestjs/platform-express/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@nestjs/schematics/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@nestjs/schematics/dist/lib/application/files/js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@nestjs/schematics/dist/lib/application/files/ts/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@nestjs/schematics/node_modules/@angular-devkit/core/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@nestjs/schematics/node_modules/@angular-devkit/schematics/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@nestjs/schematics/node_modules/rxjs/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@nestjs/schematics/node_modules/rxjs/CODE_OF_CONDUCT.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@nestjs/schematics/node_modules/rxjs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@nestjs/testing/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@noble/hashes/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@paralleldrive/cuid2/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@phc/format/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@pkgjs/parseargs/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@pkgjs/parseargs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@sinclair/typebox/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@sinonjs/commons/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@sinonjs/commons/lib/prototypes/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@sinonjs/fake-timers/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@smithy/core/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@smithy/credential-provider-imds/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@smithy/fetch-http-handler/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@smithy/node-http-handler/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@smithy/signature-v4/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@smithy/types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@tokenizer/inflate/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@tokenizer/token/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@tsconfig/node10/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@tsconfig/node12/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@tsconfig/node14/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@tsconfig/node16/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/babel__core/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/babel__generator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/babel__template/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/babel__traverse/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/body-parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/connect/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/cookie-parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/cookiejar/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/eslint-scope/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/eslint/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/estree/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/express-serve-static-core/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/express/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/http-errors/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/istanbul-lib-coverage/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/istanbul-lib-report/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/istanbul-reports/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/jest/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/json-schema/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/methods/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/node/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/pg/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/qs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/range-parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/send/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/serve-static/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/stack-utils/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/superagent/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/supertest/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/validator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/yargs-parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@types/yargs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@ungap/structured-clone/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@unrs/resolver-binding-linux-x64-gnu/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@unrs/resolver-binding-linux-x64-musl/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@webassemblyjs/ast/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@webassemblyjs/floating-point-hex-parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@webassemblyjs/wasm-edit/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@webassemblyjs/wasm-parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@webassemblyjs/wast-printer/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@xtuc/ieee754/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/@xtuc/long/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/accepts/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/accepts/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/acorn-import-phases/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/acorn-walk/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/acorn-walk/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/acorn/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/acorn/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ajv-formats/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ajv-keywords/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ajv/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ansi-colors/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ansi-escapes/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ansi-regex/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ansi-styles/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ansis/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/anymatch/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/anymatch/node_modules/picomatch/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/append-field/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/arg/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/arg/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/argon2/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/argon2/argon2/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/argparse/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/argparse/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/array-timsort/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/asap/CHANGES.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/asap/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/asap/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/asynckit/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/babel-jest/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/babel-plugin-istanbul/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/babel-plugin-istanbul/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/babel-plugin-jest-hoist/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/babel-preset-current-node-syntax/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/babel-preset-jest/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/balanced-match/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/balanced-match/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/base64-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/baseline-browser-mapping/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/bcryptjs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/bl/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/bl/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/body-parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/body-parser/node_modules/content-type/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/bowser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/brace-expansion/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/browserslist/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/bs-logger/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/bs-logger/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/bser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/buffer-from/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/buffer/AUTHORS.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/buffer/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/busboy/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/bytes/History.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/bytes/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/call-bind-apply-helpers/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/call-bind-apply-helpers/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/call-bound/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/call-bound/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/callsites/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/camelcase/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/caniuse-lite/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/chalk/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/char-regex/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/chardet/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/chokidar/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/chrome-trace-event/CHANGES.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/chrome-trace-event/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ci-info/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ci-info/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cjs-module-lexer/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/class-transformer/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/class-validator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cli-cursor/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cli-spinners/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cli-table3/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cli-width/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cliui/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cliui/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cliui/node_modules/wrap-ansi/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/clone/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/co/History.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/co/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/collect-v8-coverage/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/collect-v8-coverage/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/color-convert/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/color-convert/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/color-name/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/combined-stream/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/commander/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/commander/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/comment-json/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/component-emitter/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/concat-stream/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/content-disposition/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/content-type/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/content-type/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/convert-source-map/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cookie-parser/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cookie-parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cookie-signature/History.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cookie-signature/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cookie/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cookie/SECURITY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cookiejar/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cors/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cosmiconfig/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/create-require/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/create-require/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cross-env/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/cross-spawn/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/debug/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/dedent/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/dedent/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/deepmerge/changelog.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/deepmerge/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/defaults/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/delayed-stream/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/depd/History.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/depd/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/detect-newline/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/dezalgo/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/diff/CONTRIBUTING.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/diff/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/diff/release-notes.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/dunder-proto/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/dunder-proto/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/eastasianwidth/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ee-first/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/electron-to-chromium/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/emittery/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/emoji-regex/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/encodeurl/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/enhanced-resolve/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/error-ex/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/es-define-property/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/es-define-property/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/es-errors/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/es-errors/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/es-module-lexer/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/es-object-atoms/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/es-object-atoms/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/es-set-tostringtag/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/es-set-tostringtag/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/escalade/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/escape-html/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/escape-string-regexp/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/eslint-scope/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/eslint-scope/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/esprima/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/esrecurse/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/esrecurse/node_modules/estraverse/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/estraverse/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/etag/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/etag/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/events/History.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/events/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/events/security.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/execa/node_modules/signal-exit/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/execa/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/exit-x/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/expect/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/express/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/express/node_modules/cookie-signature/History.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/express/node_modules/cookie-signature/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/fast-deep-equal/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/fast-json-stable-stringify/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/fast-safe-stringify/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/fast-safe-stringify/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/fast-uri/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/fb-watchman/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/file-type/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/finalhandler/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/finalhandler/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/find-up/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/foreground-child/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/fork-ts-checker-webpack-plugin/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/form-data/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/form-data/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/form-data/node_modules/mime-db/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/form-data/node_modules/mime-db/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/form-data/node_modules/mime-types/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/form-data/node_modules/mime-types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/formidable/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/formidable/README_pt_BR.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/forwarded/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/forwarded/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/fresh/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/fresh/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/fs-extra/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/fs-monkey/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/fs-monkey/docs/api/patchFs.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/fs-monkey/docs/api/patchRequire.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/fs.realpath/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/function-bind/.github/SECURITY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/function-bind/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/function-bind/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/gensync/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/get-caller-file/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/get-caller-file/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/get-intrinsic/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/get-intrinsic/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/get-package-type/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/get-package-type/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/get-proto/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/get-proto/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/get-stream/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/glob-to-regexp/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/glob/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/glob/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/glob/node_modules/balanced-match/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/glob/node_modules/balanced-match/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/glob/node_modules/brace-expansion/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/glob/node_modules/minimatch/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/glob/node_modules/minimatch/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/gopd/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/gopd/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/graceful-fs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/handlebars/node_modules/source-map/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/handlebars/node_modules/source-map/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/handlebars/release-notes.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/has-flag/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/has-symbols/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/has-symbols/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/has-tostringtag/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/has-tostringtag/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/hasown/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/hasown/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/helmet/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/helmet/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/helmet/SECURITY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/html-escaper/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/http-errors/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/http-errors/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/human-signals/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/human-signals/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/iconv-lite/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ieee754/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/import-fresh/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/import-local/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/imurmurhash/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/inflight/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/inherits/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ipaddr.js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/is-arrayish/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/is-fullwidth-code-point/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/is-generator-fn/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/is-interactive/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/is-promise/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/is-stream/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/is-unicode-supported/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/isexe/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/istanbul-lib-coverage/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/istanbul-lib-coverage/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/istanbul-lib-instrument/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/istanbul-lib-instrument/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/istanbul-lib-report/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/istanbul-lib-report/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/istanbul-lib-source-maps/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/istanbul-lib-source-maps/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/istanbul-reports/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/istanbul-reports/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/iterare/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jackspeak/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jackspeak/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-changed-files/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-circus/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-cli/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-config/node_modules/brace-expansion/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-config/node_modules/glob/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-config/node_modules/lru-cache/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-config/node_modules/minimatch/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-config/node_modules/path-scurry/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-config/node_modules/path-scurry/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-diff/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-docblock/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-each/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-haste-map/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-leak-detector/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-matcher-utils/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-mock/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-pnp-resolver/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-runtime/node_modules/brace-expansion/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-runtime/node_modules/glob/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-runtime/node_modules/lru-cache/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-runtime/node_modules/minimatch/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-runtime/node_modules/path-scurry/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-runtime/node_modules/path-scurry/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-util/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-validate/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-validate/node_modules/camelcase/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-worker/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest-worker/node_modules/supports-color/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jest/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jose/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jose/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/js-tokens/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/js-tokens/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/js-yaml/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jsesc/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/json-parse-even-better-errors/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/json-parse-even-better-errors/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/json-parse-even-better-errors/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/json-schema-traverse/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/json5/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/json5/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jsonc-parser/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jsonc-parser/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jsonc-parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jsonc-parser/SECURITY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/jsonfile/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/leven/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/libphonenumber-js/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/libphonenumber-js/CODE_OF_CONDUCT.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/libphonenumber-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/lines-and-columns/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/load-esm/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/loader-runner/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/locate-path/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/lodash.memoize/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/lodash/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/log-symbols/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/lru-cache/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/magic-string/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/make-dir/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/make-error/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/makeerror/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/math-intrinsics/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/math-intrinsics/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/media-typer/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/media-typer/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/memfs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/merge-descriptors/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/merge-stream/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/methods/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/methods/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/mime-db/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/mime-db/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/mime-types/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/mime-types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/mime/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/mime/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/mimic-fn/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/minimatch/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/minimist/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/minimist/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/minipass/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/minipass/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ms/license.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ms/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/multer/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/multer/node_modules/media-typer/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/multer/node_modules/media-typer/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/multer/node_modules/mime-db/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/multer/node_modules/mime-db/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/multer/node_modules/mime-types/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/multer/node_modules/mime-types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/multer/node_modules/type-is/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/multer/node_modules/type-is/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/mute-stream/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/napi-postinstall/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/natural-compare/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/negotiator/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/negotiator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/neo-async/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/node-abort-controller/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/node-abort-controller/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/node-addon-api/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/node-addon-api/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/node-addon-api/tools/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/node-emoji/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/node-gyp-build/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/node-gyp-build/SECURITY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/node-int64/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/node-releases/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/normalize-path/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/npm-run-path/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/object-assign/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/object-inspect/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/on-finished/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/on-finished/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/once/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/onetime/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ora/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/p-limit/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/p-locate/node_modules/p-limit/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/p-locate/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/p-try/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/package-json-from-dist/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/package-json-from-dist/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/parent-module/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/parse-json/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/parseurl/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/parseurl/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/path-exists/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/path-is-absolute/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/path-key/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/path-scurry/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/path-scurry/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/path-scurry/node_modules/lru-cache/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/path-scurry/node_modules/lru-cache/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/path-to-regexp/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/path-type/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/pg-cloudflare/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/pg-connection-string/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/pg-int8/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/pg-pool/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/pg-protocol/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/pg-types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/pg/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/pgpass/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/picocolors/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/picomatch/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/pirates/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/pkg-dir/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/pluralize/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/postgres-array/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/postgres-bytea/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/postgres-date/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/postgres-interval/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/pretty-format/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/pretty-format/node_modules/ansi-styles/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/proxy-addr/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/proxy-addr/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/punycode/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/pure-rand/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/pure-rand/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/qs/.github/SECURITY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/qs/.github/THREAT_MODEL.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/qs/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/qs/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/qs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/range-parser/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/range-parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/raw-body/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/react-is-18/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/react-is-19/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/readable-stream/CONTRIBUTING.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/readable-stream/GOVERNANCE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/readable-stream/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/readdirp/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/reflect-metadata/AUTHORS.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/reflect-metadata/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/require-from-string/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/resolve-cwd/node_modules/resolve-from/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/resolve-cwd/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/resolve-from/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/restore-cursor/node_modules/signal-exit/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/restore-cursor/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/router/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/router/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/rxjs/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/rxjs/CODE_OF_CONDUCT.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/rxjs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/safe-buffer/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/safer-buffer/Porting-Buffer.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/safer-buffer/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/schema-utils/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/schema-utils/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/schema-utils/node_modules/ajv-keywords/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/schema-utils/node_modules/ajv-keywords/keywords/dotjs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/schema-utils/node_modules/ajv/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/schema-utils/node_modules/ajv/lib/dotjs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/schema-utils/node_modules/json-schema-traverse/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/semver/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/send/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/serve-static/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/setprototypeof/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/shebang-command/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/shebang-regex/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/side-channel-list/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/side-channel-list/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/side-channel-map/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/side-channel-map/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/side-channel-weakmap/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/side-channel-weakmap/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/side-channel/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/side-channel/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/signal-exit/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/slash/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/source-map-support/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/source-map-support/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/source-map-support/node_modules/source-map/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/source-map-support/node_modules/source-map/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/source-map/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/split2/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/sprintf-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/stack-utils/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/stack-utils/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/statuses/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/statuses/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/streamsearch/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/string-length/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/string-width-cjs/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/string-width/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/string_decoder/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/strip-ansi-cjs/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/strip-ansi/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/strip-bom/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/strip-final-newline/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/strip-json-comments/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/strtok3/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/superagent/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/supertest/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/supertest/node_modules/cookie-signature/History.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/supertest/node_modules/cookie-signature/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/supports-color/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/symbol-observable/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/symbol-observable/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/synckit/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/tapable/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/terser-webpack-plugin/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/terser-webpack-plugin/node_modules/ajv-formats/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/terser-webpack-plugin/node_modules/jest-worker/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/terser-webpack-plugin/node_modules/schema-utils/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/terser-webpack-plugin/node_modules/supports-color/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/terser/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/terser/PATRONS.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/terser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/terser/node_modules/commander/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/terser/node_modules/commander/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/terser/node_modules/source-map-support/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/terser/node_modules/source-map-support/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/terser/node_modules/source-map/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/terser/node_modules/source-map/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/test-exclude/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/test-exclude/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/test-exclude/node_modules/glob/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/tmpl/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/toidentifier/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/toidentifier/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/token-types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ts-jest/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ts-jest/CONTRIBUTING.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ts-jest/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ts-jest/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ts-jest/TROUBLESHOOTING.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ts-jest/node_modules/type-fest/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ts-node/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ts-node/dist-raw/NODE-LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/ts-node/dist-raw/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/tsconfig-paths-webpack-plugin/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/tsconfig-paths-webpack-plugin/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/tsconfig-paths/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/tsconfig-paths/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/tsconfig-paths/node_modules/strip-bom/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/tslib/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/tslib/SECURITY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/type-detect/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/type-fest/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/type-is/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/type-is/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/type-is/node_modules/content-type/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/typescript/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/typescript/SECURITY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/uglify-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/uid/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/uint8array-extras/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/undici-types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/universalify/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/unpipe/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/unpipe/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/unrs-resolver/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/update-browserslist-db/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/uri-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/util-deprecate/History.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/util-deprecate/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/v8-compile-cache-lib/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/v8-compile-cache-lib/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/v8-to-istanbul/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/v8-to-istanbul/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/validator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/vary/HISTORY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/vary/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/walker/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/watchpack/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/wcwidth/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/wcwidth/docs/index.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/webpack-node-externals/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/webpack-node-externals/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/webpack-sources/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/webpack/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/webpack/node_modules/ajv-formats/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/webpack/node_modules/schema-utils/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/which/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/which/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/wrap-ansi-cjs/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/wrap-ansi/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/wrappy/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/write-file-atomic/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/write-file-atomic/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/xtend/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/y18n/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/y18n/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/yallist/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/yargs-parser/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/yargs-parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/yargs/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/yargs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/yn/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/yocto-queue/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/yoctocolors-cjs/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./ehr/server/node_modules/zod/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/code-frame/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/compat-data/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/core/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/generator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-annotate-as-pure/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-compilation-targets/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-create-class-features-plugin/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-create-regexp-features-plugin/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-define-polyfill-provider/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-globals/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-member-expression-to-functions/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-module-imports/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-module-transforms/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-optimise-call-expression/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-plugin-utils/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-remap-async-to-generator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-replace-supers/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-skip-transparent-expression-wrappers/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-string-parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-validator-identifier/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-validator-option/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helper-wrap-function/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/helpers/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/parser/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/parser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-bugfix-firefox-class-in-computed-class-key/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-bugfix-safari-class-field-initializer-scope/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-bugfix-safari-id-destructuring-collision-in-function-expression/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-bugfix-safari-rest-destructuring-rhs-array/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-bugfix-v8-spread-parameters-in-optional-chaining/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-bugfix-v8-static-class-fields-redefine-readonly/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-proposal-private-property-in-object/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-syntax-import-assertions/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-syntax-import-attributes/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-syntax-unicode-sets-regex/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-arrow-functions/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-async-generator-functions/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-async-to-generator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-block-scoped-functions/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-block-scoping/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-class-properties/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-class-static-block/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-classes/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-computed-properties/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-destructuring/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-dotall-regex/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-duplicate-keys/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-duplicate-named-capturing-groups-regex/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-dynamic-import/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-explicit-resource-management/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-exponentiation-operator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-export-namespace-from/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-for-of/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-function-name/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-json-strings/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-literals/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-logical-assignment-operators/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-member-expression-literals/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-modules-amd/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-modules-commonjs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-modules-systemjs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-modules-umd/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-named-capturing-groups-regex/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-new-target/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-nullish-coalescing-operator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-numeric-separator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-object-rest-spread/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-object-super/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-optional-catch-binding/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-optional-chaining/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-parameters/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-private-methods/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-private-property-in-object/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-property-literals/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-regenerator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-regexp-modifiers/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-reserved-words/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-shorthand-properties/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-spread/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-sticky-regex/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-template-literals/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-typeof-symbol/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-unicode-escapes/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-unicode-property-regex/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-unicode-regex/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/plugin-transform-unicode-sets-regex/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/preset-env/CONTRIBUTING.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/preset-env/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/preset-modules/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/template/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/traverse/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@babel/types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@fontsource/inter/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@fontsource/inter/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@fontsource/jetbrains-mono/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@fontsource/jetbrains-mono/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@jridgewell/gen-mapping/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@jridgewell/remapping/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@jridgewell/resolve-uri/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@jridgewell/source-map/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@jridgewell/sourcemap-codec/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@jridgewell/trace-mapping/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@oxc-project/types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@posthog/types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@remix-run/router/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@remix-run/router/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@remix-run/router/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@rolldown/binding-linux-x64-gnu/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@rolldown/binding-linux-x64-musl/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@rolldown/pluginutils/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@sentry/browser-utils/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@sentry/browser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@sentry/core/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@sentry/feedback/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@sentry/react/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@sentry/replay-canvas/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@sentry/replay/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/auth-js/AGENTS.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/auth-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/auth-js/migrations/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/auth-js/migrations/lockless-coordination.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/functions-js/AGENTS.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/functions-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/functions-js/migrations/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/phoenix/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/phoenix/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/postgrest-js/AGENTS.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/postgrest-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/postgrest-js/migrations/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/realtime-js/AGENTS.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/realtime-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/realtime-js/migrations/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/realtime-js/migrations/httpsend-server-version.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/storage-js/AGENTS.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/storage-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/storage-js/migrations/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/supabase-js/AGENTS.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/supabase-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@supabase/supabase-js/migrations/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@types/prop-types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@types/react-dom/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@types/react/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@types/trusted-types/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@vitejs/plugin-legacy/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/@vitejs/plugin-react/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/acorn/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/acorn/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/adler-32/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/babel-plugin-polyfill-corejs2/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/babel-plugin-polyfill-corejs3/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/babel-plugin-polyfill-corejs3/core-js-compat/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/babel-plugin-polyfill-regenerator/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/baseline-browser-mapping/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/browserslist-to-esbuild/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/browserslist/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/buffer-from/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/caniuse-lite/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/cfb/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/codepage/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/commander/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/commander/Readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/convert-source-map/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/core-js-compat/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/core-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/core-js/actual/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/core-js/es/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/core-js/full/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/core-js/internals/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/core-js/modules/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/core-js/stable/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/core-js/stage/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/core-js/web/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/crc-32/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/csstype/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/debug/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/detect-libc/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/dompurify/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/electron-to-chromium/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/es-errors/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/es-errors/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/escalade/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/esutils/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/fdir/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/fflate/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/fflate/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/frac/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/function-bind/.github/SECURITY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/function-bind/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/function-bind/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/gensync/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/hasown/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/hasown/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/iceberg-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/is-core-module/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/is-core-module/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/js-tokens/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/js-tokens/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/jsesc/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/json5/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/json5/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/lightningcss-linux-x64-gnu/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/lightningcss-linux-x64-musl/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/lightningcss/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/lodash.debounce/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/loose-envify/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/lru-cache/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/magic-string/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/meow/build/licenses.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/meow/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/ms/license.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/ms/readme.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/nanoid/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/node-releases/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/path-parse/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/picocolors/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/picomatch/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/postcss/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/posthog-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/posthog-node/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/preact/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/query-selector-shadow-dom/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/query-selector-shadow-dom/plugins/codeceptjs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/react-dom/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/react-router-dom/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/react-router-dom/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/react-router-dom/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/react-router/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/react-router/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/react-router/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/react/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/regenerate-unicode-properties/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/regenerate/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/regenerator-runtime/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/regexpu-core/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/regjsgen/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/regjsparser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/resolve/.claude/notes.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/resolve/.github/INCIDENT_RESPONSE_PROCESS.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/resolve/.github/THREAT_MODEL.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/resolve/SECURITY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/rolldown/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/scheduler/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/semver/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/source-map-js/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/source-map-support/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/source-map-support/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/source-map/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/source-map/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/ssf/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/supports-preserve-symlinks-flag/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/supports-preserve-symlinks-flag/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/systemjs/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/terser/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/terser/PATRONS.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/terser/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/tinyglobby/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/tslib/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/tslib/SECURITY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/typescript/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/typescript/SECURITY.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/unicode-canonical-property-names-ecmascript/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/unicode-match-property-ecmascript/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/unicode-match-property-value-ecmascript/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/unicode-property-aliases-ecmascript/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/update-browserslist-db/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/vite/LICENSE.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/vite/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/web-vitals/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/wmf/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/word/CONTRIBUTING.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/word/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/xlsx/CHANGELOG.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/xlsx/README.md` | generated/external | keep unchanged | Installed third-party package documentation.
- `./identity/hid-unified-package/node_modules/yallist/README.md` | generated/external | keep unchanged | Installed third-party package documentation.

## Appendix B: upstream_snapshot Markdown inventory

Every snapshot file is classified **historical/superseded** with action **keep
unchanged** and is reference material only. None was copied or promoted.

- `upstream_snapshot/.github/PULL_REQUEST_TEMPLATE.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/ADMIN_DASHBOARD_SETUP.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/CONTRIBUTING.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/HID_COMMERCIAL_BILLING_UPDATE.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/HID_DESIGN_SYSTEM_INVENTORY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/HID_MIGRATE_IMPLEMENTATION_STATUS.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/HID_MIGRATE_OPERATIONS_RUNBOOK.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/HID_MIGRATE_PRODUCTION_IMPLEMENTATION_PLAN.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/HID_MIGRATE_PRODUCTION_LAUNCH_RUNBOOK.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/HID_MIGRATE_RELEASE_EVIDENCE_REGISTER.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/HID_MIGRATE_STAGING_UAT_PLAN.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/HID_MIGRATE_THREAT_MODEL.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/HID_PLATFORM_ADMIN_AI_PROCESSING_UPDATE.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/HOSTINGER_DEPLOY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/PHASE_10_CHANGE_SUMMARY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/PHASE_11_CHANGE_SUMMARY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/PHASE_12_CHANGE_SUMMARY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/PHASE_13_CHANGE_SUMMARY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/PHASE_14_CHANGE_SUMMARY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/PHASE_7_CHANGE_SUMMARY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/PHASE_8_CHANGE_SUMMARY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/PHASE_9_CHANGE_SUMMARY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/README.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/VERCEL_DEPLOY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/src/features/migrate/DATA_DICTIONARY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/src/features/migrate/PHASE_1_CHANGE_SUMMARY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/src/features/migrate/PHASE_2_CHANGE_SUMMARY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/src/features/migrate/PHASE_3_CHANGE_SUMMARY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/src/features/migrate/PHASE_4_CHANGE_SUMMARY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/src/features/migrate/PHASE_5_CHANGE_SUMMARY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/src/features/migrate/PHASE_6_CHANGE_SUMMARY.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/src/features/migrate/README.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/supabase/PRODUCTION_API_VERIFICATION.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/supabase/PRODUCTION_REPAIR.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
- `upstream_snapshot/supabase/README.md` | historical/superseded | keep unchanged | Reference-only upstream snapshot; never current authority.
