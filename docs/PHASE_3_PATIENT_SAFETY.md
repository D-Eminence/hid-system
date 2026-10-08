# Phase 3 Patient Safety, Account Lifecycle, and Emergency Contacts

Branch: `phase-3-patient-safety` (base `phase-2-provider-reconciliation`).
Status: implementation on a draft branch. Nothing here is deployed, migrated
against a live database, or enabled for production emergency-contact delivery.

This document records the approved Phase 3 decisions (D1-D6, E1-E5, M1), the
state machines, and the API contracts. It does not change legal policy.

## 1. Four separate concepts

| Concept | Authority | Effect of patient account deletion |
|---|---|---|
| Login / account access | `auth.accounts`, `auth.sessions`, `auth.external_identities`, patient access PIN | Closed permanently: status `deleted`, password credential cleared, sessions and federated links revoked, PIN revoked. A database trigger makes `deleted` terminal. |
| Patient identity | `identity.patients` (canonical UUID, HID, NIN binding, demographics) | **Unchanged.** The patient record stays `active`; the HID and NIN binding are preserved for clinical continuity and audit integrity. |
| Clinical record | `ehr.*`, Lab, Pharmacy | **Unchanged.** Nothing is deleted or de-identified. |
| Provider access | `identity.consent_grants` / `identity.access_requests` | Patient-granted grants (patient-approved requests and PIN-derived grants) are revoked; pending requests addressed to the patient expire. Treatment workflows that the architecture already authorizes without a patient grant are untouched. |
| Break-glass access | `identity.activate_break_glass` | **Unchanged.** Emergency authorization rules, rate limits, audit, and review still apply; break-glass grants are never revoked by account deletion. |

`DECISIONS.md` already states that a patient may exist without a login; a
deleted login therefore leaves a patient without a usable login. The account
row is retained as a closed tombstone (the account identifier is referenced by
sessions, consent evidence, and audit). The canonical `identity.patients.account_id`
link is intentionally retained so historical evidence stays traceable;
re-enrolling a new login for the same patient is a separate product decision.

## 2. Governance boundary (D3, D6)

`DATABASE.md` §3.5 and §15 gate erasure. Phase 3 does **not** pass that gate:

- no physical deletion of patient identity, NIN binding, clinical, consent, audit,
  or notification records;
- no demographic or NIN erasure, de-identification, or NIN de-binding;
- no automatic purge and no invented statutory retention period.

`platform.record_class_retention_policies` represents record classes and allows
only the `retain` disposition with `automatic_purge = false`. A future erasure or
purge disposition requires a new governed migration and explicit approval.
`platform.legal_holds` represents patient- or account-scoped holds; an active hold
blocks account-deletion completion (fail safe: everything is preserved). No
runtime role can place or release a hold in this phase; the authority and
procedure for holds remain a policy decision.

## 3. Account deletion state machine (D1, D2, D4, D5)

```text
                 request (fresh sign-in <= 10 min)
                              |
                              v
   superseded <--- AWAITING_CONFIRMATION ---> expired (token TTL or attempts)
   (new request)              |   \
                              |    `--> cancelled (patient)
              confirm (fresh sign-in, single-use token,
               typed "DELETE MY ACCOUNT")
                              |
                     retention / legal-hold / workforce check
                       |                    |
                       v                    v
                   BLOCKED               PENDING  --- cancel --> cancelled
               (LEGAL_HOLD,                 |
                RETENTION_POLICY_UNAVAILABLE,  scheduled_for reached
                WORKFORCE_ACCOUNT)          |  (login unusable from this instant)
                                            v
                              re-check holds, then atomically:
                              revoke sessions + session events,
                              clear password credential, revoke federated links,
                              revoke PIN, revoke patient-granted grants,
                              expire pending access requests,
                              revoke notification devices,
                              account -> deleted, completion audit
                                            |
                                            v
                                        COMPLETED
```

- The confirmation token is 256 random bits returned once to the authenticated
  patient; only its SHA-256 is stored (refresh-token convention). It is bound to
  the account and patient, expires after the configured TTL (default 10 minutes),
  allows a bounded number of failed attempts, is consumed on use, and is
  invalidated by cancellation, expiry, or a newer request.
- The waiting period is configuration
  (`platform.patient_account_deletion_settings.waiting_period`, default 14 days,
  allowed range 0-90 days). It is a cancellation window, not a legal retention
  period. A zero waiting period completes deletion inside the confirmation
  transaction.
- From `scheduled_for`, `identity.current_patient_account` and
  `identity.patient_self_session` deny the account, so the login cannot
  authenticate even before finalization runs. Finalization is performed by
  `identity.finalize_due_patient_account_deletions`, invoked by the Identity API
  lifecycle sweeper (`PATIENT_LIFECYCLE_SWEEP_SECONDS`).
- An account that also carries a workforce identity or platform role is blocked
  (`WORKFORCE_ACCOUNT`): closing a shared login through the patient portal would
  silently remove workforce access.

API (Identity API, patient session, cookie CSRF):

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/identity/me/account-deletion` | Current status and configured waiting period |
| POST | `/api/v1/identity/me/account-deletion` | Requires sign-in within 10 minutes; returns `requestId`, `confirmationToken`, `confirmationExpiresAt` |
| POST | `/api/v1/identity/me/account-deletion/confirm` | `{ requestId, confirmationToken, confirmation: "DELETE MY ACCOUNT" }`; requires sign-in within 10 minutes |
| POST | `/api/v1/identity/me/account-deletion/cancel` | `{ requestId }` |

## 4. Emergency contact state machine (E1-E5)

```text
ADD (patient) --> UNVERIFIED --send code--> code delivered to the contact
                     |   ^                         |
                     |   `-- expired / attempts ---'
                     |                             |
                     |        patient enters code (single use)
                     |                             v
                     |                         VERIFIED --> eligible for alerts
                     |                             |        (if notify = true)
                     `--------> DEACTIVATED <------'
```

- Contact name and destination are encrypted with the existing application
  AES-256-GCM pattern (`NIN_ENCRYPTION_KEY_B64`, version byte, 12-byte nonce)
  under the distinct associated data `identity:patient-emergency-contact:<id>:contact`.
  A keyed HMAC of the normalized destination (`OTP_HMAC_KEY_B64`, namespace
  `hid-emergency-contact-destination:v1`) prevents duplicates and binds the
  verification code. It is not the contact-lookup HMAC and never identifies a
  patient.
- Verification codes are six digits, stored only as a challenge-bound HMAC,
  expire with `OTP_EXPIRY_SECONDS`, allow `OTP_MAX_ATTEMPTS` failures, are single
  use, and are rate limited per patient (5 per hour) and per contact (60 second
  resend cooldown). The verification message contains no patient name and no
  clinical information.
- Legacy `identity.patients.emergency_contact_ciphertext` is untouched and never
  used as a recipient.

## 5. Emergency-contact notification (E1, E2)

1. `identity.activate_break_glass` is unchanged. Its existing
   `EmergencyAccessActivated` outbox row and patient inbox trigger are unchanged.
2. A new trigger on that outbox row creates one
   `identity.emergency_contact_notifications` intent per active, verified contact
   with notification consent (`UNIQUE (consent_grant_id, contact_id)` prevents
   duplicates). If no contact is eligible, a `no-eligible-contact` audit is written.
   Any failure in this trigger is audited and swallowed: break-glass authorization
   never fails because of emergency-contact notification.
3. Delivery is provider-neutral: the Identity API claims intents with a lease,
   decrypts the destination, and sends a fixed minimum-necessary message through
   notification-api, which applies the existing provider delivery plan. Outcomes
   are recorded per intent with bounded exponential retry (8 attempts) and a
   24-hour delivery window; every outcome is audited.
4. The message contains only: the patient's first name, the facility name, the
   time of the emergency access, and safe contact guidance. It never contains
   diagnoses, medications, results, notes, HID, or NIN.

**Production delivery is disabled.** Both Identity API
(`EMERGENCY_CONTACT_DELIVERY_ENABLED`) and notification-api
(`EMERGENCY_CONTACT_DELIVERY_ENABLED`) default to `false` and refuse to start if
the flag is enabled in a production deployment. The existing EventBridge
production exclusion of `EmergencyAccessActivated.v1` and its infrastructure test
are unchanged. Staging enablement is a configuration step outside this change.

## 6. Focused patient-safety fixes

| Finding | Fix |
|---|---|
| Patient inbox functions had no runtime `EXECUTE` | Granted to the Identity runtime only; regression test |
| Patient access-request routes required a facility | Session-bound patient wrappers; patient routes no longer use the staff consent context |
| Patient "Revoke access" used a staff route | New patient route `POST /api/v1/identity/me/consent-grants/:grantId/revoke` for patient-granted, non-break-glass grants |
| `break_glass_enabled` not enforced | Checked inside the break-glass transaction; disabled returns `423 BREAK_GLASS_DISABLED` |
| `0035` decision commands always failed (`status` ambiguous; grant missing `purpose_of_use`) | Repeated in `0065` with `#variable_conflict use_column`; the grant carries the request purpose required by `0008` |
| identity-api audit rows labelled `ehr-api` | Default source system is `identity-api` |

## 7. Migrations

`0063_patient_account_deletion_lifecycle.sql`, `0064_patient_emergency_contacts.sql`,
`0065_patient_access_safety.sql`, contiguous after the Phase 2 ledger (`0062`).

The Phase 2 migration `0062_provider_cac_self_service_constraints.sql` fails on a
fresh database (`record "constraint_row" is not assigned yet`): its loop variable
shadows the query alias. This is a pre-existing Phase 2 defect, also visible as
the failed `migration-rehearsal` gate on the Phase 2 pull request. Phase 3 does
not modify `0062` or its checksum; the fix belongs on the Phase 2 branch.

## 8. Verification

- Rollback-only SQL suites: `patient-account-deletion`, `emergency-contacts`,
  `patient-access-safety` (all existing suites also pass).
- HTTP workflow under `hid_identity_runtime`:
  `services/identity-api/scripts/verify-patient-safety-runtime.mjs`, registered
  in the synthetic migration rehearsal (local delivery stub only).
- Unit tests in identity-api and notification-api.

## 9. Remaining decisions

- Legal hold authority and procedure; any non-`retain` disposition (DATABASE.md §15).
- Product default for the deletion waiting period (configured 14 days).
- Re-enrolling a new login for a patient whose login was deleted.
- Whether verified emergency contacts remain eligible after the patient's login is deleted (currently: retained, because they protect the patient, not the login).
- Production and staging enablement of emergency-contact delivery, SMS sender/template approval, and provider configuration.
