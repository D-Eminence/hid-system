# Phase 4 Stage 5: platform administration release readiness

This is the combined release checklist for the platform administration work
of Phase 4. It covers Identity and the database in this repository, and the
admin console in Health-id (`apps/patient-web/src/admin`). It records what was
verified locally and what an operator must still do. **Nothing here has been
deployed, and no staging or production database has been migrated.** Every
"verified" below means a local synthetic environment unless it says otherwise.

## 1. What is being released

| Component | Source | Contents |
| --- | --- | --- |
| Database | `services/ehr-api/database/migrations` through `0072_platform_admin_contract_gaps.sql` | Phase 1–4 schema. The platform admin migrations are 0067–0072. Stage 5 adds no migration. |
| Identity API | `services/identity-api` on `main` (Stage 2A, 4A and Stage 5) | Platform MFA sessions, step-up, two-person approval and the Stage 4A admin contracts. Stage 5 adds the two fixes in §2. |
| Pharmacy API | `services/pharmacy-api` | Stage 5 CORS header fix (§2). |
| Admin console | Health-id `main` (Stage 4B and the Stage 5 fix) | The console for the contracts above. |

## 2. Stage 5 changes

- **Refresh-token revocation reason** (`token.service.ts`):
  - Only a rotated refresh token presented again is treated as reuse. Its family is revoked and `reuse_detected` is recorded, as before.
  - A token whose session ended any other way is refused. This covers sign-out, expiry, an administrator or account action, and an earlier reuse in the family. The refusal is recorded as a `refresh` session event with outcome `denied` and details `{ reason: 'session_ended', revocation_reason, session_kind }`. It is no longer recorded as reuse, and the family is not revoked again.
  - Answers are unchanged: platform `401 PLATFORM_SESSION_EXPIRED` (expired) or `PLATFORM_SESSION_REVOKED`, and generic `401 AUTHENTICATION_REQUIRED` for staff and patients. Only the problem `detail` changes, from "Refresh token reuse detected" to "Refresh session ended".
  - Before this fix, the console's normal refresh after an administrator revoked a session recorded `reuse_detected` twice per revocation. That made real token theft harder to spot.
- **CORS**:
  - Identity now allows `PATCH` (organization profile completion, `/identity/organization-applications/completion/profile`) and `DELETE` (patient access PIN, `/identity/me/access-pin`).
  - Pharmacy allows the `x-csrf-token` header that its cookie sessions send.
  - Origins, credentials and every other header are unchanged. No other service had a route whose method or header was missing. EHR's `PATCH` routes were already covered. Lab still lists `PATCH` without a route; that is left as is.
  - Same-origin `/api/v1` routing, the production design, never needed these. They matter only to a cross-origin deployment.
- **Admin console (Health-id)**: after **Revoke all sessions**, the confirmation stays visible. Before, the reload reported no sessions and the form, with its confirmation, disappeared. This was found by the browser run in §8.

## 3. Compatibility

| Identity build | Stage 3 console (Health-id `d5ce01c`) | Stage 4B console (`a180cea`) and later |
| --- | --- | --- |
| Before Stage 4A | Supported (the earlier release) | Works with less. Approvals list one capped page and the target audit filter returns `400`. Authenticator enrolment shows "Not reported" and the session-end notice is generic. See the Health-id Stage 4B release note. |
| Stage 4A (`deb6fba`) and later, including Stage 5 | **Not supported.** The console does not handle `STEP_UP_EXPIRED`, so every high-risk action is refused once the first step-up is five minutes old. | Supported, and verified end to end (§8). |

Stage 5 changes no request or response contract the console uses, so Stage 4B
and Stage 5 consoles both work with Stage 4A and Stage 5 Identity.

**Rule:** never run Identity at Stage 4A or later with a console older than Stage 4B.

## 4. Prerequisites and pre-release checks

| # | Check | Owner | How |
| --- | --- | --- | --- |
| P1 | The production migration ledger's last applied version is known. | Database operator | `npm run db:plan` with read-only credentials. The rehearsal covers 0028 → 0072; any other starting point needs its own rehearsal. |
| P2 | A restorable backup of the target database exists and its restore was tested. | Database operator | Snapshot or `pg_dump` taken immediately before the window. The rehearsal checks backup and restore integrity, but the real restore must be proven on staging. |
| P3 | `MFA_SECRET_KEY_B64` is provisioned for Identity: 32 random bytes, base64, from the secret store. `MFA_KEY_VERSION` is set. | Security owner | Without it, platform sign-in fails closed with `503 MFA_UNAVAILABLE`. A malformed key stops Identity at start-up. Never reuse a staging key in production. Rotating it later invalidates enrolled authenticators unless a re-encryption plan exists. |
| P4 | Identity `CORS_ORIGINS` lists only the exact HTTPS console origins, with no paths. | Platform operator | Enforced at start-up in production. With same-origin `/api/v1`, CORS is not used by the console. |
| P5 | The audit table size is known, for the 0072 index build. | Database operator | `select count(*) from audit.events` and `pg_total_relation_size('audit.events')` on a recent snapshot. See §5. |
| P6 | Two Super Admins can sign in and confirm. | Security owner | Two-person approval needs a second Super Admin. Facility suspension needs at least one reachable Super Admin (0072). |
| P7 | The staging acceptance in §7 passed on the exact builds being released. | Release owner | Evidence attached to the release record. |

## 5. Migration order and the 0072 index-build window

1. Apply migrations in ledger order with `npm run db:migrate`. Every migration runs in one transaction with `lock_timeout 5s` and `statement_timeout 120s`, and a failed migration rolls back completely. Never edit an applied migration; checksums are verified.
2. **0072 builds `audit_resource_uuid_sequence_idx` without `CONCURRENTLY`.** This is possible only inside the runner's transaction. The build holds a `SHARE` lock on `audit.events`:
   - every audited write waits until the build finishes, and that includes most authenticated requests;
   - reads continue.
3. The build must finish within 120 s, or the migration rolls back and nothing changes. Measured locally (Stage 5, PostgreSQL 16, synthetic rows, development container, not production hardware): over 1,000,000 audit rows (414 MB, two thirds with a UUID target), the index statement ran in 1.1 s under the runner's settings and produced a 35 MB index. Scale that by the P5 row count, with a wide margin for production I/O, and apply 0072 in a low-traffic window. If the table is too large, stop and plan a separate change: a `CONCURRENTLY` build outside the runner, followed by a no-op 0072. Do not raise the timeout ad hoc.
4. **Immediately after the migrations, run `npm run db:bootstrap`, then `npm run db:verify-roles`.**
   - 0072 drops and recreates `audit.list_platform_events` with eleven arguments. Until the bootstrap grants `EXECUTE` on the new signature, any running Identity is refused on the platform audit list.
   - The bootstrap also runs the runtime-role assertions.

## 6. Deployment order

1. Pass the pre-release checks P1–P7.
2. Deploy the **admin console** (Health-id `main`). It works with the Identity build already running (§3).
3. Take the backup (P2).
4. Apply the **migrations** (§5).
5. Run the **role bootstrap** and verify it (§5).
6. Deploy **Identity**, with `MFA_SECRET_KEY_B64`, `MFA_KEY_VERSION` and `CORS_ORIGINS`.
7. Deploy the **Pharmacy API**. This is independent of the other steps.
8. Run the smoke checks:
   - a Super Admin signs in with TOTP;
   - a high-risk action asks for step-up;
   - `GET /admin/audit/events?resourceType=facility` answers `200`;
   - `GET /admin/approvals` returns `{ items, nextCursor }`;
   - CloudWatch shows no `MFA_UNAVAILABLE`.

## 7. Staging acceptance

These must all pass before production; record evidence for each. None of them
has been run, because no staging environment exists yet (Health-id
`docs/OPEN-QUESTIONS.md`).

| # | Test | Evidence |
| --- | --- | --- |
| S1 | Migration rehearsal on a staging snapshot (`scripts/tuf-staging-migration-rehearsal.mjs`): dry run, apply to 0072, SQL suites, restore. | Rehearsal evidence JSON. |
| S2 | `db:verify-roles` on staging. | Command output. |
| S3 | The Identity runtime verifiers against staging Identity, especially `verify-platform-security-runtime.mjs` and `verify-platform-admin-runtime.mjs`. | Verifier JSON. |
| S4 | The browser checks of §8, by hand with real authenticators, on the staging console and API. Check 3 needs a confirmation older than five minutes: wait it out, or use a second session. | Screenshots and notes for each check. |
| S5 | Cross-origin preflights, only if staging serves the console from another origin. | `OPTIONS` responses. |
| S6 | Rollback drill: redeploy the previous Identity build against the migrated staging database and sign in. | Notes. |

## 8. Evidence gathered locally (Stage 5)

All of this was run on 2026-10-09 against local synthetic data. It was run as
the non-root `postgres` user, on a new local cluster
(`/tmp/hid-tuf-migration.stage5`, migrated 0001 → 0072 and role-bootstrapped).
Other local clusters were not touched.

- **Unit tests:**
  - Identity 703/703. The new `refresh-revocation-reason.spec.ts`, the updated `platform-session-end.spec.ts` and the new `config/cors.spec.ts` fail 39 and 3 times on `deb6fba`.
  - Pharmacy 21/21. The new `config/cors.spec.ts` fails once on the old header list.
- **Runtime verifier:** `verify-platform-security-runtime.mjs` passes. Its new checks fail on `deb6fba`:
  - "a signed-out refresh token is not reuse": 2 `reuse_detected` events instead of 0;
  - "CORS does not allow DELETE".
- **Browser:** `services/identity-api/scripts/admin-console-e2e` serves this Identity API on a disposable database copy. Chromium (Playwright 1.56.1, headless) drives the built Health-id console through its `vite preview` same-origin proxy. Twelve checks:
  1. platform sign-in, with first-time authenticator enrolment, sign-out, then password and TOTP;
  2. `STEP_UP_REQUIRED` on facility suspension, then the change listed under the facility's platform changes;
  3. `STEP_UP_EXPIRED`, with the "more than 5 minutes" note, on facility restoration; both changes stay listed after a reload;
  4. approvals cursor paging: 55 rows over 2 pages, newest first, no duplicates;
  5. demo-request cursor paging for one filter, restarting when the filter changes;
  6. an MFA reset is offered only where `mfaEnrolled` is true;
  7. revoked-session notice in session, after another Super Admin revokes all sessions;
  8. revoked-session notice after a reload;
  9. expired-session notice in session;
  10. expired-session notice after a reload;
  11. no `reuse_detected` recorded for those ended sessions;
  12. no browser errors.

  Results:
  - **Stage 5 backend and console:** 12/12, on three separate fresh-database runs.
  - **Health-id `main` (`a180cea`) console:** check 7 fails, because the revoke-all confirmation disappears (§2).
  - **Refresh logic of `deb6fba`:** check 11 fails with 2 `reuse_detected` events.
- **Not run:** staging or production anything (§7). The browser run uses the backend's own TOTP clock seam to issue codes, not a real authenticator app.

To reproduce, run as the owner of a local cluster migrated to 0072 and role-bootstrapped (`services/ehr-api` `db:migrate` and `db:bootstrap`).

1. Build the console from Health-id:

   ```bash
   VITE_HID_ENVIRONMENT=local VITE_HID_API_BASE_URL=http://127.0.0.1:3200 VITE_HID_APP_ORIGIN=http://127.0.0.1:3200 \
     npx vite build --outDir "$OUT"
   ```

2. Serve it, also from Health-id:

   ```bash
   HID_LOCAL_GATEWAY_ORIGIN=http://127.0.0.1:4010 npx vite preview --configLoader runner --outDir "$OUT" --host 127.0.0.1
   ```

3. Start the API from this repository:

   ```bash
   HID_E2E_SOCKET=<socket dir> HID_E2E_WORKDIR=<dir> node services/identity-api/scripts/admin-console-e2e/server.mjs
   ```

4. Run the checks, with the same variables plus `HID_E2E_PLAYWRIGHT=<path to playwright/index.mjs>`:

   ```bash
   node services/identity-api/scripts/admin-console-e2e/flows.mjs
   ```

   The evidence is written to `<dir>/evidence.json`.

## 9. Rollback and recovery

- **Migrations are forward-only.** There are no down migrations. Recovery from a failed migration needs no action, because the transaction rolls back. Recovery from a wrong but successful migration is a restore from P2. Practise it in staging (S6) before relying on it.
- **Identity after 0072:**
  - The previous Stage 4A build runs unchanged, because Stage 5 has no schema change.
  - A pre-4A build also runs. Its nine-argument audit call resolves to the new function through the defaulted arguments; `platform-admin-contracts.integration.sql` checks this.
  - **Do not roll the console back below Stage 4B while Identity is at Stage 4A or later (§3).**
- **Refresh-event change:** this is code only. Rolling back Identity brings back the old misclassification and nothing else. Existing `refresh`/`denied` events remain valid rows.
- **MFA key:** if `MFA_SECRET_KEY_B64` is lost, every enrolled authenticator must be re-enrolled. Store it with the same care as the field-encryption keys.
- **Lockout:** if every Super Admin is locked out (lost authenticators and recovery codes), recovery needs the documented break-glass procedure. That procedure is not built yet; see the product decisions in `PHASE_4_STAGE_4A_ADMIN_CONTRACTS.md` §9. Keep two independent Super Admins with stored recovery codes.

## 10. Operator actions, not performed here

These are documented for the operators and were not done in this stage:
- deploying anything;
- running migrations or the role bootstrap against staging or production;
- provisioning `MFA_SECRET_KEY_B64`;
- changing AWS, DNS, Cloudflare, Supabase, IAM or Softbridge;
- creating the staging environment needed for §7.
