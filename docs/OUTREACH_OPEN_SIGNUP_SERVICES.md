# Open sign-up on outreach.: services (identity-api, outreach-api, notification-api)

Plan PR-3 and PR-4, with the owner's decisions of 11 November 2026: no Health ID check before an organiser's
campaigns go live (decision Q38: a new organiser may set a campaign Active at once; support can still pause a
group, the name blocklist stays, and registrants see "Unverified organiser"), no per-organiser limits, unlinked registrations kept 1 year, joint-controller
terms version `2026-11-01`, an existing account may start an outreach group with the same login, free for now.
The database side (migrations 0114 "outreach organisers" and 0115 "outreach retention", branch
`wt-outreach-signup-db`) is a separate change; every rule below is enforced there too, and the calls listed at the
end are its functions exactly. Identity and Outreach only answer earlier and in plain English.

## Routes

identity-api (all under `/api/v1`):

| Route | Who | What |
|---|---|---|
| `GET identity/outreach-organisers/availability` | anyone | `{ open, termsVersion }`, never an error |
| `POST identity/outreach-organisers` | signed out, Turnstile `outreach-organiser-signup` | start: details, then a 6-digit code by email; sets `hid_outreach_signup` |
| `POST identity/outreach-organisers/verify-email` | signed out, the cookie | `{ code }` (a `challengeId` is accepted and not needed) |
| `POST identity/outreach-organisers/resend-code` | signed out, the cookie | a new code after a minute, at most 5 codes |
| `POST identity/outreach-organisers/activate` | signed out, the cookie | `{ termsVersion: '2026-11-01', acceptTerms: true, password }`; signs the organiser in |
| `GET/POST identity/outreach-organisers/for-my-account` | a signed-in staff account | "Start an outreach group" with the same login |
| `GET identity/outreach-invitations` | the organiser at the X-Facility-ID group | `{ members, invitations }` (pending invitations) |
| `POST identity/outreach-invitations` | the organiser | `{ name, email }`: invite a helper as `outreach_volunteer`; 409 if already invited or in the team; 429 at 50 waiting, 30 made today, or after 10 undeliverable emails today |
| `POST identity/outreach-invitations/:invitationId/revoke` | the organiser | cancel a waiting invitation |
| `POST identity/outreach-invitations/preview` | anyone with the link | `{ invitationId, token }`: the group, who invited, `accountCase` new, existing or patient_login |
| `POST identity/outreach-invitations/accept` | signed out, Turnstile `outreach-invitation` | `{ invitationId, token, password }`; signs the helper in |
| `POST identity/outreach-invitations/signed-in/accept` | a signed-in account | `{ invitationId, token }` |
| `GET admin/outreach-organisers?status=active` | `platform.facility.read` | the groups (`active`, `suspended`, or `all` by default), each with its `version`, the phone, `status` (`active`/`suspended`) and `label` ("Unverified organiser" or "Paused") |
| `POST admin/outreach-organisers/:organizationId/suspend` | `platform.facility.manage` and `.unlock` | If-Match version and `{ reason }`; answers `{ status: 'suspended', label: 'Paused', version, revokedRoles }` |
| `POST admin/outreach-campaigns/:campaignId/close` | `platform.facility.manage` and `.unlock` | the campaign's version as If-Match and `{ reason }` |
| `POST admin/outreach-campaigns/:campaignId/admins` | `platform.facility.manage` and `.unlock` | `{ membershipId, reason }` |

Every sign-up route answers 423 `OUTREACH_ORGANISER_SIGNUP_UNAVAILABLE` while the control
`outreach_organiser_signup_enabled` (seeded off) is off, the Outreach portal is off or maintenance is on. An email
that already has an account is refused with 409 `OUTREACH_ORGANISER_EMAIL_REGISTERED`, telling the person to sign
in and use "Start an outreach group". Anti-bot: Turnstile, 10 starts a network an hour (Identity), then in the
command the shared public application quota, 5 sign-ups a network a day and 3 sign-ups (code emails) an email a day
(429 `OUTREACH_ORGANISER_EMAIL_RATE_LIMITED`). A patient's Health ID email is refused with 409
`OUTREACH_ORGANISER_PATIENT_LOGIN`. A suspended group's organiser cannot start again: "Start an outreach group"
answers 403 `OUTREACH_ORGANISER_SUSPENDED` for a login that organised a suspended group or a suspended group's
contact phone, and the public sign-up answers 423 for that phone. Group names are checked as 0114 checks them
(accents dropped, Latin letters only, words kept for hospitals, health agencies and government bodies in any case).
Outreach invitations are accepted by link only; the email shows no code. Abuse guards, because the email names the
group: at most 50 invitations wait at once and 30 are made a day per group, cancelled ones included (429
`OUTREACH_INVITATION_DAILY_LIMIT`); 10 undeliverable emails in a day pause the group's invitations (429
`OUTREACH_INVITATION_DELIVERY_PAUSED`); one address gets at most 3 outreach invitation emails a day from all groups
(past that the invitation is made, not emailed, and answers `deliveryOutcome: 'unknown'`). `POST identity/outreach/patient-authorization` refuses 403 `OUTREACH_TENANT_NO_HEALTH_ID_LINK`
at an outreach group. A staff session signed in or refreshed from an `outreach.` origin idles out after
`AUTH_OUTREACH_REFRESH_TTL_SECONDS` (default 900). Activation and "Start an outreach group" answer
`organiserStatus: 'active'` and `label: 'Unverified organiser'`. There is no review route.

outreach-api: `CreateRegistrationCaseDto` takes `consent { textVersion, language (en|yo|ha|ig|pcm), method
(verbal_read_aloud|self_ticked|guardian), guardianName? }`, required at an outreach group with a campaign, a
guardian's name under 18 and notes of 280 characters at most; the consent row is written in the same SERIALIZABLE
transaction. Phones are normalised to E.164 (`0801...` is `+234801...`). A registration in a campaign answers
`possibleDuplicate`. `link-existing` refuses 403 `OUTREACH_TENANT_NO_HEALTH_ID_LINK` at an outreach group. Database
refusals answer 423 `OUTREACH_ORGANISER_SUSPENDED` and 422 for consent (`OUTREACH_CONSENT_REQUIRED`), guardian
(`OUTREACH_CONSENT_GUARDIAN_REQUIRED`), campaign and notes. A new group's campaign goes Active with no check first.
`GET .../campaigns/governance` adds `organiserStatus` (`not_outreach_group|unverified|suspended|unknown`):
`unverified` is any outreach group that is not paused (Health ID never verifies one).

Retention (owner decision 3): identity-api's `OutreachRetentionSweeper` calls 0115's
`identity.sweep_expired_outreach_registrations(500)` as `system:auth` every `OUTREACH_RETENTION_SWEEP_SECONDS`
(default 3600, 0 off). It redacts registrations never linked to a Health ID once `closed_at + 365 days` (or
`starts_at + 365 days` for a campaign never closed) has passed. The same call deletes sign-ups never activated
after 30 days and invitations never accepted 30 days after they expired or were cancelled. EXECUTE is granted to Identity's runtime only, so
the sweeper lives in identity-api, not outreach-api.

notification-api: the staff invitation email accepts role `outreach_volunteer`, worded for the group and opening
`https://outreach.<deployment>/provider/outreach-invitation`, with the link only (no typed code).

## An outreach group

A facility is an outreach group when the membership's roles include `outreach_organiser` or `outreach_volunteer`.
The database's fence on `auth.account_roles` keeps those roles at outreach groups only and keeps every clinical role
out of them; the same account may hold hospital roles at hospital facilities.

## The database calls the services make (0114 and 0115)

Positional arguments; refusals are matched by the code in the error's message (the specs compare the codes with
0114's raise messages). P = a `system:auth` transaction, A = a transaction as the signed-in account (facility ''
when none, purpose `healthcare-operations`), ADM = a platform administrator's transaction.

- P `identity.start_outreach_organiser_signup(signup_id, token_hmac, email, organiser_name, group_name, kind,
  registration_number, phone_lookup_hmac, phone_ciphertext bytea, key_version, network_digest, code_hmac)` returns
  text: `started`, `email_registered`, `patient_login`, `name_not_allowed`, `rate_limited`, `email_rate_limited` or
  `suspended`. The code HMAC is
  `HMAC(otp key, 'outreach-organiser-signup\0otp\0<signup_id>\0<code>')`.
- P `identity.resend_outreach_organiser_signup_code(signup_id, token_hmac, code_hmac)` returns `(result, email)`:
  `sent` with the sign-up's own email (Identity has no read of the sign-up table and sends the code there), or
  `too_soon`, `too_many`, `expired` or `denied` with a null email.
- P `identity.verify_outreach_organiser_email(signup_id, token_hmac, code_hmac)` returns `verified`, `wrong_code`,
  `code_expired`, `locked`, `expired` or `denied`.
- P `identity.activate_outreach_organiser(signup_id, token_hmac, password_hash, terms_version)` returns
  `(organization_id, facility_id, account_id, membership_id, hid_subject, replayed)`; Identity reads the login's email
  from `auth.accounts` in the same transaction to sign the organiser in.
- A `identity.activate_outreach_organiser_for_account(group_name, kind, registration_number, terms_version,
  phone_lookup_hmac, phone_ciphertext, key_version)` returns `(result, organization_id, facility_id, membership_id)`;
  `suspended`, `already_organiser`, `name_not_allowed`, `patient_login` and `not_eligible` are refusals.
- A `identity.create_outreach_invitation(invitation_id, name, email, link_token_hmac)` returns `(result
  'created'|'already_member'|'already_invited'|'too_many_pending'|'too_many_today'|'sending_paused', invitation_id,
  expires_at, dispatch)`; Identity emails the link only when `dispatch` is true, then calls A
  `identity.record_outreach_invitation_delivery(invitation_id, outcome)` with the email service's answer;
  A `identity.revoke_outreach_invitation(invitation_id)`; A `identity.list_outreach_team()`.
- P `identity.preview_outreach_invitation(invitation_id, link_hmac)`; P
  `identity.accept_outreach_invitation_with_password(invitation_id, link_hmac, password_hash)` returns `(result,
  account_id, membership_id, facility_id, hid_subject)`; A `identity.accept_outreach_invitation_for_account(
  invitation_id, link_hmac)` returns `(result, membership_id, facility_id)`.
- ADM `identity.admin_list_outreach_organisers(state)` with `'active'`, `'suspended'` or `'all'` (not read-only: it
  writes an audit row; Identity reads the row's `status`, or `suspended_at`, and no review column),
  `identity.admin_suspend_outreach_organiser(organization_id, expected_version, reason)` (Identity reads
  `row_version` and `revoked_roles`),
  `identity.admin_close_outreach_campaign(campaign_id, expected_version, reason)` and
  `identity.admin_appoint_outreach_campaign_admin(campaign_id, membership_id, reason)` (both return text).
- P `identity.sweep_expired_outreach_registrations(requested_limit)` returns the number redacted.
- outreach-api: `insert into outreach.registration_consents (registration_case_id, facility_id,
  consent_text_version, language, method, guardian_name, captured_by_account_id, captured_by_membership_id)` with
  `platform.current_account_id()` as the capturer (0114's policy); `select outreach.organiser_status()`, a scalar
  for `app.facility_id`: `active` or `suspended` (any other text is read as not paused), null when the facility is
  not an outreach group.

`services/identity-api/scripts/verify-outreach-organisers-runtime.mjs` runs these calls through the real services
against a disposable Postgres 16 with 0114 and 0115 applied.
