# Phase 4 Stage 1: Platform Admin Foundation

Branch: `phase-4-admin-foundation` (base `phase-3-patient-safety`).
Status: implementation on a draft branch. Nothing here is deployed or migrated
against a live database.

Stage 1 makes Platform Admin requests work without a facility, fixes the
platform audit reader, and closes two account-management bypasses. It adds no
new administration capability. ADR-037 records the decisions.

## 1. Authoritative Admin UI

The Platform Admin frontend is `apps/patient-web/src/admin` in the
`D-Eminence/Health-id` repository. `apps/admin` in this repository is legacy
reference code. It is not deleted in this stage and gets no new features.
Both call the same `/api/v1/admin/*` contract.

## 2. Platform scope

Before Stage 1, admin routes were `@FacilityOptional()`. With no
`X-Facility-ID`, the request audit wrote a staff row without a facility, which
the audit service refuses, so every successful admin request returned 503.
With a header, the API borrowed the administrator's own facility membership
and recorded admin work against that facility.

| Layer | Behavior now |
|---|---|
| Routes | `@PlatformScope()` on `AdminController`, `IntegrationAdminController`, `AdminOrganizationApplicationsController`, `AdminDemoRequestsController`. |
| Guard | Binds no facility on platform routes and ignores a supplied `X-Facility-ID`. It strips the token's facility roles and permissions and checks only platform permissions. Facility routes check only the bound membership's permissions; platform permissions are no longer merged into them. |
| Context | `requireAdminContext` returns a `PlatformAccessContext` (`scope: 'platform'`, `facilityId: null`, `membershipId: null`). It requires a platform route and `platform.admin.access` (403 otherwise). |
| Database | `DatabaseService` sets `app.access_scope` (`platform` or `facility`) with the other request GUCs. Facility and membership GUCs are empty in platform scope. |
| Audit | Platform rows have `access_scope = 'platform'`, a staff actor with an account, and no facility, membership or organization. Facility rows are unchanged. |

Facility-scoped clinical and domain routes still require `X-Facility-ID` and an
active membership at that facility, and use only that membership's
permissions. A platform role grants no clinical access.

Staff sign-in still requires an active staff membership at an active facility
(`CurrentStaffContextService`). A platform-only account with no membership
cannot sign in. Platform routes do not use that membership. See section 7.

## 3. Audit integrity (0067)

`audit.events.access_scope` is new. Only `'platform'` relaxes the facility rules:

- `events_staff_facility_scope_check` and `events_staff_membership_scope_check`
  replace the two `0003` staff rules. The only addition is
  `access_scope IS NOT DISTINCT FROM 'platform'`. A plain `= 'platform'` would
  be NULL for ordinary rows and make the whole CHECK pass. The new suite
  includes a mutant for exactly that.
- `events_platform_scope_shape_check`: a platform row is a staff actor with a
  subject and an account, and no facility or membership.
- Trigger `audit_events_platform_scope` (BEFORE INSERT, security definer):
  - In a platform-scoped transaction it marks a facility-less staff row as
    platform, so SQL commands such as onboarding decisions need no change.
  - It rejects malformed platform rows (`23514 AUDIT_PLATFORM_SCOPE_INVALID`).
  - It requires an active `platform.admin.access` grant for a `success` row
    (`42501 AUDIT_PLATFORM_SCOPE_DENIED`). Denied and failed attempts stay
    recordable as evidence.
- Writes stay fail-closed. The API still returns 503 when an audit write fails;
  Stage 1 stops producing invalid writes instead of ignoring failures.
- The append-only trigger is unchanged; the scope cannot be edited later.

## 4. Platform audit reader (0067)

`audit.list_platform_events` declared `patient_id` but the `0027` query did not
select it, so every call failed (`42804`) and `GET /admin/audit/events`
returned 500. `0067` replaces the body only. The signature, the
`platform.audit.read` check, filters, page bounds, keyset ordering and
`security definer` are unchanged. The HTTP response still omits patient IDs and
free-form details.

`identity.organization_application_admin_account` (0046) keeps its membership
check for facility-scoped callers. In platform scope it requires the platform
permission alone (which already requires an active, unsuspended account).

## 5. Account status safety (0068)

`auth.admin_transition_account`, same signature and idempotency:

| From | `disabled` | `active` |
|---|---|---|
| `active` | allowed; records `disabled_from_status = active` | `ADMIN_NO_STATE_CHANGE` (409) |
| `pending_reset` | allowed; records `pending_reset` | `ACCOUNT_RECOVERY_REQUIRED` (409) |
| `locked` | allowed; records `locked` | `ACCOUNT_RECOVERY_REQUIRED` (409) |
| `disabled` | `ADMIN_NO_STATE_CHANGE` (409) | restores the recorded status; `pending_reset` if none was recorded (disabled before 0068) |
| `deleted` | `ADMIN_COMMAND_INVALID` (400) | `ADMIN_COMMAND_INVALID` (400) |

- **Recovery is not bypassed.** Disabling and re-enabling restores the prior
  state rather than `active`. Re-enabling does not clear `disabled_until`.
- **Existing flows still work.** OTP recovery (0029) still moves `pending_reset`
  to `active`. Patient deletion (0064) still makes `deleted` terminal.
  Suspension still revokes sessions and bumps the token version.
- **Self-changes are blocked.** An administrator cannot change their own
  account status (`auth.admin_transition_account`) or their own platform roles
  (`auth.admin_change_platform_role`): `403 ADMIN_SELF_CHANGE_DENIED`. A full
  self-action policy is not implemented.
- **Last-Super-Admin protection is unchanged.** `schema.integration.sql`
  previously tested it with the Super Admin acting on their own account; the
  self guard now refuses that first. Its two assertions now expect
  `ADMIN_SELF_CHANGE_DENIED`. `platform-admin-scope.integration.sql` covers the
  last-Super-Admin refusal with a different administrator.

## 6. Tests

| Layer | Coverage |
|---|---|
| Unit (`auth/platform-scope.spec.ts`, admin specs) | Guard scope binding, header ignored, platform-only grants, facility routes still require facility, no clinical permission from platform roles, cross-facility denial, audit service and interceptor shapes, fail-closed audit, error mapping. |
| SQL (`platform-admin-scope.integration.sql`) | Platform audit rows and refusals, implicit marking, unchanged facility rule, invalid scope, reader pagination/filters/patient_id/authorization, onboarding gate in both scopes, every account transition, self guard, last Super Admin. Fails against 8 old-behavior mutants: 0027 reader, 0027 transition, pre-0067 checks, NULL-passing checks, no trigger, 0046 gate, no self guard, re-enable to active. |
| HTTP (`scripts/verify-platform-admin-runtime.mjs`) | Exact runtime role with the real guard, interceptor, controllers, services and database. Covers `/admin/session`, `/admin/overview`, `/admin/principals`, `/admin/audit/events` for unauthenticated, facility staff with and without a header, platform role without the permission, and valid admins without a header. Also covers audit pagination, platform-scoped rows, facility-route controls and account status. Against `c9f6ab4` it fails with the original 503. |

Wiring:

- The rehearsal (`tuf-staging-migration-rehearsal.mjs`) runs the new SQL suite
  automatically and records `platform_admin_runtime`.
- Container acceptance runs the SQL suite.

## 7. Security review

| Area | Result |
|---|---|
| Privilege escalation | Platform routes accept only platform grants, and SQL commands repeat their permission checks. Setting `app.access_scope` grants nothing: it only marks rows, and success rows need `platform.admin.access`. The self guard stops self-promotion and self-reactivation. |
| Scope separation | No facility is bound or borrowed on platform routes. Facility routes no longer accept platform permissions; no current facility route required one. |
| Clinical permissions | Unchanged. Platform roles hold no clinical permission (schema suite) and a platform role cannot reach a facility route without that facility's membership (unit + HTTP). |
| Audit integrity | Append-only. Platform rows are shape-checked and permission-checked in the database; facility rules are unchanged and mutation-tested. |
| Patient data | The admin audit response omits `patient_id`. Only the SQL function returns it, to platform audit readers. |
| Recovery bypass | Closed for `pending_reset`, `locked`, and disable/re-enable. |
| RLS and grants | No grant changes. The new helper and trigger function are revoked from PUBLIC; runtime roles call neither directly. |

Found during review, out of scope, and not fixed here:

| ID | Finding | Why it is deferred |
|---|---|---|
| S1 | A platform-only account (no staff membership) cannot sign in. | Changes login, token and session shape; needs an auth design decision. |
| S2 | Legacy `locked` accounts have no recovery path: OTP recovery accepts only `active`/`pending_reset`, and the admin command can no longer unlock them. No current code sets `locked`. | Needs a governed unlock or reset flow. |
| S3 | No MFA, step-up re-authentication or two-person approval for admin commands. | Explicitly excluded from Stage 1. |
| S4 | Principal export: the CSV newline escape is written as a literal `\n`, and the 10,000-row export is unbounded by role. | Exports redesign is excluded. |
| S5 | `platform_operations_admin` holds `platform.control.manage` (maintenance and portal switches). | Needs a role-policy decision. |
| S6 | The legacy `platform_admin` role still holds `principal.manage` and `role.manage`. | Needs a role migration decision. |
| S7 | No administrative surface for legal holds or session-event review. | New capability, out of scope. |

## 8. Remaining Phase 4

- MFA/TOTP, recovery codes, step-up re-authentication, two-person approval.
- Platform-only administrator sign-in (S1) and a governed `locked`-account
  recovery (S2).
- Organization, facility creation and editing, staff management.
- Patient support UI, exports redesign (S4), analytics, AI, billing,
  notification administration, case management.
- Retiring or consolidating `apps/admin` after the Health-id admin reaches parity.
