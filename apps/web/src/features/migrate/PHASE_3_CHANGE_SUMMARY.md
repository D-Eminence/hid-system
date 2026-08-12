# HID Migrate Phase 3 change summary

Status: implemented locally; retired hosted identity backend migrations/functions are not deployed
Scope: projects, teams, logical batches and work assignment only

## Persistent model

- Extended `hid_migration_projects` with controlled lifecycle status, description,
  record location, estimates, dates and creator lineage.
- Added tenant-scoped `hid_migration_batches`. These are logical operational batches;
  scan sessions, pages and storage remain Phase 4.
- Added `hid_migration_work_assignments` for project/batch ownership, priority, due
  date and work status.
- Added idempotency receipts keyed by staff account and `Idempotency-Key`.
- Added database triggers that reject organization/facility, project, batch, member
  and assignment scope mismatches.
- Added RLS read policies for batches and assignments using the Phase 2 project
  access predicate.

## Authorization and lifecycle

- Project creation is limited to an active organization administrator or a migration
  administrator already assigned within the same organization.
- The project creator becomes its first migration administrator.
- Project/member/assignment commands are checked against the active project role,
  HID staff account and current HID organization/facility membership.
- Project lifecycle transitions are constrained to:
  `draft → active/cancelled`, `active → paused/completed/cancelled`, and
  `paused → active/completed/cancelled`.
- Completed and cancelled projects are terminal.
- The last active project manager/administrator cannot be revoked.
- Every Phase 3 mutation writes an immutable HID audit event before a successful API
  response.

## API and frontend

- Added the authenticated `migration-operations` Edge Function.
- Added bounded cursor pagination for projects, members, eligible staff, batches and
  assignments.
- Added idempotent commands for project creation/lifecycle, member upsert/revocation,
  batch creation and work assignment.
- Replaced the visible Projects and Team fixtures with persistent, typed screens.
- Added first-project bootstrap for eligible organization administrators.
- Added project lifecycle controls, project selection, batch creation, staff role
  assignment, access revocation/restoration and work assignment.
- UI actions are hidden when the active project capability does not permit them.

## Verification and remaining deployment checks

- `npm run build` passes.
- `git diff --check` reports no patch whitespace errors.
- Unique constraints cover project references, batch references, membership and
  command idempotency.
- The retired hosted identity backend CLI is unavailable in this workspace. The migrations, RLS matrix,
  Edge Functions and concurrent command cases must still run in an ephemeral
  retired hosted identity backend test environment before deployment.

## Explicitly outside Phase 3

- Camera/file capture, scan sessions, source folders/documents/pages and uploads.
- Private storage paths, resumable uploads, checksum or malware processing.
- OCR, image processing, AI extraction/classification and durable workers.
- Validation, QA, patient matching, canonical patient creation or EHR import.

Do not begin Phase 4 without approval.
