# Open sign-up on outreach.: services (identity-api, outreach-api, notification-api)

Plan PR-3 and PR-4, with the owner's decisions of 11 November 2026: a one-time Health ID check before an
organiser's first live campaign, no per-organiser limits, unlinked registrations kept 1 year, joint-controller
terms version `2026-11-01`, an existing account may start an outreach group with the same login, free for now.
The database side (migration "outreach organisers" and "outreach retention") is a separate change; every rule
below is enforced there too. Identity and Outreach only answer earlier and in plain English.

## Routes

identity-api (all under `/api/v1`):

| Route | Who | What |
|---|---|---|
| `GET identity/outreach-organisers/availability` | anyone | `{ open, termsVersion }`, never an error |
| `POST identity/outreach-organisers` | signed out, Turnstile `outreach-organiser-signup` | start: details, then a 6-digit code by email; sets `hid_outreach_signup` |
| `POST identity/outreach-organisers/verify-email` | signed out, the cookie | `{ challengeId, code }` |
| `POST identity/outreach-organisers/activate` | signed out, the cookie | `{ termsVersion: '2026-11-01', acceptTerms: true, password }`; signs the organiser in |
| `GET/POST identity/outreach-organisers/for-my-account` | a signed-in staff account | "Start an outreach group" with the same login |
| `GET/POST identity/outreach-invitations` | the organiser at the X-Facility-ID group | list, and invite a helper as `outreach_volunteer` |
| `POST identity/outreach-invitations/accept` | signed out, Turnstile `outreach-invitation` | link or email and code, and a password; signs the helper in |
| `POST identity/outreach-invitations/signed-in/accept` | a signed-in account | link or code |
| `GET admin/outreach-organisers?reviewState=pending` | `platform.facility.read` | the queue, with the phone |
| `POST admin/outreach-organisers/:organizationId/review` | `platform.facility.unlock` | one click: an empty body is enough |
| `POST admin/outreach-organisers/:organizationId/suspend` | `platform.facility.manage` | `{ reason }` |
| `POST admin/outreach-campaigns/:campaignId/close` | `platform.facility.manage` | `{ reason }` |
| `POST admin/outreach-campaigns/:campaignId/admins` | `platform.facility.manage` | `{ membershipId, reason }` |

Every sign-up route answers 423 `OUTREACH_ORGANISER_SIGNUP_UNAVAILABLE` while the control
`outreach_organiser_signup_enabled` (seeded off) is off, the Outreach portal is off or maintenance is on. An email
that already has an account is refused with 409 `OUTREACH_ORGANISER_EMAIL_REGISTERED`, telling the person to sign
in and use "Start an outreach group". Anti-bot: Turnstile, 10 starts a network an hour and the shared public
application quota. `POST identity/outreach/patient-authorization` refuses 403 `OUTREACH_TENANT_NO_HEALTH_ID_LINK`
at an outreach group. A staff session signed in or refreshed from an `outreach.` origin idles out after
`AUTH_OUTREACH_REFRESH_TTL_SECONDS` (default 900).

outreach-api: `CreateRegistrationCaseDto` takes `consent { textVersion, language (en|yo|ha|ig|pcm), method
(verbal_read_aloud|self_ticked|guardian), guardianName? }`, required at an outreach group with a campaign, a
guardian's name under 18 and notes of 280 characters at most; the consent row is written in the same SERIALIZABLE
transaction. Phones are normalised to E.164 (`0801...` is `+234801...`). A registration in a campaign answers
`possibleDuplicate`. `link-existing` refuses 403 `OUTREACH_TENANT_NO_HEALTH_ID_LINK` at an outreach group. Database
refusals answer 409 `OUTREACH_ORGANISER_AWAITING_REVIEW`, 423 `OUTREACH_ORGANISATION_SUSPENDED` and 422 for consent,
guardian, campaign and notes. `GET .../campaigns/governance` adds `organiserStatus`
(`not_outreach_group|unverified|reviewed|suspended|unknown`). The retention sweeper runs every
`OUTREACH_RETENTION_SWEEP_SECONDS` (default 3600, 0 off).

notification-api: the staff invitation email accepts role `outreach_volunteer`, worded for the group and opening
`https://outreach.<deployment>/provider/outreach-invitation`.

## An outreach group

A facility is an outreach group when the membership's roles include `outreach_organiser` or `outreach_volunteer`.
The database's fence on `auth.account_roles` keeps those roles at outreach groups only and keeps every clinical role
out of them; the same account may hold hospital roles at hospital facilities.

## The database calls the services make

Positional arguments; refusals are matched by the code in the error's message. P = a `system:auth` transaction,
A = a transaction as the signed-in account (facility '' when none), ADM = a platform administrator's transaction.

- P `identity.start_outreach_organiser_signup(signup_id, token_hmac, email, phone_lookup_hmac, phone_ciphertext bytea,
  organiser_name, group_name, kind, registration_number, network_digest, challenge_id, verifier_hmac,
  verifier_key_version text, expires_seconds, max_attempts)` returns `(outcome 'code_issued'|'resend_wait'|'email_registered',
  signup_id, challenge_id, resend_after_seconds)`.
- P `identity.verify_outreach_organiser_email(signup_id, token_hmac, challenge_id, verifier_hmac)` returns
  `(result 'verified'|'invalid_code'|'expired'|'attempts_exhausted'|'not_found')`.
- P `identity.activate_outreach_organiser(signup_id, token_hmac, password_hash, terms_version)` returns
  `(organization_id, facility_id, account_id, membership_id, email)`.
- A `identity.activate_outreach_organiser_for_account(group_name, kind, registration_number, phone_lookup_hmac,
  phone_ciphertext, terms_version)` returns `(organization_id, facility_id, membership_id)`.
- A `identity.create_outreach_invitation(invitation_id, send_id, name, email, idempotency_key, request_sha256,
  link_hmac, code_hmac, key_version text)` returns `create_staff_invitation`'s row; A
  `identity.record_outreach_invitation_delivery(send_id, outcome)`; A `identity.list_outreach_invitations()`.
- P `identity.accept_outreach_invitation_with_password(invitation_id, link_hmac, email, code_hmac, password_hash)`
  and A `identity.accept_outreach_invitation_for_account(invitation_id, link_hmac, code_hmac)` return
  `(result, membership_id, facility_id, facility_name, role_code[, account_id, email])`.
- ADM `identity.admin_list_outreach_organisers(review_state)`, `identity.admin_review_outreach_organiser(organization_id,
  display_name, reason)`, `identity.admin_suspend_outreach_organiser(organization_id, reason)`,
  `outreach.admin_close_campaign(campaign_id, reason)`, `outreach.admin_appoint_campaign_admin(campaign_id,
  membership_id, reason)`.
- outreach-api: `insert into outreach.registration_consents (case_id, consent_text_version, language, method,
  guardian_name, captured_by_membership_id)`; `outreach.organiser_status()` returning `(review_state)` for
  `app.facility_id`; `outreach.sweep_expired_registrations()` returning the number redacted, as
  `app.actor_subject = 'system:outreach-retention'`.
