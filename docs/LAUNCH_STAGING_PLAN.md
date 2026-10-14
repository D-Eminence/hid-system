# EHR and Patient Portal Launch: Staging Plan

This is the order of work that takes the patient portal and the provider EHR from `main` to staging, and from staging to production.

The detailed checks live in `PHASE_4_STAGE_5_RELEASE_READINESS.md` (the release checklist) and this plan cites them by section and row. The launch decisions are recorded in `PHASE_3_LAUNCH_DECISIONS.md`, and the ADRs are in `DECISIONS.md`.

Nothing in this plan has been run on staging or production. Every step that touches AWS, Cloudflare, DNS, IAM, secrets, a live database or a live integration needs a separate deployment authorization.

## 1. Launch scope (D17)

| On at launch | Off at launch (route switch off, desired count 0, permissions withdrawn by 0091) |
|---|---|
| Identity API: patient sign-in (HIDCode and password), staff sign-in with a password and an authenticator (0088), platform administration, consent and access requests, patient self-service | Lab API, Pharmacy API, OCR API and worker, Outreach API, notification worker |
| EHR API: encounters, notes, diagnoses, vitals, prescriptions recorded in the EHR, the patient's own records | Document uploads (`uploads_enabled` off), break-glass (`break_glass_enabled` off, no role holds `identity.break-glass.write`), the Outreach portal |
| Notification API (SES email, Termii SMS after P18), event dispatcher, gateway | Google sign-in (P19), facility-assisted registration, NIN-only self-enrollment in production (until N1) |

Re-enabling an off module takes its own reviewed migration (ADR-058). It is never a hand-made grant.

## 2. What `main` contains

- **Migrations:** 0001 to 0091.
- **Launch PRs merged to `main`:**
  - D-Eminence/hid-system#63 to #67: non-superuser database chain, EHR clinical safety, edge and gateway, launch configuration, launch frontend hosts.
  - D-Eminence/hid-system#68 to #71: enrollment gate, recovery and search, workforce provisioning, staff MFA.
  - D-Eminence/hid-system#72: edge hardening.
  - D-Eminence/hid-system#73: facility selection.
  - D-Eminence/hid-system#74: EHR retraction integrity, 0090.
  - D-Eminence/hid-system#75: launch module withdrawal, 0091.
  - D-Eminence/hid-system#76: identity error hardening.

## 3. Staging, in order

1. **Preflight for staging.** Release checklist §4 lists P1 to P22.
   - Run against staging: the database, secret and artefact rows, P1 to P5 and P8 to P14. P11 and P12 run again after the migration.
   - P22 (staff enrolment before clinical roles) applies to every environment that enables clinical roles.
   - Production gates: P6 (two Super Admins), P7 (the staging acceptance passed) and P15 to P21.
2. **Rehearse on a restored staging snapshot (S1).** Run `db:plan`, `db:dry-run` and `db:migrate` to 0091 in an isolated copy, then the bootstrap, `db:verify-roles` and `db:verify-logins` (S2).
3. **Migrate staging.** Follow release checklist §5 in ledger order.
   - Each migration has its lock window: steps 2 to 17 for 0067 to 0084, 18 to 24 for 0085 to 0091, the estimate check at 25 and the role bootstrap at 26.
   - Run the bootstrap after the last migration and before any new build starts.
4. **Deploy in the order of release checklist §6.**
   - Identity and EHR builds go out only after their migrations and the bootstrap.
   - The gateway, Workers and the regional stack follow §6 step 11.
   - Off modules stay at desired count 0.
5. **Staging acceptance (release checklist §7), with synthetic data only.**
   - Database: S1 and S2.
   - Identity runtime verifiers against staging: S3.
   - Browser checks with real authenticators: S4 and S4a.
   - Launch rows: S4d, S4e, S4f, S4g, S4i, S4j, S4k, S4l, S4m, S4n, S4o, S4p, S4q, S4r, S4s.
   - Rollback drill: S6.
   - S4b, S4c and S4h apply only once their module is re-enabled.
   - The provider-portal browser rows (S4a, S4e, S4j, S4o, S4q) need a Health-id build that signs staff in with an authenticator (FE-2, §7). Health-id `82b474e` cannot sign staff in once 0088 is applied, so until FE-2 ships these rows run as scripted API requests and the browser part waits.
6. **Record the evidence** against the exact build digests and the migration ledger (P7).

## 4. Smoke tests that decide go or no-go

**Patient**
- Sign in with HIDCode and password through `staging`.
- `GET /auth/session` reports the patient.
- `GET /ehr/me/records` returns only that patient's completed encounters and signed notes.
- A refresh rotates the cookies.
- Sign-out clears them (S4e).
- The patient portal still shows only the patient's own records after 0091's patient-self binding (S4r (6)). Delegated cookie reads answer `200` (S4d).

**Provider**
- Staff sign-in with password and authenticator (S4o).
- Facility selection is kept across a reload (S4o).
- The governed-access loop: a clinician requests access, the patient approves, the clinician reads and writes, closes access, requests again, and the patient revokes (S4a). Search never grants chart access; locally this is covered by the patient search verifier (§8), with no staging row of its own.
- An encounter's lifecycle and the retraction rules: a nurse cannot retract a doctor's records (S4j, S4q).
- Lab, Pharmacy, OCR and Outreach routes answer `404 API_ROUTE_NOT_FOUND` at the gateway or `403 PERMISSION_DENIED` (S4g, S4l, S4r).

**Administration**
- The §8 console checks by hand with real authenticators (S4), the platform admin runtime verifier against staging Identity, which includes workforce provisioning (S3), and principal search and export through `POST` (S4s (5)).

**Faults**
- With Identity at desired count 0, the portals answer `503 UPSTREAM_UNAVAILABLE` and do not sign out (S4p (3) and (6)).
- In maintenance mode, a clinician's session gets `503 PLATFORM_MAINTENANCE` (S4s (4)).

## 5. Rollback

Release checklist §9 has the rollback for each change.

- **Schema:** migrations are forward-only. A failed migration rolls back completely. An applied migration is never reverted by hand; the earlier build of each service tolerates the later schema where §9 says so.
- **Before 0091's bootstrap:** the patient's request list answers `403`.
- **Before 0090's bootstrap:** retractions of encounters with records fail closed, and nothing is written.
- **Code:** redeploy the previous image (S6). Rolling Identity back to a build from before staff MFA needs an explicit decision, because that build issues staff sessions on the password alone again (§9, "Identity after staff MFA").
- **Data:** the restore-tested backup from P2.

## 6. Monitoring at launch

- **Alarm topic:** `hid-<env>-operational-alerts`, with a customer-managed key and one confirmed subscription (P16, S4m).
- **Alarms:**
  - OTP definitive failures;
  - workload token renewal;
  - issuer 4XX;
  - WAF rate blocks (`hid-<env>-origin-rate`);
  - ECS task health.
- **Logs:**
  - `notification.otp.outcome` (no recipient, code or message);
  - `identity_workload_token_expired`;
  - the gateway JSON access log (no query strings, #72).
- **Audit:**
  - `audit.events` refusal rows carry `status` and `code` (A17).
  - Access requests, approvals, PIN uses (inbox notice) and break-glass (off) are audited per patient.

## 7. Operator and external items that block production

None of these can be done from the repository. Each needs its owner and, where it changes live infrastructure, a deployment authorization.

1. Staging deploy and the §7 acceptance evidence (P7).
2. RDS: the migration administrator, the `SET ON PARAMETER plpgsql.variable_conflict` grant for the 0015 run (I3, `MIGRATION_RUNBOOK.md` §6.1), and P8.
3. Secrets and keys: `MFA_SECRET_KEY_B64` (P3), signing and login pepper, runtime credentials (S2), the Cloudflare `ORIGIN_AUTH_TOKEN`, and the Turnstile widget keys (P14).
4. SES production access and a DKIM-verified domain (P17); a Termii sender ID (P18); a paused Brevo fallback (P21).
5. The on-call alarm topic and its recipients (P16).
6. Cloudflare and DNS for the launch hosts (P14, P15); the production parameter file at desired count 0 first (P20).
7. Health-id:
   - staff MFA sign-in and enrolment screens (FE-2);
   - the workforce administration UI (FE-3);
   - the `POST` admin search and export (A24);
   - optionally keeping the facility selection (FE-20).
   Until FE-2 ships, staff cannot sign in to the EHR from Health-id.
8. N1: QoreID holder confirmation and DPO sign-off before NIN-only self-enrollment opens in production. Until then, enrollment answers "not open" (FE-4).
9. The clinical owner's review of open records of closed encounters (P12) and staff MFA enrolment before clinical roles (P22).

## 8. Evidence levels

| Level | State |
|---|---|
| Committed and merged to `main` | Every change above, through D-Eminence/hid-system#76 |
| Checks run locally | Unit and SQL suites, runtime verifiers over HTTP against PostgreSQL 16 as the runtime roles, and the full workspace gates with the synthetic 0028 to 0091 migration rehearsal on each PR head (each PR's evidence) |
| CI | Green on each merged PR's head (each PR) |
| Staging-verified | None yet |
| Production-verified | None |
