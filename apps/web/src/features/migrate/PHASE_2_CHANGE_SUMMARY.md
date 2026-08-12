# HID Migrate Phase 2 change summary

Status: implemented locally; database migration not applied to a remote environment  
Scope: authentication, project-scoped RBAC and tenant access boundary only

## Implemented

- Added the `hid_migration_role` database enum matching the canonical frontend role
  union.
- Added the minimal `hid_migration_projects` security boundary and
  `hid_migration_project_members` assignment table. Project lifecycle management,
  staffing workflows and operational project fields remain Phase 3.
- Validated every project assignment against the staff account's active HID
  organization/facility membership.
- Added a canonical role-to-capability function and project access/capability
  predicates.
- Enabled RLS on both migration tables. Authenticated users can read only projects
  to which they have a current, active assignment.
- Added an authenticated `migration-context` Edge Function. It reuses HID account
  lock/deletion, hospital-role policy, portal availability and MFA checks.
- Added `migrate_portal_enabled`, defaulting to `false`, to the existing platform
  controls and exposed it in the HID admin controls UI.
- Protected `/migrate/*` with a session/access gate. Signed-out users return to HID
  hospital authentication; unassigned users receive an explicit empty state.
- Removed the frontend role as an authority. Navigation is derived from the role on
  the server-returned active project assignment.
- Updated session bootstrap so `/migrate/*` loads a staff session and never attempts
  to bootstrap a patient session by default.

## Security decisions

- A platform administrator does not receive implicit Migrate workspace access.
- Organization/facility scope is derived from the project and active HID staff
  membership, not accepted from frontend input.
- Deactivating the staff account, HID membership, project assignment, project,
  organization or facility removes access on the next context request.
- Expired project assignments are rejected.
- The feature flag is disabled by default and must be explicitly enabled by a
  platform administrator after the migration and assignments are provisioned.
- No insert, update or delete RLS policy is exposed to authenticated clients in this
  phase.

## Verification

- `npm run build` passes.
- TypeScript compiles the protected route, context client and admin feature control.
- `git diff --check` reports no patch whitespace errors.
- The retired hosted identity backend CLI is not installed in this workspace, so the SQL migration has not
  been executed against a disposable local database here. It must be applied and
  exercised in the normal retired hosted identity backend test environment before deployment.

## Explicitly not implemented

- Project creation/editing, member management or work assignment UI/API.
- Operational batches, scanning, uploads, OCR, validation, QA, matching or imports.
- Support-access grants for platform administrators.
- Any canonical patient or medical-record schema change.

These items remain outside Phase 2. Do not begin Phase 3 without approval.
