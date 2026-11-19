# HID Interface Contract

## Imported medical history (2026-10-03)

Patient self/emergency record summaries add `importedRecords`; staff may read
`GET /api/v1/ehr/patients/:patientId/imported-records` with fresh read consent,
selected membership/facility and `ehr.note.read`. Migration 0062 also adds
preserved health profiles, authorized attachment-download routes, recipient-owned
historical notifications and guarded configuration reads. The current contract
is [CUSTOMER_DATA_COMPLETION.md](CUSTOMER_DATA_COMPLETION.md). Original DTOs and preservation are specified
in [IMPORTED_MEDICAL_HISTORY.md](IMPORTED_MEDICAL_HISTORY.md).

## Current browser and notification boundary

Production browsers call relative `/api/v1/*` URLs on their own approved app
hostname. The app-specific Cloudflare Worker proxies only that versioned
namespace to the fixed AWS origin and never accepts an upstream from browser
input. Cookie sessions are host-only; browser token storage is prohibited.

Authentication OTP commands are purpose-bound and use three stages: start
returns a generic challenge, verify accepts exactly six digits and returns an
opaque one-time completion credential, and complete consumes that credential.
Identity calls Notification API directly over workload authentication; these
credentials never use the ordinary-notification event path. Ordinary domain
events remain minimum-necessary versioned envelopes delivered through outbox,
Event Dispatcher, EventBridge/SQS, Notification Worker, and Novu.

### Patient sessions and self service

`POST /api/v1/auth/patient/login` accepts an email, a Health ID or a phone
number (in the field `email`; see "Patient parity with hid-1.0" below) with the
password and the `patient-login` Turnstile action. It binds a separate patient session to the existing canonical
Identity patient; its actor has no staff roles, facility memberships or platform
permissions. Existing session, refresh and logout routes retain that binding,
host-only Secure/HttpOnly cookies, Origin/CSRF checks and refresh-family reuse
revocation. The server rechecks account eligibility, token version, session and
patient mapping on use.

Session lifetimes (owner decision of 2026-10-28): a patient session lasts 7
days idle and 30 days at most (`AUTH_PATIENT_REFRESH_TTL_SECONDS`, default
604800, 900-604800; `AUTH_PATIENT_ABSOLUTE_TTL_SECONDS`, default 2592000,
3600-2592000). Each refresh renews the idle expiry to the earlier of now plus 7
days and the family's absolute expiry. Staff and platform sessions keep 8 hours
idle and 24 hours at most (`AUTH_REFRESH_TTL_SECONDS`,
`AUTH_ABSOLUTE_TTL_SECONDS`); the access token lasts 15 minutes for both. The
refresh and CSRF cookies expire with the idle expiry. An idle lifetime
configured above its absolute one is capped at it. Sessions issued before this
release keep the absolute expiry stored with them.

Suspended account (owner decision of 2026-10-28): when the password is right
but the account is suspended, blocked or disabled (`auth.accounts.status`
`disabled` or `locked`, or `disabled_until` in the future), patient sign-in
answers `403 ACCOUNT_SUSPENDED` with the detail "This account is suspended.
Contact support@healthidentitydirectory.com." A wrong password, an unknown
email or Health ID, a locked-out principal (5 failures in 15 minutes) and every
other refusal still answer the one `401` "Invalid credentials". The suspended
answer is recorded as a denied sign-in on that account; it neither counts
towards nor clears the lockout, and no hash is upgraded. The 403 is for
patient accounts only: an account that has, or ever had, a platform or
facility role, a staff record or a facility membership (a clinician or platform
administrator, even when its roles are revoked) answers the uniform `401`
"Invalid credentials" on the patient route too, whatever its state, so the
patient route never confirms a workforce password; so does a patient account
that is also a workforce account. Staff sign-in (`POST /api/v1/auth/login`)
is unchanged. Since 0093 the same holds by Health ID and by phone for patients
migrated from hid-1.0 (their bans were migrated as `disabled_until`), and
Google sign-in answers a suspended patient the same `403 ACCOUNT_SUSPENDED`
(below).

### Patient parity with hid-1.0 (0093; owner decisions of 2026-10-28)

Identity's runtime reads `identity.patients` through RLS that shows system:auth
public-enrollment patients only, so the lookups below go through 0093's
SECURITY DEFINER functions and find patients migrated from hid-1.0 as well
(their Health ID sign-in failed before).

**Sign-in and reset with a phone number.** `POST /api/v1/auth/patient/login`
keeps its body field `email`, and `POST /api/v1/auth/otp/start` its field
`identifier`; each takes an email, a Health ID (`HID-` and 6-32 Health ID
characters, any case) or a phone number. A phone is `+` and 7-15 digits
(E.164, any country) or a Nigerian local number, `0` and 10 digits, read as
`+234`; spaces, dots, dashes and brackets anywhere are ignored, and a trunk
`0` typed after `+234` is dropped (`+2340803...` is `+234803...`). Anything
else fails validation (400 `VALIDATION_FAILED`), as a malformed email does.
The phone is looked up by its contact lookup HMAC (`identity.patients.phone_lookup_hmac`,
the same key for sign-up, NIN-route and migrated patients), for an active
patient whose account is not deleted. A Nigerian number is looked up in both
its forms, `+234803...` and `+2340803...`, because hid-1.0 stored a phone as
typed and a patient who typed the trunk `0` after `+234` was migrated with it.
A phone that matches no account, or more than one (across both forms too),
gets the same answer as a wrong email: the dummy hashes are verified and
sign-in answers 401 "Invalid credentials"; the recovery start answers its
usual 202 and sends nothing. Sign-in's lockout (5 failures in 15 minutes) and
the recovery start's cooldown are keyed by the E.164 number, so `0803...` and
`+234803...` share one. Production sends no SMS: a reset started with a phone
sends the code to the account's verified email (`email_verified_at` set) only;
an account without a verified email gets nothing and the answer stays the same.
A reset started with an email or a Health ID is unchanged. Without
`CONTACT_LOOKUP_HMAC_KEY_B64`, a phone sign-in or reset answers 503
`CONTACT_LOOKUP_UNAVAILABLE`. Suspension (above) applies by phone too.

**International phones at sign-up.** `POST /api/v1/identity/patient-enrollments/signup`
takes `phone` as E.164 of any country (`+` and 7-15 digits) or a Nigerian
local number (stored as `+234...`); a refused phone answers 400
`VALIDATION_FAILED` on `phone` with "Enter your phone number with its country
code, like +44 7700 900123, or a Nigerian number like 08012345678." The
activation command admits the same (0093 replaced 0092's `+234`-only rule).

**Google sign-in for a registered patient.** `POST /api/v1/auth/oidc/exchange`
with intent `sign_in` and `patient-login`: a Google identity already linked
signs in as before. When none is linked and Google's token says
`email_verified: true`, and that email is the verified email
(`auth.accounts.email`, `email_verified_at` set) of exactly one active patient
account (migrated hid-1.0 patients included), the Google account is linked to
it (`auth.external_identities`, source `hid-google-verified-email-link`, audit
`auth.google.auto-link`, inbox `SECURITY_GOOGLE_LINKED`) and the patient is
signed in exactly as a linked Google sign-in is (session, cookies,
`x-csrf-token`, `auth.google.login` audit). Otherwise:

| Case | Answer |
| --- | --- |
| No patient account has the email | `404 GOOGLE_NOT_REGISTERED` "This Google account is not registered on Health ID. Use Sign Up first." |
| Two or more patients have it (one account's email, another patient's contact email), the one account's email is not verified or is another, the account is pending a reset, it already has another Google link, or this Google subject is linked to another account | `409 GOOGLE_LINK_REQUIRED` "Sign in with your password, then link Google from Settings." |
| The patient is suspended (also when this Google subject is linked to a suspended patient) | `403 ACCOUNT_SUSPENDED`, B1's detail |
| No verified email, a workforce account (never linked), or anything else | `401 GOOGLE_SIGN_IN_DENIED`, as before |

Each refusal is recorded as a failed sign-in with its code as the reason. Staff
Google sign-in is unchanged. With intent `enroll` (the sign-up page's Google
button), a verified email a patient account already uses (account email or
patient contact email) answers `409 GOOGLE_ACCOUNT_EXISTS` "You already have a
Health ID. Sign in with Google instead." and starts no sign-up; another
account's email still answers 409 `GOOGLE_EXISTING_ACCOUNT_LINK_REQUIRED`, and
a Google identity already linked still signs in. Accepted risk (owner's rule):
Google's `email_verified` for a non-Gmail address means Google verified it
once. There is no unlink route; support removes a link.

**Inbox notices.** Written into the existing inbox
(`GET /api/v1/identity/me/notifications`), each in the transaction of its event:

| Code | `resourceType` | `resourceId` | `metadata` | When |
| --- | --- | --- | --- | --- |
| `SECURITY_PASSWORD_RESET_REQUESTED` | `account` | null | `{}` | A recovery start that created a challenge for the patient's account, at most once an hour |
| `SECURITY_PASSWORD_CHANGED` | `account` | null | `{}` | A completed recovery |
| `SECURITY_GOOGLE_LINKED` | `account` | null | `{}` | A Google link, from Settings or automatic |
| `CONSENT_GRANT_ENDED_BY_CLINICIAN` | `consent-grant` | the grant | `{ "facilityName" }` only | A clinician ends their own access before it expires (`identity.close_own_consent_grant`); never on a replay, never after expiry, never the clinician's reason |

Security notices carry no PHI and no secret, are written only for an account's
active patient (never a staff-only or deleted account), never fail the sign-in,
reset or link they belong to, and are written once per event.

**Unread count.**

```text
GET /api/v1/identity/me/notifications/unread-count
```

Patient session only. `200 { "unread": number }`: unread inbox items plus
unread imported hid-1.0 notifications, at most 1000. Not audited when it
succeeds (the portal polls it); a staff session answers 403
`PATIENT_SESSION_REQUIRED`, a revoked or ended session 403
`PATIENT_ACCESS_DENIED`.

**Access log.**

```text
GET /api/v1/identity/me/access-log?limit=<1..100, default 50>&before=<opaque cursor>
```

Patient session only. `200 { "events": [ { "id", "at", "action", "actorKind",
"actorName", "facilityName" } ], "nextBefore": string | null }`, newest
first: `id` is a string, `at` an ISO time (milliseconds, `Z`), `action` one of
`viewed`, `changed`, `access_granted`, `access_ended`, `emergency_access`,
`actorKind` one of `clinician`, `facility`, `patient`, `support`, `system`,
`actorName` the clinician's name or null, `facilityName` or null. It is read
from the patient's own successful audit events that record a clinician (or a
facility's system) reading or changing the record (EHR, Lab and Pharmacy
reads, lists and writes, document downloads and OCR source reads, OCR reads,
routed orders sent and withdrawn, and read, accepted, marked cannot complete
or wrong patient, or corrected by the receiving laboratory or pharmacy, work
items accepted, a lookup by Health ID), the patient's approval of an
access request and a clinician's use of the Access PIN (`access_granted`), a
clinician closing their access and the patient revoking it (`access_ended`)
and break-glass (`emergency_access`). Refused and failed attempts, request
interceptor rows, authorization checks, replays, the patient's own reads and
imported hid-1.0 rows are not shown; nothing about other patients and no
record contents, resource ids, reasons, addresses or user agents. Consecutive
views (or changes) by one person at one facility less than 10 minutes apart are
one entry at the latest time. `nextBefore` is the cursor for the next page
(`before`); null at the end. A page reads at most 2000 audit rows, so a page
can hold fewer entries than `limit` while `nextBefore` is still set. Each read
is audited as `identity.patient.self.access-log`. 400
`INVALID_ACCESS_LOG_LIMIT`, 400 `INVALID_ACCESS_LOG_CURSOR`, 403
`PATIENT_SESSION_REQUIRED` (staff), 403 `PATIENT_ACCESS_DENIED` (session no
longer live).

An Identity image before 0093's release does not serve the two GET routes
(404), answers phone sign-in and reset with 400 `VALIDATION_FAILED`, and keeps
its Google refusals; the website treats a 404 as not available yet.

### Patient profile parity with hid-1.0 (0094; owner decisions of 2026-10-28)

Patient sessions only on every Identity route below (`@PatientOnly`: a staff
session answers 403 `PATIENT_SESSION_REQUIRED`; a revoked or ended session 403
`PATIENT_ACCESS_DENIED`); every write is a cookie write with Origin and
`x-csrf-token`, as the other patient writes. Every success writes its own
audit row in its transaction, with no contact, code, photo or health value in
it; the interceptor records refusals.

**`GET /api/v1/identity/me` gains four keys** (and `emailVerified`, for the
profile's "email verified" item): `"email": string | null` (the account's
email, the one sign-in and recovery use), `"emailVerified": boolean`,
`"phone": string | null` (E.164; the website masks it), `"phoneVerified":
boolean` and `"hasPhoto": boolean`. The phone is null when there is none and
also for a phone migrated from hid-1.0 until the patient changes it (it is
encrypted with the migration's key, which Identity does not hold; phone
sign-in still finds it). A phone is verified only while it is the NIN route's
verified contact; a sign-up's declared phone and a changed phone are not
(production sends no SMS). Every other key is unchanged.

**Hospital and HMO.**

```text
GET /api/v1/identity/me/profile-details
PUT /api/v1/identity/me/profile-details   { "hospitalCurrentlyUsing": string | null, "hmoName": string | null, "expectedVersion": number }
```

Both answer `{ "hospitalCurrentlyUsing": string | null, "hmoName": string |
null, "rowVersion": number }`. Before the first save `rowVersion` is 0 and the
hospital is the one the patient declared at sign-up, if any; the first save
sends `expectedVersion: 0`. Values are trimmed (blank is null), at most 120
characters, no control characters (400 `PROFILE_DETAILS_INVALID` on the
field); a stale version answers 409 `VERSION_CONFLICT`. Free text, as
hid-1.0; the website offers the sign-up hospital picker. The read is audited
as `identity.patient.self.profile-details`, a save as
`identity.patient.profile-details.update`.

**Photo.**

```text
PUT    /api/v1/identity/me/photo   { "mediaType": "image/jpeg" | "image/png", "data": "<base64>" }   -> { "hasPhoto": true }
GET    /api/v1/identity/me/photo   -> the image bytes
DELETE /api/v1/identity/me/photo   -> { "hasPhoto": false }
```

The browser crops and re-encodes to a JPEG of at most 256 x 256 (the largest of
256, 224, 192, 160 and 128 px, best quality first, whose JSON body is at most
8,000 bytes) and drops all metadata; the
server checks again: strict base64 of at most 300 KB decoded (the route
admits a body of about 410 KB; every other Identity route keeps 256 KB), the
type proved by the magic bytes (JPEG `FF D8 FF` ... `FF D9`; PNG signature,
`IHDR` first, `IEND` last), so nothing may follow the image, the frame size
read from the JPEG start-of-frame or PNG `IHDR`, 1 to 1024 pixels a side, and
no Exif, XMP, IPTC or PNG text chunk. Anything else answers 400 `PHOTO_INVALID`.
At the production edge the request body must stay under 8,192 bytes: the
regional WAF in front of the API (AWS managed rule group
`AWSManagedRulesCommonRuleSet`, rule `SizeRestrictions_BODY`, on the public
ALB) answers 403 to a larger body before the gateway or Identity sees it. So
in practice the base64 JSON body carries a JPEG of at most about 6 KB (6,100
bytes); the website keeps the body under that limit. Identity's own limits
above are unchanged (they are what a request that reaches Identity meets).
It is stored encrypted in the database (AES-256-GCM with
`NIN_ENCRYPTION_KEY_B64`, bound to the patient and the image's sha256; no new
AWS infrastructure). `GET` answers the bytes with `Content-Type` the stored
type, `Content-Disposition: inline`, `Cache-Control: private, no-store` and
`X-Content-Type-Options: nosniff`, or 404 `PHOTO_NOT_FOUND`; it is not
audited when it succeeds (the header shows it on every page). `DELETE`
answers `{ "hasPhoto": false }` whether or not one was saved. Clinicians do
not see the photo. Without the encryption key a save or read answers 503
`PROFILE_PROTECTION_UNAVAILABLE`.

**Changing the email or the phone.**

```text
POST /api/v1/identity/me/contact-changes   { "channel": "email", "email": string, "currentPassword": string }
  -> { "changeId", "maskedContact", "expiresInSeconds", "resendAfterSeconds" }
POST /api/v1/identity/me/contact-changes/{changeId}/verify   { "code": "123456" }   -> { "email": string }
POST /api/v1/identity/me/contact-changes   { "channel": "phone", "phone": string, "currentPassword": string }
  -> { "phone": string, "phoneVerified": false }
```

Both channels need the current password (bcrypt for an account migrated from
hid-1.0, else argon2id): a wrong one answers 403 `PASSWORD_INCORRECT`. Every
attempt is counted, under the account's budget lock and before the hash is
checked (a right password gives its count back), so at most four passwords
are checked in 15 minutes however many requests arrive at once; the next
attempt answers 429 `CONTACT_CHANGE_RATE_LIMITED` and blocks contact changes
for 15 minutes. For 24 hours after an OTP account recovery both channels,
and the verify step, answer 403 `PATIENT_RECENT_RECOVERY_HOLD` before the
password is checked (as emergency contacts, access approvals and the Access
PIN: REC-NOTIFY), so whoever recovered the account with a code cannot also
move its email or phone. An account without a password (Google only)
answers 409 `PASSWORD_REQUIRED` "Set a password first to change your contact
details." A contact another account, patient or staff record holds answers
409 `CONTACT_UNAVAILABLE` "That email address or phone number can't be
used." with no further detail; the refused attempt counts toward the limits
and is audited as denied. A malformed or mixed body answers 400
`CONTACT_INVALID` (or `VALIDATION_FAILED`).

- Email: a patient account that is also a staff login (a platform role, a
  staff record or a facility membership: its email is the staff sign-in too)
  answers 409 `CONTACT_CHANGE_STAFF_ACCOUNT` "This account is also used to
  sign in as facility staff, so its email can't be changed here. Contact
  Health ID support to change it.", at the start and at verify. The new
  address (normalized to lower case) must differ from the account's verified
  address (400 `CONTACT_UNCHANGED` "That is already the email address on your
  account."). The account's own address while it is not verified
  (`emailVerified: false`) is accepted and goes through the same code step: on
  success it becomes verified and nothing else changes (no Google link,
  recovery code or session ends, and no notice is sent, since the previous
  address is the same one). A 6-digit code goes to the NEW address ("Confirm
  your new Health ID email address", hid-1.0's design, naming neither the
  patient nor the Health ID, since the address is not yet proved to be theirs;
  an older notification-api gets the generic `EMAIL_VERIFY` code instead); it
  expires after `OTP_EXPIRY_SECONDS` (300), allows `OTP_MAX_ATTEMPTS` (5)
  tries, and a new start is refused for `OTP_RESEND_COOLDOWN_SECONDS` (60) and
  after five in an hour (429 `CONTACT_CHANGE_RATE_LIMITED`); a new start
  replaces the open one. A code that cannot be delivered answers 422
  `CONTACT_CODE_UNDELIVERABLE`. `maskedContact` is the address as
  `n•••@example.com`. Verify: a wrong, used or expired code answers 400
  `OTP_INVALID_OR_EXPIRED` (the attempt is counted first; the fifth wrong one
  ends the change); an address taken meanwhile answers 409
  `CONTACT_UNAVAILABLE`. On success the account's email becomes the new
  address, verified, and so does the patient's contact email: sign-in,
  recovery, Google's automatic link and Novu's emails use it from then on, and
  the old address is free. Whoever holds the old mailbox keeps nothing it gave
  them: a Google account linked automatically because Google verified the old
  address no longer signs in (a Google account the patient linked or signed up
  with stays linked; the patient can link the unlinked one again from
  Settings, with the password, and it is then an explicit link, announced as
  `SECURITY_GOOGLE_LINKED`; another account still cannot link it), open
  recovery codes (password reset and hid-1.0 recovery) no longer complete, and
  the account's other sessions end (the caller's session and its refreshes go
  on). The OLD address gets "Your Health ID email was changed" (best-effort,
  after the answer), with the new one masked from letters, digits, "." and "-"
  only (any other character as "•", an international domain in punycode), so
  that no spelling of the new address can stop the notice.
- Phone: E.164 of any country or a Nigerian `0` and 10 digits (as sign-up;
  400 `CONTACT_INVALID` otherwise). It takes effect at once: phone sign-in
  and reset use the new number, the old one stops working, and the answer
  says `phoneVerified: false`. The number the profile already shows answers
  400 `CONTACT_UNCHANGED` "That is already the phone number on your account."
  and nothing is sent; a stored number the profile cannot show (one migrated
  from hid-1.0, under the migration's key) entered again is written again
  under Identity's key, as a change (announced, `phoneVerified: false`), so
  GET me shows it from then on. A number another patient holds, in either of
  a Nigerian number's stored forms, answers 409; five changes an hour at most
  (429). The account's verified email gets "Your Health ID phone number was
  changed" (best-effort), with the new number masked; an account without a
  verified email gets nothing.

A phone change ends no session and no recovery code. Audit:
`identity.patient.contact-change.start` (success, or denied for an
unavailable address), `.delivery` (failure: a code that could not be
delivered ended the change), `.verify` (refused codes, denied) and
`.complete` (resource type `patient-contact-change`, details
`{ channel, result }`, and for a completed email change the counts
`otherSessionsRevoked`, `recoveryCodesInvalidated`, `googleLinksRevoked`, or
`addressUnchanged: true` when the account's own address was verified),
and `auth.google.auto-link.revoke` (resource type `account`) when a Google
link ended; never an address, a number or a code.

**The patient's health information (EHR).**

```text
GET /api/v1/ehr/me/health-profile
PUT /api/v1/ehr/me/health-profile   { "bloodGroup", "genotype", "allergies", "currentMedications", "chronicConditions", "medicalNotes", "expectedVersion" }
```

Patient session (Identity authorizes it, as `GET /ehr/me/records`), facility
optional. Both answer `{ "bloodGroup": "A+" | "A-" | "B+" | "B-" | "AB+" |
"AB-" | "O+" | "O-" | null, "genotype": "AA" | "AS" | "AC" | "SS" | "SC" |
"CC" | null, "allergies", "currentMedications", "chronicConditions",
"medicalNotes": string | null, "rowVersion": number, "updatedAt": ISO | null }`.
Nothing saved is all null, `rowVersion` 0, `updatedAt` null; the website then
starts the form from the imported hid-1.0 profile (`importedHealthProfile` of
`GET /ehr/me/records`) and saves it as the patient's. Text is trimmed (blank
is null; CRLF is a newline), at most 1000 characters, no control character
but the newline (400 `HEALTH_PROFILE_INVALID`); another list value fails
validation (400 `VALIDATION_FAILED`); a stale `expectedVersion` answers 409
`VERSION_CONFLICT`. As for the photo, the request body must stay under 8,192
bytes at the production edge (the WAF answers 403 to a larger one before EHR
sees it): four 1000-character texts fit when they are plain ASCII, but text
with many accented or non-Latin characters (two or more bytes each in UTF-8)
can pass the limit, so the website keeps the body under it. Stored apart from
clinician records and from the imported profile; audited as
`ehr.patient.self.health-profile.read` and `.update` (the fields set, never
their values).

```text
GET /api/v1/ehr/patients/{patientId}/reported-health-profile
```

A clinician with `ehr.note.read` and `X-Facility-ID`/`X-Purpose-Of-Use`,
authorized and audited exactly as the chart's other reads
(`ClinicalRepository.run`, `read_records`; database RLS checks the same grant
again): `200` with the six fields and `updatedAt` (no `rowVersion`; all null
when the patient entered nothing), 403 `CONSENT_REQUIRED` without current
access. The read is audited as `ehr.record.read` on resource type
`patient-reported-health-profile`, which the patient's access log shows as a
view. The website labels it "Reported by the patient".

An Identity or EHR image before 0094's release answers these routes 404 and
`GET /identity/me` without the new keys; the website hides each section then.

### Patient sharing (0095, B4; owner decisions of 2026-10-28)

Patient routes are `@PatientOnly` (a staff session answers 403
`PATIENT_SESSION_REQUIRED`); every POST is a cookie write with Origin and
`x-csrf-token`. Staff routes need a staff session, `X-Facility-ID`,
`X-Purpose-Of-Use: direct-care` and `identity.consent.write`. Errors are
problem+json with `code` and a patient-written `detail`; unknown fields answer
400 `VALIDATION_FAILED`. Every request body is under 1 KB. While
`PATIENT_SHARES_ENABLED` is `false` (code default `true`; production sets no
key) every route below answers 404, as an Identity before 0095 does.

- `POST /api/v1/identity/me/share-providers/search` `{ query }` (3-80
  characters): 200 `{ items: [{ membershipId, clinicianName, role:
  'doctor'|'clinician'|'nurse', facilityName, organizationName, newOnHealthId
  }] }`, at most 10, never an email, phone, licence or account id; 400
  `SHARE_SEARCH_QUERY_INVALID`; 429 `SHARE_SEARCH_LIMITED` (30 an hour per
  account); 503 `SHARE_UNAVAILABLE`.
- `POST /api/v1/identity/me/shares` with `Idempotency-Key`: `{ membershipId,
  level: 'view_only'|'clinical_review'|'clinical_collaboration', duration:
  '24h'|'7d'|'30d'|'until_revoked' }`: 201 `{ consentGrantId, membershipId,
  scope, level, duration, startsAt, expiresAt, clinicianName, facilityName,
  replacedConsentGrantId, replayed: false }` (200 with `replayed: true` for a
  replay); 403 `PATIENT_RECENT_AUTH_REQUIRED` (sign-in older than 10 minutes),
  `PATIENT_RECENT_RECOVERY_HOLD`; 404 `SHARE_PROVIDER_UNAVAILABLE`; 409
  `IDEMPOTENCY_KEY_REUSED`; 429 `SHARE_CREATE_LIMITED` (20 a day). The
  clinician is emailed (`share-received`, no patient name or Health ID). A
  share is ended with `POST /identity/me/consent-grants/:grantId/revoke`.
- `GET /api/v1/identity/me/access-history`: each item gains `shareLevel`,
  `shareDuration` and `clinicianName`, null unless the grant came from a share
  or a confirmed invitation.
- `GET /api/v1/identity/me/share-invitations` (the website's served probe): 200
  `{ items: ShareInvitation[], limits: { maxOpen: 20, maxNewPerDay: 5,
  remainingToday } }`, open invitations and those ended in 30 days, newest
  first, at most 50; `ShareInvitation` = `{ invitationId, reference,
  inviteeEmail, inviteeName, level, duration, status:
  'pending'|'accepted'|'confirmed'|'cancelled'|'expired', createdAt, expiresAt,
  acceptedAt, deliveryOutcome: 'pending'|'sent'|'not_confirmed', offer: {
  clinicianName, role, facilityName, organizationName, newOnHealthId } | null
  (accepted only), consentGrantId (confirmed only) }`.
- `POST /api/v1/identity/me/share-invitations` with `Idempotency-Key`: `{
  email, name?, level, duration }`: 201 `{ invitationId, reference, status:
  'pending', expiresAt, deliveryOutcome: 'sent'|'not_confirmed', replayed }`,
  the same whether or not the address is registered (200 for a replay); 400
  `SHARE_INVITATION_EMAIL_INVALID`; 403 `PATIENT_RECENT_RECOVERY_HOLD`; 409
  `SHARE_INVITATION_ALREADY_OPEN`, `SHARE_INVITATION_TOO_MANY_OPEN` (20 open),
  `IDEMPOTENCY_KEY_REUSED`; 429 `SHARE_INVITATION_LIMITED` (5 a day). Past 3
  emails a day to one address the invitation is created and no email is sent
  (`not_confirmed`).
- `POST /api/v1/identity/me/share-invitations/:invitationId/cancel`: 200 `{
  invitationId, status: 'cancelled', replayed }`; 404
  `SHARE_INVITATION_NOT_FOUND`; 409 `SHARE_INVITATION_NOT_CANCELLABLE`.
- `POST /api/v1/identity/me/share-invitations/:invitationId/confirm`: 201 `{
  invitationId, status: 'confirmed', consentGrantId, scope, level, duration,
  startsAt, expiresAt, clinicianName, facilityName, replacedConsentGrantId,
  replayed }` (200 on a repeat); 403 as `shares`; 404
  `SHARE_INVITATION_NOT_FOUND`; 409 `SHARE_INVITATION_NOT_ACCEPTED`,
  `SHARE_PROVIDER_UNAVAILABLE`.
- Staff `GET /api/v1/identity/shared-with-me`: 200 `{ items: [{
  consentGrantId, patientId, hid, fullName, level, duration, scope, startsAt,
  expiresAt }] }`, the active shares to the caller's membership, at most 100.
- Staff `GET /api/v1/identity/share-invitations`: 200 `{ eligible, items: [{
  invitationId, reference, inviteeName, level, duration, createdAt, expiresAt
  }] }`, the pending invitations to the caller's verified sign-in email; no
  patient identity.
- Staff `POST /api/v1/identity/share-invitations/:invitationId/accept`: 200 `{
  invitationId, status: 'accepted', acceptedAt, replayed }`; 404
  `SHARE_INVITATION_NOT_FOUND`; 403 `SHARE_PROVIDER_NOT_ELIGIBLE`; 409
  `SHARE_INVITATION_NOT_PENDING`. The patient gets `SHARE_INVITATION_ACCEPTED`.

"Your records were opened": after every allowed staff authorization that
carries a non-emergency grant (`service/patients/:id/record-read-authorization`,
`authorization/check`, `service/authorization/check`, `patient-lookup`; never
`service/authorization/precheck` or `consent-status`), Identity notes the access once per patient, facility and Africa/Lagos day (at
most 10 a day), after the answer and never failing it: the inbox item
`RECORDS_OPENED` (resource `record-access`, metadata `facilityName`,
`accessKind` standard, share or pin) and, for a verified email with
notifications on, the email `record-access-alert` naming nothing but the time
(`RECORD_ACCESS_EMAIL_ENABLED`, default `true`). Other inbox codes:
`SHARE_INVITATION_ACCEPTED` (`facilityName`) and `SHARE_INVITATION_EXPIRED`
(resource `share-invitation`). notification-api gains `POST
notifications/patient-share-invitation`, `share-received` and
`record-access-alert` (fixed fields only; an older notification-api's 404 is a
definitive non-send).

### Delete my account (0096, B5; main 0064, owner decisions of 2026-10-28)

Patient routes, `@PatientOnly` and `@AuditFailuresOnly` (the SECURITY DEFINER
commands audit each success); every POST is a cookie write with Origin and
`x-csrf-token`; bodies are under 200 bytes. While `ACCOUNT_DELETION_ENABLED` is
`false` (code default `true`; production sets no key) every route below answers
404, as an Identity before 0096 does, and deletions already scheduled still
complete. Deletion closes the login only: the patient, the NIN binding,
clinical, consent and access, audit, authentication and notification records
are all kept.

- `GET /api/v1/identity/me/account-deletion` (the website's served probe): 200
  `{ waitingPeriodSeconds, confirmationTtlSeconds, request: null | { requestId,
  state: 'awaiting_confirmation'|'pending'|'blocked'|'cancelled'|'completed'|
  'expired'|'superseded', requestedAt, confirmationExpiresAt, scheduledFor,
  blockedReasonCode: 'LEGAL_HOLD'|'RETENTION_POLICY_UNAVAILABLE'|
  'WORKFORCE_ACCOUNT'|null, cancelledAt, cancellable } }`; 403
  `PATIENT_ACCESS_DENIED`.
- `POST /api/v1/identity/me/account-deletion` (no body): 201 `{ requestId,
  confirmationToken (43-character base64url, single use; only its SHA-256 is
  stored), confirmationExpiresAt (10 minutes), waitingPeriodSeconds }`; 403
  `PATIENT_RECENT_AUTH_REQUIRED` (sign-in older than 10 minutes),
  `PATIENT_RECENT_RECOVERY_HOLD` (24 hours after an OTP recovery),
  `PATIENT_SESSION_REQUIRED`; 409 `ACCOUNT_DELETION_ALREADY_PENDING`; 429
  `ACCOUNT_DELETION_RATE_LIMITED` (the sixth in a day); 503
  `ACCOUNT_DELETION_UNAVAILABLE`.
- `POST /api/v1/identity/me/account-deletion/confirm` `{ requestId (uuid v4),
  confirmationToken, confirmation }` (`DELETE MY ACCOUNT`, any case and
  spacing): 200 `{ requestId, state: 'pending'|'blocked'|'completed',
  scheduledFor, blockedReasonCode }`; 403
  `ACCOUNT_DELETION_CONFIRMATION_INVALID` (wrong token or phrase, or already
  used; the fifth failure expires the request),
  `ACCOUNT_DELETION_CONFIRMATION_EXPIRED`, `PATIENT_RECENT_AUTH_REQUIRED`; 400
  `INVALID_ACCOUNT_DELETION_COMMAND`; 503.
- `POST /api/v1/identity/me/account-deletion/cancel` `{ requestId }`: 200 `{
  requestId, state: 'cancelled', replayed }`; 404 `ACCOUNT_DELETION_NOT_FOUND`;
  409 `ACCOUNT_DELETION_NOT_CANCELLABLE` (completed, blocked, expired or due);
  503.

The login stops working at `scheduledFor` (14 days after confirmation); the
sweeper completes the deletion within a minute: sessions, federated links, the
access PIN, patient-granted access (approvals, PIN grants and 0095's shares;
break-glass is untouched), pending access requests and notification devices are
closed, emergency contacts deactivated, open share invitations cancelled, a
pending contact change invalidated and pending records-opened emails
suppressed. Inbox codes (resource `account-deletion`, the request id):
`ACCOUNT_DELETION_SCHEDULED` (`scheduledFor`), `ACCOUNT_DELETION_CANCELLED`
(`{}`), `ACCOUNT_DELETION_BLOCKED` (`reasonCode`). Emails, durable and sent by
the sweeper to the account's verified email: notification-api `POST
notifications/account-deletion` `{ channel: 'email', recipient, kind:
'scheduled'|'cancelled'|'completed', scheduledFor (scheduled only), plan? }`,
keyed `account-deletion:<requestId>:<kind>`; no name, Health ID or record.

### Phone and computer notifications (0097, B6; owner decisions of 2026-10-28)

Standard Web Push (RFC 8030) with VAPID (RFC 8292) and no payload: the service
worker shows the fixed "Health ID / You have a new notification." and opens
Notifications. Patient routes under `identity/me/web-push`, `@PatientOnly` and
`@AuditFailuresOnly` (the SECURITY DEFINER commands audit each success); the
PUT and the POST are cookie writes with Origin and `x-csrf-token`. While push is
not configured (Identity needs a valid `WEB_PUSH_VAPID_PUBLIC_KEY` and
`WEB_PUSH_SUBJECT`; production sets neither until the owner creates the key
pair) every route below answers a plain 404, a malformed body too, as an
Identity before 0097 does: a middleware answers it before authentication, the
Origin and CSRF checks and the ValidationPipe, so a request without a session
gets the same 404 with no token check, control read or audit row; the website
hides the section. Problems: 403 `PATIENT_SESSION_REQUIRED` (a non-patient session,
or the database's 42501: no live patient session), 503 `WEB_PUSH_UNAVAILABLE`
(any other database error, never its message).

- R1 `GET /api/v1/identity/me/web-push`: 200 `{ applicationServerKey (87
  base64url), keyId (16 hex: SHA-256 of the key's 65 bytes), limit: 10,
  subscriptions: [{ id, endpointDigest (64 hex), pushService:
  'fcm'|'mozilla'|'apple'|'windows', thisSignIn, keyCurrent, createdAt, boundAt,
  lastDeliveredAt | null }] }`, the account's active subscriptions, most
  recently bound first; never an endpoint, ciphertext, key, session or family id.
- R2 `PUT /api/v1/identity/me/web-push/subscription` `{ endpoint, expirationTime
  (null or a number, ignored), keys: { p256dh, auth }, keyId }` (at most about
  2.3 KB): 200 `{ id, created, endpointDigest, pushService }`; `created: false`
  when the endpoint was already this account's (now bound to this sign-in, same
  id). Checked in this order: the body (400 `VALIDATION_FAILED`), the keys (65
  bytes beginning 0x04 and 16 bytes, with or without padding; never stored; 400
  `WEB_PUSH_SUBSCRIPTION_INVALID`), the endpoint (rule E: at most 2048
  characters, its WHATWG serialization exactly itself, https, no user info,
  port, `#` (an empty fragment too) or empty query (a bare `?`), else 400
  `WEB_PUSH_SUBSCRIPTION_INVALID`; a host that is an IP
  literal or not exactly `fcm.googleapis.com`, `updates.push.services.mozilla.com`,
  `web.push.apple.com` / `*.push.apple.com` or `*.notify.windows.com`: 400
  `WEB_PUSH_SERVICE_UNSUPPORTED`), the key id (409 `WEB_PUSH_KEY_CHANGED`: reload
  R1 and subscribe again), 30 an hour per account (429 `WEB_PUSH_RATE_LIMITED`),
  the contact key (503). The endpoint is stored AES-256-GCM encrypted (the
  emergency contacts' key, associated data
  `identity:web-push-subscription:<id>:endpoint`) and as its SHA-256. One
  subscription per sign-in (a new endpoint replaces the sign-in's old one), at
  most 10 per patient (the least recently bound is removed), an endpoint on one
  account only (another account's subscription of the same browser is removed).
- R3 `POST /api/v1/identity/me/web-push/subscription/remove` `{ endpoint }` (an
  https URL of at most 2048 characters whose serialization is itself; no
  allowlist): 200 `{ removed: true|false }`, idempotent, never rate limited; 400
  `WEB_PUSH_SUBSCRIPTION_INVALID`.

A subscription belongs to the sign-in (the session family) that turned it on and
is pushed to only while that sign-in is live: not revoked, idle-expired or past
its absolute end, the current token version, the account active and not
deletion-due, the patient active (a temporary suspension pauses pushes and keeps
the subscription). Signing out turns notifications off on that device: the
website removes the subscription first, and the sweeper erases any subscription
whose sign-in has ended (`session_ended`, or `account_closed`). Account deletion
erases them in its completion. Every new unread inbox item makes the sweeper
send at most one push per subscription per 2 minutes; retries after 1, 2, 4, 8
and 16 minutes (a Retry-After up to an hour is honoured), the sixth failure
gives up that round; a 404 or 410 from the push service removes the
subscription; any other refusal waits an hour and the third in a row removes it.

- N1 (notification-api, not routed by the gateway) `POST
  /api/v1/notifications/web-push` `{ endpoint, vapidKeyId }`, workload
  authentication and `Idempotency-Key: web-push:<subscriptionId>:<claimedThrough
  epoch ms>` as the other routes: 202 `{ requestId, outcome:
  'accepted'|'gone'|'retry'|'rejected', pushStatus: number|null,
  retryAfterSeconds: number|null, safeCode: string|null }`; 404
  `WEB_PUSH_NOT_CONFIGURED` while its public key, private key
  (`WEB_PUSH_VAPID_PRIVATE_KEY`, held by notification-api only) and subject are
  not all valid and matching (Identity retries; it never removes a subscription
  for this); 400 `WEB_PUSH_ENDPOINT_NOT_ALLOWED` (rule E); 409
  `WEB_PUSH_KEY_MISMATCH`. The push: `POST <endpoint>` with `TTL: 14400`,
  `Urgency: normal`, `Topic: hid-inbox`, `Authorization: vapid t=<ES256 JWT: aud
  the endpoint's origin, exp 12 hours, sub the subject>, k=<public key>`, an empty
  body, no Content-Type, Content-Encoding or Crypto-Key, redirects never followed,
  timed out after the lower of `NOTIFICATION_PROVIDER_TIMEOUT_MS` and 5 seconds
  (inside Identity's 8-second wait for N1). 2xx accepted; 404/410 gone; 429 and 5xx retry; 3xx and other 4xx rejected;
  timeouts and transport errors retry. Logs the push service, status and outcome
  only.

`GET /api/v1/identity/me` returns the authenticated patient's profile and HID.
`GET /api/v1/identity/me/access-history` returns at most 50 safe grant summaries;
grant status does not assert notification delivery. Access-history items
include `breakGlass` and `patientRevocable`, both booleans and never both true;
the limit of 50 keeps the grants the patient can revoke before any others, and
the items are listed newest first.
`POST /api/v1/identity/me/consent-grants/:grantId/revoke` (`{ "reason" }`, 3 to
500 characters) revokes a grant the patient gave (patient-approved or
PIN-derived) and answers `200 { consentGrantId, status: "revoked", revokedAt,
replayed }`; a repeat, or a grant already revoked otherwise, answers
`replayed: true`. Break-glass and workforce grants, and an expired grant,
answer `409 CONSENT_COMMAND_CONFLICT`; another patient's or an unknown grant
`404 CONSENT_RESOURCE_NOT_FOUND`; a session that is no longer live `403
CONSENT_COMMAND_DENIED`; a short reason `400`; a staff session `403
PATIENT_SESSION_REQUIRED`. Revoking needs no recent sign-in and is never held
after an account recovery. `GET /api/v1/ehr/me/records`
returns at most 50 completed encounters and 50 current signed/amended note
revisions, after fresh Identity authorization through the EHR workload caller.
These routes accept no browser-selected patient identity. Patient record access
is read-only and owning-service disclosure/audit is atomic. The internal
`GET /api/v1/identity/service/patient-self-authorization` requires both the
current patient session and the exact authenticated EHR workload caller.

`POST /api/v1/identity/me/verification/nin` is a separate patient-session
command for QoreID evidence verification and progressive NIN binding. Its body
is `{ "nin": "<11-digit-NIN>", "dateOfBirth"?: "YYYY-MM-DD" }`; it returns only
a normalized provider/result state, optional opaque provider reference, and
timestamp. `dateOfBirth` is required when the profile has none (a patient who
signed up without a NIN, 0092; 400 `VALIDATION_FAILED` on `dateOfBirth` if
missing or invalid); the NIN record must then carry that date and the
profile's first and last name in either order (else 409
`PATIENT_NIN_DETAILS_MISMATCH`), and on success the record's date of birth is
stored on the profile. A profile with a date of birth keeps using it; a stated
date that differs is refused 409 `PATIENT_NIN_DETAILS_MISMATCH` before any
lookup. It accepts no other identity attributes and never creates a patient.
It is on unless `QOREID_PATIENT_SELF_NIN_BINDING_ENABLED=false` (owner decision
of 2026-10-27) and needs QoreID enabled; it does not expose provider
credentials or tokens. `GET /api/v1/identity/me` answers `ninVerified`
(a verified, unrevoked NIN identifier is bound).

`GET /api/v1/ehr/patients/:patientId/emergency-records` requires current workforce
permissions, emergency purpose and a freshly checked break-glass grant authorizing
the `read_records` action for the exact facility and patient. With 0117 it also answers `allergies` (recorded and
patient-reported, labelled by source; see section 44, "Allergies and the allergy check at prescribing"). Activation requires a reason, expires
within the configured 5–240 minute bounds, permits at most ten new activations
per account per hour, and atomically emits `EmergencyAccessActivated.v1` for
notification and review. Idempotent replay does not extend expiry. Expiry,
revocation and failed authorization/audit prevent further disclosure.
Identity's activation (`POST /api/v1/identity/break-glass`) also requires the
platform `break_glass_enabled` control, checked inside the activation
transaction before the command: while it is off, activation answers
`423 BREAK_GLASS_DISABLED` ("Emergency access is currently disabled by the
platform administrator") and writes no grant, and while the control cannot be
read, `503 PLATFORM_CONTROL_UNAVAILABLE`. It also requires an active
`emergency` purpose of use, which 0085 seeds; without it (an operator
deactivated the code) activation also answers `423 BREAK_GLASS_DISABLED`
("Emergency access is not enabled on this platform"), where it answered
`400 INVALID_CONSENT_COMMAND`. Other refusals are unchanged: a session
without `identity.consent.write` and `identity.break-glass.write`
`403 PERMISSION_DENIED`, before either check; a membership or context the
command refuses `403 CONSENT_COMMAND_DENIED`; an invalid duration or reason
`400 INVALID_CONSENT_COMMAND`; an unknown HID
`404 CONSENT_RESOURCE_NOT_FOUND`; the hourly limit
`429 EMERGENCY_RATE_LIMITED`; and a state conflict
`409 CONSENT_COMMAND_CONFLICT`.

Recovery completion atomically consumes the account/token-bound OTP credential,
sets an Argon2 password and revokes sessions. Disabled, stale, expired and replayed
credentials fail closed. Completion returns to login rather than opening a session.

## 1. Purpose

This document defines communication rules between HID clients and services.

Service implementations may evolve internally, but public contracts must remain explicit and versioned.

## 2. API Version

Current API version:

```text
/api/v1
```

Breaking future interfaces should use a new API version.

Do not silently break v1 clients.

## 3. API Entry

External clients use the approved API-only Gateway/BFF through the fixed
Cloudflare-to-AWS origin path.

Clients include:

* Next.js web
* React/Vite applications
* future mobile applications
* approved external integrations

## 4. General Rules

APIs must:

* validate requests
* authenticate protected requests
* authorize protected operations
* enforce facility context
* produce correlation IDs
* audit sensitive operations
* use consistent errors
* avoid unnecessary sensitive data
* remain mobile-friendly
* support idempotency for applicable writes

## 5. Recommended Headers

Use as applicable:

```text
Authorization
Content-Type
Idempotency-Key
If-Match
X-Correlation-ID
X-CSRF-Token
X-Facility-ID
X-Purpose-Of-Use
```

Do not expose secrets or raw sensitive identifiers through headers unnecessarily.

## 6. Problem Details

Use a consistent machine-readable error structure.

Conceptual fields:

```json
{
  "type": "problem-uri",
  "title": "Readable title",
  "status": 400,
  "detail": "Safe detail",
  "instance": "request-instance",
  "correlationId": "uuid",
  "code": "MACHINE_CODE"
}
```

Do not leak:

* secrets
* database details
* stack traces
* NIN
* access tokens
* protected clinical information

## 7. Health Endpoints

Every service should provide:

```text
GET /api/v1/health/live
GET /api/v1/health/ready
```

`live` confirms process health.

`ready` confirms required dependencies are ready.

### Extracted Identity boundary

The gateway preserves public `/api/v1/auth/*`, `/api/v1/identity/*`, and
`/api/v1/audit/*` URLs while routing them to `services/identity-api` on port
3001. EHR no longer hosts those routes.

Internal consumers use `packages/api-client` rather than direct database access
or scattered fetch calls. Every sensitive internal call carries two independent
forms of evidence:

```text
propagated user Authorization/cookie + facility/purpose/correlation
approved service workload identity + exact caller name
```

Identity validates both. Cookie mutation validation also propagates the exact
Origin and CSRF header/cookie evidence. Production workload evidence is an
issuer/JWKS-validated, audience-bound, unexpired JWT with an exact configured
caller subject; local per-caller secrets are development-only.

Internal actor/session validation uses `GET /api/v1/auth/service-session`, or
`POST` for cookie mutation revalidation. Patient decisions use
`POST /api/v1/identity/service/authorization/check`. A service that must refuse
before it opens anything prechecks a records read with `POST
/api/v1/identity/service/authorization/precheck` (body `{ patientId, scope:
'read_records', purpose }`; 400 `PRECHECK_READ_ONLY` for any other scope): the
same answer without `consentGrantId` or `expiresAt`, and without the check's
side effects (no "Your records were opened" note, no
`identity.authorization.check` row; Identity records only a neutral
`identity.authorization.precheck` row, which the patient's access history does
not list). The service still calls `service/authorization/check` before it
opens the record. An Identity without the route answers 404, and the caller
goes on without the precheck. These return API DTOs,
never database rows. Problem Details status/code, correlation, bounded timeout,
and safe JSON request bodies are preserved by the typed client.

## 8. Identity Resolution

HID lookup uses the existing versioned Identity resolution interface. Sensitive
NIN resolution uses the active body-based contract:

```text
POST /api/v1/identity/nin/resolve
```

Supported resolution inputs:

* HID
* NIN

For sensitive NIN lookup, prefer a body-based protected request when query-string exposure would create logging or browser-history risk.

### QoreID self and organization verification

This is distinct from governed NIN resolution above. The browser sends the
11-digit NIN (and, only for a profile without a date of birth, `dateOfBirth`);
the server adds required first/last name and DOB claims from the
authenticated patient's canonical profile to QoreID's request. HID never
returns the NIN or provider demographics. Extra browser body fields are rejected.

```text
POST /api/v1/identity/me/verification/nin
POST /api/v1/identity/organizations/verification/cac/hospital
POST /api/v1/identity/organizations/verification/cac/laboratory
POST /api/v1/identity/organizations/verification/cac/pharmacy
```

The first route requires an active patient session. The CAC routes require the
active facility plus `organization.manage` and accept exactly `{ "regNumber":
"RC1234" }` (or `BN`/`IT`). The server derives the existing organization from
the membership rather than accepting an organization ID. All routes return a
safe HID result state (`verified`, `not_verified`, `incomplete`) or static
Problem Details; raw QoreID payloads, NIN/CAC inputs, OAuth tokens, and
diagnostic text are excluded. Full configuration and activation controls are in
[QoreID verification contract](QOREID_VERIFICATION_CONTRACT.md).

### Patient enrollment activation signs the patient in

```text
POST /api/v1/identity/patient-enrollments/activate
```

Owner decision of 2026-10-28, for the sign-up without a NIN and the NIN route
alike. Body `{ password }` (12-256), with the `hid_enrollment` cookie, an
approved Origin and no session (else 409 `PATIENT_ENROLLMENT_REQUIRES_SIGN_OUT`
or `GOOGLE_ONBOARDING_REQUIRES_SIGN_OUT`). It answers
`200 { stage: "active", hidCode, signedIn }`:

- A first activation then signs the new patient in exactly as a successful
  `POST /api/v1/auth/patient/login` does with the new Health ID and this
  password: the same patient session (7 days idle, 30 days at most), the three
  session cookies (`hid_access`, `hid_access_refresh`, `hid_access_csrf`), the
  `x-csrf-token` header, the `auth.login` audit event and the session's
  device facts (address and hashed user agent). `signedIn: true`.
- A replay (the enrollment was already active, within the 15 minutes the
  enrollment cookie still shows the Health ID) verified no password, so it
  signs nobody in: `signedIn: false`, no cookie. Only the browser holding the
  enrollment cookie, and only its first activation, gets a session; once it
  holds the session, a further activation answers 409
  `PATIENT_ENROLLMENT_REQUIRES_SIGN_OUT`.
- If the session cannot be created (for example the audit write fails), the
  activation still succeeds with `signedIn: false` and no cookie; the patient
  signs in as before.

The enrollment cookie is kept and the Google onboarding cookie is cleared, as
before. A browser that reads `signedIn` as missing or `false` shows the Health
ID and asks the patient to sign in.

A first activation also sends "Your Health ID is ready" (below) to the contact
the enrollment verified when it is an email address. It is sent after the
answer and never holds it up or fails it.

### Patient emails (owner decision of 2026-10-28)

Identity sends these emails through notification-api, which renders them in
hid-1.0's design (its layout, colours and wording, with "HID" spelt "Health
ID"), as a text part and an HTML part (SES multipart/alternative; Brevo
`textContent` and `htmlContent`). Each is best-effort: a failed or refused send
never fails the sign-up or the reset, and Identity logs only the correlation
id, the outcome and a safe code. None carries a password, a NIN, a link or a
code in a URL or subject.

| Email | When | notification-api route (workload-authenticated, `Idempotency-Key`) |
| --- | --- | --- |
| "Your Health ID is ready": greets the patient by first name and shows the Health ID | A first activation, to the verified email (key `patient-welcome:<patientId>`) | `POST /api/v1/notifications/patient-welcome` `{ channel: "email", recipient, firstName?, healthId, plan }` |
| "Your Health ID password reset code": greets the patient by first name, names their Health ID, shows the code and its expiry in minutes | `POST /api/v1/auth/otp/start` with `PASSWORD_RESET` for a patient account with an email, patients migrated from hid-1.0 included since 0093 (key `otp:<challengeId>`). Staff and admin resets have their own email since Q89 (section 53); legacy recovery and SMS keep the generic code message | `POST /api/v1/notifications/password-reset-code` `{ channel: "email", recipient, code, firstName?, healthId, expiresInMinutes (1-60), plan }` |
| "Your Health ID password was updated": names the Health ID when known (migrated hid-1.0 patients too, since 0093) and Health ID support's address | After `POST /api/v1/auth/otp/complete` completes, to the account's email (key `password-updated:<challengeId>`); an account without an email gets nothing | `POST /api/v1/notifications/password-updated` `{ channel: "email", recipient, firstName?, healthId?, plan }` |

All three routes take email only and refuse unknown fields (400). `firstName`
is letters, marks, apostrophes, spaces, dots and hyphens (at most 120);
`healthId` is `HID-` and 6-32 Health ID characters. A notification-api that
does not serve `password-reset-code` yet answers 404 having sent nothing;
Identity then sends the code once through `POST /api/v1/notifications/otp`
under the same key. Any other answer is final, so a code is never sent twice.
The start still answers every identifier alike and does not wait for any
delivery.

### Patient sign-up without NIN

Owner decision of 2026-10-27 (as hid-1.0): no NIN at sign-up.

```text
POST /api/v1/identity/patient-enrollments/signup
```

Public, with the NIN start's origin, Turnstile (`patient-enrollment`),
signed-out and `Idempotency-Key` rules. Body: `firstName`, `lastName` (1-80),
`email` (<=254), `phone` (E.164 of any country, or a Nigerian `0XXXXXXXXXX`
stored as `+234...`; since 0093, see above),
`gender` (`male`, `female`, `intersex`, `other`, `unknown`), optional
`hospitalCurrentlyUsing` (<=120), `termsAccepted: true`, `turnstileToken`,
`turnstileAction`. It stores the declared profile in a pending enrollment
without a NIN (0092), sets the `hid_enrollment` cookie and sends a
`SIGNUP_VERIFY` code to the email at once; it answers the enrollment progress
(`stage: verify_contact`, `contactChannel: email`, `maskedContact`,
`challengeId`, `expiresInSeconds`, `resendAfterSeconds`, `expiresAt`). Refusals:
400 `VALIDATION_FAILED`; 409 `PATIENT_EMAIL_ALREADY_REGISTERED`, 409
`PATIENT_PHONE_ALREADY_REGISTERED`, 409 `IDEMPOTENCY_KEY_REUSED`; Turnstile and
rate limits as the NIN start. `POST .../contact` resends only to the declared
email (else 400 `ENROLLMENT_CONTACT_MISMATCH`); `POST .../contact/verify` is
unchanged for the browser, and `POST .../activate` is described below, for both
routes. `GET .../availability`
answers `{ open, signup: true, ninStart }`: `open` is the sign-up's, independent
of QoreID and the NIN keys; `ninStart` is the NIN-first start's.

### HID Resolution

Input:

* HID

Return only authorized patient identity information required by the caller.

### Registration Capabilities

`GET /api/v1/identity/registration-capabilities` requires authenticated workforce
access, `X-Facility-Id`, and `identity.registration.write`. Staging returns:

```json
{"nin":{"enabled":false,"state":"deferred"},"newPatientRegistrationRequiresNin":true}
```

With `NIN_PROVIDER_MODE=deferred`, NIN resolve returns HTTP 503 with code
`NIN_PROVIDER_DEFERRED` before identifier lookup or a provider call. No NIN keys
or QoreID credentials are required for startup. Existing case review and enrollment
retain their identity-evidence, authorization and audit requirements. Reviewed
synthetic staging accounts exercise recovery, sign-in and care access independently
of new NIN registration; see [staging patient journeys](STAGING_PATIENT_JOURNEYS.md).

### NIN Resolution

Flow:

1. validate format
2. verify through NIN provider abstraction when required
3. use a keyed lookup HMAC to search verified bindings
4. search deterministic demographic candidates when no binding exists
5. create or replay an idempotent registration case
6. audit lookup and case creation atomically
7. return only the case state and an authorized canonical patient reference when already resolved

Do not unnecessarily return raw NIN.
Do not persist an unkeyed digest of raw NIN in idempotency records.

### Registration Cases

```text
GET  /api/v1/identity/registration-cases/:caseId
POST /api/v1/identity/registration-cases/:caseId/approve-new
POST /api/v1/identity/registration-cases/:caseId/link-existing
POST /api/v1/identity/registration-cases/:caseId/enroll
```

`resolve`, `approve-new`, and `link-existing` require `Idempotency-Key`.
Review commands require `expectedVersion` and fail with a version conflict when
the case changed. Replaying the same key and canonical request returns the
existing terminal result; reusing a key with a different request returns a
conflict.

Case states currently include:

```text
pending_new_identity_approval
review_required
resolved_existing_identity
linked_existing
approved_new_identity
rejected
cancelled
```

`resolved_existing_identity` means the verified NIN was already bound and no
identity mutation occurred. `linked_existing` requires explicit review of a
stored candidate. `approved_new_identity` is the only transition that may issue
a new canonical UUID and HID.

Enrollment requires `identity.registration.approve`, the current facility,
`Idempotency-Key`, `expectedVersion`, reason, `healthcare-operations` purpose and
a normalized email address. Only a resolved, currently verified canonical NIN
binding can enroll an unmapped patient. The command creates a separate
`pending_reset` auth account and immutable enrollment evidence; it does not link
an existing account merely because an email matches. Governed NIN assurance is
preserved when the existing OTP flow verifies contact ownership and sets the
password. The case response supplies only bounded authorized review candidates.
Real NIN verification still requires a configured provider; deterministic mode
is test-only, is rejected in staging, and unavailable/deferred modes cannot issue
verified evidence.

### Outreach registration boundary

```text
GET  /api/v1/outreach/registration-cases
GET  /api/v1/outreach/registration-cases/:caseId
POST /api/v1/outreach/registration-cases
POST /api/v1/outreach/registration-cases/:caseId/link-existing
```

All requests require authenticated Identity user context, an authorized exact
`X-Facility-ID`, `X-Purpose-Of-Use: direct-care`, and a correlation ID. Cookie
requests also require the same-origin `Origin` and CSRF token. Writes require a
stable `Idempotency-Key`. Creation accepts a UUID-v4 local command ID and only a
`tmp_<uuid-v4>` temporary patient reference; it always returns
`identity_resolution_pending` initially.

`link-existing` requires a canonical Identity patient UUID, a reason, and the
exact expected Outreach row version. Outreach calls the Identity authorization
boundary with separate `outreach-api` workload evidence before opening the
mutation transaction. Stale versions return 412; a reused idempotency key with
different content returns 409; Identity/dependency failure never returns
success. There is no Outreach create-patient, HID, NIN, encounter,
screening, document, OCR, or EHR-ingestion endpoint in this slice. Campaigns
are served under the same prefix (`/campaigns`), and only a campaign's own
admins manage one (section 40, 0111).

## 9. Patient Identifier Contract

Conceptual identifier:

```text
id
patient_id
type
protected value
verified
registration_case_id for NIN
created_at
```

Rules:

* HID remains canonical application identifier.
* NIN is secondary.
* verified NIN is unique.
* NIN is never patient primary key.

## 10. Authorization Contract

Services requiring access to patient data must obtain approved authorization context.

Authorization should include:

* actor
* active facility
* patient
* purpose
* permission
* consent or break-glass evidence where required
* expiration when applicable

Do not authorize based only on UI-selected roles.

## 11. EHR

EHR endpoints operate on canonical Identity patient IDs.

Representative resources:

```text
/api/v1/ehr/patients/:patientId/encounters
/api/v1/ehr/patients/:patientId/encounters/:encounterId/clinical-notes
/api/v1/ehr/patients/:patientId/encounters/:encounterId/vitals
/api/v1/ehr/patients/:patientId/encounters/:encounterId/diagnoses
/api/v1/ehr/patients/:patientId/encounters/:encounterId/prescriptions
/api/v1/ehr/patients/:patientId/encounters/:encounterId/prescriptions/:prescriptionId/pharmacy-work-item
```

All writes require:

* verified actor
* facility context
* authorization
* validation
* audit
* appropriate concurrency protection

## 12. Lab

EHR communicates with Lab through Lab APIs.

Representative operations:

```text
POST /api/v1/lab/requests
GET  /api/v1/lab/requests/:requestId
PATCH /api/v1/lab/requests/:requestId
POST /api/v1/lab/imports
GET  /api/v1/lab/imports?patientId=<uuid>[&cursor=<importId>][&limit=1..50]
GET  /api/v1/lab/imports/:importId
```

`POST /api/v1/lab/imports` is an idempotent Lab-owned command for imported
external evidence. It requires the canonical Identity patient UUID, importing
facility context, an authorized source document, one or more bounded imported
observations, `Idempotency-Key`, and `X-Purpose-Of-Use: direct-care`. It never
represents native HID accessioning, specimen handling, execution, QC, or Lab
verification. OCR LAB publication invokes the same Lab service contract with
the exact document, job, extraction, validation/version, publication, patient,
facility, reviewer, and publishing actor references.

`GET /api/v1/lab/imports?patientId=<uuid>` lists one patient's imported Lab
evidence at the requesting facility, newest received first, each with its
observations in order, so OCR-published paper results reach the chart. It
needs `lab.import.read` and `X-Purpose-Of-Use`, and the same canonical
`read_records` decision as `GET /api/v1/lab/imports/:importId` (taken before
any query; a refusal is `403 LAB_IMPORT_ACCESS_DENIED` with no rows and no
read audit). The 0017 row-level security policies apply as well. The page is
`{ records, nextCursor }`: `limit` defaults to 20 and is at most 50;
`nextCursor` is the last import id, sent back as `cursor`. Each record carries
`externalLabName`, `collectedAt`, `reportedAt`, `receivedAt` and the source
document and OCR job, extraction, validation (and version) and publication
ids. One audit row per page (`lab.import.list`) records ids and counts only.
`patientId` is the Identity UUID; a Health ID is never accepted in this URL.

Exact contract should be documented through OpenAPI.

Lab results may notify consuming services through events.

## 13. Pharmacy

EHR communicates with Pharmacy through Pharmacy APIs.

Implemented operations:

```text
POST /api/v1/pharmacy/work-items/accept-ehr-prescription  # internal EHR caller
GET  /api/v1/pharmacy/work-items
GET  /api/v1/pharmacy/work-items/:workItemId
POST /api/v1/pharmacy/work-items/:workItemId/dispensings
GET  /api/v1/pharmacy/dispensings/:dispensingId
POST /api/v1/pharmacy/dispensings/:dispensingId/reversals
POST /api/v1/pharmacy/imports/from-ocr                  # internal OCR caller
POST /api/v1/pharmacy/imports/from-ocr/batch            # internal OCR caller, 2-50 medicines
GET  /api/v1/pharmacy/imports?patientId=<uuid>[&limit=1-100][&cursor=<id>]
GET  /api/v1/pharmacy/imports/:importId
```

EHR's public handoff command requires the prescription ID, current expected row
version, reason, and `Idempotency-Key`. EHR locks and verifies the current
`active` prescription before sending its exact canonical patient, same-facility
source ID/version, encounter, medication/dose/route/frequency/instructions,
prescriber, and timestamp snapshot. Pharmacy reauthorizes the actor and
patient, enforces same-facility processing, and returns an `accepted` work item.
That result never means `dispensed`.

Dispensing is a separate Pharmacy command requiring an accepted work item,
expected work-item version, positive quantity/unit, reason, pharmacist
permission, non-break-glass write authorization, and idempotency. This slice
allows one full dispensing per work item; partial fills and refills are not
modeled. Reversal requires the exact dispensing version and appends a preserved
relationship rather than updating or deleting the original event.

The OCR import command accepts only the exact reviewed document/job/extraction/
validation/version/publication provenance and bounded medication text. Its
response is always `IMPORTED_MEDICATION_EVIDENCE` with activity status
`unknown`; no request can supply `active`, `dispensed`, stock, or administration
state. No direct EHR- or OCR-to-Pharmacy database access exists.

The batch command takes the same provenance once plus `medications`, 2 to 50
entries of the same bounded text (`medicationText`, `strengthText`, `doseText`,
`frequencyText`, `historicalContext`), and stores each entry as its own record
in one SERIALIZABLE transaction: every record is written, or none is. It has
the same guards as the single route (`InternalCaller('ocr-api')`,
`pharmacy.import.write`, `write_records` with view-only shares and break-glass
refused). Entries are never merged. Each record gets the idempotency key
`<Idempotency-Key>:mNN` (NN = 01-50 in array order; the batch key may be at most
120 characters) and a per-medicine `publicationId`: the UUID version 5 of
`<publicationId>:NN` in a fixed namespace (`batchPublicationId` in
pharmacy.service.ts). For batch records, `publicationId` is therefore not the
OCR publication id; `validationId`, one-to-one with the OCR publication, links
every record of the batch. A replay with the same body answers the stored
records; a partial or different replay, or a publication already stored through
the single route, answers 409 `IDEMPOTENCY_CONFLICT`. The answer is
`{ id, count, items }`, where `items` are the records in array order and `id`
is the first.

`GET /api/v1/pharmacy/imports?patientId=` answers one patient's imported
medication records at the request's facility (single and batch alike), newest
first (`created_at`, then `id`), as `{ items, nextCursor }`: each item is the
same projection as `GET imports/:importId`, OCR provenance ids included
(`sourceDocumentId`, `ocrJobId`, `extractionId`, `validationId`,
`validationVersion`, `publicationId`). `limit` is 1-100 (default 50);
`nextCursor` is the last record's id when more may follow, else `null`, and is
passed back as `cursor` (a cursor that is not one of this patient's records
here answers an empty page). It has the guards of `GET imports/:importId`:
browser route, `pharmacy.import.read`, Identity `read_records` for that patient
at that facility under `X-Purpose-Of-Use` (break-glass may read), checked
before any read, so a refusal reads and audits nothing; row-level security
(`pharmacy_imports_read`) applies as well. One audit row
`pharmacy.import.list` names the patient, with the returned ids and count only.
Any other query parameter, `healthId` among them, is refused 400.

## 14. OCR

The gateway owns `/api/v1/ocr/*` and routes it to the independently runnable
OCR API on port 3005. Port 3002 is EHR-only and must not expose these routes.
The EHR browser UI consumes the shared typed OCR contracts/client without
changing public URLs.

Current durable job endpoints:

```text
POST /api/v1/ocr/jobs
GET  /api/v1/ocr/jobs?documentId=:documentId
GET  /api/v1/ocr/jobs/:jobId
POST /api/v1/ocr/jobs/:jobId/retry
GET  /api/v1/ocr/jobs/:jobId/extractions
POST /api/v1/ocr/jobs/:jobId/validation
POST /api/v1/ocr/jobs/:jobId/validations
GET  /api/v1/ocr/jobs/:jobId/validations
POST /api/v1/ocr/jobs/:jobId/patient-confirmation
POST /api/v1/ocr/validations/:validationId/publications
GET  /api/v1/ocr/validations/:validationId/publications
GET  /api/v1/ocr/quality/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
```

The document-scoped job lookup returns the latest authorized job as
`{ job: OcrJob | null }`. The EHR review client also uses
`GET /api/v1/ehr/documents?patientId=:patientId&encounterId=:encounterId` to
list safe document metadata in the active patient and encounter boundary.
Both reads re-authorize canonical patient access on the server; document
storage keys and provider credentials are never returned. Source preview uses
the existing authorized short-lived document download command.

Job creation accepts:

* an authorized registered document identifier
* a provider-neutral provider selector
* an optional already-known canonical Identity patient UUID
* `Idempotency-Key`

The server resolves the private immutable object reference and requires an
exact current clean-scan binding. A repeated key with the same canonical
request returns the existing job; a different request conflicts. Reads,
retries, and validation reauthorize against the source document's canonical
patient and exact actor facility.

OCR resolves that evidence through the internal typed EHR contract rather than
EHR SQL:

```text
GET  /api/v1/ehr/internal/ocr/documents/:documentId/source
POST /api/v1/ehr/internal/ocr/patients/:patientId/clinical-notes
```

These routes require propagated human authentication plus an independent exact
`ocr-api` workload identity. The source read returns only the document,
patient, facility, object-version, SHA-256, status, and scan status required by
OCR. The clinical-note command requires `ocr-publication:<publicationId>`
idempotency and preserves the existing immutable provenance contract. They are
not browser endpoints.

Return only governed job/extraction fields including:

```text
job identifier
extracted text
structured fields
confidence scores
processing status
```

OCR output is provisional.

No clinical record may be created solely from this response.

## 15. OCR Validation

Provide an explicit validation workflow.

Validation operation:

```text
POST /api/v1/ocr/jobs/:jobId/validation
```

Exact design may evolve.

Required invariant:

Human confirmation precedes clinical persistence.

Validation appends a corrected candidate referencing the immutable source
extraction. It does not publish to EHR, Lab, Pharmacy, or Identity.

Validation records an explicit `validated` or `rejected` disposition, confirmed
target domain, HID-owned candidate type, accepted/rejected fields, corrections,
reviewer, reason, and provenance. It requires `Idempotency-Key` and an expected
OCR job version. The singular validation route remains a compatible alias.

Several medicines from one paper (`PHARMACY`): `acceptedFields.medications` is a
list of 1 to 50 entries in reading order, each `{ itemId?, page, medicationText,
strengthText?, doseText?, frequencyText?, historicalContext }`; `page` is an
integer 1-10000 and `historicalContext` (the as-written text and page) is
required. `itemId` is the reading item id (`it-` and 16 hex characters, unique
in the review) when the entry was taken from a reading item; it must then be a
`medicine` item read on that `page` of the reviewed extraction, or validation
answers 400 `OCR_MEDICATION_NOT_READ`. An entry the reviewer typed from the
page has no `itemId` (AI reading off, which is the default, declined, failed,
or missed that medicine); its `page` must be a page of the reviewed extraction,
or validation answers 400 `OCR_MEDICATION_PAGE_NOT_FOUND`. Read and typed
entries may be mixed. Every entry stays its own record, even when identical. The
legacy shape (the five text fields at the top of `acceptedFields`) is unchanged;
sending both shapes, an empty list or more than 50 answers 400
`OCR_INVALID_MEDICATION_EVIDENCE` and stores nothing. One medicine in either
shape publishes through `POST /api/v1/pharmacy/imports/from-ocr` exactly as
before; two or more publish through one call to `.../from-ocr/batch`, all or
none, and the publication's `targetResourceId` is the first record (the audit
`ocr.publication.succeed` lists every id and the count). `itemId` and `page`
stay in the stored review and are not sent to Pharmacy.

Dates on paper lab results (`LAB`): the reviewer sends the text as written as
`collectedAtAsWritten`, `reportedAtAsWritten` and, per observation,
`reportedAtAsWritten` (1-120 characters), optionally with `page` and `itemId`
per observation. The text is always kept in the stored review. Lab receives a
real date only when the text is unambiguous: the whole text is day/month/year
with `/`, `-` or `.` (day first, as used in Nigeria), day month-name year, or
month-name day year (an ordinal suffix and a comma are allowed), or an ISO date
(optionally with a time `THH:mm`, `THH:mm:ss` or `THH:mm:ss.fff`, with or
without a zone, as Lab's ISO 8601 check accepts; the time must be real);
the year has 4 digits and is 1900 or later; the day exists on the calendar; and
it is not later than today in Lagos (for publication, the day the review was
stored). Forms other than ISO become midnight UTC of that day; ISO passes
unchanged. Anything else (2-digit year, month and year only, a range, extra
words) sends no date and is not an error. A legacy `reportedAt`/`collectedAt`
that is not ISO is read as text written on paper by the same rule. An ISO value
sent together with as-written text must be the same day, else 400
`OCR_LAB_DATE_CONFLICT`; when it carries a time it is sent instead of midnight.
A legacy ISO `reportedAt`/`collectedAt` (with or without a time or zone) passes
unchanged, and one that is not a real day and time answers 400
`OCR_INVALID_LAB_EVIDENCE`. Order of the top-level dates (Lab's
`reported_at >= collected_at`): days are compared first (a value with a zone by
its day in Lagos, otherwise the day written; a value without a zone is read as
UTC, as the database reads it); a report day before the collection day answers
400 `OCR_LAB_DATE_ORDER`. On the same day, when one side names a day only (a
converted paper date or an ISO day without a time) and would fall before the
other side's time, that day-only date is not sent (its as-written text stays in
the stored review) rather than refusing or inventing a time; two times in the
wrong order answer 400 `OCR_LAB_DATE_ORDER`. The as-written keys, `page` and
`itemId` are never sent to Lab.

Review outcome (phase 1, measurement only; no migration). Every validation,
validated or rejected, stores `provenance.reviewOutcome` in
`ocr.validations` (beside `source` and `extractionId`) and the same object in
the `details.reviewOutcome` of its `ocr.validation.accept` /
`ocr.validation.reject` audit event. It compares the reviewed extraction's
reading (`structured_payload` items and `provenance.reading`) with what the
reviewer kept, as counts and codes only: schema `hid.ocr.review-outcome/v1`,
`promptVersion`, `processingContract`, `readingStatus`, `linkage`
(`item_ids` | `estimated` | `none`), `estimated`, `totals`, `buckets` (per item
kind x decision x AI confidence x hard page x `readBy`, each with check-reason
code counts and field-change class counts) and `reviewer` (counts of the
optional signals below). Decisions: `kept_unchanged`, `kept_changed`,
`removed`, `added_by_reviewer` (entries linked by `itemId`, or typed),
`unlinked` (whole text saved without item links: an EHR note, the legacy
single medicine, a list with no `itemId`; the summary is then `estimated` and
carries `estimate.foundInSavedText` / `notFoundInSavedText` / `notChecked`
instead of per-item decisions; at most 300 items are checked, within a fixed
allowance of 1,000,000 word comparisons and 2,000,000 edit-distance cells, the
rest are `notChecked`), `not_in_target` and
`rejected_with_document`. When nothing was read of the kept kinds, typed
entries are `added_by_reviewer` and `linkage` is `none`. "Changed" uses the
OCR accuracy kit's normalisers (name, strength, frequency for medicines; name,
value, unit and date for lab results), so spacing, case and spellings such as
"5 mg"/"5mg" or "bd"/"twice daily" are not changes. It never holds a name,
value, text, item id or reviewer identifier. It is kept to 16,384 bytes
serialised: past that every bucket's check-reason counts are emptied and
`checkReasonsDropped: true` is added, and if it is still larger the stored value
is `{ schema, error: 'summary_too_large' }`. Computing it never blocks a save:
on any failure the stored value is `{ schema, error: 'summary_failed' }`.

Optional review signals on the validation body (all optional; existing clients
are unaffected): `reviewConfirmed` (boolean), `missedItems` (integer 0-200),
`removedItems` (up to 200 `{ itemId, removalReason? }`, the reason optional:
`not_on_paper` | `duplicate` | `not_needed` | `unreadable` | `other_patient`),
`rejectionReasonCode` (only with `rejected`, else 400
`OCR_REJECTION_REASON_NOT_ALLOWED`: `wrong_patient`, `wrong_document`,
`unreadable`, `duplicate_document`, `pages_missing`, `reading_unusable`,
`not_clinical`, `other`), and on any `corrections[]` entry `itemId`, `fields`
(1-9 distinct of `name`, `strength`, `dose`, `frequency`, `route`, `duration`,
`date`, `value`, `unit`) and `changeReason` (`misread` | `clinical_update`).
They enter the review outcome as counts only. When sent they join the request
digest (the same `Idempotency-Key` with different signals answers 409
`IDEMPOTENCY_CONFLICT`); when absent the digest is exactly as before. None is
ever required from staff (owner decision Q43): every one, and every reason, may
be left out. Each extraction on `GET /api/v1/ocr/jobs/:jobId/extractions`
carries `reviewLearning: true` on a server that accepts them; a client sends
them only when it sees it (an older server answers them 400).

`GET /api/v1/ocr/quality/summary` (staff actors only: a platform
administrator, holding platform permissions `platform.admin.access` and
`platform.operations.read`, or the manager of the facility named by
`X-Facility-ID`, whose membership at that facility holds `workforce.manage`, at
a facility not awaiting Health ID support's review; a manager's permission at
another facility never counts; anyone else, including the administrator of a
self-signed-up facility still awaiting review, 403 `PERMISSION_DENIED`). Every
answer carries `available`. No staff monitoring: for a manager, each review is
read with its reviewer keyed by a fresh random per-request key (SHA-256 in the
database; unlinkable to a person or across requests, never returned or
logged). Fewer than 3 distinct reviewers in the (widened) range answers `{
schema, from, to, scope, available: false, reason: 'too_few_reviewers' }` with
no counts; otherwise any group to which fewer than 3 distinct reviewers
contributed is suppressed like a small group (the rule counts distinct
reviewers; it does not weigh how much each did). A manager's range also ends at
the last finished ISO week (the answer's `to`; asking only about the current
week answers `too_few_reviewers`), so a group shown never changes later, and
when more than 50,000 reviews match, the last, cut-off week is left out.
Platform administrators get every group over the minimum size, current week
included. When figures are returned (`available:
true`) the route sums stored review outcomes by ISO
week, facility, item kind and prompt version (`itemGroups`) and by ISO week,
facility and prompt version (`reviewGroups`) for `from`..`to` (UTC days,
inclusive, default the last 28 days, at most 92; else 400
`OCR_QUALITY_RANGE_INVALID`), widened to whole ISO weeks (Monday to Sunday;
the answer's `from`/`to` are the widened days) so two ranges a day apart cannot
be subtracted. A group with fewer than 20 items (reviews, for a review group) is
returned as `{ ...keys, suppressed: true }` with no counts. Inside a group that
is shown, reason, check-reason and field-class counts under 5 are left out and
counted in `smallCellsHidden` (a hidden count can still be worked out from the
group's totals; the hidden code cannot). `summaryFailed` counts both
`summary_failed` and `summary_too_large`; an outcome stored with
`checkReasonsDropped` adds no check-reason counts.
There are no per-reviewer figures. The read is audited as
`ocr.quality.summary.read` with the range, the reader kind
(`platform_admin` or `facility_manager`), `available` and counts only. Row-level security
limits it to the facility named by `X-Facility-ID` (`scope: 'bound_facility'`);
a cross-facility read needs a database change that is not part of this phase.

Patient confirmation is a separate idempotent command bound to the canonical
Identity patient already governing the source document. The server rechecks
write authorization and rejects break-glass, facility mismatch, wrong-patient,
and stale job versions.

Publication requires `Idempotency-Key`, `direct-care`, an explicit validation
ID/version, and the latest confirmation ID. It needs the publisher's own
direct-care `write_records` grant on the patient for every target (section
39), or the patient's dedicated records-processing grant, which publishes any
reading (a Lab, medicine or document-only one as a draft note titled by kind)
as a draft into the patient's "Imported paper
records" encounter (section 42, 0113): a caller with neither who can read the
job answers 403 `OCR_PUBLISH_NEEDS_DIRECT_CARE`; one who cannot read the job
answers 404 `OCR_JOB_NOT_FOUND`. An EHR reading's `encounterId` is optional
since 0113: without one, the note goes to the imported paper records. Current operations are EHR
`create_imported_clinical_note`, Lab `create_imported_lab_evidence`, Pharmacy
`create_imported_medication_evidence`, and `retain_validated_document` for
`DOCUMENT_ONLY`. EHR creates a draft imported
note with immutable source provenance. Lab creates explicitly imported external
evidence through its owning command and exact OCR provenance. Pharmacy creates
historical medication evidence through its owning command and exact provenance;
it cannot create Pharmacy work or dispensing.

The OCR API uses typed shared clients for Identity, EHR, Lab, and Pharmacy.
User credentials, facility, purpose, correlation, CSRF/origin evidence where
applicable, and idempotency are propagated separately from workload identity.
Calls are bounded; idempotent publication calls retry only transient transport
or 502/503/504 failures. OCR never reports `published` until the owning service
returns its durable resource reference.

## 16. Storage

Uploads should use controlled storage flows.

Never return permanent public healthcare document URLs.

Use:

* authorized upload intent
* signed upload
* completion confirmation
* authorized download
* short-lived signed access where appropriate

## 17. Event Contracts

Events must contain:

* event ID
* event type
* event version
* occurred timestamp
* correlation ID
* producer
* domain identifiers required by consumer
* safe metadata

Potential events:

```text
OCRCompleted
EncounterCreated
LabResultAvailable
PrescriptionIssued
ConsentUpdated
OutreachCompleted
```

Consumers must be idempotent.

Events must not expose unnecessary sensitive information.

The implemented external contract is `ng.hid.event-envelope` schema version 1
with stable `id`, registered `type` and `version`, RFC-3339 `occurredAt`,
`producer`, aggregate type/ID/version, correlation and optional causation IDs,
nullable facility/patient context IDs, and a producer-registered PHI-minimal
payload. The complete JSON shape and active type inventory are authoritative in
`EVENT_DELIVERY_ARCHITECTURE.md`.

EventBridge acceptance is at-least-once transport delivery, not consumer
completion. A publish/mark crash can redeliver the same ID. Consumers must
deduplicate by their own name plus stable event ID and atomically commit their
business effect with the durable inbox processed marker. Unsupported event
versions are not guessed or coerced; they become terminal delivery evidence.

### Native Lab accession and specimen API

`GET /api/v1/lab/work-items`, `POST /api/v1/lab/work-items/{id}/accession`,
`GET /api/v1/lab/accessions/{id}`, and specimen `collect`, `receive`, and
`reject` subcommands form the minimum native operations contract. Mutations
require active facility context, direct-care purpose, Lab permission,
canonical-patient non-break-glass authorization, idempotency, and expected
versions. Receipt records custody only; it creates no execution, QC, or result.

### Work list order (Lab and Pharmacy)

`GET /api/v1/lab/work-items` and `GET /api/v1/pharmacy/work-items` answer at
most 200 items: open work first, oldest first, then done work, newest first.
Lab work is open while any test it asks for has no released result at its
current version (or that result is marked entered in error); a work item with
no requested test is open. Pharmacy work is open while it has no dispensing;
a reversed dispensing counts as done, because a work item takes one dispensing
only and cannot be dispensed again. Earlier backends answered the 200 oldest items
the member could read whatever their state, so a busy facility stopped seeing
new work. The answer's shape and audit rows are unchanged.

Each Lab work-list item also carries `openWork` (boolean): true while the work
item is open by the rule above, false once every test it asks for has a
released, current result not marked entered in error. It is the value the
list is ordered by, so a client can show finished work as done. Earlier
backends do not send it, so clients treat it as optional. Pharmacy sends no
such field: its items already carry `dispensing` (null while open; a reversed
dispensing counts as done), which is the same rule.

Known limit of the Lab list (no schema change in this step). Every row the
list reads from a Lab table pays its own row-level security check, mostly the
member's consent check, over a millisecond each. The list reads each Lab
table once: about 5 checks per work item at the laboratory plus 2 per row
answered (the oldest-200 list read 3 per work item). Measured on PostgreSQL 16
on a shared 2.1 GHz Xeon as the restricted Lab login with lab-api's 15-second
statement limit: 1,041-1,050 work items 8.8-12.1 s, 1,541 work items 11.1 s,
2,041 work items over the limit (the oldest-200 list: 4.7-5.7 s, 6.2 s and
8.6 s). So a laboratory with more than roughly 1,800 to 2,000 work items gets
an error instead of the list, and fewer on a slower database server. Raising
that ceiling needs a migration (for example one row of open or done state per
work item, kept by the database), which is a separate owner decision.
`services/ehr-api/scripts/lab-work-list-runtime-checks.mjs` (run by
`test-patient-evidence-runtime.mjs`) checks 1,050 work items within the
limit and counts the checks.

### Clinical information on Lab work items

Each same-facility Lab work item carries `clinicalIndication` (string or
null): the clinical information on the version of the EHR lab request that Lab
accepted (`sourceEhrOrderVersion`), stored as `clinical_indication` on
`lab.work_items`. It is null when that version had none. Lab keeps the version
it accepted: if the doctor later changes the request's clinical information,
the EHR is told `already_accepted` and Lab still sends the earlier text. A
client therefore shows it as the text sent with the request, not as the
request's current text. Both work-item reads send it: each item of
`GET /api/v1/lab/work-items` and `GET /api/v1/lab/work-items/{id}`. It is read
in the same statement and under the same row-level security as the rest of
the row, so only a member who may already read the work item gets it, and it
adds no audit row (the single read's `lab.work-item.read` row is unchanged).
A work item from another facility's order route never carries it: that
route's detail gives the same text as `clinicalInformation`, and only while
the route allows a read. The answer to `accept-ehr-order` is unchanged.
Earlier backends do not send it, so clients treat it as optional. No
migration.

### Lab results: check, release and correction

Checking a result (`POST /api/v1/lab/results/{resultId}/verify`) needs
someone other than the person who entered that version; the database keeps
the rule. When the person who entered it tries, Lab answers
`409 LAB_RESULT_VERIFIER_NOT_INDEPENDENT` with the detail "You entered this
result, so someone else at your lab must check it." Earlier backends
answered `500`. A check of a version marked entered in error is refused by
the same database rule and still answers `500`.

Each result revision Lab answers also carries `enteredByYou` (boolean): true
when the member asking entered that version. That is every revision in the
execution reads (`GET .../executions/{id}`, `GET .../specimens/{id}/executions`),
a result's history, the answers to entering, correcting, checking and
releasing a result, and the released views. Lab works it out from the
version's author and the session, and never answers anyone's account id. A
client can use it to offer no check to the person who entered the version.
Earlier backends do not send it, so clients treat it as optional.

The `reason` of a check, a release (`POST .../results/{resultId}/release`)
and a correction (`POST .../executions/{executionId}/results/{resultId}/corrections`)
needs at least 3 characters, not counting spaces at either end, and at most
500: what Lab keeps. A shorter one is refused `400 VALIDATION_FAILED` with
the field error `reason must be at least 3 characters`; earlier backends
passed it to the database and answered `500`.

The released view of a result also carries `correctionPending` (boolean).
That is each result of
`GET /api/v1/lab/ehr-orders/{sourceEhrOrderId}/released-results`, which the
clinician who placed the order reads, and `GET .../results/{resultId}/history`
for a reader without `lab.execution.read`. It is true while a newer version
of that released result waits to be checked and released: a correction or
amendment entered after the release, checked or not, and not marked entered
in error. Lab answers nothing else of that version (no value, reason or
version number), and the read's audit row still names only the versions
returned. Earlier backends do not send it, so clients treat it as optional.

### Record chat: where each source came from

Each source in a record chat answer (`POST /api/v1/ehr/me/chat`,
`POST /api/v1/ehr/patients/:patientId/chat`) and each source read
(`GET …/chat/sources/:kind/:sourceId`) carries `origin` and `originLabel`.
The server sets them from the record itself, never the model:

| `origin` | Source kinds | `originLabel` (patient / staff) |
|---|---|---|
| `patient` | imported history recorded as patient provided, imported health profile | "You added this" / "Added by the patient" |
| `health_worker` | notes, encounters, diagnoses, prescriptions, investigations, vitals, released lab results, imported history recorded as provider authored | "Recorded by a health worker" |
| `scanned_paper` | readable documents and imported files, and a clinical note imported from a scanned record | "From a scanned paper record" |
| `health_id_profile` | the Health ID profile | "Your Health ID profile" / "The patient's Health ID profile" |

The model is given the label and told to say where each fact came from. Both
fields are optional to clients: answers saved before this change have neither.
The origin is outside each source's content and hash, so saved conversations
and stored vectors stay current.

### Record chat: time and length limits

Staff questions ("summarise this patient's history") need longer answers than
a patient's, so the two have their own limits:

| | Patient (`/ehr/me/chat`) | Staff (`/ehr/patients/:patientId/chat`) |
|---|---|---|
| Output tokens per Claude call | 1200 | 2000 |
| Time per Claude call | `AI_REQUEST_TIMEOUT_MS` (20 s by default) | 40 s |
| Whole turn | 60 s | 48 s |
| Gateway read timeout | 45 s | 50 s |
| Gateway rate limit (per address) | `hid_chat`, 6 a minute, burst 2 | `hid_staff_chat`, 20 a minute, burst 5 |
| Answer length | 3800 characters, then the server's lines | 4000 characters; the model is asked for under 3000 |

The model's raw text may be up to 8000 characters when it answers in JSON
blocks (field names and quotes add length) and 4000 otherwise; the answer
limits above still apply to the answer it becomes. The staff chat location is
nested in the gateway's `^~ /api/v1/ehr/` location, because that location
stops nginx from looking at regex locations outside it. Its history and source
routes stay on the ordinary EHR proxy. A failed turn is still a 503: ehr-api
answers `PATIENT_CHAT_UNAVAILABLE`, which the gateway replaces with its own
`UPSTREAM_UNAVAILABLE` (as it does every 502, 503 and 504), so the browser
cannot tell the two apart. ehr-api logs only the category (for example
`timeout`, `model_answer_cut_off`, `model_request_failed` with the provider's
status), the audience and the correlation ID, never the question, record text,
the model's words or an error message.

## 18. API Documentation

Public and internal service APIs should maintain OpenAPI documentation.

Contract changes must update:

* OpenAPI
* this file
* ADRs where architecture changes

### Lab execution and governed-result API

Lab exposes specimen execution create/list, execution read/complete, result
entry, result correction, exact-version verification, separate release, and
released-history reads under `/api/v1/lab`. Execution requires the expected
received specimen version and exact accepted requested-test reference. Entry
and correction append `manual`, initially `unverified` revisions; entry never
means verified or released. Verification and release are distinct idempotent
commands with separate permissions, reasons, and expected result versions.
Release requires prior verification of the exact version. A post-release
correction appends a new unverified version and preserves released history;
ordinary released-result readers receive 404 until at least one release exists.

### Extracted Lab transport

Public Lab routes remain `/api/v1/lab/*` through the gateway. Internal EHR order acceptance uses `POST /api/v1/lab/work-items/accept-ehr-order`; governed OCR publication uses `POST /api/v1/lab/imports/from-ocr`. Both preserve bearer or Identity session-cookie user evidence, facility, purpose, correlation ID, and idempotency key and additionally require authenticated internal-caller identity. Cookie mutations also preserve the Cookie header, Origin, and CSRF header so Identity can revalidate the unsafe request through `POST /api/v1/auth/service-session`. User and workload credentials remain separate. Local development uses one process-generated ephemeral credential. Production requires a rotating asymmetric JWT from an injected token file, exact issuer/JWKS/audience validation, and distinct configured EHR/OCR subjects; local-secret mode is rejected.

### Extracted Pharmacy transport

Public Pharmacy reads and pharmacist commands remain
`/api/v1/pharmacy/*` through the gateway. EHR prescription acceptance and OCR
medication import use internal-only routes with exact caller metadata. The
shared Pharmacy client propagates bearer or Identity session-cookie user
evidence, facility, purpose, correlation ID and idempotency key. Cookie
mutations preserve Cookie, Origin, and CSRF for Identity revalidation through
the POST service-session route. The client applies a 10-second timeout and at
most one retry for an idempotent network/502/503/504 failure, parses Problem
Details, and obtains a fresh workload credential for each attempt. A separate
workload header is mandatory. Production rejects shared-secret mode and
requires rotating Pharmacy-audience JWT files plus exact EHR/OCR subject
verification. The Lab client follows the same bounded retry and per-attempt
credential-refresh policy.

## 19. Platform Administration API

The gateway sends `/api/v1/admin/*` to Identity. All routes require the normal
Identity user credential and an explicit backend `platform.*` capability.
Platform roles are not clinical roles and cannot satisfy EHR, Lab, Pharmacy,
OCR, or Outreach permissions.

Read endpoints:

```text
GET /api/v1/admin/session
GET /api/v1/admin/overview
GET /api/v1/admin/facilities?page=&pageSize=&status=&query=
GET /api/v1/admin/facilities/:facilityId
GET /api/v1/admin/principals?query=&page=&pageSize=&status=
POST /api/v1/admin/principals/search   {query, page?, pageSize?, status?}
GET /api/v1/admin/identity/reviews?page=&pageSize=&status=
GET /api/v1/admin/audit/events?limit=&beforeSequenceId=&actor=&facilityId=&action=&correlationId=&outcome=&from=&to=
GET /api/v1/admin/operations/services
GET /api/v1/admin/operations/events
```

Principal search requires at least two characters. `POST principals/search`
answers `200` with the same page as `GET principals`; it keeps the search term
(a name or an email address) out of URLs and request-line access logs, and is
the form browsers use. Facility, principal, and
review page sizes are bounded to 100; audit pages are bounded to 200 and use a
descending sequence cursor. Raw NIN, password material, tokens, event payloads,
patient audit identifiers, and free-form audit details are absent.

Command endpoints:

```text
POST /api/v1/admin/facilities/:facilityId/status
POST /api/v1/admin/principals/:accountId/status
POST /api/v1/admin/principals/:accountId/platform-roles
POST /api/v1/admin/principals/:accountId/sessions/revoke
```

Every command requires `Idempotency-Key` and a reason of 8–500 characters.
Versioned commands also require `If-Match: "<positive-version>"`. Exact
replays return `replayed: true`; a reused key with a different digest returns
409, stale versions return 409, missing `If-Match` returns 428, and last-admin
protection returns 409. Cookie mutations keep the existing exact Origin and
CSRF contract. Problem Details and correlation IDs remain the only error
surface.

Operations aggregation forwards `X-Correlation-ID`, uses a 250–5000 ms
configured bound (1500 ms default), reports each dependency independently,
and whitelists terminal failure fields. No arbitrary retry command exists.

## 20. Browser gateway and application contract

The local one-origin gateway serves Web at `/` and proxies EHR, Lab, Pharmacy,
Migrate, Outreach, and Admin at `/ehr/`, `/lab/`, `/pharmacy/`, `/migrate/`,
`/outreach/`, and `/admin/`. In production Migrate is the standalone root
application at `https://migrate.healthidentitydirectory.com/`; legacy
`/migrate/*` and `/ocr/*` paths redirect to root-equivalent Migrate paths.
These UI prefixes are distinct from API ownership:
`/api/v1/pharmacy/*` remains Pharmacy API-owned and `/api/v1/ocr/*` remains OCR
API-owned. Browser applications call only gateway API paths with Identity
cookies/CSRF, exact facility and purpose context, correlation, and idempotency
where the owning command requires it. No browser calls an internal host/port.

Pharmacy reads only existing work items/evidence and sends acceptance,
dispensing, and reversal commands through the typed Pharmacy client. A UI state
becomes `dispensed` or `reversed` only from a successful authoritative response;
the exact expected server version is preserved. Migrate uses the typed
OCR client for job/document reads, job create/retry, and lifecycle state. It
does not receive a generic clinical write, provider-success, or patient-create
interface. Clinical review/publication authority remains governed in context.

All workers are path-scoped and exclude `/api/`. Outreach offline storage is
encrypted IndexedDB with stable command idempotency and reconnect
reauthorization. Other apps are offline-aware but have no persisted mutation
outbox in this checkpoint. No frontend may expose a database connection,
workload credential, broad mutation endpoint, raw PHI telemetry, or untrusted
HTML execution surface.

Frontend telemetry accepts only enumerated product event names and primitive
allowlisted properties. Safe correlation IDs may accompany sanitized technical
errors; request/response bodies, URLs, headers, identity/clinical content, and
OCR extraction text are never part of the browser telemetry contract.

## 21. Orders between facilities: an order accepted for the wrong person

A laboratory or pharmacy that accepted an order from another facility can
report that the person it accepted it for was not the order's patient
(migration 0088; owner decisions of 2026-10-26, recorded in
`MAIN_TO_NOVU_PORT.md`). In one transaction its access ends, every result it
released on the order is marked entered in error, a dispensing it recorded is
reversed, support gets a report, and the patient gets an inbox notice
(`ORDER_ROUTE_WRONG_PATIENT`, metadata `{routeId, kind, orderingFacilityName,
receivingFacilityName}`; no email). The order cannot be received again: the
clinician writes a new one.

```text
POST /api/v1/lab/order-routes/:routeId/wrong-patient        # lab.order-route.receive
POST /api/v1/pharmacy/order-routes/:routeId/wrong-patient   # pharmacy.order-route.receive
```

Facility context, `X-Purpose-Of-Use: direct-care` and `Idempotency-Key` are
required. The body is `{ expectedVersion, reason, note }`: `reason` is one of
`wrong_order_chosen`, `someone_elses_details`, `suspected_misuse`, `other`;
`note` is 8-500 characters once trimmed and reaches Health ID support only
(never an audit row, a log line, the ordering facility or the patient). Any
member who may receive that kind of order may report; when something must be
withdrawn the member also needs `lab.result.entered-in-error` or
`pharmacy.dispensing.reverse`. It is allowed while the receiver may still work
on the order (30 days after acceptance, or 14 days after the first return, 45
at most) and not once anyone else ended it. `200` answers
`{ route: { id, version, effectiveState, endedKind: 'wrong_patient' },
resultsVoided, resultReportsMarked, dispensingReversed, replayed }`; the same
member, key and request answer the stored report with `replayed: true`.

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | the body (an unknown reason, a note outside 8-500, an unknown field) |
| 400 | `ORDER_ROUTE_INVALID` | a note shorter than 8 once trimmed, or the command's own input check |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | no or malformed key |
| 403 | `PERMISSION_DENIED` | not a receiving member under direct care |
| 403 | `ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED` | something must be withdrawn; problem member `permission` names the missing one |
| 404 | `ORDER_ROUTE_NOT_FOUND` | not addressed to this facility, or another kind |
| 409 | `ORDER_ROUTE_NOT_ACCEPTED` | not accepted (decline it instead) |
| 409 | `ORDER_ROUTE_ALREADY_ENDED` | ended by anyone, or past the window; checked before the version |
| 409 | `IDEMPOTENCY_KEY_REUSED` | the key with another request, also when that request is on another route at the same moment |
| 409 | `ORDER_ROUTE_CHANGED_CONCURRENTLY` | a concurrent route write or a deadlock (this command only) |
| 412 | `VERSION_CONFLICT` | something was returned or changed since the version was read |
| 423 | `CROSS_FACILITY_ORDERS_UNAVAILABLE` | `cross_facility_route_access_enabled` off |
| 503 | `ORDER_ROUTE_UNAVAILABLE` | anything else |

The Lab and Pharmacy work lists' `orderRoute` card gains `version` (a number)
and `endedKind` (null while the route is live). After a report the work item
leaves the list for members without the patient's consent; any write on it
answers 409 `ORDER_ROUTE_CLOSED`, and a Lab release under consent is refused.

Support (Identity, `@FacilityOptional`, platform transactions):

```text
GET  /api/v1/admin/wrong-patient-reports?status=unreviewed|recent&facilityId=   # platform.facility.read
POST /api/v1/admin/wrong-patient-reports/:reportId/review                       # platform.facility.manage, If-Match
```

The list answers `{ items }` (at most 200): `unreviewed` flagged first, then
oldest first; `recent` the last 90 days, newest first; `facilityId` the
reporting (receiving) facility, 404 `ADMIN_FACILITY_NOT_FOUND` when unknown.
Each item carries the report, both facilities, who reported and who accepted
(names, `sameMember`, `acceptedWith`), the reason and note, what was
withdrawn, who recorded the work, `flags` (`something_came_back`,
`reporter_recorded_work`, `suspected_misuse`, `other_reason_nothing_recorded`),
the 30-day counts per facility and per accepting member, and `review`. It
carries no patient and no order content. The admin Overview tile counts the
`unreviewed` list. The review takes `{ actions, note, removeNote? }`: one or
more of `ordering_facility_told`, `facility_contacted`,
`staff_access_changed`, `facility_suspended`, `referred_to_dpo`, or exactly
`["no_further_action"]`, and a note of 8-500; `removeNote` replaces the
reporter's note with "Removed by Health ID support at review." It answers
`{ reportId, version, reviewedAt, actions, noteRemoved }`; refusals are 400
`WRONG_PATIENT_REVIEW_INVALID`, 404 `WRONG_PATIENT_REPORT_NOT_FOUND`, 409
`WRONG_PATIENT_REPORT_ALREADY_REVIEWED` (once only, checked before the
version), 409 `VERSION_CONFLICT`, 428 `IF_MATCH_REQUIRED`. The command writes
the platform audit row `admin.wrong-patient-report.review`.

The ordering facility (EHR):

```text
GET /api/v1/ehr/order-routes/wrong-patient   # ehr.order-route.send, facility, direct-care only
```

The Overview card lists the orders sent from the session's facility that
ended this way in the last 30 days: `{ windowDays: 30, items, others: { count,
references } }`. A member sees an order in full (`routeId`, `reference`,
`kind`, `receivingFacility { id, name }`, `patient { name }`, `endedAt`,
`resultsWithdrawn`, `dispensingReversed`, `link { patientId, encounterId,
kind, orderId }`) only if they sent it, whether or not they may still open
the patient's record (at most 50, newest first); every colleague's such order
of the facility counts in `others` with its reference only (at most 100
references; the count is complete). A member's own order is never in
`others`. The read is audited in its transaction: one
`ehr.order-route.wrong-patient-overview` row (no patient, details `{ itemCount,
otherCount }`) and one `ehr.order-route.wrong-patient-overview.item` row per
order shown in full, naming its patient. The order's route views (`GET
…/order-routes`), the order lists' `orderRoute`, the patient's
`GET /api/v1/ehr/me/order-routes` and support's lookup answer `endedKind:
'wrong_patient'` unchanged in shape; the views list each withdrawn result as
an `entered_in_error` report, without a value, beside its `released` row.

This backend also says that it serves the report, so the website's guidance
can wait for it (D15: the website ships first and stays dormant). The EHR's
lab-request and prescription lists (`GET …/encounters/:encounterId/lab-requests`
and `…/prescriptions`) and support's lookup (`GET /api/v1/admin/order-routes`
and `POST /api/v1/admin/order-routes/search`) answer `wrongPatientReports:
true` beside their items; an earlier backend sends no such field. Only then
does the website ask the ordering clinician, in its change warning, and
support, in its Close form, to have the laboratory or pharmacy end an order it
accepted for the wrong person first. The Lab and Pharmacy work lists say the
same through `orderRoute.version`, which only this backend sends.

## 22. Orders between facilities: whether a facility receives, when support's Close acts, and what a facility is as a destination

Migration 0089 (item 4; owner decisions of 2026-10-26, recorded in
`MAIN_TO_NOVU_PORT.md`) adds three read-only facts to answers that already
exist. No route, status code or audit row is added. An earlier backend sends
none of the new fields, so a client reads each only when it is present and of
the right type.

The Lab and Pharmacy work lists and Incoming:

```text
GET  /api/v1/lab/work-items                GET  /api/v1/pharmacy/work-items
GET  /api/v1/lab/order-routes              GET  /api/v1/pharmacy/order-routes
POST /api/v1/lab/order-routes/search       POST /api/v1/pharmacy/order-routes/search
```

answer two more fields beside `items`, `crossFacilityOrders` and
`crossFacilityWork`:

- `receives` (boolean): whether clinicians at other facilities can send this
  facility lab requests (prescriptions) now. That is: an active, verified
  facility whose sign-up support reviewed or approved, with an active
  laboratory (pharmacy) product, listed for orders, with a member who may
  receive them. It reads no switch, so it stays true while orders between
  facilities are off.
- `routesHere` (`{ waiting: boolean, held: boolean }`): `waiting` says an
  order of that kind was sent to this facility and is not yet past its
  respond-by (what Incoming lists). It can be accepted only while `receives`
  is true and orders between facilities are on; it can be declined until its
  respond-by either way. `held` says one it accepted (accepted, completed, or
  cancelled with its reads kept) may still be read here. Both stay true at a
  facility that support unlisted, or whose product is suspended, so it still
  sees and can decline what was sent and is told when its accepted work is
  paused.

Both are about the session's own facility (the request names none), carry no
patient, count or reference, and are answered only to a member holding
`lab.order-route.receive` (`pharmacy.order-route.receive`). A member without
it, and an earlier backend, get neither field; a failure to read them leaves
them out and the list still answers. While
`cross_facility_route_access_enabled` is off, Incoming answers 423 as before,
without them; the work list still carries them.

```json
{ "items": [], "receives": true, "routesHere": { "waiting": true, "held": false },
  "crossFacilityOrders": true, "crossFacilityWork": true }
```

Support's lookup (`GET /api/v1/admin/order-routes?reference=` and
`POST /api/v1/admin/order-routes/search`, `platform.principal.read`): each
item gains `accessEndsAt` (ISO-8601, when the receiving facility's read
access ends; `null` before acceptance) and `closable` (whether
`POST /api/v1/admin/order-routes/:routeId/close` would act now, by the
database's clock). A live order that is not closable is a completed one
whose access has ended, or that someone ended. Clients trust `closable` as
answered and use no clock of their own. Close may still answer 409
`ORDER_ROUTE_ALREADY_CLOSED` when access ends between the lookup and the
close. An earlier backend, or a schema without 0089, sends neither field.

```json
{ "items": [{ "routeId": "…", "reference": "3F2A9C1B", "kind": "lab_request", "version": 4,
  "effectiveState": "completed", "…": "…", "acceptedAt": "2026-10-01T09:00:00.000Z", "endedAt": null,
  "endedKind": null, "accessEndsAt": "2026-10-19T11:12:00.000Z", "closable": false }],
  "wrongPatientReports": true }
```

Support's facility summary
(`GET /api/v1/admin/facilities/:facilityId/order-route-summary`,
`platform.facility.read`) gains `destination` after `listed`, which keeps its
four keys:

- `receivingTypes`: the sorted subset of `laboratory` and `pharmacy` of the
  facility's active products whose source application is approved. It is
  `[]` for a hospital, clinic or other facility, a suspended product and a
  released sign-up.
- `review`: `pending`, `reviewed` or `released` (the self sign-up's review),
  `governed` (approved by support without a self sign-up) or `legacy`.

No verification method is answered. Listing can change whether clinicians
find the facility only when `receivingTypes` is not empty and `review` is
`pending`, `reviewed` or `governed`; the console offers the listing form only
then. The summary is the database's own, which Identity passes through as it
is, so `destination` is answered as soon as 0089 is applied, by an earlier
Identity image too; a schema before 0089 answers without it.

```json
{ "facilityId": "…", "listed": { "value": true, "byDefault": true, "reason": null, "setAt": null },
  "destination": { "receivingTypes": ["laboratory"], "review": "governed" },
  "receivedAcceptedLifetime": 0, "receivedPatientsLifetime": 0, "counterparts": [] }
```

## 23. Orders between facilities: correcting an order accepted for the wrong person after it ended

A laboratory or pharmacy that finds out, after an order ended or its window
lapsed, that it accepted the order for someone who was not its patient can
still withdraw what it recorded on it, until 180 days after it accepted the
order (migration 0090, D17; owner decisions of 2026-10-26, recorded in
`MAIN_TO_NOVU_PORT.md`). In one transaction every result it recorded on the
order is marked entered in error (or its dispensing reversed) exactly as §21
does; an order whose time had only run out ends `wrong_patient` now, and an
order that had ended another way keeps that ending; support gets a report
flagged `late_correction`; the patient gets an inbox notice
(`ORDER_ROUTE_WRONG_PATIENT` when the order ended now,
`ORDER_ROUTE_WRONG_PATIENT_CORRECTED` when it had ended before; metadata
`{routeId, kind, orderingFacilityName, receivingFacilityName}`; no email).
The receiver's access to the patient's records is never reopened. What the
ordering facility recorded from the value (a note, a diagnosis, a
prescription) stays until it amends it.

```text
POST /api/v1/lab/order-routes/correctable                               # lab.order-route.receive
POST /api/v1/pharmacy/order-routes/correctable                          # pharmacy.order-route.receive
POST /api/v1/lab/order-routes/:routeId/wrong-patient-correction        # lab.order-route.receive
POST /api/v1/pharmacy/order-routes/:routeId/wrong-patient-correction   # pharmacy.order-route.receive
```

Facility context and `X-Purpose-Of-Use: direct-care` are required on all four.

**Find an order by its reference.** The body is `{ reference }` (a string of
1-16 characters; a POST, so the reference, which with a date of birth names an
order at acceptance, is in no request line). The service trims and
upper-cases it; it must then be 8 hex characters (400 `ORDER_ROUTE_INVALID`).
`200` answers at most 5 orders this facility accepted with that reference,
newest acceptance first, and `lateCorrection: true`:

```json
{ "items": [ { "id": "…", "reference": "3F2A9C1B", "kind": "lab_request", "version": 9,
    "effectiveState": "completed", "orderingFacilityName": "…", "acceptedAt": "…", "completedAt": "… | null",
    "endedAt": "… | null", "endedKind": "support | … | null", "returned": true,
    "correction": "open | correctable | reported | receiver_released | too_late", "correctableUntil": "…",
    "wrongPatient": { "reportedAt": "…", "late": true } | null,
    "details": { "what": "Full blood count", "acceptedBy": "…",
                 "acceptedWith": "health_id | date_of_birth_with_reference | date_of_birth",
                 "returned": [ { "at": "…", "withdrawn": false } ] } | null } ],
  "lateCorrection": true }
```

`correction` is `open` while item 3's report (§21) still applies (the
website then offers that form with this `id` and `version`), `correctable`
when only this correction applies, `reported` once the order has a report (in
or after its window), `receiver_released` once the receiving facility's
organization was released from Health ID (the order ended
`receiving_released`, or ended another way before the release; no member can
act on it any more, so in practice only support's lookup below ever shows it),
`too_late` from `correctableUntil` (180 days after acceptance; for `too_late`
already past). `details`, the facility's own facts
about the order (the test or medicine, who here accepted it and how identity
was checked, what went back and when, at most 20), is present only while the
order is `open` or `correctable`. No patient, orderer, work item or value is
ever answered. A reference no order accepted here carries answers `200
{ "items": [], "lateCorrection": true }`, never 404. Each lookup writes one
audit row (`lab.order-route.correctable` / `pharmacy.order-route.correctable`,
no patient, details `{ found, states, routeIds }`, never the reference);
Lab's interceptor writes `api.lab.order-route.correctable.request`.

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | the body (no reference, not a string, longer than 16, an unknown field) |
| 400 | `ORDER_ROUTE_INVALID` | not 8 hex characters once trimmed and upper-cased |
| 403 | `PERMISSION_DENIED` | not a receiving member under direct care |
| 423 | `CROSS_FACILITY_ORDERS_UNAVAILABLE` | `cross_facility_route_access_enabled` off |
| 503 | `ORDER_ROUTE_UNAVAILABLE` | anything else |

Lab and Pharmacy never answer `ORDER_ROUTE_LOOKUP_INVALID` (the code of support's lookup).

**Correct it.** `Idempotency-Key` is required. The body, every field
required, unknown fields refused:

```json
{ "expectedVersion": 9,
  "reason": "wrong_order_chosen | someone_elses_details | suspected_misuse | other",
  "discoveredBy": "patient | ordering_facility | own_check | support | other",
  "discoveredOn": "2026-10-20",
  "note": "8 to 500 characters once trimmed, for Health ID support" }
```

`discoveredOn` is the day the facility found out: a calendar date, not after
today and not before the day it accepted the order (Africa/Lagos). The note
reaches support's list only (never an audit row, a log line, the ordering
facility or the patient). The request digest is
`requestDigest('lab.order-route.wrong-patient-correction', { routeId,
expectedVersion, reason, discoveredBy, discoveredOn, note: note.trim() })`
(`pharmacy.…` for the pharmacy). Any member who may receive that kind of order
may correct; when something must be withdrawn the member also needs
`lab.result.entered-in-error` or `pharmacy.dispensing.reverse`. At most 5
late corrections per member and 20 per facility in any 24 hours, exact;
support cannot lift the limit. `200` answers:

```json
{ "route": { "id": "…", "version": 11, "effectiveState": "completed | cancelled", "endedKind": "wrong_patient | support | …" },
  "late": true, "endedKindBefore": "support | null", "resultsVoided": 1, "resultReportsMarked": 1,
  "dispensingReversed": false, "correctableUntil": "…", "replayed": false }
```

`endedKindBefore` is how the order had ended before the correction (null when
its time had only run out; it then ends `wrong_patient` now). The same member,
key and request answer the stored report with `replayed: true`. The service
writes its own row (`lab.order-route.wrong-patient-correction` /
`pharmacy.order-route.wrong-patient-correction`, with the patient from the
command, details `{routeId, kind, reportId, stateBefore, endedKindBefore,
state, reasonCode, discoveredBy, discoveredOn, resultsVoided,
dispensingReversed, replayed, late: true}`, never the note); Lab's interceptor
writes `api.lab.order-route.wrong-patient-correction.request` without a body.

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | the body: an unknown reason or `discoveredBy`, a date not in the form `YYYY-MM-DD`, a note outside 8-500 as sent, a missing or unknown field |
| 400 | `ORDER_ROUTE_INVALID` | a note under 8 once trimmed; `discoveredOn` not a calendar date, in the future, or before the order was accepted; the command's own input check |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | no or malformed key |
| 403 | `PERMISSION_DENIED` | not a receiving member under direct care; also an order whose receiving organization was released (the command's `ORDER_ROUTE_RECEIVER_RELEASED`, which such a member never reaches) |
| 403 | `ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED` | something must be withdrawn; problem member `permission` names the missing one |
| 404 | `ORDER_ROUTE_NOT_FOUND` | not addressed to this facility, or another kind |
| 409 | `ORDER_ROUTE_NOT_ACCEPTED` | never accepted here |
| 409 | `ORDER_ROUTE_STILL_OPEN` | still open: use §21's report |
| 409 | `ORDER_ROUTE_ALREADY_REPORTED` | reported already, in or after the window (also when a concurrent report won) |
| 409 | `ORDER_ROUTE_CORRECTION_TOO_LATE` | past `correctableUntil` |
| 409 | `IDEMPOTENCY_KEY_REUSED` | the key with another request, or a key first used for §21's report |
| 409 | `ORDER_ROUTE_CHANGED_CONCURRENTLY` | a concurrent release, reversal or order change, or a deadlock (this command only) |
| 412 | `VERSION_CONFLICT` | correctable, but the order's version moved since it was read; checked after the state |
| 423 | `CROSS_FACILITY_ORDERS_UNAVAILABLE` | `cross_facility_route_access_enabled` off |
| 429 | `ORDER_ROUTE_CORRECTION_LIMIT` | 5 by this member or 20 at this facility in the last 24 hours; problem member `retryAfter` (ISO-8601 UTC, milliseconds) is the earliest time another is possible |
| 503 | `ORDER_ROUTE_UNAVAILABLE` | anything else, including the command's refusal of a caller whose transaction is not READ COMMITTED (`25000 ORDER_ROUTE_CORRECTION_READ_COMMITTED_REQUIRED`: the limits are exact only there; the services always call it so) |

After a correction (in or after the window), nothing more can be written or
released on the order's work item, even under the patient's consent (409
`ORDER_ROUTE_CLOSED`; a Lab release is refused).

**What the other services answer (fields only; no new route).** Each new
field is sent only by a backend with 0090; a client reads it only when it is
present and of the right type.

- EHR: the order's route views (`GET …/order-routes`), the lab-request and
  prescription lists' and reads' `orderRoute`, and the patient's
  `GET /api/v1/ehr/me/order-routes` items gain `wrongPatient: { reportedAt,
  late } | null` (the receiver's report, in or after the window) and
  `correctableUntil: string | null` (set while the order is `open` or
  `correctable`; never once the receiving organization was released). The lab-request and prescription lists add
  `lateCorrection: true` beside `wrongPatientReports: true`. The Overview card
  (`GET /api/v1/ehr/order-routes/wrong-patient`) lists the reports of the last
  30 days whatever the order's ending; its items gain `reportedAt`, `late` and
  `endedKindBefore` (a late report on an order that had ended another way
  keeps that ending in `endedAt`), and the answer adds `lateCorrection: true`.
- Lab and Pharmacy: the work lists add `lateCorrection: true` for a member
  holding the kind's receive permission (nothing to anyone else).
- Identity, support's lookup (`GET /api/v1/admin/order-routes`, `POST
  /api/v1/admin/order-routes/search`): each item gains `correction`
  (`not_accepted | open | correctable | reported | receiver_released |
  too_late`), `correctableUntil` (null for `not_accepted`, `reported` and
  `receiver_released`; already past for `too_late`) and `wrongPatient: { reportedAt, late } | null`; the answer adds
  `lateCorrection: true`.
- Identity, support's reports list (`GET /api/v1/admin/wrong-patient-reports`):
  each item gains `late`, `endedKindBefore`, `discoveredBy`, `discoveredOn`
  (`YYYY-MM-DD`), `reporterLateReportsLast30Days`, `orderingSenderActive` and
  `requiredActions` (what the review requires: `referred_to_dpo`, then
  `ordering_facility_told`); `flags` may also hold `late_correction`,
  `patient_prompted` and `patient_reported_before`; the answer adds
  `lateCorrection: true`.
- Identity, the review (`POST /api/v1/admin/wrong-patient-reports/:reportId/review`):
  a late report where something had gone back, or a "suspected misuse" one,
  cannot be marked reviewed without `referred_to_dpo`; where something had
  gone back and the ordering facility is still on Health ID, also without
  `ordering_facility_told`. Refused 400
  `WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED`, problem member `required` (the
  missing actions, comma-separated, `referred_to_dpo` first). Every other
  refusal is unchanged.

```json
{ "type": "https://healthidentitydirectory.com/problems/wrong-patient-review-referral-required",
  "title": "BAD_REQUEST", "status": 400, "detail": "…", "instance": "urn:hid:request:…", "correlationId": "…",
  "code": "WRONG_PATIENT_REVIEW_REFERRAL_REQUIRED", "required": "referred_to_dpo,ordering_facility_told" }
```

`lateCorrection: true` on any of these answers, a `correctableUntil` key on
any route, or any answer from the lookup tells the website that this backend
serves the correction (D17-11: the website ships first and stays dormant). An
earlier backend sends none of them, and its Lab and Pharmacy answer the two
new routes 404.

## 24. Orders between facilities: an order the laboratory or pharmacy accepted but can't complete

A laboratory or pharmacy that accepted an order from another facility and then
cannot do it (the test is not offered after all, something has run out or is
out of service, the sample can't be used, the patient chose not to go ahead or
left) ends it itself with one fixed reason (migration 0091, hid-system 0091 on
`staging-novu-ci-20261005`, D18; owner decisions of 2026-10-27, recorded in
`MAIN_TO_NOVU_PORT.md`). In one transaction the order ends (`cancelled`, ended
kind `receiving_unable`); the facility can record nothing more on it; it keeps
reading it for up to 7 days (never past the order's 30-day work window) only
if it had opened an accession on a lab request,
otherwise not at all from that moment (no one, support included, can shorten
the 7 days); the reason and what it had recorded are kept for the ordering
facility and support; both facilities get a system audit row
(`ehr.order-route.not-completed`); and the patient gets an inbox notice
`ORDER_ROUTE_NOT_COMPLETED` (metadata `{routeId, kind, orderingFacilityName,
receivingFacilityName}`; no reason; no email; nothing for a patient without an
active account). Nothing is withdrawn: on an accepted order nothing has gone
back to the ordering facility or the patient.

```text
POST /api/v1/lab/order-routes/:routeId/cannot-complete        # lab.order-route.receive
POST /api/v1/pharmacy/order-routes/:routeId/cannot-complete   # pharmacy.order-route.receive
```

Facility context, `X-Purpose-Of-Use: direct-care` and `Idempotency-Key` are
required. Any member who may receive that kind of order may use it (D18-10).
It applies only to an order this facility accepted, inside its 30-day work
window, not ended, not reported as accepted for the wrong person, with nothing
returned yet (D18-1); a lab request with a checked (verified, not invalidated)
result waiting to be released is refused until that result is released, or
corrected if it is wrong (a correction makes a new, unverified version; no Lab
route marks a single result entered in error) (D18-15). The body, unknown fields
refused, no free text (D18-6):

```json
{ "expectedVersion": 2, "reason": "supplies_unavailable", "confirmedPatient": true, "criticalValueTold": true }
```

- `reason`, by kind (D18-5; the database's command and its endings table hold
  the same lists, as does `services/ehr-api/test/fixtures/order-route-cannot-complete-reasons.sql`):
  - Lab: `test_not_offered`, `supplies_unavailable`, `equipment_unavailable`,
    `sample_unusable`, `sample_not_obtained`, `cannot_meet_priority`,
    `patient_declined`, `patient_did_not_return`, `other`;
  - Pharmacy: `out_of_stock`, `medicine_unavailable`, `needs_prescriber_review`,
    `controlled_requirements`, `cannot_meet_priority`, `patient_declined`,
    `patient_did_not_return`, `other`.
- `confirmedPatient` must be `true`: the member states that the person it
  accepted the order for was the order's patient (for a prescription, or was
  collecting it for them). Someone who was not uses §21's report or §23's
  correction instead.
- `criticalValueTold` (Lab only; the Pharmacy refuses it as an unknown field):
  `true` states that the ordering facility was phoned about a possibly
  critical value recorded on the order (a current, not invalidated result
  version the laboratory flagged `critical_candidate`); required only when
  there is one; absent, `false` or `null` reads as not told.
- The request digest is `requestDigest('lab.order-route.cannot-complete',
  { routeId, expectedVersion, reason, criticalValueTold })` with
  `criticalValueTold` as `true` or `false` (Pharmacy
  `requestDigest('pharmacy.order-route.cannot-complete', { routeId,
  expectedVersion, reason })`). The same member, facility, key and request
  answer `replayed: true` with the order as it is now and the first ending's
  reason and counts; a resubmission with `criticalValueTold: true` after
  `ORDER_ROUTE_CRITICAL_VALUE_NOT_TOLD` is a new request with a new key.

`200` answers:

```json
{ "route": { "id": "…", "version": 3, "effectiveState": "cancelled", "endedKind": "receiving_unable" },
  "reason": "supplies_unavailable", "readUntil": "2026-11-03T10:15:00.000Z",
  "specimensCollected": 1, "resultsRecorded": 1, "criticalCandidates": 1, "replayed": false }
```

`version` is a number. `readUntil` is when the facility's reading ends: 7 days
after the ending, or the end of the order's 30-day window if that comes first,
when it had opened an accession; else the ending's moment (always for a
prescription). The counts are what the laboratory had recorded
(specimens collected and still held, that is collected or received, never a
rejected one; results in any state; possibly critical current values; 0 for a
pharmacy). Never the patient, the ending's id or anything clinical.
The service writes its own row in the same transaction
(`lab.order-route.cannot-complete` / `pharmacy.order-route.cannot-complete`,
with the patient from the command, details `{routeId, kind, endingId, state,
reasonCode, specimensCollected, resultsRecorded, criticalCandidates,
criticalValueTold, confirmedPatient, replayed}`); Lab's interceptor writes
`api.lab.order-route.cannot-complete.request` without a body (pharmacy-api has
no interceptor).

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | the body: a reason not of this service's list (the other kind's included), a version not an integer of at least 1, `confirmedPatient` not `true`, `criticalValueTold` not a boolean (Lab) or present at all (Pharmacy), an unknown field |
| 400 | `ORDER_ROUTE_INVALID` | the command's own input check (a key or digest that reached it malformed) |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | no or malformed key |
| 403 | `PERMISSION_DENIED` | not a receiving member under direct care; a released receiving organization |
| 404 | `ORDER_ROUTE_NOT_FOUND` | not addressed to this facility, or another kind |
| 409 | `ORDER_ROUTE_NOT_ACCEPTED` | never accepted (sent, declined, withdrawn, expired): decline it instead |
| 409 | `ORDER_ROUTE_ALREADY_ENDED` | ended any way (also a concurrent ending that won, or another key on an order this command ended), reported as accepted for the wrong person, or its work window lapsed |
| 409 | `ORDER_ROUTE_ALREADY_RETURNED` | completed: a result or the dispensing went back |
| 409 | `ORDER_ROUTE_RESULT_READY` | Lab: a checked result waits to be released (answered before a stale version, whatever `criticalValueTold` says) |
| 409 | `ORDER_ROUTE_CRITICAL_VALUE_NOT_TOLD` | Lab: a possibly critical value is recorded and `criticalValueTold` is not `true` (checked before the limits, so a member or facility at its limit is still asked about it) |
| 409 | `IDEMPOTENCY_KEY_REUSED` | the key with another request, another order or the other kind |
| 409 | `ORDER_ROUTE_CHANGED_CONCURRENTLY` | a serialization failure or deadlock (this command only) |
| 412 | `VERSION_CONFLICT` | still open, but the order's version moved since it was read; checked after the state |
| 423 | `CROSS_FACILITY_ORDERS_UNAVAILABLE` | `cross_facility_route_access_enabled` off |
| 429 | `ORDER_ROUTE_CANNOT_COMPLETE_LIMIT` | 20 endings by this staff member's account (at every facility it belongs to, not only this one) or 50 at this facility in the last 24 hours (D18-7, exact, never lifted); problem member `retryAfter` (ISO-8601 UTC, milliseconds, the later of the two when both are reached) is the earliest time another is possible. Past the limit the facility asks the ordering facility to cancel the order or Health ID support to close it, after phoning the ordering facility about any result recorded on it: either ending ends the facility's reading at once and shows the ordering facility no word of a result |
| 503 | `ORDER_ROUTE_UNAVAILABLE` | anything else, including the command's refusal of a caller whose transaction is not READ COMMITTED (`25000 ORDER_ROUTE_CANNOT_COMPLETE_READ_COMMITTED_REQUIRED`; the services always call it so) and a schema without 0091 |

After the ending nothing more can be written, verified, released or
dispensed on the order's work item, even under the patient's consent: a
dispensing answers 409 `ORDER_ROUTE_CLOSED`; a Lab write answers 409
`ORDER_ROUTE_CLOSED` under the patient's consent and 404 (the execution or
result is not found for writing) while only the order lets the laboratory read
it, as after §21's report. Results the laboratory recorded and never released
stay in its own records only. §21's report then answers
`ORDER_ROUTE_ALREADY_ENDED`; §23's lookup lists the order `correctable` and
§23's correction corrects it (also after the facility's reading ended), so an
ending of this kind never closes the way to a wrong-patient report. Support's
Close answers `ORDER_ROUTE_ALREADY_CLOSED`. The same order can never be sent
again (`ORDER_ROUTE_ORDER_IN_WORK`, D18-9); the clinician writes a new order.

**What the other services answer (fields only; no new route).** Each is sent
only by a backend with 0091; a client reads it only when it is present and of
the right type.

- Lab and Pharmacy: the work lists (`GET /api/v1/{lab,pharmacy}/work-items`)
  add `cannotComplete: true` (after `lateCorrection`) for a member holding the
  kind's receive permission, nothing to anyone else. A row ended this way
  shows `endedKind: 'receiving_unable'` with `access: 'read'` while the
  facility's reading lasts; after it only the patient's consent shows it.
- EHR: the order summary (`orderRoute` on the lab-request and prescription
  lists and reads, the order's route views) gains `notCompleted: { reason,
  sampleTaken, resultRecorded } | null`: an object only for an order ended
  `receiving_unable` that has no wrong-patient report (once one exists the
  earlier reason is not about the patient, and `wrongPatient` and
  `correctableUntil` follow §23); `sampleTaken` (a specimen was collected and not rejected) and
  `resultRecorded` (a result was recorded there and not released) are
  booleans for a lab request and `null` for a prescription. The patient's
  `GET /api/v1/ehr/me/order-routes` is unchanged (the order reads `cancelled`,
  `receiving_unable`, with §23's `correctableUntil`); the Overview is unchanged
  (D18-8: no card).
- Identity, support's facility summary
  (`GET /api/v1/admin/facilities/:facilityId/order-route-summary`): the answer
  adds, after its earlier keys, `notCompleted` and `cannotComplete: true`,
  read in the same read-only transaction in a savepoint and both left out on
  any failure (D18-11; counted at the receiving facility over the last 30
  days):

  ```json
  { "notCompleted": { "last30Days": 4, "soonAfterAcceptance": 1, "afterSevenDays": 1, "laterReportedWrongPatient": 1,
      "byReason": { "supplies_unavailable": 2, "other": 1, "out_of_stock": 1 } },
    "cannotComplete": true }
  ```

  `soonAfterAcceptance` counts endings within 60 minutes of acceptance with no
  accession, `afterSevenDays` those 7 days or more after acceptance,
  `laterReportedWrongPatient` those whose order then got a wrong-patient
  report; `byReason` holds only the reasons that occur. Counts only. There is
  no list across facilities.
- Identity, support's lookup (`GET /api/v1/admin/order-routes`,
  `POST /api/v1/admin/order-routes/search`): the answer adds
  `cannotComplete: true`; an order ended this way is found as any other
  (`cancelled`, `receiving_unable`, `closable: false`, §23's `correction`).
- Identity, support's reports list (`GET /api/v1/admin/wrong-patient-reports`):
  unchanged. A report made after such an ending is a late report (D18-12):
  `late: true`, `endedKindBefore: 'receiving_unable'`, the flag
  `late_correction`, so it is listed among the flagged reports, first; it is
  reviewed like any late report where nothing came back (no DPO referral is
  required unless it is a "suspected misuse" one).

`cannotComplete: true` on any of these answers tells the website that this
backend serves the ending (D18-13: the website ships first and stays
dormant). An earlier backend sends none of these fields, and its Lab and
Pharmacy answer the new route 404.

## 25. Offline-first support (ehr-api, code-only; offline contract §2.10)

Four routes under `/api/v1/ehr/offline`, built for the offline-first staff
client (contract: D-Eminence/health `offline/base`, `docs/OFFLINE-CONTRACT.md`
§2.10, paths and headers in `packages/offline/src/contracts.ts`). No migration,
no grant change, no change to how a clinical write is authorized.

Common to C1, C2 and C4: a staff session (cookie or bearer; a patient session
answers 403 `PATIENT_SCOPE_DENIED`, none 401), `X-Facility-ID` at a facility the
actor works at, `X-Purpose-Of-Use: direct-care` (else 400
`PURPOSE_OF_USE_REQUIRED`), `X-CSRF-Token` on POST as on every browser write,
and either `ehr.encounter.read` or `ehr.document.write` (`@RequireAnyPermission`;
neither answers 403 `PERMISSION_DENIED`). Every answer is `private, no-store`
and every error is problem+json. None of them is gated on current consent; C2's patient check (A10) asks only whether a qualifying grant once existed.

**C0. `GET /api/v1/ehr/offline/ping`** (public, not audited). 200
`{"service":"ehr-api","serverTime":"2026-10-29T10:42:00.123Z"}`.

**C1. `POST /api/v1/ehr/offline/receipts/lookup`** `{"keys":["off1.…"]}`, 1 to
50 keys of the Idempotency-Key format (repeats looked up once). 200:

```json
{ "receipts": [ { "key": "off1.…", "operation": "encounter.create", "state": "completed",
                  "resourceType": "encounter", "resourceId": "uuid", "responseStatus": 201,
                  "createdAt": "…", "completedAt": "…" } ],
  "unknown": ["off1.…"] }
```

Reads `ehr.idempotency_keys` in the caller's transaction context; its owner-only
RLS (and the query's own predicates) limit rows to the caller's account,
membership and facility, so another account's key, or the caller's key at
another facility, is `unknown`. `state` is `processing`, `completed` or
`failed`; `resourceType`, `resourceId` and `completedAt` are null unless
completed. No patient id or clinical content. 400 `INVALID_KEYS` for any other
body. Audit: `ehr.offline.receipts.lookup` with `{requested, found}`.

**C2. `POST /api/v1/ehr/offline/audit-events`** `{"vaultId":"uuid","events":[…]}`,
1 to 20 events, each with a UUID `eventId` (otherwise 400 `VALIDATION_FAILED`).
Each event is checked on its own; 200
`{"accepted":[…],"duplicate":[…],"rejected":[{"eventId":"…","code":"…"}]}`.

| `action` | `patientId` | `section` |
|---|---|---|
| `ehr.record.read` | required | `consent`, `encounters`, `encounter`, `clinical-notes`, `vitals`, `diagnoses`, `prescriptions`, `lab-requests`, `documents`, `note-revisions`, `vital-corrections`, `reported-health`, `lab-results`, `summary` |
| `ehr.offline.unlock` | none | none |
| `ehr.offline.wipe` | none | the reason: `sign-out`, `failed-unlocks`, `lease`, `membership`, `kill-switch`, `account` |
| `ehr.offline.command.discarded` | required | none or a chart section; `details` is exactly `{op, reason, bodySha256, capturedAt}` |

Rejections: `INVALID_ACTION` (not in the table), `PATIENT_NOT_FOUND` (the
caller may not record reads of that patient, or the patient does not exist:
the same answer for both), `INVALID_EVENT` (anything else: unknown field,
`details` on any action but a discard, `seq` outside 1..2147483647, an `occurredAt`, `grantExpiresAt` or discard
`capturedAt` that is not a real calendar instant (31 September, hour 24),
bad `clock`, `resourceId`, section or patient presence).

**Patient check (contract A10).** An event that names a patient is written
only if `ehr.offline_audit_patient_allowed(patientId)` answers true: a consent
grant for that patient to the caller's account, membership and facility,
scope `read_records` or `write_records`, not break-glass, not held for
migration, already started, whatever its status or expiry now (a read synced
late still counts). The function comes with a later migration. Until it is
installed, or if the runtime may not execute it, a request with any patient
event answers **503 `OFFLINE_AUDIT_UNAVAILABLE`** and writes nothing; the
device keeps its events and sends them again. A request with only session
events (`ehr.offline.unlock`, `ehr.offline.wipe`) never calls it and is
accepted as before. The patient foreign key stays as a backstop. Each event is one `audit.events` row under its own
savepoint: `event_id` = `eventId`; `occurred_at` = `occurredAt` clamped into
[database now − 26 h, database now]; actor, membership, organization and
facility from the session; `resource_type` `offline-chart-section` (patient
events) or `offline-session`; `outcome` `success`, `purpose_of_use`
`direct-care`, `provenance` `application`; `source_system` `health-id-offline`,
`source_event_id` `<vaultId>:<seq>`; `details`
`{offline:true, vaultId, seq, section, clock, deviceOccurredAt, clamped, grantExpiresAt}`
(plus the four discard fields). A repeated `event_id` writes nothing and is
`duplicate`. The statement is `insert … on conflict do nothing` without a
conflict target: naming `(event_id)` needs SELECT on `audit.events`, which
`hid_audit_writer` does not have; `event_id` is the only unique key a caller
supplies, so the effect is the same.

**C4. `POST /api/v1/ehr/offline/escrow-key`** `{"vaultId":"uuid","keyVersion":null}`.
200 `{"keyVersion":1,"key":"<base64url of 32 bytes>","algorithm":"HKDF-SHA256"}`,
the key being HKDF-SHA256(ikm = secret of that version, salt =
`hid-offline-escrow/v1`, info = `accountId|membershipId|facilityId|vaultId`,
lower-case UUIDs, 32 bytes). `keyVersion` null or absent gives the highest
version. 503 `OFFLINE_ESCROW_UNAVAILABLE` unless `OFFLINE_ESCROW_ENABLED=true`
(it is not set anywhere yet; the Terraform wiring is held by the owner); 404
`OFFLINE_ESCROW_VERSION_UNKNOWN`; 429 `OFFLINE_ESCROW_RATE_LIMITED` past 30 per
account per hour (counted per running task, like the patient chat admission
limit); 400 `VALIDATION_FAILED` for another body. `OFFLINE_ESCROW_KEYS` is
`{"<version>":"<base64url of 32 bytes>"}`; with escrow enabled, a missing or
malformed value stops the service at start-up. Audit:
`ehr.offline.escrow-key.issue` with `{vaultId, keyVersion}` (never the key, no
patient).

**C3. Offline replay headers.** Any route that builds its request context
(`requireRequestContext`) reads, all optional:

| Header | Valid value |
|---|---|
| `X-HID-Offline-Command` | `off1.<uuid>` |
| `X-HID-Captured-At` | ISO-8601 UTC, `…Z`, up to milliseconds |
| `X-HID-Clock` | `anchored`, `wall` or `suspect` |

An invalid header is ignored and none ever refuses a request. Valid values go
to `DataAccessContext.offline`, and the clinical write audit
(`ClinicalRepository.record`) and the document audit
(`DocumentService.auditEvent`) add
`details.offline = {commandId, capturedAt, clock, capturedClamped}` (null for a
header that was missing or invalid; a capture time that is not a real calendar
instant is invalid). A capture time outside [now − 24 h, now + 5 min] is
recorded clamped into that window with `capturedClamped: true`, and the header
as sent is kept as `deviceCapturedAt` (held and reviewed commands arrive more
than 24 h after capture).

**`operation` per keyed route of the offline registry (§2.8).** C1 finds a
command only if its route stores the key in `ehr.idempotency_keys`; for the
others it answers `unknown`, and the client re-reads instead.

| Registry op | Route | `operation` in `ehr.idempotency_keys` |
|---|---|---|
| `ehr.encounter.create` | POST `E` | `encounter.create` (`encounters.service.ts`) |
| `ehr.note.create` | POST `E/{eid}/clinical-notes` | `clinical-note.create` (`clinical-notes.service.ts`) |
| `ehr.vital.create` | POST `E/{eid}/vitals` | `vital.create` (`vitals.service.ts`) |
| `ehr.diagnosis.create` | POST `E/{eid}/diagnoses` | `diagnosis.create` (`diagnoses.service.ts`) |
| `ehr.prescription.create` | POST `E/{eid}/prescriptions` | `prescription.create` (`prescriptions.service.ts`) |
| `ehr.lab-request.create` | POST `E/{eid}/lab-requests` | `lab-request.create` (`lab-requests.service.ts`) |
| `ehr.note.revise` | POST `E/{eid}/clinical-notes/{nid}/revisions` | `clinical-note-revision.create` (`clinical-notes.service.ts`) |
| `ehr.vital.correct` | POST `E/{eid}/vitals/{vid}/corrections` | `vital-correction.create` (`vitals.service.ts`) |
| `ehr.document.upload` (upload intent) | POST `/api/v1/ehr/documents/upload-intents` | `document.upload-intent` (`document.service.ts`); `…/complete` takes no key |
| `ehr.prescription.to-pharmacy` | POST `E/{eid}/prescriptions/{id}/pharmacy-work-item` | **none**: the key is passed to Pharmacy (`acceptEhrPrescription`), which keeps its own idempotency |
| `ehr.lab-request.to-lab` | POST `E/{eid}/lab-requests/{id}/lab-work-item` | **none**: the key is checked and not used; Lab is called with `ehr-order:<requestId>:<rowVersion>` |
| `ehr.encounter.update`, `ehr.note.update`, `ehr.diagnosis.update` | PATCH | **none**: the PATCH routes take no key (A1 not built) |
| `identity.grant.close` | POST `/api/v1/identity/consent-grants/{gid}/close` | not an EHR route |

`E` is `/api/v1/ehr/patients/{patientId}/encounters`.

**Document upload completion is idempotent (offline contract A8.6).**
`POST /api/v1/ehr/documents/{id}/complete` on a document whose upload is
already complete (status `uploaded`, or `available` or `rejected` after the
scan, with its object bound) answers 201 with the document as it is now: no
write, no second `ehr.document.upload.complete` event, and storage is not
read again. While nothing has changed since the first call, the body is the
same as the first answer; after the scan, `status` and `scanStatus` show the
scan result. The checks before answering are unchanged: the caller must be the
account that created the upload intent, at the document's facility (anyone else
gets 404), with write access to the patient (403 otherwise). A document entered
in error still answers 409, with code `INVALID_DOCUMENT_TRANSITION` (not the
generic `CONFLICT`, which the offline client retries). The offline client treats a document as applied
only on its own `/complete` 2xx.

## 26. The sealed demo tenant (0098)

Migration 0098 (`0098_sealed_demo_tenant.sql`, owner decision of 2026-10-29
"Sealed demo, yes") keeps a demo tenant beside the real ones in production so
that testers sign in and use every portal without creating accounts. It is
sealed in the database: a facility and a patient are linked (a consent grant, an
order route, a share, an accepted invitation) only when both belong to the demo
tenant or neither does, and so are an account and a facility (a staff
membership). The marker is the owner-only table `identity.sealed_demo_members`
(row-level security enabled but not forced, so the owner's helpers always read
it and fail closed if they lose access; no update, delete or TRUNCATE). No
existing API field changes for real tenants, and every answer below is one a
real tenant already gets for an unknown or ineligible value.

The tenant (seeded only on Amazon RDS, i.e. production; CI and rehearsals get the
seal without the seed): Demo Hospital (`DEMO-HOSPITAL`), Demo Laboratory
(`DEMO-LABORATORY`), Demo Pharmacy (`DEMO-PHARMACY`) and Demo Outreach
(`DEMO-OUTREACH`), verified and active; one staff login,
`operations@healthidentitydirectory.com` ("Demo Operations"), with a membership
at each (doctor, lab, pharmacist, nurse) and `org_admin` at each, chosen after
sign-in as for any member of several facilities; two patient logins,
`patientdemo1@healthidentitydirectory.com` (`HID-ZDEMAAA2`) and
`patientdemo2@healthidentitydirectory.com` (`HID-ZDEMAAA3`) (0098 seeded them at
`patient1@` and `patient2@`; 0123 moved them, address only, so that those two
are the QA patients' logins, section 52); eight
fictional patients without a login or any contact detail (`HID-ZDEMBBB2` to
`HID-ZDEMBBB9`). Patient One and Patient Two each share their record with the
demo login at Demo Hospital (doctor) and at Demo Outreach (nurse): the seed
writes the consent grant and share row that the patient's own Share action
writes, with `identity.write_patient_share`'s values (clinical collaboration
until revoked, 365 days of direct-care write access, granted by the patient
and revocable in the patient portal), so they read like any share in the
patient's access history and the staff login's shared-with-me list; these
four shares are the only grants seeded, a revoked one is never restored, and
none is written beside a share the patient already holds or to a membership
the patient could not choose. The audit says who wrote them: no audit row
names a patient (or anyone) as its actor. Each share has one row of the
migration's own (`actor_type` `system`, `provenance` `migration`,
`source_system` `hid-sealed-demo`, `action` `identity.sealed-demo.seed-share`,
correlation id `0098-sealed-demo-install`, the grant as its resource, the
patient and the facility as its subject), and the install one more
(`identity.sealed-demo.install`, the same actor, provenance, source system and
correlation id, counts only): five rows. The four share rows appear in Demo
Hospital's and Demo Outreach's facility audit lists and all five in the
platform's audit list; a patient's access log leaves migration rows out. The
three accounts are seeded `pending_reset`
without a password, their email verified: the owner sets each password with
Forgot password (`POST /api/v1/auth/otp/start|verify|complete`, unchanged; a
patient may start with the email or the Health ID).

The seed refuses (55000 `SEALED_DEMO_ADDRESS_TAKEN`, nothing written, the
release stops) while any of the three addresses belongs to an account that is
not deleted or to a staff record, or is named by an open organization
application (its first administrator, `pending_verification` or
`ready_for_review`) or by a pending staff invitation that has not expired:
seeding the account would break that application's approval or that
invitation's acceptance. It also refuses a Health ID, facility code, slug,
CAC or fixed id held by a real row, and never attaches demo access to an
existing account. The read-only query in the migration's header (including
`open_applications` and `pending_invitations`) is run on production before
signing. A share the seed would write to a membership the patient could not
choose in the share directory is refused too (55000
`SEALED_DEMO_SHARE_INELIGIBLE`, nothing written).

Before testers start, the owner sets the three passwords once, at least 24
hours before patient approvals, new shares, the PIN, emergency contacts or
invitations are tested: Identity holds those patient actions for 24 hours after
any OTP recovery of the account (live rule). The logins are shared by every
tester: testers never use Forgot password on them (each recovery restarts that
patient's 24-hour hold), and five wrong passwords in 15 minutes lock a shared
login for 15 minutes for everyone (live rule).

What testers can do, from the first day: at Demo Hospital (doctor) or Demo
Outreach (nurse), open Patient One's or Patient Two's chart through the seeded
share and write in it (visits, notes, vitals, lab requests and prescriptions,
outreach links, documents; Migrate's document upload and lab and pharmacy
imports); send orders from Demo Hospital to Demo Laboratory or Demo Pharmacy
for Patient One or Two and accept, return results or dispense with the same
login at those facilities. Break-glass (emergency purpose) on any demo patient
opens a read-only emergency summary, never a write; the eight fictional
patients can only be looked up and break-glassed, and their charts are empty.
After the 24-hour hold, the patients approve requests, share, set a PIN and add
emergency contacts and invitees (each one of the three demo addresses below). To
test accepting a patient's invitation, the patient invites
`operations@healthidentitydirectory.com` (the staff login's own address), which
accepts it at Demo Hospital or Demo Outreach; an invitation to
`patientdemo1@healthidentitydirectory.com` or `patientdemo2@healthidentitydirectory.com`
is delivered to that mailbox but can never be accepted (acceptance needs a staff
login whose own verified address it is). Migrate's OCR
job creation (`POST /api/v1/ocr/jobs`) needs a records-processing
(`healthcare-operations`) grant for the patient. 0098 seeds none and widens
nothing; once 0104 is applied the demo login asks for one at Demo Hospital and
Patient One or Patient Two approves it in the portal, as any patient does
(section 32). Upload and publication run under the seeded direct-care shares.
The fictional patients born in 2012 and 2020 are refused as under 18. The
owner can check production's purposes with `select code, active from
identity.purpose_of_use_codes order by 1;`.

Answers across the boundary (a demo actor and a real patient or facility, or a
real actor and a demo one):

- Identity's Health ID lookups (`lookupExactHid`, `lookupPatientId`, and Lab's
  and Pharmacy's through them): not found (404), as an unknown Health ID; the
  registration read policy of `identity.patients` shows demo patients only at a
  demo facility and real ones only at a real one.
- Access request (`identity.create_access_request`) and break-glass
  (`identity.activate_break_glass`): `P0002 Patient is not available`, as an
  unknown Health ID; nothing is written and no inbox item, outbox event or alert
  is created. Access PIN (`identity.access_patient_with_pin`): `verified: false`,
  as an unknown Health ID (the PIN is not read; the actor's window counts it).
- Orders between facilities: the directory (`identity.search_order_destinations`)
  lists facilities on the sender's side only; sending to the other side answers
  `ORDER_ROUTE_DESTINATION_INELIGIBLE` (409) with nothing written.
- Share directory (`identity.search_share_providers`): clinicians on the
  patient's side only. A share to a membership on the other side is refused
  with nothing written (the database's 42501 `SEALED_DEMO_BOUNDARY`, which
  Identity answers as any 42501 there, 403 `PATIENT_SESSION_REQUIRED`);
  accepting a patient's invitation from the other side answers 403
  `SHARE_PERMISSION_DENIED` and the invitation stays pending.
- A demo patient may invite, add as an emergency contact or change their email to
  the owner's three demo mailboxes only, an exact allowlist (any case, trimmed;
  no pattern and no plus-address): `operations@healthidentitydirectory.com`,
  `patientdemo1@healthidentitydirectory.com` and
  `patientdemo2@healthidentitydirectory.com`, the demo logins' own addresses
  (`patient1@` and `patient2@` until 0123, which made them QA addresses).
  Otherwise: invitation 400 `SHARE_INVITATION_EMAIL_INVALID`; email change 409
  `CONTACT_UNAVAILABLE` (nothing recorded, no code sent; each allowlisted address
  already belongs to a demo login, so a demo patient's email change never
  completes and the patient keeps its address); emergency
  contact `POST /api/v1/identity/me/emergency-contacts` 400
  `EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED` ("A demo account can only add the
  demo mailboxes."), checked after the recovery hold and before anything is
  written or sent. The database checks the contact too, as far as it can see
  (trigger `patient_emergency_contacts_sealed_demo`): Identity asks
  `identity.sealed_demo_contact_allowed(subject, session, channel,
  destination, destination HMAC)`, which for a demo patient, an allowed
  mailbox and a well-formed HMAC (64 lowercase hex characters) records the
  HMAC it was given for the rest of the transaction; the trigger refuses a
  demo patient's SMS contact, and an email contact whose
  HMAC the check did not record in that transaction (an Identity image before
  0098 never asks the check, so it answers 403 with nothing added or sent).
  The database holds only the contact's HMAC and ciphertext, so it cannot
  tell whether either belongs to the checked address, and any session can set
  `hid.sealed_demo_contact_hmac` itself: that the destination is one of the
  three demo mailboxes rests on Identity (`EmergencyContactService.add`
  computes the HMAC from the same normalized address it checks and
  encrypts). Removing a contact is never refused. A
  demo patient never holds a phone: a phone change answers 400
  `PROFILE_REQUEST_INVALID`, so no SMS is ever due for one.
- QoreID: a demo account consumes no quota (`QOREID_QUOTA_PERMISSION_DENIED`, the
  existing refusal), so it never causes a QoreID call (a demo patient's NIN
  check, a demo administrator's CAC check).
- Demo facilities send no staff invitations (`STAFF_MANAGEMENT_NOT_AVAILABLE`, as
  any governed facility); the demo login never joins a real facility and no
  real account a demo one (42501 `SEALED_DEMO_MEMBERSHIP_REFUSED`); a demo
  account never holds a platform role (42501 `SEALED_DEMO_PLATFORM_ROLE_REFUSED`).

Platform administration: `GET /api/v1/admin/overview` counts real tenants only
(patients, facilities, memberships and pending reviews of the demo tenant are
left out). Every admin list that shows the demo tenant marks it with `demo:
boolean` (true for the demo tenant's rows, false otherwise; an Identity before
0098 sends no `demo` field):

- `GET /api/v1/admin/facilities` items and `GET
  /api/v1/admin/facilities/:facilityId` (the four demo facilities);
- `GET /api/v1/admin/principals` and `POST /api/v1/admin/principals/search`
  items (the three demo accounts), and a last `demo` column (`true` or `false`)
  in `GET /api/v1/admin/principals/export`;
- `GET /api/v1/admin/identity/reviews` items (a review at a demo facility);
- `GET /api/v1/admin/audit/events` items (an event at a demo facility or by a
  demo login);
- `GET /api/v1/admin/order-routes` and `POST /api/v1/admin/order-routes/search`
  items, and `GET /api/v1/admin/wrong-patient-reports` items (between demo
  facilities), each read in the request's own transaction;
- `GET /api/v1/admin/organization-applications` items (the approved Demo
  Laboratory and Demo Pharmacy applications), through
  `identity.sealed_demo_application`.

Within the demo tenant everything else works as for a real tenant: consent
rules, audit, the PIN, break-glass, requests and approvals, orders from Demo
Hospital to Demo Laboratory or Demo Pharmacy and their acceptance, results and
dispensing, document upload and imports, outreach. Notifications go only to the
owner's three demo mailboxes (the demo logins' own addresses, which are the
allowlist above; for emergency contacts as Identity enforces it, see above) and
the testers' own devices.

Off switch and removal. To switch the demo off (if the seal is ever found
wanting, or testing ends), a platform administrator disables the three demo
accounts and revokes their sessions in the admin console (`POST
/api/v1/admin/principals/:accountId/status` with `disabled`, `POST
/api/v1/admin/principals/:accountId/sessions/revoke`) and suspends Demo
Hospital, Demo Laboratory, Demo Pharmacy and Demo Outreach (`POST
/api/v1/admin/facilities/:facilityId/status` with `suspended`); nothing in 0098
stands in the way, and the rows stay sealed (the triggers, the policy and the
replaced bodies' clauses stay in force). Removing the demo needs a new reviewed
migration that drops the triggers `sealed_demo_members_immutable` and
`sealed_demo_members_no_truncate` before deleting the demo rows and their member
rows. 0098 has no down migration, and rolling back the service images leaves the
seed and the seal in place.

## 27. Offline audit: the patient check (0099)

Migration 0099 (`0099_offline_audit_patient_allowed.sql`, OFFLINE-CONTRACT.md
amendment A10 item 1, after the review of hid-system#131; signed by D-Eminence
on 2026-10-30) adds one database function for the EHR API's offline audit ingest
(C2). It changes no table, policy, trigger or existing function and no API
field. The EHR API's C2 (from #131, live since 2026-10-30) looks for this
function on every request that names a patient and calls it once it exists.

`ehr.offline_audit_patient_allowed(requested_patient_id uuid) returns boolean`
answers, for the request context the EHR API sets on every request
(`app.actor_subject`, `app.membership_id`, `app.facility_id`), whether that
account, membership and facility ever held a consent grant for the patient
that:

- has scope `read_records` or `write_records`;
- is not break-glass (owner decision D5: break-glass records are never written
  to a device; the scope and the `break_glass` flag are both checked, since a
  legacy row may carry one without the other);
- is not held by the cutover (`migration_hold_reason` is null);
- has started (`starts_at <= now()`).

It ignores the grant's `status`, `revoked_at` and `expires_at` on purpose: a
read made offline while the grant was open may sync after the grant expired,
was revoked by the patient or was closed by the clinician, and its audit event
must still be accepted (the ingest is never gated on current consent).
Everything else answers false: another membership of the same account, another
facility, another account, a patient with no qualifying grant, a patient that
does not exist, a null argument, a disabled or deleted account, a request
without context. C2 answers a missing and an unrelated patient alike,
`rejected: PATIENT_NOT_FOUND`. Until 0099 is applied, C2 answers 503
`OFFLINE_AUDIT_UNAVAILABLE` to any request containing a patient event and
writes nothing; session events (unlock, wipe) never ask the check.

The function is SQL, STABLE and SECURITY DEFINER with `search_path =
pg_catalog, pg_temp`, owned by `ehr.context_allows`'s owner, so it reads
`identity.consent_grants` as the existing consent gate does. EXECUTE is granted
to `hid_ehr_runtime` only (the ehr-api login inherits it), in the migration
and in `runtime-grants.sql`; never to PUBLIC, the Identity runtime or any other
runtime. The EHR runtime gains no privilege on any Identity table. The answer
is only true or false about the caller's own grants (rows that
`consent_grants_actor_read` already shows that account, membership and
facility). The sealed demo (0098) needs nothing: grants never cross its
boundary, so a demo session answers true only for demo patients and a real one
only for real patients. Creating the function takes ACCESS SHARE on
`identity.consent_grants` until commit (the body's validation) and no other
lock on an application table.

The suite is `services/ehr-api/test/database/offline-audit-patient-allowed.integration.sql`.
0099 has no down migration; an EHR API image from before #131 never calls the
function, and #131's image answers 503 without it.

## 28. Pharmacy acceptance checks its EHR prescription (0100)

Migration 0100 (`0100_pharmacy_prescription_source_check.sql`, owner decision
of 2026-11-01 by D-Eminence, "Fix it now"; unsigned until the owner signs the
declaration) makes the database refuse a same-facility Pharmacy work item that
is not exactly the EHR prescription it names. It changes no table, column,
policy, grant or API field; it replaces `pharmacy.validate_work_item()` (the
BEFORE INSERT trigger function on `pharmacy.work_items`) from its 0086
definition with only the same-facility branch changed. The order-route branch
(work items accepted from another facility's route) and the checks 0077 and
0086 put after it are byte for byte as they were.

Before 0100, `POST /api/v1/pharmacy/work-items/accept-ehr-prescription`
(internal EHR caller) inserted a dispensable work item from the fields the
caller sent, and the database checked only the session, facility, actor,
`source_status = 'active'` (which the caller sends) and that the prescription
had no live route. Since 0100 the trigger reads the `ehr.prescriptions` row
named by `sourceEhrPrescriptionId` FOR SHARE (held until the acceptance
commits) and refuses, with SQLSTATE 23514 and one of these messages, which
pharmacy-api answers as follows (the code is the message; the EHR API passes
status, code and detail on to the website unchanged):

| Database message | pharmacy-api | When |
| --- | --- | --- |
| `PRESCRIPTION_SOURCE_NOT_FOUND` | 404 | No such prescription, or one this session may not read and write (another facility's; no write consent for its patient). |
| `PRESCRIPTION_SOURCE_NOT_ACTIVE` | 409 | The prescription is draft, on hold, completed, cancelled or entered in error. |
| `PRESCRIPTION_SOURCE_VERSION_MISMATCH` | 409 | Its `row_version` is not `sourceEhrPrescriptionVersion`: it changed since it was read; reload it and send it again. |
| `PRESCRIPTION_SOURCE_MISMATCH` | 422 | Any of these differs: patient, facility (= ordering facility), encounter, medication code system, code and display, dose quantity and unit, route, frequency, instructions, start and end dates, prescriber (`created_by`), prescribed at (`created_at`). |
| `PRESCRIPTION_ROUTED` (P4c, unchanged) | 409 | The prescription has a live route to another facility. |

They are checked in that order (existence, status, version, fields), then
0077's session checks and the routed check as before. The comparison follows
what the only writer carries: the EHR API's hand-off
(`PrescriptionsService.acceptForPharmacy`) reads the row with node-postgres and
sends it as JSON; pharmacy-api's DTO trims texts. So a text matches as stored
or with what JavaScript's `String.prototype.trim()` removes cut from the stored
text (the 25 characters it removes, listed in the migration); the dose matches
by numeric value (the row's `1.5000` arrives as the number `1.5`); prescribed
at matches `created_at` or `created_at` cut to the millisecond (a JavaScript
Date keeps milliseconds); ids and dates exactly; null only null. Dates: from
this release the EHR API sends `startsOn` and `endsOn` as calendar dates
(`YYYY-MM-DD`, the local year, month and day of the Date node-postgres makes
of a date column, which are the stored date whatever `TZ` the process runs
in; `src/ehr/shared/calendar-date.ts`, tested under Africa/Lagos, UTC,
Europe/London, America/New_York, Asia/Kolkata, Pacific/Kiritimati and
Pacific/Pago_Pago). An older EHR API image sends that Date itself (local
midnight as an ISO string), which matches only while the process runs in UTC,
as it does today (its image and the Terraform task definitions set no `TZ`);
east of UTC it would send the day before and the acceptance would be refused
as a mismatch. pharmacy-api accepts both forms (`IsDateString`).

The website never sends these fields: both "Send to Pharmacy" actions (the
classic clinical record, `staff/routes/Clinical.tsx`, and the blue order page,
`ehr-blue/clinical/consult/orders/OrderPage.tsx`) call
`staffApi.acceptPrescription`, which posts only `{ expectedRowVersion, reason }`
to the EHR API's `.../prescriptions/:id/pharmacy-work-item`; the Pharmacy work
lists (classic Operations and the blue Pharmacy department) only list and
dispense. A legitimate acceptance therefore always matches, and the only new
refusals a user can meet are a prescription changed or stopped between the EHR
API's check and Pharmacy's insert (`VERSION_MISMATCH`, `NOT_ACTIVE`), which the
website shows with the problem's detail until it maps the two codes to its
existing "changed since it was loaded" and "no longer active" texts.

Row-level security: the trigger is SECURITY DEFINER and reads as its owner.
On production that owner does not bypass row-level security and
`ehr.prescriptions` forces it, so the read and the FOR SHARE lock are allowed
only where the session's consent allows reading and writing that patient's
records at this facility (`ehr.context_allows`), exactly where the work item's
own insert policy allows the insert. A session that is not a member with
consent there is therefore refused `PRESCRIPTION_SOURCE_NOT_FOUND` before
0077's session checks; under an owner that bypasses row-level security those
checks answer first.

Locks: the acceptance holds the prescription FOR SHARE until it commits. A
second reader or an order route's foreign key check proceeds; the EHR's own
change of that prescription (FOR UPDATE, UPDATE) and the route send (FOR NO
KEY UPDATE) wait for the acceptance, so the EHR cannot change or cancel the
prescription under it. An acceptance that reaches a prescription being changed
waits, then fails with 40001 (SERIALIZABLE), which pharmacy-api retries; the
retry answers `PRESCRIPTION_SOURCE_VERSION_MISMATCH`. Every EHR writer already
locks the prescription before the routes, so the order prescription, then
routes, adds no deadlock.

The lock does not by itself stop a route send to another facility that
overlaps the acceptance. The send (`ehr.send_order_route`) only locks the
prescription FOR NO KEY UPDATE and inserts the route, it does not update the
prescription row; so an acceptance that waited for it gets its FOR SHARE lock
without a serialization error, and its `PRESCRIPTION_ROUTED` check reads
`ehr.order_routes` with the snapshot it took before the send committed. From
this release the EHR API runs the send SERIALIZABLE
(`OrderRoutesService.send`, `ClinicalRepository.run`'s transaction options,
and `DatabaseService.withTransaction` running a SERIALIZABLE transaction that
PostgreSQL cancels with 40001 or 40P01 again, up to 12 times, as pharmacy-api
does); the send reads the Pharmacy work items, so PostgreSQL's serializable
checks cancel the overlapping acceptance with 40001, and pharmacy-api's retry
answers `PRESCRIPTION_ROUTED` (proved with two sessions: the route committed
after the acceptance's snapshot, and the send holding the prescription while
the acceptance waited). With an older EHR API image that sends READ COMMITTED,
such an overlap leaves a live route and a same-facility work item; only the
one-work-item-per-prescription key then stops the receiving pharmacy from
accepting it too, so nothing is dispensed twice. The send's own limits (per
sender, per facility pair, open per destination: an advisory lock, then a
count of `ehr.order_routes`) stay exact under SERIALIZABLE: two sends that
overlap are cancelled and retried, and the retry counts the one that
committed (proved with two sessions). Only while the older image's READ
COMMITTED send overlaps a new SERIALIZABLE one during the rollout can the
new one's count miss the older one's route, so a daily limit can be passed
by one in that window. The send's statements are unchanged. Run with every
transaction SERIALIZABLE, the order route suites that send, receive and
withdraw (send, receive, privileges, wrong-patient, wrong-patient overview)
and the three Pharmacy suites pass; the others stop only at the late
correction and "can't complete" commands, which refuse anything but READ
COMMITTED by design and stay READ COMMITTED, or at a lock check that counts
SERIALIZABLE's own predicate locks.

Existing work items are not touched (the trigger fires on INSERT only, and
work items are insert-only). `audit-existing-work-items.sql`, kept beside the
branch for the owner (not shipped), counts the existing same-facility work
items that 0100 would have refused, by reason (judged against the version
they name and the version that was current when they were accepted), and
those whose prescription changed or stopped after acceptance, before or after
they were dispensed (§29), without returning any patient data.

The suite is `services/ehr-api/test/database/pharmacy-prescription-source.integration.sql`;
`pharmacy-session-guards.integration.sql` and `database/tests/schema.integration.sql`
now name real prescriptions in their acceptances. 0100 has no down migration;
applying 0086's text of `pharmacy.validate_work_item()` restores the old
behaviour. Today's pharmacy-api image sends the same INSERT and keeps working:
a legitimate acceptance passes, and the four new refusals reach it as 23514
errors it answers 500 until the new image maps them.

## 29. Pharmacy dispensing checks its EHR prescription (0101)

Migration 0101 (`0101_pharmacy_dispensing_source_check.sql`, the review of
0100 under the same owner decision of 2026-11-01, "Fix it now"; main 0080's
dispensing half; unsigned until the owner signs the declaration) makes the
database refuse to dispense a same-facility Pharmacy work item once its EHR
prescription is no longer what Pharmacy accepted. It changes no table,
column, policy, grant or API field; it replaces `pharmacy.validate_dispensing()`
(the BEFORE INSERT trigger function on `pharmacy.dispensings`) from its 0086
definition with one declaration and one block added after its existing checks.
The order-route branch (`ORDER_ROUTE_CLOSED`) and 0077's actor and work-item
check are byte for byte as they were and still answer first.

0100's FOR SHARE lock ends when the acceptance commits. Before 0101 the EHR
could then cancel the prescription, put it on hold, complete it, mark it
entered in error, or change its instructions, frequency or dates, and the
same-facility work item stayed dispensable (work items are insert-only and
nothing updated them). Since 0101, for a work item with no order route, the
trigger reads the `ehr.prescriptions` row the work item names FOR SHARE (held
until the dispensing commits) and refuses with SQLSTATE 23514 and the message
`PRESCRIPTION_SOURCE_NOT_DISPENSABLE` when the row is missing, or its patient,
facility or encounter is not the work item's, or its status is not `active`,
or its `row_version` is not the version Pharmacy accepted
(`source_ehr_prescription_version`). The version is the EHR's row version,
raised by every change of the row, and 0100 made the work item equal to that
version, so no field needs comparing again.

`POST .../pharmacy/work-items/:id/dispensings` answers that message 409
`PHARMACY_PRESCRIPTION_NOT_DISPENSABLE` ("This prescription can no longer be
dispensed here"), the code it already answers for a route-backed work item
whose prescription changed; the website already handles it (it marks the work
"Not dispensable"). Only that message is mapped for same-facility work: the
validator's other 23514 refusals (0077's) pass on unchanged, and a
serialization failure goes to pharmacy-api's retry.

Owner decision this carries (as on `main`): once its prescription has changed
or stopped, a same-facility work item can be neither dispensed nor accepted
again (one work item per prescription; a second acceptance is answered 409),
so the prescriber writes a new prescription. A prescription put on hold and
resumed is a new version, and its work item stays undispensable too. A
dispensing recorded while the prescription was active can still be reversed
after it is cancelled: `pharmacy.validate_dispensing_reversal()` is unchanged.

Row-level security: as in §28, the read is the function owner's, so on
production only a prescription the session may read and write is found;
pharmacy-api's dispensing already requires write consent for a same-facility
work item, and any other session is refused by 0077's check first.

Locks: a dispensing holds the prescription FOR SHARE until it commits; another
reader proceeds, and the EHR's change (FOR UPDATE, UPDATE) and the route send
(FOR NO KEY UPDATE) wait for it. A dispensing that reaches a prescription being
changed, or that the EHR changed after the dispensing's snapshot, fails with
40001 (SERIALIZABLE); pharmacy-api's retry is then refused
`PRESCRIPTION_SOURCE_NOT_DISPENSABLE`. A route-backed dispensing takes no new
lock.

The suite is `services/ehr-api/test/database/pharmacy-dispensing-source.integration.sql`;
`pharmacy-session-guards.integration.sql` now creates the prescriptions its
work items name. 0101 has no down migration; applying 0086's text of
`pharmacy.validate_dispensing()` restores the old behaviour. Today's
pharmacy-api image sends the same INSERT and keeps working: a dispensing of a
work item whose prescription is still active at the accepted version passes,
and the new refusal reaches it as a 23514 error it answers 500 until the new
image maps it.

`audit-existing-work-items.sql` (beside the branch for the owner, not shipped)
counts, besides §28's reasons, the same-facility work items not yet dispensed
whose prescription is now not active or at another version (what 0101 will
hold back), those dispensed whose prescription has since changed, and those
dispensed after a newer version of their prescription was recorded (what 0101
now refuses), with no patient data.

## 30. The sealed demo story (0102)

Migration 0102 (`0102_sealed_demo_story.sql`, owner request of 2026-11-02 in
chat: "i need the access pin and emergency to work in demo account now and fill
both patient and ehr with the informaton you filled in the demo video";
unsigned until the owner signs) fills the sealed demo tenant of section 26 with
the demo video's made-up story. It changes no table, column, policy, trigger or
existing function and no API field. It adds three functions, owned by the
applier and granted to no role (revoked from PUBLIC here and in
`runtime-grants.sql`): `identity.demo_story_install(text)` (the seed,
SECURITY DEFINER), `identity.demo_story_context(text,uuid,uuid,text)`
and `identity.demo_story_lab_result(...)`. No service calls them. The
seed runs on Amazon RDS only, as 0098's install does; every other database gets
the functions only.

What the screens show after the seed (every row demo, written once):

- Names: Patient One is Adaeze Okafor (female, born 1991-03-04, Lagos,
  Nigeria), Patient Two Chinedu Okafor (male, 1990-07-02, Lagos, Nigeria);
  Patients Three to Ten are Abubakar Bello, Halima Yusuf, Emeka Nwosu, Ngozi
  Eze, Musa Ibrahim, Funke Adebayo, Ifeanyi Okeke and Zainab Lawal. The patient
  logins' display names follow; the staff login is Dr Tunde Bello. Health IDs
  are unchanged.
- Profiles: the hospital and HMO (Sample Teaching Hospital, Sample HMO) and the
  health information (Adaeze: O+, AA, "Penicillin — rash", ferrous sulphate,
  iron deficiency anaemia; Chinedu: A+, AS), where the patient saved none.
  Adaeze's completion card counts 8 of 12; the photo and an emergency contact
  are added by the owner in the app (10 of 12); a phone (0098 G5) and a
  verified NIN (0098 G6) cannot be held by a demo patient.
- The access PIN: both patient logins hold the owner's PIN (the bcrypt hash
  `identity.set_my_patient_access_pin` would store, cost 12), unless the
  patient already has a PIN row. `identity.access_patient_with_pin` at Demo
  Hospital (the demo login's doctor membership, direct care) answers
  `verified: true` for it.
- EHR at Demo Hospital: Adaeze's completed visit six weeks before the apply
  (vitals, a consultation note and a patient summary, diagnoses Z88.0 and
  D50.9, ferrous sulphate) and today's visit in progress (triage vitals, the
  signed consultation note, B54 malaria, artemether-lumefantrine and
  paracetamol, a malaria rapid test and a full blood count); Chinedu checked in
  today (triage vitals, a malaria rapid test and paracetamol).
- Orders: all six sent from Demo Hospital with `ehr.send_order_route` and
  accepted with `lab.accept_order_route` / `pharmacy.accept_order_route`.
  Adaeze's two tests have their results entered at Demo Laboratory and are not
  checked or released: `lab.validate_result_governance` requires a second
  person for the check and the demo has one staff login. Her two prescriptions
  are dispensed at Demo Pharmacy (6 and 18 tablets), which completes those
  routes. Chinedu's test waits for his sample at Demo Laboratory and his
  paracetamol waits at Demo Pharmacy.
- Demo Outreach: "Ajegunle health week" (active) and "Makoko school screening"
  (planned), and four field registrations awaiting resolution, without phone
  numbers and not linked to the campaign: the campaign check
  (`outreach.validate_registration_campaign_write`, 0045) reads the member row
  FOR SHARE, which forced row-level security refuses an owner without
  BYPASSRLS (`outreach.campaign_members` has no UPDATE policy). The same check
  runs for outreach-api, so a live registration into a campaign may meet the
  same refusal; 0102 reports it and changes nothing. 0110 fixes it (§38); the demo
  registrations stay unlinked.

Nothing is sent: the order commands' inbox notices are marked read in the same
transaction (no web push is due), the services' outbox rows for results and
dispensings are not written, and no identity outbox row or delivery attempt is
made. The accept commands queue `LabWorkItemCreated` and
`PharmacyWorkItemCreated` integration events, as for every order; no
notification workflow reads them. The audit has one row of the migration's own
per row written (actor system, provenance `migration`, source system
`hid-sealed-demo`, correlation id `0102-sealed-demo-story`) and a story row
with counts; no audit row names a patient or clinician. The order commands add
their own system rows (received, accepted, dispensing returned).

The seed refuses with 55000 and writes nothing while the three demo logins are
not all active (`SEALED_DEMO_STORY_LOGINS_NOT_READY`), while
`cross_facility_orders_enabled` or `cross_facility_route_access_enabled` is off
(`SEALED_DEMO_STORY_ORDERS_OFF`), when a 0098 share at Demo Hospital was
revoked (`SEALED_DEMO_STORY_SHARE_MISSING`) or a target is not the demo's
(`SEALED_DEMO_STORY_NOT_DEMO`); a PIN hash that is not bcrypt cost 12 is 22023
`SEALED_DEMO_STORY_PIN_HASH_INVALID`. Before any order command runs it also
asks what those commands would refuse on live data, so the release never stops
inside them: `SEALED_DEMO_STORY_ROLE_MISSING` (a demo membership inactive, a
send or receive permission gone, or the staff record without a name),
`SEALED_DEMO_STORY_DESTINATION_OFF` (Demo Laboratory or Demo Pharmacy not
eligible to receive, for example unlisted by support, or Demo Hospital not
active and verified), `SEALED_DEMO_STORY_PATIENT_RESTRICTED` (Adaeze or
Chinedu not active, without a Health ID, or with a deny directive naming Demo
Laboratory or Demo Pharmacy) and `SEALED_DEMO_STORY_ORDER_LIMIT` (the six sends
would pass a daily send limit, a destination is full of open orders, or a demo
receiving membership has used its daily wrong-patient tries). The Health IDs
and the attestation texts the commands are given are read from the database.
The owner's read-only pre-signing query in the file's header asks the same
and must answer rds 1, active_logins 3, orders_on, roles_ok, destinations_on,
patients_open and limits_ok true, hospital_shares 2, pins 0 and story 0. A
second call changes nothing.

Emergency needs nothing from 0102: the demo login break-glasses any demo
patient at Demo Hospital or Demo Outreach (emergency purpose, a reason) for a
read-only emergency view, while `break_glass_enabled` is on, the `emergency`
purpose is active, and the login has made fewer than 10 activations in the
past hour (one count for every tester sharing the login).

The suite is `services/ehr-api/test/database/sealed-demo-story.integration.sql`.
0102 has no down migration; 0098's off switch still applies.

## 31. Platform administrators review organization applications (0103)

Owner request of 2026-11-01 (D-Eminence, "fix the two dashboard errors now"):
the admin Overview showed "Organization applications: Your account does not
have permission" for the platform super admin. 0103 is unsigned until the
owner signs its declaration.

Routes (unchanged): `GET /api/v1/admin/organization-applications`
(`platform.identity-review.read`), `POST .../:applicationId/verify-cac`
(`platform.facility.manage`), `POST .../:applicationId/approve`
(`platform.facility.manage`, `platform.principal.manage`,
`platform.role.manage`) and `POST .../:applicationId/reject`
(`platform.facility.manage`). The Identity API runs each in a platform
transaction, which sends no facility and no membership for an administrator
who has none.

Who may act:

- A platform-scoped call (no facility and no membership in the request
  context, and the account holds `platform.admin.access`) is authorized by the
  route's platform permission alone. Before 0103 it also needed an active
  facility membership, which a platform administrator does not have, so every
  route answered 403.
- A call that names a facility or a membership keeps exactly the old check:
  an active membership of that facility, plus the platform permission.
- Everyone still needs an active account, a correlation id, the purpose
  `healthcare-operations` and the route's platform permission. No permission
  is granted to anyone. The identity reviewer role can list but not check,
  approve or reject (it lacks `platform.facility.manage`).

Audit rows written by the database for a platform-scoped call:

| Action | Outcome |
| --- | --- |
| `admin.organization-application.cac-verify` | `success` when verified; `denied` for not verified or incomplete; `failure` otherwise |
| `admin.organization-application.approve` | `success` |
| `admin.organization-application.reject` | `denied` |

They are `actor_type = 'platform'` with facility, membership, organization and
patient empty (0064's platform rules); approve's `details.organizationId`
names the new or reused organization. A facility-scoped call still writes the
old `staff` rows (`identity.organization.application.*`, with its facility,
membership and, for approve, organization). The Identity API's own failure
rows (`api.admin.organization-application*`) are unchanged.

Responses, request bodies, `If-Match` versions and error mapping are
unchanged. 0103 has no down migration; applying the previous bodies (0046,
0056) restores the old behaviour. The suite is
`services/ehr-api/test/database/platform-organization-applications.integration.sql`.

## 32. Records processing: the purpose OCR runs under (0104)

Stage 1 of records processing (owner decisions of D-Eminence in chat,
2026-10-31, numbered 0104 by the owner's decision 33(6) of 2026-11-03; 0104's
declaration is unsigned until the owner signs): a staff
member asks the patient for access to turn the patient's paper records into the
digital record at the facility with OCR, and the patient approves or denies it
as any access request. The purpose of use is `healthcare-operations`, shown to
patients as "Records processing". The OCR API's create, validate, confirm and
retry already require it, and Identity's access-request route already admits
it. Migration 0104 (`0104_records_processing_purpose.sql`) seeds it active,
refuses requests the facility could not use, and lists each patient request's
purpose. Since the owner's decision 34(1) of 2026-11-03 ("the first access
request or the Access PIN also covers bringing in paper records for 24 hours,
said clearly to the patient; under-18s still refused; the patient can still say
no") the patient's approval of a direct-care request, or the Access PIN, also
covers records processing for 24 hours (below). It seeds no grant and changes
no row-level security policy; ocr-api and the role map are unchanged (a
records officer role is Stage 2). Publishing into the chart stays direct care.

- The code: `('healthcare-operations', 'Records processing', active, 'hid')`,
  inserted ON CONFLICT DO NOTHING, as 0085 seeds `emergency` (a row already
  there, active or not, is kept). Its `active` flag is the kill switch (below).
- How a grant comes to exist: the staff member asks with the existing request
  (below), the patient approves it (approval needs no change: 0072 copies the
  purpose onto the grant), and the grant is honoured for that purpose only, for
  that one membership, facility and patient, for at most 24 hours. No grant is
  seeded, and a records-processing grant never satisfies direct care. The other
  way is the cover of decision 34(1), below: a direct-care grant from the
  patient's approval or the Access PIN. A patient share never covers it.

The request is today's staff access request with the purpose header:

```
POST /api/v1/identity/access-requests
X-Purpose-Of-Use: healthcare-operations
{ "hid": "HID-...", "scope": "write_records", "durationMinutes": 1440,
  "reason": "Turn paper records into the digital record at <facility> (OCR)" }
```

`write_records` is what OCR's validate, confirm and retry need (and it covers
create's read); 1440 minutes (24 hours) is the most a request may last (the DTO
and the table's CHECK). The answer is today's 201, `purpose:
"healthcare-operations"`; a pending request of the same scope and purpose is
answered again with `existingRequest: true` and is not checked again.

The trigger `access_requests_records_processing` (BEFORE INSERT on
`identity.access_requests`, rows with this purpose that are not break-glass)
refuses, in this order:

| Status | Code | When | Database |
|---|---|---|---|
| 403 | `RECORDS_PROCESSING_NOT_ALLOWED` | the actor (`app.actor_subject`) does not hold the requesting membership live and active, or that membership's roles lack `ocr.job.write` at the facility (doctors, clinicians, nurses and laboratory staff hold it; pharmacists and receptionists, who may ask for direct care, do not) | 42501 `RECORDS_PROCESSING_NOT_ALLOWED` |
| 400 | `INVALID_CONSENT_COMMAND` | a scope other than `read_records` or `write_records`, or a duration outside 5 to 1440 minutes; `create_access_request` and the DTO refuse both first, so only a direct insert reaches the trigger's | 22023 `RECORDS_PROCESSING_REQUEST_INVALID` |
| 422 | `RECORDS_PROCESSING_MINOR` | the patient is under 18 on today's date in Africa/Lagos (18 from the 18th birthday; born 29 February, from 1 March in a year without one), has a date of birth in the future, or has no date of birth on record (`identity.patients.dob` null); refused until a guardian approval exists | 42501 `RECORDS_PROCESSING_MINOR` |

The permission is checked first, so a caller who may not ask learns nothing
about the patient's age. Each refusal reaches Identity as the error of
`identity.create_access_request` with that SQLSTATE and message (the message
is the code, as `EMERGENCY_PROBATION_LIMIT` is). Identity matches the two 42501
refusals by SQLSTATE and exact message, so any other 42501 stays 403
`CONSENT_COMMAND_DENIED`; an Identity image from before 0104 answers both 403
`CONSENT_COMMAND_DENIED`. While the purpose is not active (a database before
0104, or the kill switch), `create_access_request` answers 22023 `Invalid
purpose for a standard access request`, Identity's 400
`INVALID_CONSENT_COMMAND`. Every other answer is today's (404
`CONSENT_RESOURCE_NOT_FOUND` for an unknown Health ID, 400 for the DTO).
Direct-care, emergency and break-glass requests never fire the trigger.

The patient sees the request in `GET /api/v1/identity/me/access-requests`, whose
items now carry `purpose` (`direct-care` or `healthcare-operations`), from the
twelfth, last column `purpose_of_use` of `identity.list_my_access_requests()`
(never null for a listed row). The function was dropped and recreated with the
same owner and EXECUTE for `hid_identity_runtime` only. Identity selects every
column, so on a database before 0104 `purpose` is left out and the list still
answers; an earlier Identity image names its eleven columns and keeps working
on 0104, without `purpose`. Approval is today's (a sign-in within 10 minutes,
no recovery hold): the grant carries the request's purpose, ends with the
request's duration, and the patient can revoke it from the access history.
Staff read where they stand with today's `POST /api/v1/identity/consent-status`
and `purpose: "healthcare-operations"`.

What the grant opens, by step (permissions unchanged, 0013 and 0016):

| Step | Permission | Purpose and grant |
|---|---|---|
| Ask the patient | `identity.consent.write` and `ocr.job.write` | `healthcare-operations`; no grant |
| Create, read and retry OCR jobs; read extractions and validations | `ocr.job.write`, `ocr.job.read` | `healthcare-operations` grant (read for reads, write for retry) |
| Validate or reject | `ocr.validation.write` | `healthcare-operations` write |
| Confirm the source patient | `ocr.patient.confirm` (doctor, clinician, nurse) | `healthcare-operations` write |
| EHR documents (`/ehr/documents` upload intent, list, complete, download) and OCR's source read (`/ehr/internal/ocr/documents/:documentId/source`) | `ehr.document.*`, `ocr.job.read` | any purpose, the grant of that purpose |
| Publish into the chart | `ocr.publication.write` (doctor, clinician, nurse) | `direct-care` write, the publisher's own; or, for any reading as a draft note, the dedicated records-processing grant (an approved `healthcare-operations` `write_records` request; never the cover: section 42, 0113); otherwise 403 `OCR_PUBLISH_NEEDS_DIRECT_CARE` (section 39) |

Without a records-processing grant or a cover, OCR's create answers 403
`OCR_RECORDS_PROCESSING_CONSENT_REQUIRED` when the request names the patient
(`patientId`): OCR API prechecks that patient with Identity (`read_records`,
`healthcare-operations`, `service/authorization/precheck`) before it reads any
document, so the answer says nothing about whether the document exists. The
precheck notes nothing: the named patient gets no "Your records were opened"
notice and Identity records no allowed read for them. The one authorization
that notes and audits the read stays the check on the document's patient after
the source read. A named patient who has given cover but is not the document's
patient still ends in 409 `OCR_PATIENT_MISMATCH`, or 404 when EHR's source read
does not find the document, with no authorization of anybody. An
`Idempotency-Key` replay is answered before the precheck, as before it: the key
reused for a different request (a different `patientId` included) answers 409
`IDEMPOTENCY_CONFLICT`, and an exact replay is authorized as the existing job,
so after the cover has lapsed it answers 404 `OCR_JOB_NOT_FOUND`. Against an
Identity without the precheck route the source read decides, as before. Without a `patientId`,
create answers 404 (EHR's source read does not find the document under that
purpose, so nobody learns whether it exists), and 403 `OCR_ACCESS_DENIED` when
the source is found but the source patient's check refuses. The other job routes
(read, retry, extractions, validations) answer 404 `OCR_JOB_NOT_FOUND` for every
refusal: they act on an existing job, and a 403 there would reveal that a job
exists for the patient. Each 4xx answer is logged by OCR API and EHR API as one
`Request refused` warning carrying only the problem code, status, method, route
template and correlation id.

### 32.1 The patient's approval or Access PIN covers records processing for 24 hours (decision 34(1))

Since 0108 (section 36) the cover lasts as long as the grant (no 24-hour
bound) and an active patient share covers too; the rules below are 0104's,
with those two changes.

A records-processing check (`healthcare-operations`, `read_records` or
`write_records`) for a patient, staff member (membership) and facility is also
allowed while that membership holds a covering direct-care grant. A grant
covers when all of these hold, and only then:

- It is that membership's, at that facility, for that patient, on that live
  account: the grant every check already names (0012). Another staff member,
  another facility, or the same staff member's membership at another facility,
  is not covered.
- It is direct care (`purpose_of_use = 'direct-care'`), `read_records` or
  `write_records`, not break-glass, active, not held by the cutover, written by
  this branch (`source_system = 'hid'`).
- It came in one of exactly two ways: the patient approved the facility's
  direct-care access request (the request is approved by the patient,
  `approved_by_patient_id`, and neither row carries an authorization method:
  0072's approval), or the patient's Access PIN was used (grant and request
  both `authorization_method = 'patient_access_pin'`: 0075's and 0098's PIN
  command). A patient share (0095), a seeded or imported grant, an emergency
  grant and break-glass never cover it. (0108 D-b: an active patient share
  is a third way, section 36.)
- The check's time is from the grant's `starts_at`, before `least(expires_at,
  starts_at + 24 hours)`: never past the grant's end, and never more than 24
  hours from its start (requests last at most 24 hours and PIN grants at most
  60 minutes today, so today the grant's end comes first; until 0122: since
  0122 a PIN grant is write_records for exactly 24 hours, section 51). (0108 D-a: from
  `starts_at` before `expires_at`, with no 24-hour bound.)
- The patient is 18 or over on that day's Africa/Lagos date and has a date of
  birth on record (the request trigger's rule, at each check, since no request
  is made). The membership's roles hold `ocr.job.write` at the facility, at
  each check (pharmacists and receptionists, who may hold a direct-care grant,
  are not covered).
- Both codes, `healthcare-operations` and `direct-care`, are active (the kill
  switch ends the cover), and no active deny directive of the patient names
  records processing or direct care (or no purpose) for this facility,
  organization, staff member or all, for this action (0012's reading).

Within the cover both `read_records` and `write_records` are allowed for
records processing, also under a PIN grant, which is read only for direct care
(until 0122; since 0122 a PIN grant is write_records for exactly 24 hours,
section 51):
bringing in paper records means creating, validating, confirming and retrying
OCR jobs. Direct care itself is unchanged: the PIN still opens the chart for
reading only (until 0122; since 0122 the PIN opens the chart to read and
write, section 51), and publishing into the chart still needs the publisher's own
direct-care write grant.

The patient can still say no: denying the request (no grant), revoking the
grant from the access history (`POST /identity/me/consent-grants/:id/revoke`),
turning the Access PIN off (`DELETE /identity/me/access-pin`, which ends its
grants) or a deny directive each end the cover at the next check; ending the
direct-care grant ends this too. A separate records-processing request (above)
still works as before and was the way past 24 hours (since 0108 the cover
itself lasts as long as the grant).

Where it lives: `identity.records_processing_direct_care_cover(patient,
subject, membership, facility, action, at_time)` returns `(consent_grant_id,
covered_until)` or no row (sql, STABLE, SECURITY DEFINER, search_path
`pg_catalog, pg_temp`, owned by the table owner, EXECUTE for
`hid_identity_runtime` only). `identity.has_active_consent_grant` keeps 0012's
body and gains one last alternative: the purpose is `healthcare-operations` and
the cover returns a row (its md5 is now `732d11892dd4e27e1ff9093ae3b7de5a`;
later migrations pin that). Every row-level security policy that calls it
(OCR's jobs, EHR's documents and their scans) therefore honours the cover with
no policy change.

What staff and services see: Identity's `POST /identity/authorization/check` and
`POST /identity/consent-status` answer a covered check allowed, with
`consentGrantId` the covering direct-care grant and `expiresAt` the cover's end
(`covered_until`); a records-processing grant of the staff member's own, when
there is one, is named first. Audit is as today: Identity records
`identity.authorization.check` (`success`, purpose `healthcare-operations`,
details naming the covering `consentGrantId`) and OCR records its own job
events; the "Your records were opened" notice (0095) fires as for any grant. An
Identity image from before 0104 answers a covered check as not allowed (its own
lookup wants a records-processing grant), so OCR then answers 403
`ACCESS_DENIED` until the new Identity image serves.

What the patient must be told (website lane, health; this branch does not edit
the website): the owner's words are "said clearly to the patient". Each place
the patient approves a facility's direct-care request or gives the Access PIN
must say, before they agree, that this also lets that staff member bring in
(scan and read) the patient's paper records at that facility for up to 24 hours
(never longer than the access itself), and that they can stop it at any time by
ending the access; and the patient's access history should show the same
grant as also covering records processing until `covered_until`. Exact places
are listed in the release notes for the website lane (approval screen, PIN
screens, access history, the request inbox item and the PIN explainer). Under
18: the patient's approval or PIN still grants direct care as today, but the
words about paper records must not be shown for a patient under 18, who is not
covered.
Since 0108 this paragraph is replaced by "What the patient must be told
(0108)" in section 36: the cover lasts as long as the access (no 24-hour
limit), and the share screens must say it too.

The grant never opens the chart. The services refuse the purpose everywhere
else:

- ehr-api: the encounter routes (encounters, notes, diagnoses, vitals,
  prescriptions, lab requests), the offline routes and the staff chat take
  `direct-care` only, the order routes answer anything else 403
  `PERMISSION_DENIED` and the emergency summary takes `emergency` only, all
  as before. Imported records (`GET /ehr/patients/:patientId/imported-records`),
  an imported attachment (`GET
  /ehr/patients/:patientId/imported-attachments/:fileId/download`), the
  reported health profile (`GET
  /ehr/patients/:patientId/reported-health-profile`) and OCR's clinical-note
  import (`POST /ehr/internal/ocr/patients/:patientId/clinical-notes`) now answer
  `healthcare-operations` 400 `PURPOSE_OF_USE_REQUIRED` ("X-Purpose-Of-Use must
  be direct-care or emergency for the patient record") before any work; direct
  care and emergency answer as before. (Since 0113 the OCR clinical-note import
  takes `healthcare-operations` as a draft in the imported paper records; see
  section 42.)
- lab-api and pharmacy-api: every route takes `direct-care` or `emergency`; a
  `healthcare-operations` purpose answers 400 `PURPOSE_OF_USE_REQUIRED`
  ("X-Purpose-Of-Use must be direct-care or emergency"). No Lab or Pharmacy
  route used it, and OCR's lab and medication imports run at publication under
  direct care.
- The database fence (records-processing rules in `ehr.context_allows` and
  Lab's and Pharmacy's twins) is Stage 2; those functions' bodies are pinned
  by later migrations.

Kill switch: `update identity.purpose_of_use_codes set active = false where
code = 'healthcare-operations';`. New requests (and replays of pending ones)
then answer 400 `INVALID_CONSENT_COMMAND` and every records-processing
authorization is refused (`identity.has_active_consent_grant` requires an
active code, and the cover of 32.1 both active codes), so OCR answers 404
again. A grant approved while the code is off is written but authorizes
nothing; unexpired grants (and covers) work again if the code is reactivated. Who may set it and how it is recorded is an owner decision.

Unchanged: `create_access_request`, `approve_access_request` and every other
function body but `has_active_consent_grant`'s (32.1; their md5 pins stay
true), policy, role, permission and grant; break-glass (emergency only), the
PIN command (direct care, read only (until 0122; since 0122 read and write
for exactly 24 hours, section 51); its grant covers records processing as
32.1 says) and patient shares (direct care, never covering records
processing; since 0108 an active share covers it, section 36). A pending request is
not checked again on approval, so a requester whose role changes afterwards
keeps a request the patient may still approve.

Applying 0104 takes SHARE ROW EXCLUSIVE on `identity.access_requests` until
commit (CREATE TRIGGER), so an access request being written waits a few
milliseconds; reads are not blocked. 0104 has no down migration. Rolling the
service images back leaves the code, the trigger and the twelfth column in
place; earlier images keep working (they read the list by column name), and
the kill switch turns records processing off without a release.

Release order: the website first, which words today's answers (400
`INVALID_CONSENT_COMMAND`: records processing is not switched on yet; no
`purpose` on the patient's requests: no label); then the backend with 0104,
whose release applies 0104 before the images roll out. The service fences do
not depend on 0104. Tests: 0104's database suite
`services/ehr-api/test/database/records-processing.integration.sql`,
Identity's `consent.service.spec.ts`, ehr-api's
`ehr/shared/patient-record-context.spec.ts`, Lab's and Pharmacy's
`common/request-context.spec.ts`, and the runtime verifier
`services/ehr-api/scripts/verify-records-processing-runtime.mjs` (Identity,
EHR, Lab, Pharmacy and OCR booted from their own code as their runtime roles,
run by the TUF migration rehearsal): the request and its refusals, the
patient's approval, OCR's job and EHR's document under the grant, the fences,
the cover of a second patient's direct-care approval and then of the Access PIN
(OCR creates and reads a job; another staff member is not covered; revoking the
grant or turning the PIN off ends it), the kill switch and the revocation.
Identity's `postgres-identity.provider.spec.ts` covers naming the covering
grant. With `HID_RECORDS_PROCESSING_STAGE` it also
runs this branch's services on a database without 0104 (`before-0104`), and an
Identity from before 0104 (`HID_RECORDS_PROCESSING_IDENTITY_DIR`) on a database
with it (`old-identity`) or without it (today's Identity on today's database).
## 33. Document virus scanning: the scanner's account, routes and refusals (0105)

Migration 0105 (`0105_document_scanner.sql`, owner decisions of 2026-10-31,
D-Eminence: D1 GuardDuty, D2 a file it cannot scan is refused, D3 a type
mismatch is accepted under the real type, D4 enforcement only after the
backfill; numbered 0105 by the owner's decision 33 of 2026-11-03; unsigned
until the owner signs) and the EHR API changes beside it are the backend half
of the GuardDuty Malware Protection for S3 scanner (D1). It was built as 0101
on the scan-be branch and is written on 0103: it uses nothing 0104 (records
processing) adds. A bridge Lambda turns each GuardDuty result into a scan
event; Terraform, the bridge and the issuer cap are separate and are not part
of this release. Nothing here turns enforcement on: until the bridge holds a
token, nothing here is reachable, every document stays scan-pending (the
website's "checking for viruses" state) and uploads behave exactly as
today.

### The scanner's identity

- The workload issuer mints `sub` `hid:staging:document-scanner` for the
  bridge's Lambda role in production (the promoted staging stack; the
  application module's environment is `staging`), `aud` `hid-identity-api`,
  ES256, 300 seconds. identity-api's `authenticateScanner` accepts it only while
  that subject is an active `auth.accounts` row holding the platform
  `document_scanner` role.
- 0105 seeds that account (`d0c5ca40-0105-4000-8000-000000000001`, no email,
  no password, `source_system` `hid-workload`) and its role row
  (`d0c5ca40-0105-4000-8000-000000000002`, `document_scanner` grants only
  `ehr.document.scan`). `auth.admin_change_platform_role` refuses this role, so
  the seed bypasses the governed admin command; the owner signs that in the
  declaration. A different row already holding the subject or the ID stops the
  migration with nothing applied.
- Kill switch, no release: revoke the role row (`revoked_at`, `revoked_by`,
  an 8-500 character `revocation_reason`) or set the account's status to
  `disabled`. Every scanner route then answers 401 from Identity.

### Routes (ehr-api, internal load balancer only)

All three are `@Public` to the session guard and authorized exactly alike:
`Authorization: Bearer <workload JWT>` is sent to Identity
(`/api/v1/identity/service/workloads/document-scanner/authorize`) before any
database call; an optional `X-Correlation-Id` matching
`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$` is kept (otherwise a UUID is generated)
and is passed to the database command, which checks it against the
transaction's. Bodies are JSON; unknown fields are refused (400
`VALIDATION_FAILED`). Errors are Problem Details with a `code`.

The public gateway answers 404 for `/api/v1/ehr/documents/scan-events`,
`/scan-targets` and `/scan-targets/resolve` (any case, trailing slash, encoded
or doubled-slash forms) before its EHR proxy.

`POST /api/v1/ehr/documents/scan-targets/resolve` (200)

```json
{ "storageBucket": "hid-staging-documents-...", "storageKey": "clinical/objects/<uuid>", "objectVersionId": "<S3 VersionId>" }
```

`storageBucket` must be the EHR API's own bucket (another answers 404
`DOCUMENT_NOT_FOUND`); `storageKey` must match
`^clinical/objects/<lower-case UUID>$`; `objectVersionId` 1-1024 characters.
Answer:

```json
{ "documentId": "<uuid>", "objectVersionId": "<bound VersionId>", "sha256Hex": "<64 hex>",
  "status": "uploaded", "declaredMediaType": "image/png", "latestEventType": null,
  "sniffResult": "supported", "sniffedMediaType": "image/jpeg" }
```

`latestEventType` is the latest event on the bound version (`scan_started`,
`failed` or null; a terminal one is a refusal). After the database answer the
EHR API reads bytes 0-1023 of exactly that VersionId (a ranged GetObject with
its own S3 and KMS rights) and sets `sniffResult`: `supported` with
`sniffedMediaType` one of `application/pdf` (`%PDF-`), `image/jpeg`
(`FF D8 FF`), `image/png` (`89 50 4E 47 0D 0A 1A 0A`), `image/tiff`
(`49 49 2A 00` or `4D 4D 00 2A`), each at byte 0; `unsupported` (null type)
when the bytes were read and match none (a PDF with anything before `%PDF-` is
unsupported); `unavailable` (null type) when they could not be read (access
denied, version gone, timeout). No patient or facility ID is returned. Audited
as `ehr.document.scan-target.resolve` (and the request as
`api.ehr.document.scan-target.resolve.request`).

`GET /api/v1/ehr/documents/scan-targets?olderThanSeconds=<0-31536000>&limit=<1-100>` (200; both required, decimal digits)

```json
{ "items": [ { "documentId": "<uuid>", "storageBucket": "...", "storageKey": "clinical/objects/<uuid>",
  "objectVersionId": "...", "sha256Hex": "<64 hex>", "declaredMediaType": "application/pdf",
  "updatedAt": "2026-10-31T09:00:00.000Z", "latestEventType": "scan_started", "scanStartedCount": 1,
  "lastScanStartedAt": "2026-10-31T10:00:00.000Z" } ] }
```

Uploaded documents whose row last changed (the upload completion sets it) at
least `olderThanSeconds` ago, with no clean or rejected event on their bound
version and SHA-256, oldest first. Every status other than `uploaded` is left
out (an upload never completed cannot be scanned). Keys outside
`clinical/objects/` are listed as they are; the bridge does not scan them.
Audited as `ehr.document.scan-target.list` naming the documents.

`POST /api/v1/ehr/documents/scan-events` (202 `{ "eventId": "<uuid>" }`) is
unchanged in shape (`documentId`, `objectVersionId`, `objectSha256Hex`,
`eventType` `scan_started|clean|rejected|failed`, `detectedMediaType` required
for clean and one of the four types, `scannerEngine`, `scannerVersion`,
`reasonCode` required for rejected and failed,
`^[A-Za-z0-9][A-Za-z0-9._:-]*$` up to 120, `idempotencyKey`
`^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$`). An identical replay of an
idempotency key answers 202 with the first event's ID.

### Status codes

| Status | `code` | Routes | Meaning |
| --- | --- | --- | --- |
| 401 | `WORKLOAD_AUTHENTICATION_REQUIRED` or Identity's code | all | no bearer token, or Identity refused it (bad signature, issuer or audience, no active scanner account: the kill switch) |
| 403 | Identity's code / `DOCUMENT_SCANNER_FORBIDDEN` | all | Identity refused; or the database found no active scanner for the actor or a mismatched correlation ID (42501) |
| 503 | `IDENTITY_SERVICE_UNAVAILABLE` and others | all | Identity, storage or the scanner database pool unavailable; retry |
| 400 | `VALIDATION_FAILED` / `INVALID_SCAN_REQUEST` | all | the request failed validation, or a database argument check (22023) |
| 404 | `DOCUMENT_NOT_FOUND` | resolve, scan-events | no document holds the object, or no such document (P0002 `Document not found`) |
| 409 | `DOCUMENT_NOT_UPLOADED` | resolve, scan-events | the upload is not completed (55000 `Only an uploaded document can be scanned`); retry later |
| 409 | `DOCUMENT_NOT_SCANNABLE` | resolve | the document is rejected or entered in error (55000 `Document is no longer awaiting a scan`) |
| 409 | `OBJECT_VERSION_MISMATCH` | resolve, scan-events | another version or SHA-256 is bound (55000 `Scan result does not match the current immutable document object`) |
| 409 | `SCAN_ALREADY_TERMINAL` | resolve, scan-events | clean or rejected already recorded for that object (55000 `Document object scan has already reached a terminal result`) |
| 409 | `SCAN_IDEMPOTENCY_CONFLICT` | scan-events | the key was used for another payload (23505 `Scanner idempotency key payload mismatch`) |

Any other database error stays a 500 `INTERNAL_ERROR`.
`services/ehr-api/src/documents/scan-errors.ts` holds the table;
`scan-errors.spec.ts` pins every message against the migration files and
`test/database/document-scanner.integration.sql` against the database.

### What a clean scan under the detected type changes (D3)

When the bridge sends `clean` with `detectedMediaType` the sniffed type, the
document is available under that type everywhere: the list
(`GET /api/v1/ehr/documents`, now read from `ehr.documents_effective`, so only
scans bound to the document's version and SHA-256 count, as for download and
OCR) and every document view show it as `mediaType`; the signed download is
served with `response-content-type` the detected type, `inline` under the
uploaded name with an extension that matches it (a JPEG uploaded as
`scan.png` opens as `scan.jpg`) and `Cache-Control: private, no-store`; the
internal OCR source (`GET /api/v1/ehr/internal/ocr/documents/:id/source`)
gains `mediaType`, the detected type or null; and `ocr.claim_worker_job`
returns the detected type as `media_type`, which the OCR worker uses to pick
its Textract path. The declared type stays on the row and in
`declaredMediaType`.

### The database (0105)

- `ehr.resolve_document_scan_target(text, text, text, text)` and
  `ehr.list_documents_awaiting_scan(integer, integer, text)`: SECURITY DEFINER,
  `search_path pg_catalog, pg_temp`, owned by `ehr.documents`' owner, EXECUTE
  for `hid_document_scanner` only. Each rechecks, as 0009 does, the scanner
  role and that the correlation ID passed is the transaction's
  (`app.correlation_id`). The comparison is IS DISTINCT FROM, so a transaction
  that carries no correlation ID (unset or empty) is refused as well (42501).
- `documents_scanner_function_lock`, a permissive UPDATE policy on
  `ehr.documents` (USING the scanner-role test of 0005's read policy, WITH
  CHECK false): `append_document_scan_event`'s row lock must pass the table's
  UPDATE policies under forced row-level security, so under an owner that does
  not bypass row-level security every append answered `Document not found`
  before 0105. It admits no written row.
- `ocr.claim_worker_job` in the RDS form, its `media_type` the clean scan's
  detected type.

Applying 0105 holds ACCESS EXCLUSIVE on `ehr.documents` from its CREATE POLICY
to commit (milliseconds); a long-running document read makes the apply stop
after its 5 s lock timeout with nothing applied. It holds no lock on
`ocr.jobs` at commit, but compiling the replaced claim briefly needs one, so a
session holding ACCESS EXCLUSIVE on `ocr.jobs` stops it the same way. 0105 has
no down migration. Today's EHR API, OCR worker and Identity keep working on it.

Release order: 0104 (records processing) ships first, in its own release with
its own signed declaration. 0105's declaration names only 0105 and
`runtime-grants.sql`, which is exact for a release whose base already has 0104
(once this branch is rebased onto it, `runtime-grants.sql` carries both blocks
and its hash in the declaration is measured again). 0105's prerequisite is
0103's admin gate body and it reads nothing 0104 adds, so it applies the same
way after 0104 as on 0103 alone.

## 34. The OCR worker's account (0106)

Migration 0106 (`0106_ocr_worker_account.sql`, unsigned until the owner signs)
gives the OCR worker the database identity its commands have always required.
`ocr.claim_worker_job` and the worker's other commands (0014, 0077, 0105) refuse
with 42501 `Authorized OCR workload context is required` unless
`app.actor_subject` is the subject of an active `auth.accounts` row holding the
platform `ocr_worker` role. Before 0106 no such row existed, so every claim in
production was refused and no OCR job was ever claimed.

- 0106 seeds the account `0c4e0106-0106-4000-8000-000000000001` (subject
  `hid:staging:ocr-worker`, display name `OCR worker`, no email, no password,
  `source_system` `hid-workload`) and its role row
  `0c4e0106-0106-4000-8000-000000000002` (platform `ocr_worker`, which grants
  only `ocr.job.process`). `auth.admin_change_platform_role` refuses this role,
  so the seed bypasses the governed admin command, as 0105 does for the
  scanner; the owner signs that in the declaration. A different row already
  holding the subject stops the migration with nothing applied. No function,
  policy or grant changes; `runtime-grants.sql` is unchanged.
- The worker sets `app.actor_subject` from `OCR_WORKER_SUBJECT`
  (`services/ocr-worker/src/repository.ts`) and uses no workload token. Its own
  subject keeps the OCR API's service identity (`hid:staging:ocr-api`) free of
  worker authority and tells the two apart in audit rows. Terraform on `dev`
  must set `OCR_WORKER_SUBJECT = "hid:${local.workload_identity_environment}:ocr-worker"`
  (`infra/terraform/modules/application/workloads.tf`); until then the worker
  keeps answering 42501 exactly as before 0106.
- A claim still takes only a job whose document's latest scan event is clean
  (0105), so claims return no job until the document scanner is live.
- Kill switch, no release: revoke the role row (`revoked_at`, `revoked_by`, an
  8-500 character `revocation_reason`) or set the account's status to
  `disabled`; the next claim answers 42501 again.

`test/database/ocr-worker-account.integration.sql` pins the seed and checks, as
`hid_ocr_worker`, that the seeded subject claims while `hid:staging:ocr-api`, a
random subject, an empty subject, the scanner's subject, a near-miss subject and
the seeded subject with its role revoked or its account disabled are refused
with 42501.

## 35. OCR page allowance (0107)

Owner decision (D-Eminence, 2026-11-02/03, Migrate item 7): 500 pages per
facility per month, Textract and the AI reading counted together; only a
super admin raises it; at 100% reading pauses but review and manual entry keep
working. 0107 is unsigned until the owner signs its declaration. Drafted as
0110 on 0103 and renumbered 0107, the next free number after 0106 (numbers
follow release order). It applies after 0106; it needs `ocr.claim_worker_job`
exactly as 0105 left it (the fair claim copies that body, md5 pinned) and uses
nothing 0104 or 0106 add.

Month: the Africa/Lagos calendar month. `resets_on` is the first day of the
next month; a parked job becomes due at 00:00 Africa/Lagos that day.
`paused` is `pages_used >= pages_limit`; `pages_used` is the sum of the
facility's job counts first recorded this month; `pages_limit` is 500 unless
a super admin set another (1-100000).

Database commands (every one returns `(pages_used integer, pages_limit
integer, resets_on date, paused boolean)` unless noted):

| Command | Caller (role) | Notes |
| --- | --- | --- |
| `ocr.worker_page_allowance(job_id, claim_token)` | OCR worker (`hid_ocr_worker`) | The facility of the job it holds; the same claim checks as `ocr.fail_worker_job` (42501 not a worker, 55000 claim not active). `paused` is false for a job whose pages are already recorded, so a retry is never parked by its own pages. |
| `ocr.record_worker_pages(job_id, claim_token, page_count, correlation_id)` | OCR worker | 1-200 pages (22023 otherwise). Once per job: a replay or a smaller count changes nothing; a larger count is kept. Audit `ocr.worker.pages_recorded` (`details.pages` only) when stored or raised. |
| `ocr.pause_worker_job_for_allowance(job_id, claim_token, correlation_id)` returns `timestamptz` | OCR worker | NULL, changing nothing, unless the allowance is used up and the job's pages are not yet recorded (a limit raised since the read, or a retry); the worker then reads the job. Otherwise the job goes processing -> failed -> queued, `attempt_count` back by one (a pause never uses an attempt), `last_error_code = OCR_PAGE_ALLOWANCE_USED_UP`, `last_error_summary = Reading is paused because this facility has used this month's page allowance`, `next_attempt_at` = the returned resume time. Job events `OcrFailed` and `OcrJobQueued` carry the reason code. Audit `ocr.worker.paused_for_allowance`. Takes the facility's page-limit lock (the transaction advisory lock `ocr.set_facility_page_limit` takes) before it reads the allowance, so a raise above use racing a pause never leaves the job parked: either the pause sees the new limit and answers NULL, or the raise waits and then resumes the job. |
| `ocr.facility_page_allowance(facility_id)` | OCR API (`hid_ocr_runtime`) and Identity API (`hid_identity_runtime`) | A session naming that facility and an active membership there with `ocr.job.read`, or a platform session (no facility, no membership) whose account has `platform.admin.access`; 42501 otherwise; P0002 for an unknown facility. |
| `ocr.set_facility_page_limit(facility_id, pages_limit, reason)` returns `void` | Identity API (`hid_identity_runtime`) | Platform session, `platform.admin.access` and an active platform `platform_super_admin` role (only: a limit is a cost decision; `platform_admin`, support admins and facility staff read the allowance and usage but cannot set it), a correlation id and purpose `healthcare-operations` (42501 otherwise); limit 1-100000 and reason 1-240 characters (22023); P0002 unknown facility. Audit `admin.ocr.page-limit.set` (`actor_type = 'platform'`, resource the facility, details: new and previous limit, use, resumed and skipped jobs). When the new limit is above this month's use, the facility's queued jobs parked with `OCR_PAGE_ALLOWANCE_USED_UP` become due now (same attempt count, next version). |
| `ocr.claim_worker_job_fair(provider, lease_seconds, max_in_flight_per_facility)` returns the row of `ocr.claim_worker_job` (`job_id, facility_id, document_id, patient_id, storage_bucket, storage_key, object_version_id, source_sha256_hex, size_bytes, media_type, provider, attempt_no, max_attempts, claim_token, claim_expires_at, correlation_id`; no row when nothing is claimable) | OCR worker (`hid_ocr_worker`) | The authorization (42501), validation (22023: provider 1-120 characters, lease 30-3600 seconds, cap 1-16), lease recovery, eligibility and result of `ocr.claim_worker_job` as 0105 left it (`media_type` is the detected type of the clean scan bound to the job's source, not the declared type), plus: a facility that already has `max_in_flight_per_facility` jobs `processing` under an unexpired lease (any provider) is skipped, and among the rest the job of the facility with the fewest such jobs is taken first, then `next_attempt_at`, `queued_at`, `id`. `FOR UPDATE SKIP LOCKED`; the candidate's facility is taken with `pg_try_advisory_xact_lock` (never waits) and counted again, so the cap is exact among fair claimers; claims through the unchanged `ocr.claim_worker_job` (an old worker image) are counted but not bounded. Audit `ocr.worker.claim` adds `maxInFlightPerFacility` and `inFlightBefore`. |
| `ocr.record_worker_ai_usage(job_id, claim_token, model, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, correlation_id)` returns `void` | OCR worker | The claim checks of `ocr.fail_worker_job` (42501, 55000). `model` matches `^claude-[a-z0-9-]+$` (at most 100 characters) and every count is a non-NULL number >= 0 (22023). One row per (job, the job's current attempt, model): the totals given replace the stored ones, so a replay changes nothing. Audit `ocr.worker.ai_usage_recorded` (attempt, model and the counts only) when something changed. |
| `ocr.facility_ocr_usage(facility_id, month date)` returns `(model text, requests bigint, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint, pages bigint)` | OCR API (`hid_ocr_runtime`) and Identity API (`hid_identity_runtime`) | The callers and errors of `ocr.facility_page_allowance`. The Africa/Lagos month containing `month` (NULL: this month). One row per Claude model with its summed requests and tokens (`pages` 0), then one row `model = 'textract'` with the month's pages from the page count (requests and tokens 0; present even when 0), ordered by model. |

Nothing else changes: job, extraction, validation, publication and manual
entry paths do not read the allowance. Tables `ocr.facility_page_limits`,
`ocr.page_usage` and `ocr.ai_usage` (key `(job_id, attempt_no, model)`;
facility, Lagos month, requests and the four token counts) hold ids, counts,
dates, the model name and the limit's reason only, have no runtime grant, no
foreign key to `ocr.jobs` (the 7-day deletion of a job's working data,
section 41, never waits on them or removes them) and are read only through these commands.
`ocr.claim_worker_job` keeps the body 0105 gave it. The only change to an existing function
is one more allowed transition in `ocr.validate_job_write`: a queued job whose
`last_error_code` is exactly `OCR_PAGE_ALLOWANCE_USED_UP` may move
`next_attempt_at` earlier, not before now minus one minute (with the next
version and optionally a new correlation id), nothing else; a queued job with
no or another error code, the same or a later time, or any other column
change is refused (23514). 0107 has no down
migration. The suite is
`services/ehr-api/test/database/ocr-page-allowance.integration.sql`.

## 36. Records processing cover: as long as the access, and patient shares (0108)

Owner decisions (D-Eminence, 2026-11-05, about 12:00 UTC, relayed by the
coordinator). At about 12:03 UTC the owner typed "approve 0108" after
reading: D-a no 24 h bound; D-b active patient shares count, view-only
included -- a view-only share can start, read and check a reading but never
publish into the chart, which needs the publisher's own direct-care write;
all other 0104 rules kept. The declaration's `reviewed_by` stays empty until
the owner signs it.
Migration `0108_records_processing_cover_lifetime.sql` replaces the body of
`identity.records_processing_direct_care_cover` (32.1) and nothing else:
signature, result `(consent_grant_id, covered_until)`, owner, SECURITY
DEFINER, STABLE, search_path, ACL (`hid_identity_runtime` EXECUTE only) and
`identity.has_active_consent_grant` (body md5
`732d11892dd4e27e1ff9093ae3b7de5a`) are unchanged; the cover's body md5 is now
`6928763d3b69f0e4b4acf96a6a255736`.

- D-a (lifetime). The owner answered "recommended" to removing the 24-hour
  bound. A covering grant (the patient's approval of a direct-care
  request, or the Access PIN) covers records processing (`read_records` and
  `write_records`) from its `starts_at` until its `expires_at`, and whenever it
  stops being active before that (revoked, PIN turned off, held by the
  cutover, membership or account ended). The 24-hour bound of decision 34(1)
  is gone; `covered_until` is the grant's `expires_at`.
- D-b (shares). The owner's answer: "Yes, shares count (Recommended)", to
  "Should a patient SHARE also let that staff member bring in the patient's
  paper records (OCR)?", option text "Any active access the patient gave
  (approval, Access PIN or share) lets that staff member at that facility
  bring in paper records for as long as the access lasts. Under-18s, deny
  choices and the OCR permission still apply. The share screen will tell
  patients this." An active patient share (0095) covers it too: a grant with
  its `identity.patient_consent_shares` row (same patient and membership),
  direct care, `read_records` or `write_records`, not break-glass, active, not
  held by the cutover, `source_system = 'hid'`, no request, no authorization
  method, granted by the patient. Any share level, `view_only` included
  (`view_only`, `clinical_review`, `clinical_collaboration`), covers
  records-processing read AND write, as a PIN grant does: under
  `healthcare-operations`, creating an OCR job and getting or listing jobs
  are `read_records`; retrying, validating, confirming the patient and
  creating a publication are `write_records`. Publishing a reading into the
  chart still needs the publisher's own direct-care `write_records` grant, so
  a `view_only` or `clinical_review` share can start, read and check a
  reading but never publish it. Direct care is unchanged (a `view_only` or
  `clinical_review` share still reads only). It ends when the patient revokes
  or replaces the share, or at its `expires_at` (24 hours, 7, 30 or 365 days).
  D-b is a separate alternative in the body; without it the sealed demo
  doctor (whose only grant is 0098's seeded share) would get no cover.

Everything else of 32.1 stays: the same membership at the same facility on
the live account; `ocr.job.write` at each check; the patient 18 or over on
the Africa/Lagos date with a date of birth on record; deny directives for
records processing or direct care; break-glass, emergency and seeded or
imported grants (`source_system` not `'hid'`) never cover; both codes active
(kill switch).

Which grants count as seeded or imported: a grant whose `source_system` is not
`'hid'` (imported, or seeded by a migration as a legacy row) never covers. A
grant a migration seeds with `source_system = 'hid'` in the shape of a share
is a share for D-b: 0098's sealed demo share (granted by the demo patient, no
request, no authorization method, with its `patient_consent_shares` row,
`clinical_collaboration`) covers records processing at Demo Hospital under
D-b's rules, the only migration-seeded grant that does.

What the patient must be told (0108; website lane, health; this branch does
not edit the website). This replaces 32.1's paragraph of the same name and
keeps the owner's rule from decision 34(1), "said clearly to the patient":

- D-a: the approval screen, the PIN screens, the request inbox item and the
  PIN explainer must no longer say "for up to 24 hours". They must say that
  approving the access (or giving the PIN) also lets that staff member bring
  in (scan and read) the patient's paper records at that facility for as long
  as the access lasts, and that ending the access stops it.
- D-b: the share screens must say, before
  the patient confirms, that a share at any level, `view_only` included, also
  lets that clinician bring in (scan and read, which creates OCR jobs from) the
  patient's paper records at that facility for the share's whole duration (24
  hours, 7 days, 30 days, or until revoked: up to 365 days), and that
  revoking the share stops it. The places are the share search and its
  confirmation (`POST /identity/me/shares`), the invitation confirmation
  (`POST /identity/me/share-invitations/:invitationId/confirm`) and the
  invitation creation (`POST /identity/me/share-invitations`), whose level and
  duration are chosen then.
- The access history shows each covering grant (approval, PIN or share) as
  also covering records processing until `covered_until`, which is now the
  grant's `expiresAt`.
- Under 18 or with no date of birth: the words about paper records are not
  shown, as in 32.1 (no cover).

Until the website shows these words, a patient who approves an access, gives
the PIN or creates a share is told less than the cover allows (with D-b, a
`view_only` share is not described as allowing paper records to be brought
in). The owner decides D-a and D-b knowing that this disclosure is not yet in
place; the release notes for the website lane list it.

Identity (`postgres-identity.provider.ts`) reads `covered_until` from the
cover and answers it as `expiresAt`, so `POST /identity/authorization/check`
and `POST /identity/consent-status` report the longer cover with no code
change. Applying 0108 takes only ACCESS SHARE
on the tables the cover reads and SHARE UPDATE EXCLUSIVE on the cover itself.
Suite: `services/ehr-api/test/database/records-processing.integration.sql`
(sections 10l-10o, 10r2-10r3, 10s, 10sk, 10za and 10zk change conditions of
the cover one at a time, on a share and on the approval or PIN grant). A
mutant run of the cover body (269 mutants, each one condition made true,
false or negated, or one comparison, literal, time zone or age boundary
changed; each on a fresh 0001-0108 database with the body-md5 case 1g2 set
aside) shows 255 caught by behavioural cases and 14 that no row the tables
allow can tell apart from the body: dropping `at_time is not null` or `dob is
not null` (NULL already fails the comparison that follows), the account's
subject or status test or the account join, the grant's facility test, the
directive membership's facility (all implied by
`auth.membership_has_permission` with the exact-membership foreign key), the
grant's scope test alone or its `break_glass` test alone (a consent_grants
CHECK ties them), the request's patient, membership, facility or purpose
test (the exact-request foreign key), and `coalesce(..., true)` on the
permission (it never answers null). The suite header lists them.

## 37. Support chat Health ID check (0109)

The public support chat (`POST /api/v1/support/chat`, support-api, Lex) never
passes an issued Health ID to Lex (owner decision of 2026-10-31, option (a)
with a server check). The website and the blue EHR's Help also refuse the
shapes they recognise before sending (health #61). The server check catches
what they miss.

### support-api

- Every message is read, after NFKC folding and upper-casing, for anything
  that could be a Health ID: after a `HID` label (`HID-AB2CD3`,
  `hid ab2 cd3`, `HID: AB2-CD3`, `HIDAB2CD3`), a word of 6 to 32 Health ID
  characters on its own, or two or three short parts typed apart with a digit
  among them (`AB2 CD3`). Ordinary words in the Health ID alphabet are
  candidates too.
- Only those candidates (`HID-` and 6 to 32 Health ID characters) go to
  identity-api, never the message. Each issued one is replaced with
  `[Health ID]` (with its label and separators) before the text goes to Lex.
- The answer to the browser is the same shape whether or not anything was
  replaced.
- **Fail closed.** support-api answers `503 SUPPORT_BOT_UNAVAILABLE` (the same
  as a Lex failure) and sends nothing to Lex when any of these happen:
  - `IDENTITY_API_URL` or the workload token is missing (for every message);
  - identity-api does not answer 200 with a valid answer within 2 s;
  - the answer names anything not asked;
  - a message holds more than 200 candidates.
- **Settings:** `IDENTITY_API_URL` (identity-api's internal HTTPS origin),
  `IDENTITY_SERVICE_IDENTITY_MODE` (`jwt`; `local-secret` only outside
  production) and `IDENTITY_SUPPORT_WORKLOAD_TOKEN_FILE`, which the
  `workload-token-agent` sidecar writes. A malformed URL or mode stops the
  service at start-up.
- Nothing about a message, candidate or match is logged.

### identity-api

```text
POST /api/v1/identity/service/support/health-id-matches
x-hid-internal-caller: support-api
x-hid-service-authorization: Bearer <workload JWT, sub = IDENTITY_SUPPORT_CALLER_SUBJECT, aud hid-identity-api>
{ "candidates": ["HID-AB2CD3", "HID-PLEASE"] }          ->  200 { "matches": ["HID-AB2CD3"] }
```

- **Who may call.** support-api's workload alone, with no browser session.
  support-api is not an Identity caller of any other service route, and no
  other caller is accepted here. Without `IDENTITY_SUPPORT_CALLER_SUBJECT` the
  route answers 503.
- **Body.** 1 to 200 candidates, each exactly `^HID-[A-HJ-NP-Z2-9]{6,32}$`,
  and nothing else. Anything else answers 400 `VALIDATION_FAILED` without
  echoing a value.
- **Answer.** The issued ones, each once, `Cache-Control: no-store`. Every
  status counts, because a Health ID stays personal once issued. Nothing else
  about a patient is returned.
- **Logs.** The counts only (`candidates`, `matches`).
- **Gateway.** The public gateway answers 404 for
  `/api/v1/identity/service/support/` and its aliases. support-api calls
  identity-api on the internal load balancer.

### The database (0109)

- `identity.support_health_id_matches(candidates text[]) RETURNS TABLE(health_id text)`:
  plpgsql, STABLE, SECURITY DEFINER, search_path `pg_catalog, pg_temp`.
- It is owned by `identity.patients`' owner, so it reads past that table's
  row-level security. The table must not force it; the migration checks.
- `hid_identity_runtime` alone may execute it.
- Input other than 1 to 200 well-formed candidates raises 22023, so a bad
  request never answers "no match".
- It uses the unique index on `upper(hid_code)`.

### Release order

1. hid-system #210 (Terraform, `dev`): support-api's workload caller,
   sidecar and settings, and identity-api's `IDENTITY_SUPPORT_CALLER_SUBJECT`.
2. identity-api with 0109, then support-api with the check. Until both
   releases and the apply are in, the new support-api answers 503 to every
   message.
3. Only then health #200 and #61.

## 38. Outreach: registering a person into a campaign (0110)

> Since 0118 a registration also takes an optional `area`, answers `area` and `hasScreening`, and
> has a screening (vital signs, tests, medicines given, referral): see §48.

Migration 0110 (`0110_outreach_campaign_registration_lock.sql`; coordinator of
2026-11-04, "0120 first (prove it, then fix)"; first numbered 0120 and
renumbered 0110 on 2026-11-11 so the release list stays contiguous after 0109;
signed by the owner on 2026-11-11) is written on 0105 and uses nothing
0106-0109 add. It applies after 0109 (its marker,
`identity.support_health_id_matches(text[])`, is a precondition): none of
0106-0109 touches an object 0110 reads, pins or replaces.

The gap: every registration into a campaign was refused in production. The
campaign trigger `outreach.validate_registration_campaign_write` (0045,
SECURITY DEFINER) ran as its owner, the migration login, which is neither a
superuser nor BYPASSRLS, and locked the campaign and the registering staff
member's campaign membership (`FOR SHARE OF campaign, member`).
`outreach.campaign_members` forces row-level security and has no UPDATE
policy, and a locking read must also pass the UPDATE policies, so the lock
found no row and the trigger raised 42501 `Exact Outreach campaign membership
is required` for a member of an active campaign; outreach-api answered 500.
Resolving a campaign-linked registration was blocked too: the trigger also
runs on UPDATE, so `linkExisting`'s resolve UPDATE met the same 42501 for a
member. Registrations without a campaign were not affected. CI and the
acceptance runner migrate as a superuser, so their suites did not see it.

The change:

- The trigger's body only (signature, language, volatility, SECURITY DEFINER,
  search_path, owner, ACL and the trigger unchanged): it locks the campaign
  row only and reads the membership in the same query without a lock. Every
  check and message is 0045's: 55000 `Outreach registration campaign
  association cannot be overwritten`, 42501 `Exact Outreach campaign
  membership is required`, and on insert 23514 `Outreach campaign is not
  accepting registrations`.
- The campaign lock still serializes a registration with a status change
  (`updateCampaignStatus` locks the campaign FOR UPDATE and waits for the
  registration). A membership is no longer locked: no API command changes or
  deletes one, and a membership removed while a registration is being
  written orders after it.
- No grant, policy, row-level security or FORCE change. The Outreach runtime
  still has no UPDATE on `outreach.campaign_members`, so it can neither
  update nor lock a membership (42501 `permission denied for table
  campaign_members`).
- outreach-api: `POST` registration (`create()`) answers a refusal that still
  comes from the trigger, after its own check passed, as that check does:
  42501 `Exact Outreach campaign membership is required` is 403
  `OUTREACH_CAMPAIGN_ACCESS_DENIED`, and 23514 `Outreach campaign is not
  accepting registrations` is 409
  `OUTREACH_CAMPAIGN_NOT_ACCEPTING_REGISTRATIONS`. Any other database error is
  unchanged.

Applying 0110 replaces one function body and takes no lock on an application
table to commit. It has no down migration. Today's outreach-api image works
on it unchanged (its registration into a campaign now succeeds; a late
trigger refusal stays a 500 until the new image). Tests:
`services/ehr-api/test/database/outreach-campaign-registration.integration.sql`
runs the trigger under an owner that does not bypass row-level security (on a
superuser-migrated database it lends the function to such a role until the
rollback) and fails on 0105 (a member's registration into a campaign and a
member's resolution of a campaign-linked registration with `linkExisting`'s
UPDATE are refused; a non-member's same UPDATE finds no row on both); it
covers a campaign admin and a member who is not an admin (an enumerator, the
campaign's volunteer), both refused on 0109 and kept with 0110; the
outreach-api service tests cover the 403 and 409.

## 39. Publishing needs direct care: the refusal a records-processing caller sees

The rule is unchanged (0104 D7, 0108 D-b): publishing a reviewed reading into
the chart, EHR, Lab, Pharmacy or `DOCUMENT_ONLY`, needs the publisher's own
direct-care `write_records` grant on the patient. The records-processing
cover (sections 32, 32.1, 36), which lets staff create, read, validate and
confirm OCR jobs, never publishes. Only the answer changes.

`POST /api/v1/ocr/validations/:validationId/publications` (purpose
`direct-care`), for the request and again for each attempt:

1. EHR's source read (`GET /api/v1/ehr/internal/ocr/documents/:documentId/source`,
   EHR's row-level security and Identity read check under the request's
   purpose) does not return the job's source (404 or 403): 404
   `OCR_JOB_NOT_FOUND`, so nothing is revealed. (Before, an EHR 403 on the
   source read was passed through with EHR's own code; it is now the same
   404, which reveals less.)
2. Identity allows `write_records` under `direct-care`, not break-glass: the
   publication proceeds as before.
3. Identity allows it only as break-glass: refused as before, 404
   `OCR_JOB_NOT_FOUND`.
4. Identity refuses it: 403 `OCR_PUBLISH_NEEDS_DIRECT_CARE`, message "Ask a
   clinician with access to this patient to publish it." Nothing is written.

A Migrate staff member working under the cover, with direct-care read access
(an approval, Access PIN or share) but no direct-care write, now sees step 4
instead of the 404 they got before. The cover never publishes; since 0113 the
patient's dedicated records-processing grant publishes an EHR reading as a
draft (section 42), checked between steps 3 and 4.

## 40. Outreach campaigns: their own admins manage them (0111)

> Since 0118 a registration also takes an optional `area`, answers `area` and `hasScreening`, and
> has a screening (vital signs, tests, medicines given, referral): see §48.

Decision (relayed in chat, 2026-11-11, ADR-045 option B): any staff member
allowed to write campaigns (`outreach.campaign.write`) may create one and
becomes its admin. Only that campaign's own admins can open or close it and
add members. Identity authorizes `outreach.campaign.write` from this release
on. Before, it refused it, because any holder could add themselves to any
campaign, read its linked registrations, or close it.

```text
GET  /api/v1/outreach/registration-cases/campaigns/governance          # outreach.campaign.read
GET  /api/v1/outreach/registration-cases/campaigns                     # outreach.campaign.read
POST /api/v1/outreach/registration-cases/campaigns                     # outreach.campaign.write
POST /api/v1/outreach/registration-cases/campaigns/:campaignId/status  # outreach.campaign.write, If-Match, the campaign's admins
GET  /api/v1/outreach/registration-cases/campaigns/:campaignId/members # outreach.campaign.read
GET  /api/v1/outreach/registration-cases/campaigns/:campaignId/staff   # outreach.campaign.read
POST /api/v1/outreach/registration-cases/campaigns/:campaignId/members # outreach.campaign.write, the campaign's admins
```

**governance**
- Answers `{ "rule": "campaign_admins" }`.
- A website asks it to learn that campaign management is served. A backend
  before 0111 answers 404.

**Creating** (`{ name, services, startsAt, endsAt? }`)
- Makes a `planned` campaign, and its creator its first `admin`.
- An `endsAt` not after `startsAt` answers 400
  `OUTREACH_CAMPAIGN_DATES_INVALID`.

**status** (`{ status: planned | active | closed, reason }`)
- `If-Match` must carry the campaign's `rowVersion`.
- A caller who is not one of the campaign's admins gets 403
  `OUTREACH_CAMPAIGN_ADMIN_REQUIRED`, before the version is compared.
- It cannot become `active` before `startsAt` (409
  `OUTREACH_CAMPAIGN_NOT_STARTED`).
- A closed campaign cannot be reopened (409 `OUTREACH_CAMPAIGN_CLOSED`).

**staff**
- Answers `{ yourRole, people: [{ membershipId, name, campaignRole }] }`:
  - to a member of the campaign, its members by name;
  - to its admins, also every active staff membership at the facility that
    could be added (`campaignRole` null).
- A non-member gets `{ "yourRole": null, "people": [] }`.
- `name` is the staff member's full name. Nothing else about a person is
  returned.

**members** (`{ membershipId, role: enumerator | health_worker | admin }`)
- A caller who is not one of the campaign's admins gets 403
  `OUTREACH_CAMPAIGN_ADMIN_REQUIRED`.
- Someone who is not an active staff member at the facility gets 422
  `OUTREACH_STAFF_NOT_AVAILABLE`.
- Someone already in the campaign gets 409
  `OUTREACH_CAMPAIGN_MEMBER_EXISTS`.
- No route removes a member.

**The database (0111)**
- `outreach.validate_campaign_write()` refuses any campaign update by a
  session whose membership is not one of the campaign's admins (42501). A row
  lock fires no trigger, so a member registering a person into the campaign
  (0045's `FOR SHARE`) is unaffected. Where the function's owner does not
  bypass row-level security (RDS), the check reads the members under their
  policies, so it also needs a direct-care session holding
  `outreach.campaign.read`; the campaigns update policy needs one already.
- Restrictive policies on `outreach.campaign_members`:
  - only a campaign's admins insert or delete its members;
  - the creator may seed themself as the first admin of a campaign with no
    member yet.
- `outreach.campaign_staff(uuid)` answers the staff list above. It is
  executable by `hid_outreach_runtime` alone.

**Release order.** Apply 0111 before identity-api ships with
`outreach.campaign.write` accepted. On a database without 0111, that would
reopen the ungoverned writes.

## 41. OCR source deletion after 7 days (0112)

Owner and coordinator decisions of 2026-11-11: (1) at 24 hours (7 days since
Q36, below) after an OCR job finishes, saved or not, the uploaded source file
goes with every S3 version, and so do the Textract text, the AI reading and
the content of the job's working rows; what a person saved or published into the record
(EHR rows, `ehr.ocr_import_provenance`), `ocr.page_usage`, `ocr.ai_usage`, a
deletion audit event and the job ids and status stay. (2) The source scan is
not kept in the chart; published records keep provenance by job id. (3)
Content is removed, rows are not deleted, through one narrow SECURITY DEFINER
purge; the append-only triggers stay. Owner decision Q36 of 2026-11-11
("make it 7days (signed)") made the 24 hours of (1) 7 days: a document is
due 7 days after its latest job finished and overdue 7 days and 2 hours
after.

**When.** A document is due when its status is `uploaded`, `legal_hold` is
false, it has at least one OCR job, every job is finished
(`awaiting_validation`, `validated`, `rejected`, `failed`, `cancelled`), and
the latest finish (`completed_at`; `failed_at` for a failed job; `updated_at`
for a cancelled one) is at least 7 days ago. A publication of its jobs that
could still run (`pending`, `processing`, or `failed` with
`OWNING_SERVICE_UNAVAILABLE` or `REQUEST_IN_PROGRESS` and attempts left)
blocks until 72 hours after the finish and no longer after that (a hard cap);
since 7 days is longer than the cap, it no longer delays deletion (`due_at` is
the finish + greatest(7 days, 72 hours while blocked)). A blocked document is
not due, so it counts neither as due nor as overdue.

**Claim, then S3, then purge.** The OCR worker
(`OCR_SOURCE_DELETION_INTERVAL_SECONDS`, default 900) first claims the
document: under a row lock on it and its jobs the database checks again that
it is due and sets status `source_deleting`. From then the database refuses
(55000) a new OCR job on it, a failed -> queued retry of its jobs, setting
`legal_hold` and any other change to the document; ocr-api answers 410 (see
below). Only after the claim does the worker delete every S3 version and
delete marker whose key is exactly the document's stored `storage_key` and
confirm none remain; then it purges, which requires `source_deleting`. If S3
fails the document stays `source_deleting` and is listed first in the next
round (ocr-worker README, "Source deletion after 7 days"). Claimed
documents go least recently attempted first (`ocr.source_deletion_attempts`:
ids, counts and times, no runtime grant) and take at most half of a batch
while due documents wait. There is no unclaim: a claim that keeps failing
stays for an operator and keeps counting as overdue. A job insert takes the
document row `FOR SHARE` first, so it serializes with a claim in flight and is
refused once the document is `source_deleting`.

Accepted: a publication requested near the 72-hour cap may run its attempt
after the claim or the purge. ocr-api reads the source again for each attempt
and answers 410 `DOCUMENT_SOURCE_DELETED`, recording a terminal failure before
any owning-domain call, so nothing is published; a blanked validation would
fail the candidate check (`OCR_INVALID_CLINICAL_NOTE`) anyway.

**What the purge changes**, once, under a row lock on the document and its
jobs:

| Table | Columns | Value after |
|---|---|---|
| `ehr.documents` | `status`, `original_file_name`, `row_version` | `source_deleted`, `Source page deleted after 7 days`, + 1 (+ 1 more at the claim; no `ehr.record_versions` row for either: the audit rows `ocr.source.deletion_claimed` and the one below record them; earlier record versions keep the original file name) |
| `ocr.extractions` | `raw_text`, `structured_payload` | NULL, `{}` |
| `ocr.validations` | `validated_payload`, `accepted_fields`, `rejected_fields`, `corrections`, `reason` | `{}`, `{}`, `[]`, `[]`, `Content deleted after 7 days` |
| `ocr.patient_confirmations` | `reason`, `evidence_reference` | `Content deleted after 7 days`, NULL |
| `audit.events` | one row `ocr.source.deleted_after_7d` | workload actor, resource the document; details `jobCount`, `objectVersionsDeleted` (summed over the worker's rounds for the document), `extractionsBlanked`, `validationsBlanked`, `confirmationsBlanked`, `alreadyDeleted`, `secondsPastDue` |

Every other column stays (dispositions, target domains, versions, reviewers,
extraction provenance, confidence and content hash), as do `ocr.jobs`,
`ocr.job_events`, `ocr.outbox_events`, `ocr.publications`,
`ehr.ocr_import_provenance`, `ocr.page_usage`, `ocr.ai_usage` and every EHR
record. A purge of a document already `source_deleted` blanks only what still
holds content (a row added after the purge) and writes an audit row only then.

**Triggers.** `ocr.reject_immutable_change()` still refuses (55000) every
DELETE and UPDATE of `ocr.job_events`, `ocr.extractions`, `ocr.validations`,
`ocr.patient_confirmations` and `ehr.ocr_import_provenance`, except an UPDATE
of the middle three that changes only the columns above to exactly the values
above, made by the OCR functions' owner (inside the purge), on a row whose
document is already `source_deleted`. No session setting is consulted. A
`source_deleting` or `source_deleted` document changes only by the two exact
steps the OCR functions' owner makes (the claim from `uploaded` with no legal
hold, nothing else changed; the purge to `source_deleted` with the neutral
file name, nothing else changed), and an insert with either status is refused
(55000). `ocr.validate_job_write` refuses a job insert and any change to
`queued` or `processing` on such a document (0107 let failed -> queued pass
without the document check).

**Worker commands** (`hid_ocr_worker` only; 42501 for a subject without the
`ocr_worker` role):

| Command | Notes |
|---|---|
| `ocr.list_worker_source_deletions(limit 1-500)` returns `(document_id, facility_id, storage_bucket, storage_key, due_seconds)` | `source_deleting` documents first (least recently attempted first, at most half the limit while due documents wait), then oldest due first. 22023 for a bad limit. |
| `ocr.worker_source_deletion_backlog()` returns `(due, overdue)` | Due or claimed now; overdue = those due for more than 2 hours (7 days and 2 hours after the finish), plus `uploaded` documents with a job stuck in `extracted` for more than 24 hours or in `queued` or `processing` for more than 48 hours, not counting a job parked by the page allowance (counted, never deleted). |
| `ocr.claim_worker_source_deletion(document_id, correlation_id 8-128)` returns `(outcome, storage_bucket, storage_key)` | `claimed` (now `source_deleting`; audit `ocr.source.deletion_claimed`), `already_claimed`, `already_deleted` or `not_due` (nothing changed; bucket and key NULL); P0002, 22023. |
| `ocr.purge_worker_source_document(document_id, versions_deleted 0-100000, correlation_id 8-128)` returns `(outcome, extractions, validations, confirmations)` | `deleted`, `already_deleted` or `not_claimed` (not `source_deleting`; nothing changed); P0002 for an unknown document; 22023 for bad input. |

**Services.**
- ehr-api: `GET /api/v1/ehr/documents/:id/download` for a
  `source_deleting` or `source_deleted` document answers 410 `DOCUMENT_SOURCE_DELETED`, detail
  `Source page deleted after 7 days` (after the read check, so a caller
  without access still gets 403). The document list shows status
  `source_deleting` or `source_deleted`. The internal OCR source read
  (`GET /api/v1/ehr/internal/ocr/documents/:documentId/source`) still answers
  the metadata, with that status: ocr-api needs the document's
  patient to authorize reads of the job.
- ocr-api: each item of `GET /api/v1/ocr/jobs/:jobId/extractions` carries
  `contentDeleted` (true when the job's document is `source_deleting` or
  `source_deleted`; then `rawText` is `''`, `structuredPayload` `{}` and the
  reading empty). Creating a job on such a document, and retry, validation,
  patient confirmation and publication of its jobs, answer 410
  `DOCUMENT_SOURCE_DELETED`; a publication already claimed fails terminally
  with that code. `@hid/api-client` parses a `contentDeleted` extraction
  without text and still rejects an empty `rawText` on any other; the EHR app
  shows `Source page deleted after 7 days` instead of the page and `Content
  deleted after 7 days` instead of the review.

Under an owner that neither is a superuser nor bypasses row-level security
(release checklist P8) the worker commands see no document, as every OCR
worker command sees no job. 0112 has no down migration; the declaration is
signed separately. Suite:
`services/ehr-api/test/database/ocr-source-deletion.integration.sql`.

Expected owner attributes (release checklist P8; recorded 2026-11-12 from the
triage of the suites under a migration login that is neither a superuser nor
BYPASSRLS): the owner of the OCR tables and of their SECURITY DEFINER commands
(one role for `ocr.jobs`, `ocr.validations` and `ocr.job_events`) bypasses
row-level security, as every OCR write needs (`ocr.job_events` has no INSERT
policy, so a non-bypass owner refuses every job insert and status change); the
owner of the outreach tables (`outreach.campaign_members`) does not (0110 fixed
the campaign check for that owner). These are expected, not verified; the owner
confirms them on production with this read-only query (also in the sealed QA
tenant migration's pre-sign header):
`select c.oid::regclass, c.relowner::regrole, r.rolsuper, r.rolbypassrls from pg_class c join pg_roles r on r.oid = c.relowner where c.oid in ('ocr.jobs'::regclass, 'ocr.validations'::regclass, 'ocr.job_events'::regclass, 'outreach.campaign_members'::regclass);`.
The suites treat that owner, the
migration login, as not a runtime role whatever its name, and
`ocr-source-deletion` runs the cases that need an owner who sees the source
document only when it does.

## 42. Records processing: publishing a reading as a draft (0113)

Owner decision (D-Eminence, 2026-11-11), verbatim: "Option B: allow drafts,
but only for staff given a dedicated "records processing" permission for that
patient. Never through shares or PINs. The draft stays a draft until a
clinician signs it. This needs database change 0113 and a little more work.
but the staff permission should cover publish to patient profile/health ID".

Dated note, 2026-11-11, amending the owner decisions recorded in 0104 D7 and
0108 D-b (both migrations are applied and unchanged; 0113's header carries the
same note): publishing into the chart still needs the publisher's own
direct-care write grant, and the cover (sections 32.1 and 36: approval, Access
PIN, any share) still never publishes. The one exception: the holder of the
patient's dedicated records-processing grant may publish any reading as a
DRAFT note. "Patient profile/health ID" is read as the patient's record: an EHR
clinical-note reading is published as it is; a Lab, medication or
`DOCUMENT_ONLY` reading becomes a draft note of the same kind in the same
encounter, built from the reviewed fields only (ocr-api
`paperRecordDraftNote`), titled "Lab results", "Medicines" or "Document" (EHR
shows "From a paper record (Migrate): Lab results"). Structured Lab and
Pharmacy records (Lab imported evidence, Pharmacy imported medications) still
need direct care: under the grant they are never written, and the publication's
`targetResourceType` is `clinical-note`. A clinician signs the draft later.

**The database keeps it a draft (0113 D4).** Under `healthcare-operations` the
API is not the only check: `ehr.records_processing_draft_guard()` (BEFORE
INSERT, UPDATE and DELETE on `ehr.encounters`, `ehr.clinical_notes` and
`ehr.clinical_note_revisions`) refuses with 42501
`RECORDS_PROCESSING_DRAFT_ONLY` every update and delete, and every insert but
the "Imported paper records" encounter, a draft note in it and that note's
first revision, for a patient for whom the session's dedicated grant is named.
The draft must be inserted unsigned, at revision 1, with the paper-record note
type and title prefix.

**One route per publication (0113 D5).** `ocr.publications.publication_basis`
(`direct_care` or `records_processing_grant`; NULL before 0113, read as direct
care) is written by the request and never changed. Every execution attempt is
authorized on that basis alone: a Lab or medicine reading requested under the
grant is retried as the same draft note, never as Lab or Pharmacy evidence,
and one requested under direct care is never retried as a draft note (403
`OCR_PUBLISH_NEEDS_DIRECT_CARE` when direct care is gone). The draft note of a
Lab reading writes each date as written on the paper; a document-only reading
too long for a note (100,000 characters) is refused at validation.
A `healthcare-operations` write grant that the check does not name (for
example one imported from legacy identity) writes nothing. Under any other
purpose the guard does nothing.

**The dedicated grant.** `identity.records_processing_write_grant(patient,
subject, membership, facility)` returns its id or NULL (SECURITY DEFINER, for
`hid_ocr_runtime` and `hid_ehr_runtime` only). It is the grant the patient's
approval of a records-processing access request writes (0104 D2-D4, 0072):
purpose `healthcare-operations`, scope `write_records`, active, at most 24
hours, this membership and facility and the live account, `source_system`
`hid`, not break-glass, not held, no authorization method, granted by the
patient; its request approved by the patient, `healthcare-operations`,
`write_records`, 5-1440 minutes. Still refused (0104 D8): a patient under 18 or
with no date of birth (Africa/Lagos), a membership without `ocr.job.write`,
`healthcare-operations` or `direct-care` inactive, a deny directive for writing
under records processing or direct care. Only the session's own subject,
membership and facility may be asked about. A share has no request, a PIN grant
is direct care with an authorization method, and a read-only approval writes a
`read_records` grant, so none of them is ever named.

**OCR API** (`POST /api/v1/ocr/validations/:validationId/publications`, the
request and each attempt):

1. Steps 1-3 of section 39 under `direct-care`, as before (with direct-care
   write, every target publishes as before; a visit named in the reading is
   used; a reading with no visit goes to the imported paper records, still
   `direct-care`).
2. Otherwise the check above is asked about the job's patient (the source's,
   or the confirmed patient's when the source is hidden under direct care). With
   a grant, the source is read again under `healthcare-operations` and must be
   that patient's; then an EHR reading is published as a draft (any other
   target: 403 `OCR_PUBLISH_NEEDS_DIRECT_CARE`). EHR is called under
   `healthcare-operations`, without `encounterId`, with `confirmedBy`.
3. Otherwise 403 `OCR_PUBLISH_NEEDS_DIRECT_CARE` (job readable) or 404
   `OCR_JOB_NOT_FOUND`, as section 39.

The same person may confirm the patient and publish. `ocr.publication.request`,
`.succeed` and `.fail` carry, ids only: `basis` (`records_processing_grant` or
`direct_care`), `grantId` (the dedicated grant), `confirmedBy` and
`publishedBy` (account ids).

**EHR API** (`POST /api/v1/ehr/internal/ocr/patients/:patientId/clinical-notes`):
now also takes `X-Purpose-Of-Use: healthcare-operations`; `encounterId` is
optional; `confirmedBy` (uuid) is optional. Under `healthcare-operations` it
checks the dedicated grant again in its transaction (403
`OCR_PUBLISH_NEEDS_DIRECT_CARE` without it, nothing written; 400
`OCR_DRAFT_ENCOUNTER_NOT_CHOSEN` if a visit is named). Without `encounterId`
(either purpose) the note goes to the patient's one "Imported paper records"
encounter at the facility, found or created by
`ehr.imported_paper_records_encounter(patient)`: `encounter_type` `other`,
`status` `completed`, `started_at` = `ended_at` = creation time,
`chief_complaint` "Imported paper records (Migrate)", the new column
`imported_paper_records` true (unique per patient and facility, a partial unique
index; INSERT ... ON CONFLICT DO NOTHING then SELECT, so concurrent publishers
share one row; the flag cannot be changed after insert). The note is a
`draft`, note type "From a paper record (Migrate)", title "From a paper record
(Migrate): " + the reading's title, with `ehr.ocr_import_provenance` linking
the OCR job, as before. The audit `ehr.note.import-ocr` names `basis`,
`grantId`, `confirmedBy`, `publishedBy` and `importedPaperRecords`. Signing is
unchanged: `PATCH .../encounters/:encounterId/clinical-notes/:noteId` is
`direct-care` only.

**What the patient sees.** The "Imported paper records" encounter is hidden
from every patient-self read until it holds a signed or amended note: the
patient-self row-level security policy on `ehr.encounters`
(`encounters_patient_self_read`, through
`ehr.imported_paper_records_signed`), and the patient record summary
(`GET /api/v1/ehr/me/records`) and patient chat evidence filter it
too. Drafts stay hidden as before. Staff encounter reads carry
`importedPaperRecords: true` so staff screens can label it; the patient's
record summary and chat evidence carry the same field and the title "Imported
paper records (Migrate)".

**Website (not in place).** Migrate's publish step must stop requiring a visit
under records processing and explain that the reading lands as a draft for a
clinician to sign; patient and staff record views should label the encounter
by `importedPaperRecords`.

## 43. Sign-up, setup wizard and registration desk fields (0114)

Migration 0114 (`services/ehr-api/database/migrations/0114_collect_signup_fields.sql`), unsigned.

Owner decisions: "don't remove them instead we need to collect those information" and
"allow trading name, all fields required". Every field below is required **on the website**,
which must always send it. For the release step (43.0) the API accepts a sign-up or desk request
that carries **none** of the new fields, and refuses one that carries only **some** of them
(400 `VALIDATION_FAILED`, with `errors[].field`). A follow-up release makes them required in the
API too. These stay
**not collected** until the document bucket and its virus scanner exist: operating licence,
CAC certificate, proof of address, and the facility logo. Hide them; do not grey them out (D5).
Sending any of them (for example `logo`) is refused as an unknown field.

All existing request validation stays the same: `whitelist` and `forbidNonWhitelisted`, so an
unknown field gets 400 `VALIDATION_FAILED`.

### 43.0. Release order (important)

Today's backend refuses unknown fields (`forbidNonWhitelisted`), so the website cannot send
the new fields before this backend is live. This backend therefore accepts both bodies: the old
one (none of the new fields) and the new one (all of them). A partial set is refused. Release in
three steps:

1. This backend (0114 and Identity). The live website keeps working unchanged.
2. The website that always sends every new field (sign-up, setup wizard, every desk screen).
3. A small follow-up backend release that makes the fields required in the API.

Every screen that posts to `POST /api/v1/identity/nin/resolve` must send the desk fields in
section 43.3 before step 3, including the pharmacy `newHealthId.tsx`, the classic Registration
screen and hid-system `apps/web/src/lib/patientRegistrationApi.ts`.

### 43.1. Shared shape: `FacilityProfile`

This object is used by facility sign-up (`facilityProfile`) and by the setup wizard's save.

| Field | Type | Rule |
|---|---|---|
| `tradingName` | string | Trimmed, 2-200 characters. The name people use. The CAC legal name is kept as QoreID reads it (D1). |
| `ownership` | string | One of `public`, `private`, `faith_based`, `ngo` |
| `careLevel` | string | One of `primary`, `secondary`, `tertiary` |
| `addressLine` | string | Trimmed, 5-300 characters. The site address. It is not shown in the public directory, which keeps the CAC address (D2). |
| `city` | string | Trimmed, 2-100 characters |
| `stateCode` | string | One of the 37 codes in section 43.5 |
| `lga` | string | Trimmed, 2-100 characters. Free text until the official list is loaded (D6). |
| `gpsLatitude` | number | 4 to 14, at most 6 decimal places |
| `gpsLongitude` | number | 2.5 to 15, at most 6 decimal places |
| `phone` | string | E.164 (`+` and 8-15 digits). Spaces, dots, dashes and brackets are ignored. A Nigerian local number (`0` and 10 digits) is read as `+234…`. |
| `email` | string | A valid email, at most 254 characters. It is lower-cased and trimmed. |
| `bedCount` | integer | 0 to 100000 |
| `operatingHours` | string | Trimmed, 2-200 characters, for example `Mon-Sun 24 hours` |
| `emergency24h` | boolean | |
| `departments` | string[] | 1-15 codes, no repeats, from section 43.6. Informational only: it creates no departments (D7). |
| `servicesOffered` | string | Trimmed, 2-2000 characters |
| `smohLicenceNumber` | string | Trimmed, 2-100 characters. The State Ministry of Health licence number. |
| `hasRegistryId` | boolean | |
| `registryId` | string or null | 2-100 characters **exactly when** `hasRegistryId` is true. Must be `null` or left out when it is false. |
| `hasNhiaAccreditation` | boolean | |
| `nhiaAccreditationNumber` | string or null | 2-100 characters **exactly when** `hasNhiaAccreditation` is true. Must be `null` or left out when it is false. |
| `medicalDirectorName` | string | Trimmed, 2-200 characters |
| `medicalDirectorMdcn` | string | It is upper-cased with spaces collapsed, then must match `^[A-Z0-9][A-Z0-9/. -]{1,98}[A-Z0-9]$` (the staff-licence format). Example: `MDCN/12345`. |
| `expectedStaff` | integer | 1 to 100000 |
| `migratingRecords` | boolean | "Will you bring records from an older system?" |
| `needsInteroperability` | boolean | "Do you need to exchange records with other systems?" |

### 43.2. Facility sign-up: `POST /api/v1/identity/provider-enrollments` (start)

The existing body gains three fields, sent together (all or none, see 43.0):

```json
{
  "productCode": "ehr", "organizationType": "hospital", "cacRegistrationNumber": "RC1234567",
  "administratorName": "…", "administratorEmail": "…",
  "turnstileAction": "provider-enrollment", "turnstileToken": "…",

  "administratorRole": "owner",
  "administratorPhone": "+2348098765432",
  "facilityProfile": { …FacilityProfile… }
}
```

| Field | Rule |
|---|---|
| `administratorRole` | One of `owner`, `medical_director`, `administrator`, `other_authorised_representative` |
| `administratorPhone` | Same phone rule as `FacilityProfile.phone`. It is stored encrypted (personal data, D4) and is never returned. |
| `facilityProfile` | The object in section 43.1 |

The response is unchanged. The profile is stored with the emailed code that this request sends.
When the application is activated (self-service activation, or a platform administrator's
approval), the profile sent with the confirmed code is copied to the facility.

New refusal: **400 `FACILITY_PROFILE_INVALID`** ("Check the facility details and try again").
The database refused the profile; this should not happen when the DTO rules above are followed.
**503 `COLLECTED_FIELDS_UNAVAILABLE`** means the server's encryption key is missing. Nothing is
written or charged.

Suggested website mapping: "Role at facility" is `administratorRole` and "Your phone" is
`administratorPhone`. If the role is Medical Director, the website may prefill
`medicalDirectorName`.

### 43.3. Staff patient registration: `POST /api/v1/identity/nin/resolve`

The existing body (`nin`, `firstName`, `lastName`, `dateOfBirth`, `gender?`, `purpose`) gains
these fields, sent together (all or none, see 43.0; `existingHealthId` follows its own rule):

| Field | Type | Rule |
|---|---|---|
| `phone` | string | Same phone rule as in section 43.1 |
| `addressLine` | string | Trimmed, 5-300 characters |
| `city` | string | Trimmed, 2-100 characters |
| `stateCode` | string | One of the 37 codes in section 43.5 |
| `lga` | string | Trimmed, 2-100 characters |
| `hasExistingHealthId` | boolean | "Does the patient already have a Health ID?" (D13) |
| `existingHealthId` | string or null | **Exactly when** `hasExistingHealthId` is true: `HID-` and 6-32 of `A-H J-N P-Z 2-9`. Trimmed and upper-cased before the check, so `hid-abc234` is accepted. Must be `null` or left out when false. |

Not collected: allergies (D11, left to clinical records) and "provisional local identity" (D12, off).
Sending `allergies` is refused as an unknown field.

The phone and address are stored encrypted with the registration case. When the case resolves to
a patient (an existing NIN match, an approved new patient, or a linked existing patient), they
are copied as a **facility-held, unverified** contact at the same moment. They are never used
for sign-in or recovery and are never returned in plain text.

Deletion rule (NDPA): this data is never changed and never deleted, except by **erasure**: the
encrypted phone and address, their key version and the stated Health ID are set to null and the
erasure time and reason are recorded. Erasure happens for every facility's copy when the
patient's account deletion completes (0096), and on an NDPA erasure request, which Health ID
support has run through the database owner (`identity.erase_patient_facility_contacts`). The
same erasure removes the patient's Health ID from any other person's case that stated it (for
example by a typo); that person's own phone and address stay. A case that never became a
patient (rejected, cancelled or never reviewed) is erased by case on an NDPA erasure request
(`identity.erase_registration_case_contact`, run through the database owner). Both erasures
refuse to run, rather than erase nothing, if they are not run as the owner of the contact
tables.

The Idempotency-Key is bound to all of these fields. A retry with a different phone, address or
stated Health ID under the same key is refused (409 `IDEMPOTENCY_KEY_REUSED`).

Stated Health ID (D13). It is a hint only. It never adds a review candidate, never shows
staff a patient they could not otherwise see, and never bypasses the name and date-of-birth
matching (a patient-lookup by Health ID needs the patient's consent; this route does not).
- If the patient it names is already a review candidate (by name and date of birth against the
  verified NIN details), that candidate gains the reason `stated_hid`. Nothing else changes.
- If the NIN matches a patient, the NIN match wins.
- Otherwise it is noted internally as `no_match`. Staff are never told whether the Health ID
  exists.
- link-existing refuses (409 `PATIENT_NOT_A_REVIEW_CANDIDATE`) a candidate whose only reason is
  `stated_hid`.

Response (`RegistrationCaseResult`) gains one field:

```json
{ "caseId": "…", "status": "…", "version": 1, "candidateCount": 1,
  "contactRecorded": true, "patient": { "patientId": "…", "hid": "HID-…" } }
```

`contactRecorded` is false when the request carried no desk fields (43.0) or the contact has
been erased.

The same `contactRecorded` field appears on `GET /api/v1/identity/registration-cases/:id`,
approve-new and link-existing. No phone or address is ever returned.

### 43.4. Setup wizard and facility profile (after activation)

Both routes need a staff session at the `X-Facility-ID` facility with `workforce.manage` (the
facility administrator), plus the usual CSRF header and `X-Purpose-Of-Use: healthcare-operations`.
Only **self-service** facilities can use them. Governed, legacy and sealed demo facilities are
refused.

### `GET /api/v1/identity/facility-profile`

200, with header `ETag: "<version>"`:

```json
{
  "facility": { "id": "uuid", "name": "Name as Health ID has it (CAC)", "reviewState": "pending|reviewed|…" },
  "version": 0,
  "profile": null
}
```

When the facility has a profile, `version` is at least 1 and `profile` is:

```json
{ …every FacilityProfile field…,
  "source": "self_service_signup" | "facility_administrator",
  "submitterRole": "owner" | "medical_director" | "administrator" | "other_authorised_representative" | null,
  "submitterPhoneOnRecord": true,
  "updatedAt": "2026-11-11T10:00:00.000Z",
  "version": 3 }
```

`registryId` and `nhiaAccreditationNumber` are `null` when the matching yes/no is false.
The applicant's phone is never returned; only `submitterPhoneOnRecord` says it was given.

### `POST /api/v1/identity/facility-profile` (save; POST because the API's CORS allows GET and POST only)

Headers:
- `If-Match: "<version>"`: the `version` from the GET. Use `"0"` for a facility with no profile
  yet. `W/"3"`, `"3"` and `3` are all accepted.
- `Idempotency-Key`: 16-128 URL-safe characters (`[A-Za-z0-9][A-Za-z0-9._:-]{15,127}`). Use a
  new key for each save the user makes.

Body: a `FacilityProfile` (section 43.1), with every field required.

200, with header `ETag: "<new version>"`:

```json
{ "facilityId": "uuid", "version": 4, "changedFields": ["phone", "tradingName"], "replayed": false }
```

`changedFields` lists API field names (sorted by their database column names), never values.
A save with no changes answers the same version and `changedFields: []`. Replaying the same key
with the same body answers the first answer with `replayed: true`.

Refusals:

| Status | code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | A field is missing or invalid (DTO) |
| 400 | `FACILITY_PROFILE_INVALID` | The database refused the profile |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | The Idempotency-Key header is missing or malformed |
| 428 | `IF_MATCH_REQUIRED` | If-Match is missing or not a whole number of 0 or more |
| 412 | `VERSION_CONFLICT` | Someone saved first. Reload, then save again. |
| 409 | `IDEMPOTENCY_KEY_REUSED` | The same key was used with a different body |
| 409 | `FACILITY_PROFILE_SEALED` | A sealed demo facility (D9) |
| 403 | `STAFF_MANAGEMENT_NOT_AVAILABLE` | Not a self-service facility. Health ID support keeps its details. |
| 403 | `PERMISSION_DENIED` | Not the facility administrator |
| 503 | `FACILITY_PROFILE_UNAVAILABLE` | Anything else |

The GET uses the same 403 and 503 codes.

The setup wizard and the review step should load from GET, show the real values, and save with
POST. `FacilityProfile.tsx` can show the GET answer.

### 43.5. State codes (ISO 3166-2:NG), as `identity.nigeria_states` holds them

AB Abia, AD Adamawa, AK Akwa Ibom, AN Anambra, BA Bauchi, BY Bayelsa, BE Benue, BO Borno,
CR Cross River, DE Delta, EB Ebonyi, ED Edo, EK Ekiti, EN Enugu, FC Federal Capital Territory,
GO Gombe, IM Imo, JI Jigawa, KD Kaduna, KN Kano, KT Katsina, KE Kebbi, KO Kogi, KW Kwara,
LA Lagos, NA Nasarawa, NI Niger, OG Ogun, ON Ondo, OS Osun, OY Oyo, PL Plateau, RI Rivers,
SO Sokoto, TA Taraba, YO Yobe, ZA Zamfara.

The website's facility list says "FCT". Show "Federal Capital Territory (FCT)" and send `FC`.

### 43.6. Department codes

`general_outpatient`, `emergency`, `inpatient`, `laboratory`, `pharmacy`, `maternity`,
`pediatrics`, `radiology`, `dental`, `physiotherapy`, `dialysis`, `oncology`, `cardiology`,
`icu`, `theatre`.

### 43.7. Not in this backend change

- The admin console's application list does not show the new fields yet. The admin dashboard
  belongs to other agents; ask the coordinator.
- The current-staff-context `facility` object does not include the profile. Use
  `GET /identity/facility-profile`.
- The QoreID state, LGA, city and company email are not captured for pre-fill yet (plan A.5).

## 48. Outreach screening (0118, provisional)

Migration 0118 (`0118_outreach_screening.sql`; owner request of 2026-11-13, for the medical outreach
of 14 November 2026; the number is a placeholder) adds a screening to each outreach registration,
an optional area on the registration, raises the outreach-group notes limit, and accepts a second
organiser terms version. Provisional: the shapes below were agreed with the website team and may
still be adjusted before the migration is signed.

### 48.1. Read a screening

`GET /api/v1/outreach/registration-cases/:caseId/screening` (permission `outreach.registration.read`)

- `200 { "screening": null }` when none was recorded.
- `200 { "screening": Screening }` with header `ETag: "<version>"` otherwise.
- `404 OUTREACH_REGISTRATION_NOT_FOUND` when the session cannot see the registration.
- One audit row per read (`outreach.registration-screening.read`, resource the case id; ids only, no values).

### 48.2. Save a screening (the whole screening, replaced)

`PUT /api/v1/outreach/registration-cases/:caseId/screening` (permission `outreach.registration.write`)

Headers: `Idempotency-Key` (required, 16-128 URL-safe characters). `If-Match: "<version>"` is omitted
for the first save and required once a screening exists (send the version from the last read or save).

Body: every field optional and nullable; an omitted field is saved as `null` (the save replaces the
whole screening, so send every field you want kept). Unknown fields are refused.

| Field | Type | Rule |
|---|---|---|
| `bpSystolic`, `bpDiastolic` | integer | both or neither; systolic 50-300, diastolic 20-200 and lower than systolic (mmHg) |
| `pulseBpm` | integer | 20-250 |
| `temperatureC` | number, 1 decimal | 30.0-45.0 |
| `weightKg` | number, 1 decimal | 0.5-400 |
| `heightCm` | integer | 30-250 |
| `glucoseValue` | number, 1 decimal | 1.0-40.0 in mmol/L, 18-720 in mg/dL; needs `glucoseUnit` and `glucoseTiming` |
| `glucoseUnit` | `'mmol/L'` \| `'mg/dL'` | with a value only |
| `glucoseTiming` | `'fasting'` \| `'random'` | with a value only |
| `malariaRdt` | `'positive'` \| `'negative'` \| `'not_done'` | |
| `hearingLeft`, `hearingRight` | `'pass'` \| `'refer'` \| `'not_done'` | |
| `mainComplaint` | string | up to 200 (trimmed; empty is null) |
| `seenByClinician` | boolean | |
| `clinicianName` | string | up to 100 (name or role) |
| `outcome` | string | up to 500 (outcome or advice) |
| `medicinesGiven` | array of `{ name, dose? }` | up to 10; name 1-100, dose up to 200; null or omitted is `[]` |
| `referred` | boolean | |
| `referredTo` | string | up to 200; only with `referred: true` |

Answers: `201` for the first save, `200` for an update; body `{ "screening": Screening }` and
header `ETag: "<version>"`. The first save is version 1; each update is the next version. A retry with
the same `Idempotency-Key` and the same body answers `200` with the current screening (only the last
save's key is kept); the same key with another body is `409 IDEMPOTENCY_CONFLICT`.

`Screening`: every body field (null when absent; `medicinesGiven` `[]` when none, each item
`{ name, dose: string | null }`) plus `caseId`, `version`, `recordedAt`, `recordedByMembershipId`
(the first recording) and `updatedAt`.

Refusals (problem+json, `code`):

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | wrong type or shape, too long, unknown field or value, more than 10 medicines, more than 1 decimal |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | no or malformed `Idempotency-Key` |
| 404 | `OUTREACH_REGISTRATION_NOT_FOUND` | the registration is not visible to the session |
| 409 | `OUTREACH_SCREENING_EXISTS` | no `If-Match`, but a screening exists (reload it and save over it) |
| 409 | `IDEMPOTENCY_CONFLICT` | the key was used for another body |
| 409 | `OUTREACH_REGISTRATION_REDACTED` | the registration was redacted |
| 412 | `VERSION_CONFLICT` | `If-Match` is not the current version (or no screening exists yet) |
| 422 | `OUTREACH_SCREENING_OUT_OF_RANGE` | a value outside its range; `detail` names it in plain words, e.g. "Check the blood pressure: systolic must be 50–300 mmHg." |
| 422 | `OUTREACH_SCREENING_INCOMPLETE` | one blood pressure number without the other; a glucose value without unit and timing (or a unit or timing without a value); `referredTo` without `referred: true` |
| 428 | `IF_MATCH_REQUIRED` | `If-Match` present but not a positive version |

The service checks ranges and pairs before writing; the database checks them again (its check
violations answer 422 `OUTREACH_SCREENING_OUT_OF_RANGE`). One audit row per save
(`outreach.registration-screening.recorded`, ids only). The API's CORS now allows `PUT` and exposes `ETag`.

### 48.3. Who can see a screening, and redaction

A screening row follows its registration's row-level security: a staff session with
`outreach.registration.read` / `.write` at the registration's facility, and only for a registration
that session can see (a campaign's registrations to its members only, 0045). There is no delete
route. When a registration is redacted (the retention sweep or support), its screening is deleted
in the same transaction and its `area` is cleared.

### 48.4. Registration changes

- `POST /api/v1/outreach/registration-cases` takes an optional `area` (area, town or LGA; up to 100
  characters; trimmed, inner spaces collapsed, empty treated as not given). It is set only at
  registration and never changed.
- `GET /api/v1/outreach/registration-cases/:caseId`, the list, and the create and link answers include
  `area` (`null` if none) and `hasScreening` (whether a screening the session can see exists).
- Outreach-group notes (`operationalNotes`) may be up to 1000 characters (was 280); the refusal is
  still 422 `OUTREACH_NOTES_TOO_LONG`.
- An area the database refuses (its length counted as Postgres does, which can differ from the
  request check for variation selectors) answers 422 `OUTREACH_AREA_INVALID`. NUL characters are
  removed from the area and the screening's text fields.

### 48.5. Organiser terms and the registration notice

- The organiser activation and "Start an outreach group" bodies accept `termsVersion` `'2026-11-01'`
  or `'2026-11-14'` (the live website sends 2026-11-01 until the new terms ship). The availability
  answer (`GET identity/outreach-organisers/availability`) stays `'2026-11-01'` in this release: the
  live website compares it with its own version and would lock sign-up behind a reload screen on a
  mismatch. It moves to `'2026-11-14'` only in a later release, after the website with that text is live.
- The registration notice version is not pinned (only its form is checked), so
  `outreach-notice-2026-11-14` needs no backend change.

### 48.6. Client

`@hid/api-client`'s `OutreachApiClient` has `getRegistrationScreening(caseId, context)` and
`saveRegistrationScreening(caseId, input, expectedVersion | undefined, context, idempotencyKey)`
(types `SaveOutreachRegistrationScreening`, `OutreachRegistrationScreening`), and
`OutreachRegistrationCase` has `area` and `hasScreening` (optional in the client type, as a backend before 0118 omits them).

### 48.x Recording an export (no migration)

`POST /outreach/registration-cases/exports`, permission `outreach.registration.read`,
body `{ "format": "csv" | "pdf" | "docx" | "xlsx", "count": 0-100000, "campaignId"?: uuid }`,
answers 204. The website builds the CSV, PDF, Word or Excel file itself from the
list and case reads and then calls this once per export. It writes one audit row,
`outreach.registration.exported` (resource type `outreach-registration-export`,
the campaign as the resource when given), with `{ format, count, campaignId }` only,
never a registration's contents. A campaign that is not this facility's, or that the
session is not a member of (0045), answers 404 `OUTREACH_CAMPAIGN_NOT_FOUND`; a wrong
body answers 400 `VALIDATION_FAILED`.

### 48.y Paging the registration list (no migration)

`GET /outreach/registration-cases` takes optional query parameters:

- `campaignId` (uuid): only that campaign's registrations;
- `limit` (1-500, default 100): the page size;
- `before` (opaque): the `X-Next-Cursor` header of the previous page.

It answers the same array as before, newest first (`created_at`, then `id`), still only
registrations the session can see (the facility and campaign membership, 0045). When more
rows exist, the response carries `X-Next-Cursor` (exposed to the browser by CORS); pass it as
`before` for the next page, and stop when the header is absent. Without parameters the
answer is exactly as before: the newest 100. A cursor that is not one the API gave answers
400 `OUTREACH_LIST_CURSOR_INVALID`; a bad `limit` or `campaignId` answers 400
`VALIDATION_FAILED`. An export of a large outreach should page through the whole list.

NUL characters are removed from the name, phone, notes, area and guardian name on
registration create (Postgres text cannot hold them); nothing else about those values changes.

## 49. Outreach assisted Health ID (0119, provisional)

Migration 0119 (`0119_outreach_health_id.sql`; owner request of 2026-11-13; the number is a placeholder)
lets a volunteer or organiser at an outreach group create a Health ID for a person they registered, from
the registration's name and sex, once the person proves an email address with a 6-digit
code sent to it. The Health ID holds only the proven email: the registration's phone, typed by the
volunteer and never proven, is not stored on it (it would block the number's real owner from signing
up); the person adds a phone later in the app through the verified contact change. Provisional: the shapes below were agreed with the website team for the outreach of
14 November 2026 and may still be adjusted before the migration is signed. Codes go by email only; SMS
is not live. The registration itself is not changed (it stays `identity_resolution_pending`; 0115's rule G
stands); the link is kept in `identity.outreach_registration_health_ids`.

The account is created with no password (status `pending_reset`) and a verified email. **The person sets
a password later, in the Health ID app, with "Forgot password" by email.** No date of birth is stored.

Both routes: permission `outreach.registration.write`, the same session, Origin and CSRF checks as the
other registration writes, and a required `Idempotency-Key` (16-128 URL-safe characters). Problems are
problem JSON with `code` and a plain-words `detail`. Under-18s, registrations without a visible campaign
membership, and groups that are not outreach groups (or are sealed demo or QA tenants) are refused.

### 49.1. Send the code

`POST /api/v1/outreach/registration-cases/:caseId/health-id/start`

Body: `{ "channel": "email", "email": "ada@example.test" }` or `{ "channel": "sms" }`.

`202 { "channel": "email", "expiresAt": "<ISO>", "destinationHint": "a***@example.test", "resendAfterSeconds": 60 }`

The code works for the OTP lifetime (`OTP_EXPIRY_SECONDS`, default 5 minutes, at most 10) and allows `OTP_MAX_ATTEMPTS`
wrong tries. A new code ends the previous one. At most 3 codes per registration in 24 hours and one per
60 seconds; the volunteer and the email also have rate windows. A retry with the same `Idempotency-Key`
(and the same email) while its code is open and unexpired answers the same `202` without sending another;
once that code has failed delivery or expired, the same key is refused `409 OUTREACH_HEALTH_ID_REQUEST_USED`
(use a new key). Start answers the same for any email: it never checks whether the email already belongs
to a Health ID or any sign-in (so the route cannot probe who is registered); confirm refuses a taken email
only after the person proves it. The email
(subject "Your Health ID code", plain text only) names the outreach group (or "An outreach team"):

> &lt;Group&gt; is creating a Health ID for you. Your code is 123456. It works for 10 minutes. If you are with
> their volunteer now, read this code to them. If you didn't ask for this, ignore this email: no Health ID
> is made without the code. Afterwards, set your password in the Health ID app with 'Forgot password'.

| Status | `code` | When |
|---|---|---|
| 404 | `OUTREACH_REGISTRATION_NOT_FOUND` | not visible to this session |
| 409 | `OUTREACH_REGISTRATION_REDACTED` | the registration's details were removed |
| 409 | `OUTREACH_HEALTH_ID_ALREADY_CREATED` | a Health ID exists for it; the body carries `"healthId": "HID-..."` and the same in `"details": { "healthId": "HID-..." }` |
| 422 | `OUTREACH_HEALTH_ID_UNDER_18` | "Health IDs for under-18s can't be created at outreach yet. A parent or guardian can do it later in the app." |
| 422 | `OUTREACH_HEALTH_ID_PHONE_INVALID` | the registration has a phone that is not a valid number (a phone is optional and is never stored on the Health ID) |
| 422 | `OUTREACH_HEALTH_ID_EMAIL_INVALID` | missing or not an email (max 254) |
| 403 | `OUTREACH_HEALTH_ID_NOT_AVAILABLE` | not an outreach group, or a sealed demo/QA one |
| 423 | `OUTREACH_ORGANISER_SUSPENDED` | the group is paused by Health ID |
| 409 | `OUTREACH_HEALTH_ID_PHONE_TAKEN` | the registration's phone is already on a Health ID (refuses only this registration): "This phone number already has a Health ID. Ask them to sign in with it." |
| 429 | `OUTREACH_HEALTH_ID_TOO_MANY_CODES` | one code, its own words: "Too many codes for this person today. Try again tomorrow." (3 per registration in 24 hours); "Too many codes were sent to this email today. Try again tomorrow, or use another email." (3 per email across registrations); "You have sent too many codes today. Try again tomorrow." (per volunteer: OUTREACH_HEALTH_ID_VOLUNTEER_DAILY_MAX, 1000 a day by default, with a database backstop of 2000); "Wait a minute before sending another code." with `Retry-After: <seconds>` (60-second cooldown); "Too many codes were sent just now. Try again in N minutes." with `Retry-After` (the short per-volunteer window, OUTREACH_HEALTH_ID_VOLUNTEER_WINDOW_MAX, 120 per 15 minutes by default, and the per-email window) |
| 409 | `OUTREACH_HEALTH_ID_REQUEST_USED` | "This request was already used. Start again to send a new code." (retry with a new `Idempotency-Key`) |
| 503 | `OUTREACH_HEALTH_ID_UNAVAILABLE` | `channel: "sms"` ("Codes by SMS aren't available yet. Use the person's email."), or the email could not be sent (that code is ended) |

### 49.2. Confirm the code and create the Health ID

`POST /api/v1/outreach/registration-cases/:caseId/health-id/confirm`

Body: `{ "code": "123456" }`.

`201 { "healthId": "HID-XXXXXX", "registration": <the registration as GET returns it> }`; a replay that
Identity recognises answers `201` too. A retry after the Health ID was created (the code is spent) answers
`409 OUTREACH_HEALTH_ID_ALREADY_CREATED` with `healthId`: treat it as success.

| Status | `code` | When |
|---|---|---|
| 422 | `OUTREACH_HEALTH_ID_CODE_INVALID` | "That code isn't right. Check the email and try again." (also not 6 digits) |
| 422 | `OUTREACH_HEALTH_ID_CODE_EXPIRED` | "That code has expired. Send a new one." (no open code) |
| 429 | `OUTREACH_HEALTH_ID_TOO_MANY_TRIES` | "Too many wrong codes. Send a new one." (the code's 5 tries), or "Too many codes were tried for this email today. Try again tomorrow." (30 confirmations a day per volunteer and email) |
| 409 | `OUTREACH_HEALTH_ID_EMAIL_TAKEN` | "This email is already used by another Health ID or account. Use another email." (after the code is proved; any sign-in with that email, or one created meanwhile) |
| 409 | `OUTREACH_HEALTH_ID_PHONE_TAKEN`, `OUTREACH_REGISTRATION_REDACTED`, `OUTREACH_HEALTH_ID_ALREADY_CREATED` (+ `healthId`) | as in 49.1 |
| 404, 403, 422, 423 | as in 49.1 | |
| 503 | `OUTREACH_HEALTH_ID_UNAVAILABLE` | try again |

### 49.3. Registration reads

`GET /api/v1/outreach/registration-cases/:caseId` and the list add `"healthId": string | null` and
`"healthIdCreatedByOutreach": boolean` (read in the same transaction with
`identity.outreach_registration_health_ids_for`, which answers only registrations the session can see).

### 49.4. Internal (outreach-api to identity-api)

`POST /api/v1/identity/outreach/health-id/start` body `{ caseId, channel, email? }` and
`POST /api/v1/identity/outreach/health-id/confirm` body `{ caseId, code }`, authenticated as
`POST identity/outreach/authorize` is: the Outreach workload identity plus the volunteer's forwarded sign-in
(cookie with Origin and CSRF, or bearer) and `X-Facility-ID`, purpose `direct-care`; they are not
delegated-browser routes, so a forwarded cookie always needs Origin and CSRF. Identity runs 0119's commands
in the volunteer's own session. Answers as 49.1 and 49.2 (`confirm` answers `{ healthId, outcome }`; a
429 carries `retryAfterSeconds`). Identity alone holds the contact keys, the OTP verifier key and the
Health ID generator: the email is stored encrypted with patient sign-up's contact key and key version,
with sign-up's lookup HMAC (no phone is stored; the registration's phone is only checked against existing
Health IDs at start); the database keeps only a
keyed verifier of the code. The patient's assurance is `CONTACT_VERIFIED` with source `hid-public-signup`
(reference `outreach-health-id:<challenge>`), so NIN verification can follow later. The code
email is `POST notification-api /notifications/otp` with purpose `OUTREACH_HEALTH_ID_VERIFY` (email only,
plus `groupName` and `expiresInMinutes`).

## 50. Outreach Health ID with no contact (0120, provisional)

Migration 0120 (`0120_outreach_health_id_unclaimed.sql`; owner request of 2026-11-13; the number is a
placeholder and it releases right after 0119, which it extends) lets a volunteer or organiser create a
Health ID for a person they registered who has **no email** (and possibly no phone), from the
registration's name and sex. Provisional, as §49.

**Release order:** apply 0120 before deploying the services built for it: outreach-api's registration
reads select `created_via`, which a database before 0120 does not answer.

**There is no account.** The Health ID is created with no account, no password and no contact-verified
assurance, so **nobody can sign in to it until the person claims it** (50.4). No date of birth is stored.
Instead the person gets a one-time **claim code** (8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`),
**shown once**, in the answer to the create: **print it on the person's slip** with the Health ID. It is
never shown again, never stored (the database keeps only a keyed HMAC of it), and never logged or audited.

As in §49, the registration itself is not changed: it stays `identity_resolution_pending` (0115's rule G
stands); the link is kept in `identity.outreach_registration_health_ids`, with `created_via: 'unclaimed'`
(0119's are `'email'`).

### 50.1. Create the Health ID with no contact

`POST /api/v1/outreach/registration-cases/:caseId/health-id/create-unverified`

Permission `outreach.registration.write`, the same session, Origin and CSRF checks as the other
registration writes, and a required `Idempotency-Key`. Body: `{}` (no body is also accepted); any field
is refused `400 VALIDATION_FAILED`. Answers `Cache-Control: no-store`. A volunteer may create at most
`OUTREACH_HEALTH_ID_CREATIONS_PER_HOUR` such Health IDs an hour (identity-api configuration, 150 by default; a window per account, counted before the phone is checked); beyond that
`429 OUTREACH_HEALTH_ID_TOO_MANY_CREATIONS` with `Retry-After`.

`201 { "healthId": "HID-XXXXXX", "claimCode": "K7MP2QXW", "claimExpiresAt": "<ISO, 180 days on>", "registration": <the registration as GET returns it> }`

**The claim code is answered once.** A retry, with the same `Idempotency-Key` or another, finds the
Health ID created and answers `409 OUTREACH_HEALTH_ID_ALREADY_CREATED` with `healthId` and never the
claim code. A client must not retry this call by itself (the api-client's `createUnverifiedHealthId` never
does), and must show and print the code from the `201` before anything else. If the `201` was lost (a
timeout), the Health ID exists but its code cannot be shown again; a reissue is not part of 0120. To make
that rare, the services never throw away a code Identity returned: outreach-api waits up to 20 s for
Identity (no retry), reads the registration before asking Identity, and if reading it again afterwards
fails it still answers the `201` with the earlier read (with `healthId` and `healthIdStatus` set); Identity
answers the `201` even if its request-level audit row cannot be written afterwards (the database already
wrote the creation's own audit row in the same transaction).

The guards are 0119's: campaign membership, not redacted, not a sealed demo or QA group, not suspended,
18 or over, one Health ID per registration.

**Where the phone lives.** The registration's phone is unproven, so it is **not** put on the patient: it
is kept (encrypted, with its lookup HMAC and key version) on the Health ID's claim row,
`identity.outreach_health_id_claims`. Public sign-up and 0119 never see these unclaimed phones, so the
number's real owner can still sign up with it; 0120 reads them only to flag a duplicate (below). `OUTREACH_HEALTH_ID_PHONE_TAKEN` is answered only when
the phone (in any stored form) is on a **real patient**. When it is already on another unclaimed Health
ID's live claim (not expired, not out of attempts, not invalidated), the new one is still created and
flagged `possible_duplicate`. With no phone there is nothing
to check a duplicate person against: when an active patient has the same name and sex, the Health ID is
still created and flagged `possible_duplicate`. Flags are for review later (50.4); nothing is refused on
them. The claim's phone is removed when the registration is redacted, and once the claim can no longer be
used (expired, out of attempts or invalidated) by `identity.outreach_health_id_scrub_claims`, which each
creation and 0116's daily retention sweep run (in batches, so up to a day later); the scrub also catches
a redaction that ran while the claim was still being created. The Health ID and its claim code stay.

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | the body has a field |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | no valid `Idempotency-Key` |
| 404 | `OUTREACH_REGISTRATION_NOT_FOUND` | not visible to this session |
| 409 | `OUTREACH_REGISTRATION_REDACTED` | the registration's details were removed |
| 409 | `OUTREACH_HEALTH_ID_ALREADY_CREATED` | a Health ID exists for it (also a retry of this call); the body carries `"healthId": "HID-..."` only |
| 409 | `OUTREACH_HEALTH_ID_PHONE_TAKEN` | the phone is on a real patient: "This phone number already has a Health ID. Ask them to sign in with it." |
| 422 | `OUTREACH_HEALTH_ID_UNDER_18` | as in 49.1 |
| 422 | `OUTREACH_HEALTH_ID_PHONE_INVALID` | the registration has a phone that is not a valid number |
| 422 | `OUTREACH_HEALTH_ID_NAME_INVALID` | the registration's name has nothing printable: "The person's name on this registration can't be used for a Health ID. Check the name and register them again." |
| 429 | `OUTREACH_HEALTH_ID_TOO_MANY_CREATIONS` | "Too many Health IDs created in a short time. Try again in *N* minutes." (*N* from the real wait; refused tries count, so it can be most of the hour); `Retry-After` |
| 403 | `OUTREACH_HEALTH_ID_NOT_AVAILABLE` | not an outreach group, or a sealed demo/QA one |
| 423 | `OUTREACH_ORGANISER_SUSPENDED` | the group is paused by Health ID |
| 503 | `OUTREACH_HEALTH_ID_UNAVAILABLE` | "The Health ID couldn't be created right now. Try again in a few minutes." |

### 50.2. Registration reads

`GET /api/v1/outreach/registration-cases/:caseId` and the list add, beside `healthId` and
`healthIdCreatedByOutreach`, `"healthIdStatus": "verified" | "unclaimed" | null`: `verified` for a Health
ID created after the person proved an email (§49), `unclaimed` for one created here, `null` when none was
created. It says how the Health ID was created (`created_via`); the claim flow (50.4) will decide whether a
claimed one reads differently. Read, as before, with
`identity.outreach_registration_health_ids_for`, which now also answers `created_via`.

### 50.3. Internal (outreach-api to identity-api) and the counts

`POST /api/v1/identity/outreach/health-id/create-unclaimed` body `{ caseId }`, authenticated as 49.4's
routes (the Outreach workload plus the volunteer's forwarded sign-in; not a delegated-browser route), in
the volunteer's own session; no `Idempotency-Key`. `201 { healthId, claimCode, claimExpiresAt }`
(`Cache-Control: no-store`); refusals as 50.1. Identity generates the Health ID (another is drawn on a
clash) and the claim code (`crypto.randomInt`), and stores `HMAC-SHA256`, keyed with the key of 0119's
code verifier, the OTP key (no new secret), of `outreach-claim-code` US `v1` US *Health ID* US *code*
(both uppercased; US is U+001F), so it is labelled like every other use of that key and bound to the
Health ID; `code_key_version` is `claim-v1` and `hmac_key_version` the OTP key version. The browser
(`OutreachApiClient.createUnverifiedHealthId`) waits 45 s, longer than outreach-api's 20 s wait for
Identity, so it does not give up while the claim code can still arrive. A phone is encrypted as 0119's confirm does it (sign-up's contact key and key
version, its lookup HMAC; the ciphertext is bound to that lookup HMAC) and kept on the claim row (50.1).
A 429 carries `retryAfterSeconds`. The database writes one audit row,
`outreach.health-id.created-unclaimed`, with ids and flags only (`channel: none`, `phoneOnRecord`). The
duplicate flag is not audited: facility audit readers see `details`, and it would tell them the phone or
name is on another group's record; it is kept on the Health ID record, which only the platform reads.

**The claim key.** Each claim row stores the OTP key version it was keyed with (`hmac_key_version`,
`OTP_HMAC_KEY_VERSION` at creation), and the claim flow verifies with that version's key. An OTP key
version must not be retired while unclaimed claim codes created under it are still valid (180 days). In
non-production without `OTP_HMAC_KEY_B64`, the process-local key changes on restart, which invalidates
claim codes made there.

**Counts for the platform admin.** `GET /api/v1/admin/overview` (permission `platform.admin.access`) adds
`outreachHealthIds: { createdAtOutreach, createdWithEmail, createdUnclaimed, unclaimedNotYetClaimed,
possibleDuplicates }` (numbers; counts only, from `identity.outreach_health_id_counts()`, which itself
refuses `42501 PLATFORM_ADMIN_REQUIRED` unless the session account holds `platform.admin.access`), or
`null` on a database before 0120.

### 50.4. Later, after the campaign (not built in 0120)

- **The claim.** The person enters their Health ID, the claim code from the slip and their own email,
  proves the email with a code sent to it, and **the account is created then**, bound to that Health ID.
  A claim code works for **180 days** and allows **5** wrong tries; after either it is spent. Until it is
  claimed nobody can sign in. The phone kept on the claim row is moved onto the patient then, **only if
  it is still free** (no real patient has it by then).
- **Possible duplicates** (a phone already on another unclaimed Health ID's live claim; or no phone and an
  active patient with the same name and sex) are flagged
  `possible_duplicate` and counted (`possibleDuplicates`) for review later; nothing is merged or refused
  automatically.

## 44. Allergies and the allergy check at prescribing (0117)

Two sources, always kept apart and labelled on screens:

- **Recorded** (`ehr.recorded_allergies`, 0117): what a clinician recorded at a facility.
- **Reported by the patient** (`ehr.patient_reported_health_profiles.allergies`, 0094): free text the patient typed.

All routes are direct care only (`X-Purpose-Of-Use: direct-care`), go through `ClinicalRepository.run` (Identity's
authorization, then forced RLS) and are audited by action, resource and counts, never by substance, reaction or
reason text.

| Route | Permission | Answer |
| --- | --- | --- |
| `GET ehr/patients/:patientId/allergies[?includeEnteredInError=true]` | `ehr.note.read` | `{ recorded: RecordedAllergy[], patientReported: { allergies: string \| null, updatedAt } }` |
| `POST ehr/patients/:patientId/allergies` (`Idempotency-Key`) | `ehr.note.write` | 201 `RecordedAllergy` |
| `POST ehr/patients/:patientId/allergies/:allergyId/entered-in-error` | `ehr.note.write` | 200 `RecordedAllergy` |
| `POST ehr/patients/:patientId/allergy-check` | `ehr.prescription.write` | `{ matches: AllergyMatch[], acknowledgementRequired, warningToken }` |

`RecordedAllergy`: `id, patientId, facilityId, createdBy, createdByMembershipId, substance, reaction, severity
(mild | moderate | severe | unknown), status (active | entered_in_error), enteredInErrorBy, enteredInErrorAt,
enteredInErrorReason, rowVersion, createdAt, updatedAt, recordedHere`. Recorded allergies follow the patient: a
clinician with read access at any facility sees those recorded at every facility; only the recording facility
(`recordedHere: true`) may mark one entered in error (else 409 `ALLERGY_RECORDED_ELSEWHERE`, decided from a plain
read before the row is locked, because under forced RLS a locking read at another facility sees no row).

Create body: `{ substance (1-200, one line), reaction? (1-500, one line), severity }`. "NKDA", "No known allergies",
"none" and the like are refused with 400 `ALLERGY_NOT_A_SUBSTANCE` (they are not an allergy). The list answers active
allergies first, the most serious first (severe, not known, moderate, mild), then newest first.
Entered in error body: `{ expectedRowVersion, reason (3-500) }`; 412 `VERSION_CONFLICT`, 409
`ALLERGY_ALREADY_ENTERED_IN_ERROR`. Nothing is ever deleted.

**The check.** `AllergyMatch`: `source (recorded | patient_reported), allergyId? (recorded only; the first when
grouped), allergyIds? (recorded only: every recorded allergy the line stands for), substance, reaction, severity,
matchKind (same_medicine | same_class | cross_reactivity), className?, recordedHere? and recordedOn? (recorded only:
whether it was recorded at the current facility, and when), message`. The message is plain English: the allergy with
its severity and reaction ("Penicillin allergy: SEVERE (Anaphylaxis)." or "Patient-reported allergy: “…”."), why
it matched, then where it came from ("Recorded by a clinician at this facility on 3 Mar 2026.", "… at another
facility …", or "Entered by the patient in their Health ID portal, not checked by a clinician."). The same substance,
severity and reaction recorded more than once is one line with every id in `allergyIds` ("recorded at 2
facilities"). The medicine's display text and code are compared with each allergy (the patient's text is split into
terms on commas, semicolons, slashes, new lines and "and"; "none", "nil", "NKDA" and the like are ignored; a hyphen
separates words, so "Amoxicillin-clavulanate" names amoxicillin; "sulph" is read as "sulf"; brand and other names are
read as their generics, both ways, e.g. Flagyl as metronidazole, Augmentin as amoxicillin with clavulanic acid, Keflex
as cefalexin, Tramal as tramadol, Ciprotab as ciprofloxacin, Panadol as paracetamol and co-codamol as codeine with
paracetamol, and acetaminophen and paracetamol (or cefalexin and cephalexin) as one medicine; one-letter
misspellings and plurals of names of 8 letters or more match; salts, forms and strengths such as "sodium",
"sulfate", "capsules" or "500mg" do not name a medicine on their own): the same medicine; the same class
(`className`: "penicillins", "cephalosporins", "carbapenems", "sulfonamides (“sulfa” medicines)", "NSAIDs, the
anti-inflammatory painkillers", "fluoroquinolones" (also named "quinolones"; any "-floxacin") or "macrolides" (any
"-thromycin"); by class words, members, prefixes and name patterns; quinine, chloroquine and the other quinolines are
not quinolones); and cross-reactivity between penicillins, cephalosporins and carbapenems, both ways, and between
ceftazidime and aztreonam (`className` is then the medicine's name). No match never means "safe".

`warningToken` names exactly the warning shown: the sha256 (hex) of the medicine (its normalized display text and
code) and every matched allergy with how it matched. The prescriber's acknowledgement must carry it.

**At prescribing, at the send and at the hand-off.** The check runs, inside the transaction that writes the
prescription (or the route, or the hand-off's eligibility audit) and under a per-patient lock shared with recording an
allergy, whenever a prescription is written as or becomes active, and again before it goes to a pharmacy, because an
allergy may have been recorded since it became active:

- `POST ehr/patients/:patientId/encounters/:encounterId/prescriptions` (create);
- `PATCH …/prescriptions/:id` with `status: active` from draft (Activate) or on hold (Resume);
- `POST …/prescriptions/:id/order-routes` (send to another facility) of a draft, which the send makes active, or of
  an active prescription: every status `ehr.send_order_route` accepts (0098: draft and active). A prescription in any
  other status is not checked, so the send's own 409 `ORDER_ROUTE_ORDER_NOT_ELIGIBLE` (or its 404) answers;
- `POST …/prescriptions/:id/pharmacy-work-item` (the hand-off to this facility's pharmacy, permission
  `pharmacy.work-item.accept`), after its own checks, which answer first: 412 `PRESCRIPTION_VERSION_CONFLICT`, 409
  `PRESCRIPTION_NOT_ELIGIBLE` (not active) and 409 `PRESCRIPTION_ROUTED`. Its 409 answers before pharmacy-api is
  called, so nothing is written in the EHR or in Pharmacy.

The check reads the allergies under forced RLS, which needs `read_records`, so when the facility may write but not
read the patient's records (a deny directive of the patient's naming only `read_records`) it refuses with 403
`CONSENT_REQUIRED`, as a missing consent is refused everywhere else, before it reads or writes anything (the send asks
before it reads the prescription), so a prescription is never written, activated, resumed, sent or handed on unchecked.

On Activate, Resume, send and hand-off, a match already covered by an acknowledgement stored for the prescription (at
any stage: its recorded allergy ids, and each of the patient's own terms) needs no new one. Otherwise, with a match and
no accepted `allergyAcknowledgement`, nothing is written and the answer is 409 `ALLERGY_ACKNOWLEDGEMENT_REQUIRED` with,
in `errors[]`:

- one entry per match: `{ field: "allergyAcknowledgement", messages: [the match's message] }`;
- one entry `{ field: "allergyAcknowledgement.warningToken", messages: [the current warning's token] }`;
- one entry per part of the acknowledgement that failed: `{ field: "allergyAcknowledgement.rejected", code,
  messages: [a plain-English sentence] }`. A reason and a token can both fail (two entries).

| `code` | When | What the client does |
| --- | --- | --- |
| `ALLERGY_ACKNOWLEDGEMENT_MISSING` | no `allergyAcknowledgement` was sent (the first warning) | show the warning, ask for a reason |
| `ALLERGY_ACKNOWLEDGEMENT_REASON_MISSING` | `reason` absent, or only spaces | ask for a reason; the token was fine unless a token entry is also present |
| `ALLERGY_ACKNOWLEDGEMENT_REASON_INVALID` | `reason` under 10 or over 500 characters after trimming, no word of three letters, or a control character other than a new line | keep the warning, ask to fix the reason |
| `ALLERGY_WARNING_TOKEN_INVALID` | `warningToken` absent or not 64 lower-case hex | run the check again (or use the token in this 409) |
| `ALLERGY_WARNING_TOKEN_STALE` | a well-formed token of another warning (an allergy recorded meanwhile, another medicine, or the patient's text changed) | show the new warning, clear the tick, send the token from this 409 |

The `detail` is "The allergy warning changed since it was shown. Check the allergies again and give a reason to go
ahead." when the token is stale; "The reason to go ahead after the allergy warning was not accepted. …" for a reason
or token problem otherwise; and "This medicine may match an allergy on the patient's record. …" when none was sent. A
client reads `errors[].code` on the `allergyAcknowledgement.rejected` entries, not the detail. The create, PATCH,
send and hand-off bodies take `allergyAcknowledgement: { reason, warningToken }`, an object; the request validation
only refuses (400) a non-object, a non-string or null `reason` or `warningToken`, a `reason` over 2000 or a
`warningToken` over 200 characters, or another property. The reason's rules (10-500 after trimming, at least one word
of three letters, no control character but new lines) and the token are checked by the allergy check, so their
refusals are the 409 above with the current warning, never a 400. A valid acknowledgement writes the prescription (or
the change, or the route, or lets the hand-off go on) and one `ehr.prescription_allergy_acknowledgements` row with
its stage (`create | activate | resume | send | handoff`), the reason, the matched recorded allergy ids and the
patient's own terms that matched. The audit of that create, update, send or hand-off
(`ehr.prescription.pharmacy-handoff.eligibility-checked`) adds `allergyOverride: true, matchedRecordedCount,
patientReportedMatched` (counts and a flag, never the substance or the reason). The hand-off stores its row in the
EHR transaction that ends before pharmacy-api is called, as it does its audit row, so a refusal by Pharmacy after
that keeps the row, and a retry finds the match covered. A send's replay (the same key and body) is checked like the
first send: it answers the stored route unless an allergy recorded since matches and no stored reason covers it, and
then the 409; a reason given on a replay is not stored, since the route was already sent. An acknowledgement sent
when nothing needs one is ignored, whatever it holds. A client must only send `allergyAcknowledgement` after a
warning: an ehr-api without 0117 refuses the unknown property (on the hand-off body, so does an ehr-api from before
the hand-off check).

**The stored acknowledgements on the prescription reads.** `GET …/encounters/:encounterId/prescriptions/:id` and each
item of `GET …/encounters/:encounterId/prescriptions` carry `allergyAcknowledgements:
PrescriptionAllergyAcknowledgement[]` (oldest first; `[]` when none), so a second clinician activating, resuming,
sending or handing it off sees the earlier reason. `PrescriptionAllergyAcknowledgement`: `id, stage (create |
activate | resume | send | handoff), reason, createdBy (account id), createdByMembershipId, createdAt,
matchedRecordedAllergyIds (uuid[]: the recorded allergies it covered; `GET …/allergies?includeEnteredInError=true`
names them), patientReportedMatched, patientReportedTerms (string[]: the patient's own terms it covered,
normalized)`. Same permission (`ehr.prescription.read`), authorization and RLS as before (acknowledgements are read
at their own facility with read access); the read's audit adds `allergyAcknowledgementCount` (the list: the page's
total), never the reason.

**Severity in the messages.** `severe` reads "SEVERE", `moderate` "moderate", `mild` "mild" and `unknown` "severity
not known" (the clinician's choice "Not known" in the form): "Latex allergy: severity not known."

**In the emergency read (0117).** `GET /api/v1/ehr/patients/:patientId/emergency-records` (purpose `emergency`, a
current break-glass grant, as before) also answers `allergies`, read-only and labelled by source:

```text
allergies: {
  recorded: [{ source: "recorded", id, substance, reaction | null, severity (mild | moderate | severe | unknown),
               recordedHere, recordedOn }],          // active only, every facility, most serious first, at most 200
  patientReported: { source: "patient_reported", allergies: string | null, updatedAt | null }
}
```

`recordedHere` is whether it was recorded at the current facility; `recordedOn` when. No route changes an allergy
under the emergency purpose. RLS needs no new policy: 0117's and 0094's read policies
(`ehr.imported_record_read_context`) go through `ehr.context_allows` at the current facility, which admits the
reasoned break-glass grant for `read_records` under purpose `emergency` (and only that action). The audit
(`ehr.emergency.records.read`) adds `recordedAllergyCount` and `patientReportedAllergies` (a flag), never the
substance, reaction or text.

Retention of the codes (0119): a code keeps the email's ciphertext only until it is used (the patient
then holds the email) and its lookup HMAC until 24 hours after it expired (for the per-email daily
cap); then both are removed (by start, confirmation and 0116's daily retention sweep). When a
registration is redacted, all its codes lose their email at once. 0116's sweep no longer redacts a
registration that has a Health ID created at the outreach (it was linked); support can still redact it.
The code email never names a group whose name carries a link or a domain ("An outreach team" instead).
outreach-api waits up to 20 seconds for Identity on start and confirm (start sends the email).


## 51. Access PIN: 24 hours, read and write (0122)

Owner decision (10 Nov 2026, relayed by Ola, clinical owner): a patient's
Access PIN gives the staff member who enters it read AND write access to all
of that patient's records for exactly 24 hours (1440 minutes), whatever
duration is asked, for the same staff roles as today, with no separate "Ask
for more access". 0122 is unsigned until the owner signs its declaration
(`reviewed_by` stays empty). Written as 0121 (hid-system#208), renumbered
0120 by the release order on 2026-11-11, and renumbered 0122 on 2026-11-17
on staging 91e9fb0a, where 0001-0121 are applied (0120 and 0121 are the
outreach migrations, section 50 and its read-once follow-up, live in
production). It requires 0001-0121 applied.

Route, unchanged in shape: `POST /identity/standard-access/pin`
(permission `identity.patient-access-pin.verify`, purpose `direct-care`), body
`{ hid, pin, durationMinutes? }`, answer
`{ accessRequestId, consentGrantId, patientId, status, expiresAt, existingGrant }`.

| | Before | From 0122 |
|---|---|---|
| `durationMinutes` accepted | 5 to 60 | 5 to 1440 (still checked; outside it, or missing in the database call, is refused as before) |
| `durationMinutes` left out | 15 | 1440 (24 hours) |
| How long the grant lasts | the minutes asked | exactly 1440 minutes (24 hours), whatever duration is asked; the access request's `requested_duration_minutes`, the audit's `duration_minutes` and `expiresAt` say so. A reused grant keeps its own 24-hour expiry and its replay audit says 1440 |
| Grant and request scope | `read_records` | `write_records` (also lets the holder read) |
| A still-valid PIN grant is reused (`existingGrant: true`) | if `read_records` | if `write_records`; an older read grant is not reused, a new write grant is made and the read one runs out by itself |
| A patient's deny directive stops the PIN | if it covers reading | if it covers reading or writing (or every action) |
| Audit `identity.patient-access-pin.verify` / `.replay` details | `access_request_id`, `duration_minutes`, `expires_at`, `existing_grant`, `review_required` | the same plus `scope` |
| `PatientAccessPinVerified` payload | `{ consentGrantId, reviewRequired }` | `{ consentGrantId, reviewRequired, scope }` |

Database: `access_requests_pin_scope_ck` and `consent_grants_pin_scope_ck`
allow `read_records` or `write_records` for a PIN row (still direct care,
never break-glass); `identity_outbox_minimum_necessary` accepts the PIN notice
with or without `scope` (`read_records` or `write_records`); the insert policy
`identity_outbox_patient_access_pin_insert` admits a PIN grant of either scope
and requires the payload's `scope`, when present, to be the grant's.
`identity.access_patient_with_pin` body md5 is now
`e17925c512f5f3e9fc79d84faded6ea1` (0098's was
`830c1baa4bca3df57cc02b7b002a8831`; the two comments inside the body that
name the migration said "0121", the number it was written under, then
"0120", and say 0122 since 17 Nov 2026, changed before the declaration was
signed, so the md5 is that of the body as renumbered); its signature, result, owner, SECURITY DEFINER, search_path and ACL
are unchanged. Every other rule is kept: the
permission, direct care only, the exact active membership, the failure
windows and locks (0075), the sealed demo boundary (0098), the denial answers
(`verified: false`) and their audit rows.

What the patient keeps: each PIN use is in their access list
(`access_granted`) and raises the PIN notice; they can end the access at any
time (`revoke_my_consent_grant`, or turning the PIN off, which ends every PIN
grant); their deny choices still apply. Records processing (section 36)
already counted a PIN grant of either scope and now lasts its 24 hours.

Order of release:
1. The event dispatcher and the notification worker change that accepts the
   three-key PIN notice (they also accept the two-key one). It is in its own
   pull request (hid-system#206, branch
   `claude/fervent-galileo-datz4t-pin-notice-scope`, no migration) and must be
   merged and released before 0122 (it is live since 2026-11-11). It cannot share a
   release with 0122: a release that carries a migration applies it before it
   rolls out the services (`scripts/production_deployment.py`), so a PIN
   notice raised in between would be refused by the old check and not
   retried.
2. 0122 with identity-api (hid-system#208; written as 0121, renumbered 0120
   and then 0122 by the release order).
3. The websites, in either order with 0122: hid-system's own `apps/web`
   (hid-system#207) and health's staff site (health#197) say "see and add to
   records for 24 hours" and still ask for 60 minutes, which identity-api
   accepts before this release (at most 60) and after it (5 to 1440). 0122
   gives 1440 minutes whatever is asked, so neither site breaks the PIN if it
   ships before identity-api or if identity-api is rolled back. Until 0122 is
   live, a PIN used there gives the old 60 minutes of read access, so the new
   wording is ahead of the backend for that time.

A staff member whose role loses `identity.patient-access-pin.verify` keeps a
PIN grant they already have until it ends (24 hours after it was made), unless the
patient ends it, turns the PIN off, or the membership at that facility ends:
`has_active_consent_grant` checks the membership, not the permission.

To undo: a follow-up migration that puts back 0098's body (60 minutes,
`read_records`) and narrows the two PIN constraints again, after every
`write_records` PIN grant has ended or run out (at most 24 hours); identity-api's
default and limit go back to 15 and 60.

The suite is `services/ehr-api/database/tests/patient-access-pin.integration.sql`.

## 52. The sealed QA tenant (0123)

Migration 0123 (`0123_sealed_qa_tenant.sql`; owner decision Q60 of
2026-11-12) adds a third tenant beside the real ones and the sealed demo
(section 26), for the owner's own end-to-end testing by hand and with a browser
agent. Unlike the demo it is not a showcase: every QA login can do every real
action. Like the demo it is sealed in the database: nothing QA reaches, shares
with, orders to or finds a real or a demo facility, patient or person, and
nothing real or demo reaches QA. The marker is the owner-only table
`identity.sealed_qa_members` (as `identity.sealed_demo_members`; a member is
never both). 0098's rule ("both demo or neither") is unchanged; 0123 adds the
same rule for QA at every place 0098 enforces its own, so the three sides are
sealed from each other. Every answer is one a real tenant already gets for an
unknown or ineligible value: across the boundary a Health ID is not found, a
facility is not a destination, a clinician is not in the share directory.

The tenant (seeded only on Amazon RDS, i.e. production; CI and rehearsals get
the seal without the seed): QA Hospital (`QA-HOSPITAL`), QA Laboratory
(`QA-LABORATORY`) and QA Pharmacy (`QA-PHARMACY`), verified and active. Seven
staff logins, each with its own staff record, one mailbox of the owner's domain
per role:

| Login | Role |
| --- | --- |
| `ehr@healthidentitydirectory.com` | doctor at QA Hospital (EHR, Migrate, shares, orders) |
| `migrate@healthidentitydirectory.com` | clinician at QA Hospital (Migrate) |
| `lab@healthidentitydirectory.com` | lab at QA Laboratory |
| `lab2@healthidentitydirectory.com` | lab at QA Laboratory (a result's second check) |
| `pharmacy@healthidentitydirectory.com` | pharmacist at QA Pharmacy |
| `admin@healthidentitydirectory.com` | org_admin at QA Hospital, QA Laboratory and QA Pharmacy |
| `outreach@healthidentitydirectory.com` | no membership: starts the QA Outreach group |

Two patient logins: `patient1@healthidentitydirectory.com` (`HID-ZQAAAAA2`, QA
Patient One) and `patient2@healthidentitydirectory.com` (`HID-ZQAAAAA3`, QA Patient
Two). Those were the demo patients' logins (section 26), so in the same
transaction, before the QA seed, 0123 moves the two demo patient logins to
`patientdemo1@healthidentitydirectory.com` and `patientdemo2@healthidentitydirectory.com`
(`identity.demo_patient_logins_move()`, the owner's): address only; their
passwords, sessions, status, verification, Health IDs, shares and seal stay.
It refuses (55000, nothing moved, the release stops) a new address held by
another account, staff record, open organization application or pending staff
invitation (`DEMO_PATIENT_ADDRESS_TAKEN`), or a demo patient login on neither
address or whose patient record holds an email of its own
(`DEMO_PATIENT_LOGIN_UNEXPECTED`), or while a demo patient has a live email
emergency contact (before 0123 it could only be `operations@`, `patient1@` or
`patient2@`, and the database holds only its HMAC) or a pending share
invitation to `patient1@` or `patient2@` (`DEMO_PATIENT_OLD_ADDRESS_IN_USE`;
the owner removes or cancels them in the app first, and may add contacts again
with the new addresses afterwards); it writes one audit row
(`identity.sealed-demo.patient-logins-moved`, correlation id
`0123-demo-patient-logins`, a count only). The demo's exact allowlist
(`identity.sealed_demo_recipient`) and seed (`identity.sealed_demo_install`)
name the new addresses; a demo patient can no longer invite, add as a contact
or change their email to `patient1@` or `patient2@`. Every account is seeded `pending_reset` without a password,
its email verified; the owner sets each password with Forgot password. QA
Patient One shares with the QA clinician at QA Hospital (written as section 26
writes the demo's shares, with the migration's own audit row,
`identity.sealed-qa.seed-share`, correlation id `0123-sealed-qa-install`); QA
Patient Two has no share, so the owner tests the real share flow with it.
Identity's Health ID generator never issues a code starting `ZQA` or `ZDEM`.

QA Outreach: an outreach group (0115) must hold its organiser's
contact phone encrypted with Identity's key, which a migration cannot write
truthfully. The owner starts it with the organiser login through "Start an
outreach group" (with `outreach_organiser_signup_enabled` on), naming it "QA
..."; a group whose organiser is a QA account becomes QA as it is made, and its
name must start with "QA " (else 22023 `OUTREACH_ORGANISER_SIGNUP_INVALID`). A QA
group invites volunteers at `@healthidentitydirectory.com` addresses only (400
`OUTREACH_INVITATION_INVALID` otherwise), so no QA invitation email reaches
anyone outside the owner's domain.

Kept off for QA (coordinator, 2026-11-12): QoreID (a QA account consumes no
QoreID quota, so no paid lookup; 42501 `QOREID_QUOTA_PERMISSION_DENIED`), a QA
patient's phone (so no SMS; 400 `PATIENT_CONTACT_CHANGE_INVALID`), platform roles,
and the platform overview's counts. A QA patient's share invitations, emergency
contacts and email changes go to `@healthidentitydirectory.com` addresses only
(plus-addresses allowed); any other domain is refused as the demo refuses a
non-demo address (400 `SHARE_INVITATION_EMAIL_INVALID`, 409
`CONTACT_UNAVAILABLE`, `EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED`).

Known limits (accepted): a QA facility admin cannot invite a new login (the new
account is real, and the seal refuses a real account at a QA facility); no new
patient is created inside QA (facility registration needs a QoreID NIN check,
kept off, and app. sign-ups are platform-wide). Testing uses the seeded logins
and patients.

## 53. Each staff product is its own site; the staff reset email (owner decision of 17 November 2026, Q88, Q89 and Q97)

identity-api (with one new notification-api route) and, for the
administrator rule decided by the owner as Q90 and Q91, migration 0126
(`identity.organization_staff_kinds`, below). The gate reads the permissions
the seeds already grant and, for an administrator, the recorded kinds of its
organisation and the products it holds; the session carries its product in the signed access token.

### The product of a request

The product is the request's `Origin` host, matched exactly (https, no port,
no path) against the hosts `turnstile.service.ts` names:

| Product | Production host | Staging host |
| --- | --- | --- |
| `ehr` | `ehr.healthidentitydirectory.com` | `ehr.staging.healthidentitydirectory.com` |
| `lab` | `lab.healthidentitydirectory.com` | `lab.staging.healthidentitydirectory.com` |
| `pharmacy` | `pharmacy.healthidentitydirectory.com` | `pharmacy.staging.healthidentitydirectory.com` |
| `migrate` | `migrate.healthidentitydirectory.com` | `migrate.staging.healthidentitydirectory.com` |
| `outreach` | `outreach.healthidentitydirectory.com` | `outreach.staging.healthidentitydirectory.com` |

Every other host (`app.`, `www.`, the apex, `admin.`, and every local or
development host) has no product and keeps the behaviour before Q88: all the
account's memberships, and platform administrators sign in as before.

### Which memberships a product site keeps (Q88-1)

`POST /api/v1/auth/login` (and a staff Google sign-in), `POST
/api/v1/auth/refresh` and `POST /api/v1/auth/facility` keep only the facility
memberships whose permissions fit the product of the site:

| Site | A membership fits when it holds any of |
| --- | --- |
| `ehr.` | `ehr.encounter.write`, `organization.manage` (hospital roles) |
| `lab.` | `lab.work-item.read`, `lab.work-item.accept` (lab roles), or `organization.manage` (an administrator) |
| `pharmacy.` | `pharmacy.work-item.read`, `pharmacy.dispensing.read` (pharmacy roles), or `organization.manage` |
| `migrate.` | `ehr.encounter.write`, `organization.manage` only (lab staff are not admitted, although they hold `ocr.job.*`) |
| `outreach.` | `outreach.registration.read`, `outreach.campaign.read` (outreach roles), or `organization.manage` |

Each staff site is for its own job (owner decision Q97, "Q97 A", 17 November
2026): a membership that holds `ehr.encounter.write` without
`organization.manage` (doctor, clinician, nurse and receptionist) fits `ehr.`
and `migrate.` only, although the seeds also grant those roles the lab,
pharmacy and outreach reading codes for their own hospital work (0018, 0023,
0024, 0038). A hospital administrator (`admin`, `org_admin`, which hold
`organization.manage`, and the review-pending administrator below) keeps every
site of its own organisation. Lab staff, pharmacists, outreach organisers and
volunteers, and the account-only outreach session are unchanged. A doctor who
also helps an outreach group signs in on `outreach.` with the group only. A
membership that also holds a site's own job keeps that site: one that holds
`lab.result.enter`, `lab.specimen.receive` or `lab.order-route.receive` (the
lab role's codes, never seeded to the hospital clinical roles) is admitted on
`lab.`, and one that holds `pharmacy.dispensing.create`,
`pharmacy.work-item.accept` or `pharmacy.order-route.receive` (the
pharmacist's) on `pharmacy.`; for example a nurse also given the lab role at a
small clinic.

Owner decision 5 (11 November 2026, the same login can also run its own
outreach group) still holds for these roles. "Start an outreach group"
(`GET .../outreach-organisers/for-my-account/availability` and `POST
/api/v1/identity/outreach-organisers/for-my-account`) checks no product: any
staff session on any site may use it, so the website runs the form on `ehr.`
for a login whose `actor.products` does not list `outreach`, instead of
linking to `outreach.`, which would refuse it. The new group's organiser
membership fits `outreach.`; the login then signs in there with the group
only, and `actor.products` lists `outreach` from the next session read.

In identity-api the Q97 rule is `facilityAdmittedOnProduct` (product-gate.ts):
the permission rule `facilityFitsProduct`, then the hospital clinical rule.
Every caller (sign-in, refresh, each request, `POST /auth/facility` and
`actor.products`) uses `facilityAdmittedOnProduct`, never
`facilityFitsProduct` alone; `product-gate-own-job.spec.ts` pins this.

An administrator's membership (`organization.manage`, or the administrator
awaiting review below) is the one exception: it counts as a hospital role only
at a hospital organisation, and otherwise fits only the sites of its
organisation's recorded kinds (owner decisions Q90 and Q91, below).

From the seeds: `ehr.encounter.write` is held by doctor, clinician, nurse and
receptionist (0006); `organization.manage` by admin and org_admin (0006);
`lab.work-item.read` by lab, doctor, clinician, nurse and admin (0018);
`pharmacy.work-item.read` and `pharmacy.dispensing.read` by pharmacist, doctor,
clinician, nurse and admin (0023); the outreach reads by outreach_organiser and
outreach_volunteer (0115) and the hospital roles (0024, 0038). So an outreach
organiser or volunteer is admitted only on `outreach.`; lab staff (and a lab
second checker) only on `lab.`; a pharmacist only on `pharmacy.`; a doctor,
clinician, nurse or receptionist only on `ehr.` and `migrate.` (Q97). One
addition: the administrator of a facility that signed
itself up and awaits support's review (membership `org_admin`, permissions
`org_admin_awaiting_review`'s, which hold `workforce.manage` but not
`organization.manage`, 0086) is admitted wherever org_admin is, so it can sign
in again on the site it signed up on.

Administrators follow their organisation's kind (owner decisions of 17
November 2026, verbatim: Q90 "Q90 A since its the best option that gives each
product seperate environment"; Q91 "Q91 A"). A membership is an
administrator's when it holds `organization.manage` (admin and org_admin,
0006) or is the administrator awaiting review above, and does not hold
`ehr.encounter.write`. Its sites depend only on the recorded kinds of its
organisation and the products it holds, not on its other codes (org_admin
also reads outreach registrations, admin also reads lab and pharmacy work):

| The organisation's recorded kinds | The administrator is admitted on |
| --- | --- |
| none recorded (Q91 A), or any `hospital` or `clinic` | every product site, as a hospital role |
| `laboratory` only | `lab.`, and the site of each product it holds |
| `pharmacy` only | `pharmacy.`, and the site of each product it holds |
| `laboratory` and `pharmacy` (no hospital or clinic) | `lab.` and `pharmacy.`, and the site of each product it holds |

A held product's site is `ehr.` for `ehr`, `migrate.` for `migrate`, `lab.`
for `laboratory` and `pharmacy.` for `pharmacy`; `outreach.` is never one. So
a laboratory or a pharmacy that bought `ehr` or `migrate` (both sign-up forms
accept any organisation type with any product) keeps that product's site for
its administrator, and the administrator awaiting review of a pharmacy that
signed itself up on `migrate.` can sign in there again.

The kinds and products are `identity.organization_staff_kinds(organization_id)`
(0126, one row of `organization_kinds text[]` and `organization_products
text[]`, STABLE, SECURITY DEFINER, `search_path` pinned, EXECUTE for
`hid_identity_runtime` only). `organization_kinds` is the distinct
`organization_type`s, sorted, of every approved application of the
organisation (each governed approval, also one that reused the organisation,
whose product row already existed or was later suspended, and the self
sign-up while it is pending or reviewed; a released self sign-up is
`rejected` and gives nothing). `other` gives the kind its product makes it,
exactly as `identity.staff_invitable_roles` and identity-api's
`staffInvitableRoles` read it: `ehr` or `migrate` `hospital`, `laboratory`
`laboratory`, `pharmacy` `pharmacy`. An organisation promoted from the legacy
system (`identity.organizations.source_system` `legacy_identity`) also gives
`hospital`, so the hospital status Q91 A gave it stays when a governed
approval later reuses it for a laboratory or a pharmacy product. The answer
holds only `clinic`, `hospital`, `laboratory` and `pharmacy`, and is empty
when nothing is recorded: the sealed QA Hospital (0123) and Demo Hospital and
Demo Outreach (0098) and outreach groups (0115) have no kind, so they are
hospitals. `organization_products` is the distinct product codes, sorted, of
the organisation's active `identity.organization_products` rows (a suspended
product is not held, but its application's kind stays recorded, so
suspending a laboratory's only product narrows its administrator to `lab.`
instead of widening it to every site). The staff context reads it with one
lateral call per membership and adds `organizationKinds` (sorted, once each)
to that facility only when it is not empty, and `organizationProducts`
(sorted, once each) only beside `organizationKinds` and when it is not empty,
so a membership with no recorded kind answers exactly as before.

So, at the sealed QA tenant, admin@ (org_admin at QA Hospital, which has no
application, QA Laboratory and QA Pharmacy) keeps QA Hospital alone on `ehr.`,
`migrate.` and `outreach.`, QA Hospital and QA Laboratory on `lab.`, and QA
Hospital and QA Pharmacy on `pharmacy.`. The org_admin of a laboratory-only
organisation is refused (`403 PRODUCT_NOT_AUTHORISED`) on every site but
`lab.` (and the site of any other product it holds). The administrator
awaiting review of a self-signed-up laboratory is admitted on `lab.` (and on
the site of the product it signed up for), of a hospital or clinic on every
site. Clinical
hospital roles (`ehr.encounter.write`: doctor, clinician, nurse, receptionist)
and the lab, pharmacy and outreach roles are unchanged, at any organisation:
a hospital receptionist, for example, is still admitted on `migrate.`.
`product-gate.spec.ts` pins these answers; the database suite
`organization-staff-kinds.integration.sql` pins the function's.

The session's `actor.facilities`, `actor.facilityIds` and the selected
`actor.facility` hold only fitting memberships. The access token carries the
product (`product` claim); every request, including the delegated
`/auth/service-session` other services call, keeps only the fitting
memberships, and `X-Facility-ID` naming any other facility is `403
FACILITY_ACCESS_DENIED`. A session that no longer fits its site (its last
fitting membership ended) ends with `401`, as an ended membership always has.
This holds on `POST /auth/refresh` too: a refresh that no longer fits its site
(or, off the product sites, an account whose last membership ended) is `401`
with the cookies cleared, never one of the 403 sign-in refusals below, so every
website signs out cleanly.
`POST /auth/facility` also keeps only the facilities that fit the product of
its own `Origin` (`403 FACILITY_ACCESS_DENIED` otherwise). An access token
issued before this release carries no product and keeps today's behaviour
until its refresh, which applies the gate. After Q97, a doctor's, clinician's,
nurse's or receptionist's session issued on `lab.`, `pharmacy.` or `outreach.`
no longer fits its site: its next request or refresh answers `401` and the
website signs out, the mechanism above, unchanged.

### The sites a login can open: `actor.products` (Q97)

Every staff session answer carries the staff product sites this login can
open, so the website shows only those:

```ts
actor.products: ('ehr' | 'lab' | 'pharmacy' | 'migrate' | 'outreach')[]
```

- Always present on a staff actor; never on a patient actor.
- Order is fixed: `ehr`, `lab`, `pharmacy`, `migrate`, `outreach`; no
  duplicates.
- Computed with the gate's own rule over **all** the account's active
  memberships, before the current site's filter, so it is the same whatever
  site (or no-product host such as `admin.`) the session was issued on. A site
  is listed when at least one membership fits it.
- `["outreach"]` for the account-only outreach session (Q88-2).
- `[]` for a platform administrator with no membership (it opens `admin.`,
  which is not a staff product site).
- Carried in the answers of `POST /api/v1/auth/login`, a staff Google sign-in,
  `POST /api/v1/auth/refresh`, `GET /api/v1/auth/session` and `POST
  /api/v1/auth/facility` (each `{ actor, ... }`). It is not an access-token
  claim; it is read from the database on every request with the rest of the
  actor.

Examples (fictional): a doctor `["ehr", "migrate"]`; a doctor who also helps
an outreach group `["ehr", "migrate", "outreach"]`; lab staff `["lab"]`; a
hospital `org_admin` `["ehr", "lab", "pharmacy", "migrate", "outreach"]`.

The product is bound to the session, not to the `Origin` of each refresh (the
`Origin` is the client's to set). A staff session issued on a product site
carries its product in the server-made refresh token
(`<session id>.<secret>.<product>.<method>`; the token's hash is what
`auth.sessions` stores, so it cannot be altered). `POST /auth/refresh`
re-applies that product, and answers `401` with the cookies cleared when the
request's `Origin` names any other product or none (for example a session
issued on `lab.` refreshed with `Origin: https://app.healthidentitydirectory.com`).
A refresh token with no product (issued before this release, or on a host with
no product) takes the product of the site it is refreshed on, and keeps it from
then on.

When the password is right but no membership fits:

```json
{ "status": 403, "code": "PRODUCT_NOT_AUTHORISED",
  "detail": "This account isn't set up for this Health ID product.", "product": "lab" }
```

A platform administrator with no fitting membership gets the same answer on a
product site; on `admin.` (no product) nothing changes.

### A verified staff login with no membership (Q88-2)

An active account with an active, verified staff record, no platform role
assignment and not one of the sealed demo accounts (0098), that has no
active membership:

- on `outreach.`, signs in with an account-only session: `actor.accountOnly:
  true`, no facility, no roles, no permissions. It reaches only `GET
  /api/v1/auth/session`, `POST /api/v1/auth/logout`, `POST
  /api/v1/auth/refresh` (public) and "Start an outreach group" (`GET
  /api/v1/identity/outreach-organisers/for-my-account/availability`, `POST
  /api/v1/identity/outreach-organisers/for-my-account`); every other route,
  the delegated service session included, answers `403
  NO_ACTIVE_FACILITY_MEMBERSHIP` before its handler. The start still needs
  `outreach_organiser_signup_enabled` on (`423
  OUTREACH_ORGANISER_SIGNUP_UNAVAILABLE` while it is off). Once the group is
  started, a refresh gives the normal outreach session at the new group.
- on every other site (and hosts with no product):

```json
{ "status": 403, "code": "NO_ACTIVE_FACILITY_MEMBERSHIP",
  "detail": "You aren't part of a facility or outreach group yet." }
```

Neither 403 is a failed sign-in: they are answered only after the password
was checked, they neither count towards nor clear the principal's lockout,
and no `login_failed` row is written. Each writes one audit row
(`auth.login.refused`, outcome `denied`, details `reason` and `product`). A
wrong password, an unknown email, a locked-out principal, and a right password
for any other account with no membership (a patient login, a sealed demo
account, an account with a platform role) still answer the one `401` "Invalid
credentials" and are counted, as before.

"Start an outreach group" (`for-my-account`) no longer writes an interceptor
audit row: with no `X-Facility-ID` it would be a staff row with no facility,
which the audit layer refuses (the answer became `503`). The start command
writes its own success row at the new group (`identity.create_outreach_group`,
0115), as the signed-in staff invitation routes do (S5).

### The staff password reset code email (Q89)

`POST /api/v1/auth/otp/start` with `PASSWORD_RESET` and the Turnstile action
`staff-reset` (the five product sites) or `admin-reset` (`admin.`), for an
account with an email that is not a patient the patient email could name,
sends the code through a new notification-api route under the same key
(`otp:<challengeId>`):

```text
POST /api/v1/notifications/staff-password-reset-code
{ channel: "email", recipient, code, firstName?, expiresInMinutes (1-60), plan }
```

Workload-authenticated, `Idempotency-Key`, email only, unknown fields refused
(no `healthId`). The email is the patient reset code's layout: subject "Your
Health ID password reset code", header "Health ID Security", "Hello <first
name>," (or "Hello there,"), "A password reset was requested for your Health
ID staff account. Use the code below to continue.", the boxed "Verification
Code", and "This code expires in <N> minutes. If you did not request this
reset, ignore this message and consider changing your password after you sign
in.", with N from `OTP_EXPIRY_SECONDS`. The first name is the first word of
`auth.accounts.display_name` after any leading titles (Dr, Dr., Prof,
Professor, Mr, Mrs, Ms, Miss, Nurse), cut to notification-api's person-name
pattern. A notification-api that does not serve the route yet answers 404
having sent nothing; Identity then sends the code once through `POST
/api/v1/notifications/otp` under the same key, so either service may be
released first. Any other answer is final. A patient account keeps the
patient email whatever site asked; the patient portal's reset of a staff-only
account, legacy recovery and SMS keep the generic code message. The start
still answers every identifier alike.

## 45. Patient details on this facility's own lab and pharmacy work (0124)

Owner decision 25 of 2026-11-01 (D-Eminence, "all recommended except D5", on
the Akos handover backend plan, item 3a; D8: emergency sessions see the
patient details with the work). Laboratories and pharmacies run as
stand-alone products for the whole facility, so their staff need the
patient's name, sex, date of birth and Health ID ending on their own work,
not only on work sent from another facility. 0124 is unsigned until the
owner signs its declaration. It ships after 0123. It was numbered 0121 by
the coordinator's release order of 2026-11-11 and renumbered 0124 after
staging's 0117-0121 (0122 and 0123 are other work). It needs 0001-0123
applied. Its read consent test is the one 0104 left (0105-0123 kept it).
0122 and 0123 are sections 51 and 52, so this section keeps the number 45.

Routes (paths, permissions, requests unchanged):
`GET /api/v1/lab/work-items` and `GET /api/v1/lab/work-items/:workItemId`
(`lab.work-item.read`), `GET /api/v1/pharmacy/work-items` and
`GET /api/v1/pharmacy/work-items/:workItemId` (`pharmacy.work-item.read`).

While `OWN_WORK_PATIENT_CARD_ENABLED` is `true` in lab-api or pharmacy-api, a
work item that is this facility's own work (it has `sourceEhrOrderId` or
`sourceEhrPrescriptionId`, and no `orderRoute`) carries the existing
optional `patient` that route-backed work items already carry:

| Field | Value |
| --- | --- |
| `patient.fullName` | the patient's full name |
| `patient.sex` | as recorded, or `null` |
| `patient.dateOfBirth` | `YYYY-MM-DD`, or `null` |
| `patient.healthIdLast4` | the last 4 characters of the Health ID |

It is left out when the member may not read the work now (no read grant at
this facility for this purpose, a revoked or expired grant, a deny
directive, no work-list read permission, a disabled account), when the
database read fails (it runs in a savepoint and never fails the answer), and
whenever the setting is off. Off is the default and answers exactly as
before. `infra/aws` passes the setting to lab-api and pharmacy-api only, from
`HID_OWN_WORK_PATIENT_CARD_ENABLED` at synth: `false` unless that is `true`
(production's environment switches are made in `dev`'s Terraform). An
emergency session with an active break-glass grant gets it, because its work
rows are shown too. Route-backed work items are unchanged: their patient
still comes from the route card, only while the route allows a read.

Database (0124, functions only): `lab.work_item_patient_cards(uuid[])` and
`pharmacy.work_item_patient_cards(uuid[])`, SECURITY DEFINER, owned by
`identity.patients`' owner, at most 200 ids (else 22023
`WORK_ITEM_PATIENT_CARDS_INVALID`). A row is answered only for own work at
the session's facility whose member holds the work-list read permission
there and passes the read consent test of the work items' read policy.
EXECUTE: the Lab one to `hid_lab_runtime`, the Pharmacy one to
`hid_pharmacy_runtime`, both to `hid_schema_test_runtime`; nobody else. No
table, column, policy or existing function changes.

Audit rows, in the request's transaction, ids only:

| Route | Rows added while the setting is on |
| --- | --- |
| `GET /lab/work-items` | one `lab.work-item.list` per patient shown on own work: `patient_id` that patient, `resource_id` the first of their work items, `details` `{ "basis": "consent", "workItemIds": [...] }` |
| `GET /pharmacy/work-items` | the collection row as before, then one `pharmacy.work-item.list` per patient shown on own work, the same shape |
| `GET .../work-items/:workItemId` | none: the existing `lab.work-item.read` or `pharmacy.work-item.read` row already names the patient |

The patient's access log (`identity.patient_self_access_log`, 0093) shows
these names as views by the member at the facility (entries less than 10
minutes apart collapse into one). Responses are otherwise unchanged;
request bodies and error mapping are unchanged. `PharmacyWorkItem` in
`@hid/api-client` gains the optional `patient`.

Runtime check with the setting on: lab-api and pharmacy-api answer 200
whatever the reader does, so the runtime verifier
`services/ehr-api/scripts/verify-own-work-patient-cards-runtime.mjs` calls the
real functions through the real services. It boots Identity, EHR, Lab and
Pharmacy from their own code as their runtime roles, Lab and Pharmacy with
`OWN_WORK_PATIENT_CARD_ENABLED=true`, and runs in the TUF migration rehearsal
(`scripts/tuf-staging-migration-rehearsal.mjs`, the workspace job of
`tuf-local-gates.yml`) after the order-routes and records-processing
verifiers. It fails when an own work item the member may read comes back
without `patient` (on the list or by id), when the list writes no
`basis: consent` audit row for it, when a member without consent sees the
work or a patient, or when route-backed work shows any patient but its route
card's (none once the route has closed, though its reader holds consent).

Cost while the setting is on: each list load calls the reader once for its
own rows (at most 200), as a statement of its own, so it does not count
toward the list query's 15-second limit and does not grow with the size of
the laboratory or pharmacy. Under a NOBYPASSRLS owner, as in production, each
of those rows pays the work items' read policy and then the same consent
test again (0124's header, D5). Measured on PostgreSQL 16 on a shared 4-CPU
2.8 GHz Xeon with 200 own rows: the Lab reader 0.7-1.1 s against 0.8-1.2 s
for the Lab list query, the Pharmacy reader 0.6-1.0 s against about 0.6 s
for the Pharmacy list query. So the setting roughly doubles a list's
database time. The Lab list's known limit (about 2,000 work items) is
unchanged.

0124 has no down migration. To withdraw the feature, set
`OWN_WORK_PATIENT_CARD_ENABLED=false` in lab-api and pharmacy-api; the two
functions stay and nothing calls them. Do not drop them: 0124 stays
recorded, so the runner does not re-create them, and runtime-grants.sql's
0124 block would then stop `db:bootstrap` with 42883. The suite is
`services/ehr-api/test/database/work-item-patient-cards.integration.sql`.

## 46. Prescription strength, form, duration, quantity and priority for the pharmacy (0125)

Owner decision 25 of 2026-11-01 (D-Eminence, "all recommended except D5", on
the Akos handover backend plan, items 3b and 4; D6: no drug picture until the
price list; D9: the quantity to dispense is the prescriber's suggestion, the
pharmacist still confirms it and nothing compares the two). The prescriber
records how urgent a prescription is, the strength and form meant, how long
it is for and how much to hand over, and this facility's pharmacy sees them
on its own work. 0125 is unsigned until the owner signs its declaration.
It was numbered 0122 by the coordinator's release order of 2026-11-11 and
renumbered 0125 after staging's 0117-0121 (0122 and 0123 are other work).
It ships after 0124 (section 45). It needs 0001-0124 applied. Its read
consent test is the one 0104 left (0105-0124 kept it). It accepts
`ehr.send_order_route` as 0098 left it or as 0123 left it (0098's with the
QA seal on the receiving facility). 0122 and 0123 are sections 51 and 52,
so this section keeps the number 46.

Routes (paths and permissions unchanged): `POST
/api/v1/ehr/patients/:patientId/encounters/:encounterId/prescriptions`
(`ehr.prescription.write`), the prescription reads and update, and
`GET /api/v1/pharmacy/work-items` and `GET
/api/v1/pharmacy/work-items/:workItemId` (`pharmacy.work-item.read`).

While `PRESCRIPTION_DISPENSING_DETAILS_ENABLED` is `true` in ehr-api, the
create body takes these optional fields, at creation only (the update body is
unchanged and never changes them):

| Field | Value |
| --- | --- |
| `priority` | `routine`, `urgent`, `asap` or `stat` |
| `strength` | as written, 1-80 characters after trimming ("500 mg") |
| `doseForm` | `tablet`, `capsule`, `liquid`, `injection`, `cream`, `inhaler`, `drops` or `other` |
| `durationValue`, `durationUnit` | a whole number 1-3650 and `day`, `week` or `month`, both or neither |
| `quantityToDispense`, `quantityUnit` | a number above 0 with at most 4 decimals (at most 99,999,999.9999) and 1-80 characters, both or neither |

`null` for any of them is refused, as for every optional field. A pair sent
half answers 400 `DURATION_INCOMPLETE` ("Duration value and unit must be
supplied together") or `QUANTITY_INCOMPLETE` ("Quantity to dispense and its
unit must be supplied together"); a bad value answers 400
`VALIDATION_FAILED` naming the field. Every prescription answer (list, read,
create, update and an idempotent replay) adds each of the seven that is set,
under the same name (`quantityToDispense` as a number), and the list answer
adds `dispensingDetails: true`, which tells the website it may send them. A
create body without them keeps its Idempotency-Key digest, so a retry across
the deploy replays.

While the setting is off (the default), the routes answer exactly as
before: the create body is validated against today's fields with the
validation the app installs globally, so each new field answers 400
`VALIDATION_FAILED`, `"property priority should not exist"`, word for word;
no statement names the new columns, and no answer or list carries a new key.

`infra/aws` passes the setting to ehr-api and pharmacy-api only, from
`HID_PRESCRIPTION_DISPENSING_DETAILS_ENABLED` at synth: `false` unless that
is `true` (production's environment switches are made in `dev`'s Terraform).
It switches both services at once, so set it to `true` only after 0125 is
applied (the ehr-api setting needs the schema, below).

While `PRESCRIPTION_DISPENSING_DETAILS_ENABLED` is `true` in pharmacy-api, a
work item that is this facility's own work (it has
`sourceEhrPrescriptionId`, and no `orderRoute`) carries, each only when there
is a value:

| Field | Value |
| --- | --- |
| `medication.strength`, `medication.doseForm` | as the prescriber gave them |
| `priority` | as the prescriber gave it |
| `duration` | `{ "value": n, "unit": "day" \| "week" \| "month" }` as the prescriber gave it; else, when the work item has both a start and an end date, the whole days from one to the other, both included, as `day` |
| `quantityToDispense`, `quantityUnit` | as the prescriber gave them; the dispensing form starts with them and the pharmacist confirms the quantity |

The values are those of the prescription version Pharmacy accepted, so they
do not change when the prescription later changes (the work item is then not
dispensable, as before). A prescription written before 0125, or without
them, gives none (only the duration from the dates). The prescriber's values
are left out when the member may not read the work now and when the database
read fails (it runs in a savepoint and never fails the answer); the duration
from the work item's own dates is still given then. Nothing is added while
the setting is off.
Route-backed work items and the acceptance answer are unchanged (the same
details on work from another facility need the route to carry them, item 4b,
later). An emergency session with an active break-glass grant gets them,
because its work rows are shown too. No audit row is added: no new person is
shown. `PharmacyWorkItem` in `@hid/api-client` gains the optional fields.

Database (0125): seven nullable columns on `ehr.prescriptions` (`priority`,
`medication_strength`, `medication_dose_form`, `duration_value`,
`duration_unit`, `quantity_to_dispense` numeric(12,4), `quantity_unit`), no
default, and one CHECK, `prescriptions_dispensing_details_ck`, for the value
sets, the lengths, the ranges and the two pairs, added NOT VALID and then
validated (one CHECK, so the table is scanned once). Nothing is copied into
`pharmacy.work_items`, so the 0100 and 0101 guards are unchanged.
`pharmacy.work_item_prescription_details(uuid[])`, SECURITY DEFINER, owned by
`pharmacy.work_items`' owner, at most 200 ids (else 22023
`WORK_ITEM_PRESCRIPTION_DETAILS_INVALID`), reads the accepted version's
snapshot (`ehr.record_versions`, resource type `prescriptions`, the work
item's prescription id and version, its patient, facility and encounter) for
own work at the session's facility whose member holds
`pharmacy.work-item.read` there and passes the read consent test of the work
items' read policy. It joins the snapshot by its key (the work item's ids
are turned into text first, so the join can use the key under the snapshot
table's forced read policy), so that policy runs once per work item whatever
the prescription history. EXECUTE: `hid_pharmacy_runtime` and
`hid_schema_test_runtime`; nobody else. The EHR runtime's privileges on
`ehr.prescriptions` are table-wide, so they cover the new columns.

Locks: 0125 takes ACCESS EXCLUSIVE on `ehr.prescriptions` NOWAIT, retrying
for at most 5 seconds (an open Pharmacy acceptance or any open read of the
table makes it wait and then stop the release with nothing applied; it never
blocks them), and holds it to commit. Once taken, EHR prescription reads and
writes and Pharmacy acceptances and dispensings wait while the one
validation scans the table: about 0.07 s for 200,000 prescriptions and 0.5 s
for 1,000,000, measured on synthetic tables (nine separate CHECKs took 0.43 s
and 3.05 s there, one scan each).

Cost while the pharmacy-api setting is on: each list load calls the reader
once for its own rows (at most 200), as a statement of its own. Under a
NOBYPASSRLS owner, as in production, each row pays the work items' read
policy, the same consent test again and the snapshot table's read policy,
once each: 1.0-1.7 s for 200 own rows, against 0.4-0.7 s for reading the same
200 rows under row-level security, with 1, 5, 20 or 50 prescription
snapshots per patient and with 300,000 other snapshots at the facility
(fictional data, PostgreSQL 16 on a shared 4-CPU machine). The reader is
called under pharmacy-api's 15 s statement limit, so its cost must not grow
with the history: the first draft joined on the prescription id cast to text
inside the join, which the planner cannot use under the read policy; it took
8.8 s with 20 snapshots per patient and passed the 15 s limit with 100,000
other prescription snapshots at the facility.

0125 has no down migration. To withdraw the feature, set
`PRESCRIPTION_DISPENSING_DETAILS_ENABLED=false` in ehr-api and pharmacy-api:
the EHR API then refuses the fields again and pharmacy-api stops reading
them; the columns, the values already written and the function stay, and
nothing reads them. Do not drop the function: 0125 stays recorded, so the
runner does not re-create it, and runtime-grants.sql's 0125 block would then
stop `db:bootstrap` with 42883.

The ehr-api setting needs the schema. Switch
`PRESCRIPTION_DISPENSING_DETAILS_ENABLED` on in ehr-api only after 0125 is
applied, and switch it off before restoring ehr-api's database to a point
before 0125 or pointing ehr-api at a database without it. While it is on
without the seven columns, every statement of the prescription routes names
them and fails (42703), so every prescription list, read, create, update and
Pharmacy acceptance hand-off from the EHR answers 500. pharmacy-api is safe
either way: without 0125 its read fails inside the savepoint and only the
prescriber's values are left out.

The suite is
`services/ehr-api/test/database/prescription-dispensing-details.integration.sql`.

Runtime check with the setting on: pharmacy-api answers 200 whatever its
reader does, so the runtime verifier
`services/ehr-api/scripts/verify-prescription-details-runtime.mjs` calls the
real function through the real services. It boots Identity, EHR and Pharmacy
from their own code as their runtime roles, EHR and Pharmacy with
`PRESCRIPTION_DISPENSING_DETAILS_ENABLED=true`, and runs in the TUF migration
rehearsal (`scripts/tuf-staging-migration-rehearsal.mjs`, the workspace job of
`tuf-local-gates.yml`) after the own-work patient verifier (section 45). It
fails when ehr-api does not take, store and echo the seven details, when an
own work item the pharmacist may read comes back without exactly the
prescriber's details (on the list or by id), when a prescription written
without them gains some, when a pharmacist without consent sees the work or a
detail, or when route-backed work shows any detail (though its reader holds
the patient's consent at that facility).

## 54. Single sign-on on the product sites, staff with a password only (0127, owner decision Q92 B)

hid-system#142 (ADR-070, written on main as 0102), ported onto production as
migration 0125 and renumbered 0127 after hid-system#254's 0124, #255's 0125
and #259's 0126 (booked on hid-system#258); it needs 0001-0126 applied and
reads nothing 0124-0126 add. Owner decision Q92 B: single sign-on goes to production with
staff signing in by password only, as they sign in today. Production has no
staff authenticator (no `auth.mfa_factors`, `auth.session_assurance`,
`auth.session_facility_selection`, `MfaService` or `issueStaffSession`), so
nothing here reads or writes one. The provider on `auth.` (its sign-in page,
its session, authorize, token, discovery, key set, end-session and sending
back-channel logout) is not in this change. Each product site is an OpenID
Connect relying party of it, built with panva's `openid-client` 6.8.8;
Identity issues each product its own host-only session, as a password
sign-in there does today. No cookie has a `Domain` (ADR-033), and the session
cookies of section 53 and before are unchanged. The website switch
(`VITE_HID_SSO`) is a separate release.

### Off until configured

With `AUTH_SSO_ISSUER` unset (production today), every route below answers
exactly as a route that does not exist (`404 NOT_FOUND`, no cookie, no audit
row); sign-in, the session check and sign-out are unchanged. Two reads of the
0127 tables stay on once 0127 is applied, because a sign-in issued while
single sign-on was on keeps its rows after it is switched off: the patient
recent-sign-in check still counts such a family from its provider `auth_time`
(on a database without 0127 it sends today's statement), and a refresh of a
sign-in ended with reason `sso_logout` is still answered as an ended sign-in,
not as reuse (below). `POST /auth/sso/logout` answers `404` with or without a
session. The same holds on a host that is not a configured client (`admin.`,
`auth.` itself, a request that did not come through the edge). Identity refuses to start with any bad
setting:

| Setting | Meaning |
| --- | --- |
| `AUTH_SSO_ISSUER` | The provider's public issuer, an exact origin (`https://auth.<root>`). HTTPS in production. Requires `AUTH_MODE=local` |
| `AUTH_SSO_INTERNAL_BASE_URL` | Optional origin through which Identity reads discovery and the key set and calls the token endpoint, without going out through the edge. HTTPS in production. The browser is always sent to the public endpoints |
| `AUTH_SSO_CLIENTS` | JSON array, one entry per product site: `client_id` (`ehr`, `lab`, `pharmacy`, `migrate`, `outreach` of kind `staff`; `web` of kind `patient`; never `admin`), `host`, `kind`, `token_endpoint_auth_method` (`private_key_jwt` or `client_secret_basic`) and optional `sign_in_path` (default `/provider/sign-in` on staff sites, `/sign-in` on the patients' site) |
| `AUTH_SSO_CLIENT_CREDENTIALS` | Secret store JSON by client id: `{ "private_jwk": <EC P-256 private JWK with kid> }` or `{ "client_secret": <32+ characters> }` |

A client's `host` is one exact host named in `CORS_ORIGINS` and the client's
own site. A staff client's host starts with its `client_id`; `web`'s with a
patients' site label (`app.`, `www.`, or `staging.` or `development.` in those
environments); no staff client is ever on the patients' site. New for
production: with `NODE_ENV=production` (production and AWS staging), a staff
client's host must be one of its own product's sites in section 53's table
(`lab.healthidentitydirectory.com` or `lab.staging.healthidentitydirectory.com`
for `lab`, and so on), so its sign-ins pass that product's gate; another host
is refused at start-up. No wildcard, administration or issuer host; no port or
IP address in production.

The product site is the origin the edge names in `X-HID-Edge-Origin` (the
edge deletes any value a client sends). Every answer below carries
`Cache-Control: no-store` and `Referrer-Policy: no-referrer`; redirects are
`303` to configured addresses or the checked return path, never to an
address read from the request.

| Route (under `/api/v1`) | Answer |
| --- | --- |
| `GET /auth/sso/start?return_to=<path>[&prompt=none\|login]` | With a live session of this product (the session's kind is the client's and, for staff, it was issued for this site's product), unless `prompt=login`: `303` to `return_to`. Otherwise `303` to the provider's authorization endpoint (`client_id`, `redirect_uri=https://<host>/api/v1/auth/sso/callback`, `response_type=code`, `scope=openid`, `state`, `nonce`, S256 `code_challenge`, `max_age` = the absolute lifetime of the client's kind (`AUTH_ABSOLUTE_TTL_SECONDS` for staff, `AUTH_PATIENT_ABSOLUTE_TTL_SECONDS` for patients), `prompt` when given) with the transaction cookie. `return_to` must be a page path on this host (no other host, scheme, `//`, `\`, dot segment, encoded `/`, `\` or control character, encoded unreserved character, fragment, `/api/` route or Health ID); anything else becomes `/`. Over a live session, `prompt=login` makes the callback accept only that session's account and end the earlier sign-in. Provider unreachable: `303` to the client's `sign_in_path` |
| `GET /auth/sso/callback` | Signed in: the three session cookies a sign-in sets, `303` to the transaction's return page. A quiet attempt answered `login_required` (or `interaction_required`, `consent_required`, `account_selection_required`): `303` to the provider again, without `prompt`, with a new transaction. Anything else, the product gate's refusals included: no session, `303` to `sign_in_path`, nothing in the address |
| `POST /auth/sso/backchannel-logout` | Form `logout_token`, server to server, no cookie, CSRF token or Origin. `200` (empty) when accepted; `400 SSO_LOGOUT_TOKEN_INVALID` when refused (also a reused `jti`); `413` over 16 KiB; `503 SSO_PROVIDER_UNAVAILABLE` when the key set cannot be read |
| `POST /auth/sso/logout` | Product sign-out. With a live session it is admitted exactly as `POST /auth/logout` (a session, by bearer or by cookie with its Origin and CSRF checks; any session kind, an account-only outreach session included), and today's sign-out runs first (the session ends, the cookies are cleared, `auth.logout` is audited). With no live access token (none, or one that no longer verifies) it still answers, as hid-system#142 did and the patient website relies on: the request must come from an allowed Origin (`403 ORIGIN_DENIED` otherwise, unless it names a bearer token); a refresh cookie must come with its CSRF token (`403 CSRF_VALIDATION_FAILED` otherwise; nothing ends, nothing is cleared); a sign-in of the client's kind that the refresh cookie could still renew is ended as today's sign-out ends one (reason `logout`, a `logout` session event, `auth.logout` audited), and with none nothing ends; the cookies are cleared. When a sign-in was ended, every other unrevoked sign-in of that account and kind ends too (reason `sso_logout`). Then `200 { "endSessionUrl": "<end_session_endpoint>?client_id=…&post_logout_redirect_uri=https%3A%2F%2F<host>%2F" }` for the frontend to open. It never carries `id_token_hint`. Provider unreachable: `503 SSO_PROVIDER_UNAVAILABLE` (this product is signed out all the same). `POST /auth/logout` itself is unchanged (`204`) |

Cookies of the hand-off, each `HttpOnly`, `Secure`, `Path=/`, no `Domain`,
`SameSite=Lax`: `__Host-hid_sso_tx_<16 hex>` (the transaction: state, nonce,
PKCE verifier, return page, client; HMAC-signed with a key derived from
`AUTH_SIGNING_SECRET`; 10 minutes; spent once, by digest, in
`auth.sso_spent_tokens`; cleared by its callback) and `__Host-hid_sso_fallback=1`
(2 minutes after start or callback sent the browser to `sign_in_path`; while it
is present start never hands off quietly, and while the provider stays
unreachable it sends the browser to `/`, so no page loops).

### The session: a password sign-in on that site (Q88, Q92 B)

The callback issues the session through `TokenService.issue`, the code a
password sign-in uses, for staff and patients alike:

- **Staff.** The ID token must say the person signed in with a password
  (`amr` contains `pwd`; a second factor the provider also lists is
  accepted, never required); otherwise it is refused (`staff_password`). The
  session's product is the client's site's product (section 53), taken from
  the configured client and never from the request (a navigation from `auth.`
  carries no product `Origin`). So the same product gate applies: only the
  memberships admitted on the site (section 53's `facilityAdmittedOnProduct`:
  the Q88/Q90 permission and kind rule, then Q97's own-job rule, so a
  hospital clinical membership opens only `ehr.` and `migrate.` through
  single sign-on too), and the session's `actor.products` lists every site
  the login can open, as for a password sign-in; `403 PRODUCT_NOT_AUTHORISED` or `403
  NO_ACTIVE_FACILITY_MEMBERSHIP` refuse it, recorded exactly as for a password
  sign-in (one `auth.login.refused` audit row with `reason` and `product`, plus
  `singleSignOn`; no `login_failed` row, nothing counted towards the lockout),
  and the browser is sent to the site's own sign-in page with no session; a
  verified staff login with no membership gets its account-only session on
  `outreach.` only, with `outreach.`'s short idle lock; and the refresh token
  is bound to the product (`<session>.<secret>.<product>.local`), so refresh
  and every request keep the gate exactly as for a password sign-in.
- **Patients** on the patients' site (`web`), as a patient password sign-in.

The account must be active and not disabled. The family records the client,
the provider `sid` and the provider `auth_time` (`auth.session_single_sign_on`;
the ID token is not kept). The sign-in's absolute end, and a patient's
recent-sign-in check (`PATIENT_RECENT_AUTH_REQUIRED`), count from that
`auth_time`; idle and absolute lifetimes are otherwise those of a password
sign-in of that kind and site. A provider sign-in older than the account's
`password_changed_at` (five seconds' allowance) is refused
(`stale_provider_sign_in`), so a provider session from before a password
recovery opens nothing. The session is issued only at the account token
version read in the same statement as `password_changed_at`; a reset or
recovery that commits between that check and the issue raises the version, and
the hand-off is refused the same way (`stale_provider_sign_in`). Every other check of #142 is kept: `state` (single
use), `nonce`, S256 PKCE, `iss`, `aud`/`azp`, `exp`, `iat` within five
minutes, `auth_time` against `max_age`, `sid`, `sub` an account id,
`hid_kind` the client's kind, asymmetric signatures only.

A success is audited as a password sign-in's (`auth.login`, with
`singleSignOn` and, for staff, `product`); its session event
`login_succeeded` carries `sso_client`. A refusal other than the product gate
is a `login_failed` session event with `authentication_method: "sso"`, the
client and a reason (never a token, code or account value).

### Sign-out everywhere

Back-channel logout ends every unrevoked staff or patient sign-in that the
provider session `sid` opened, whichever product (revocation reason
`sso_logout`, a `revoked` session event each, one `auth.sso.backchannel-logout`
audit row), or, when the token names only `sub`, every staff and patient
sign-in of that account. Product sign-out also ends every other sign-in of
the account of the same kind, including one made on a product's own sign-in
page and the account's sign-ins on other devices. The other sites keep their
cookies until a request reaches Identity: then a refused `POST /auth/refresh`
clears them, as today, and so does a refused `GET /auth/session` on a single
sign-on site when nothing of the sign-in can still renew. That refused refresh
of a sign-in ended with reason `sso_logout` is an ended sign-in, not a stolen
refresh token: `401`, one `refresh` session event with outcome `denied` and
details `{ reason: "session_ended", revocation_reason: "sso_logout",
session_kind }`, and its family is left as it is. No `reuse_detected` event is
written for it. A refresh of a session ended for any other reason is answered
as production answers it today.

### What the provider must do (to confirm before switching on)

Discovery at `<issuer>/.well-known/openid-configuration` whose `issuer` is
exactly `AUTH_SSO_ISSUER` and whose authorization, token, key-set and
end-session endpoints are all on that origin; the code flow; S256 PKCE; ID
tokens signed with ES256, PS256, RS256 or EdDSA; ID token claims `iss`, `aud`
= client id, `exp`, `iat`, `nonce`, `sub` = the Identity account id (UUID),
`sid`, `auth_time`, `hid_kind` (`staff` or `patient`) and, for staff, `amr`
containing `pwd`; a token response with `access_token` and `token_type` as
well as `id_token`; logout tokens per Back-Channel Logout 1.0; and, per
client, `redirect_uris`, `post_logout_redirect_uris` and
`backchannel_logout_uri` as above, with `backchannel_logout_session_required`,
PKCE required and no consent screen. The provider ends its sessions whenever
the account's `token_version` changes (suspension, reactivation, password
recovery, deletion).

### Database (0127)

`auth.session_single_sign_on` (family, account, client, provider sid,
authenticated at; one row per sign-in family, only for the root session of a
staff or patient sign-in of the client's kind, never changed or deleted:
`auth.guard_session_single_sign_on_change()`) and `auth.sso_spent_tokens`
(purpose, sha256 digest, expiry). `hid_identity_runtime` holds `SELECT,
INSERT` on the first and `SELECT, INSERT, DELETE` on the second; no other
runtime holds anything on either. The suite is
`services/ehr-api/database/tests/sso-relying-party.integration.sql`.

## FR-1. No typed reason for a first signature or a first activation (wave 1, no migration)

Owner decision of 18 November 2026: signing a note or activating a
prescription for the first time needs no typed reason. A reason is still
needed to change anything already signed or active. ehr-api only; no
migration, no new setting. `schema.integration.sql` is unchanged.

### Request bodies

`changeReason` becomes optional in three bodies: `PATCH
/ehr/patients/:patientId/encounters/:encounterId/clinical-notes/:noteId`
(UpdateClinicalNote), `PATCH .../prescriptions/:prescriptionId`
(UpdatePrescription) and `PATCH .../lab-requests/:requestId`
(UpdateLabRequest). Q105 adds two more: `PATCH
/ehr/patients/:patientId/encounters/:encounterId` (UpdateEncounter) and
`POST .../clinical-notes/:noteId/revisions` (new note text). When it is
sent, the rules are unchanged: a string, trimmed, 3 to 500 characters,
never `null` (`400` from validation otherwise). Diagnosis updates and
vitals corrections still require it in the body.

### When the server records a fixed reason

| Change | Typed reason | What is recorded in `ehr.record_versions.change_reason` |
| --- | --- | --- |
| A draft note signed (`status: "signed"`) with no other field (no `title`), and the note's version history shows it was never signed or amended | Not needed | `First signature (no reason needed)` |
| A draft prescription activated (`status: "active"`) with no other field (no `frequency`, `instructions` or `endsOn`; `allergyAcknowledgement` may be sent), and its version history shows it was never active, on hold or completed | Not needed | `First activation (no reason needed)` |
| Either of the above with a typed reason | Optional | The typed reason |
| Q105 adds: a lab request's first activation, starting and finishing a visit, and edits to a draft note, prescription or lab request that was never signed or active (see the Q105 section for the conditions and the recorded reasons) | Not needed | The Q105 fixed reason |
| Anything else: amend, hold, resume after a hold, stop or cancel (drafts included), entered in error (drafts and visits included), completing an order, any change to something already signed or active, a visit's chief complaint | **Required** | The typed reason |

"First" is checked against the record's version history, not only its
current status, and fails closed: if the record's create version cannot be
read, a reason is required. The `record_versions` row still records who
changed it and when, as before.

A missing reason where one is required answers:

```
400 { "code": "CHANGE_REASON_REQUIRED", "detail": "Please say why you are changing this.", ... }
```

before anything is written. For prescriptions the reason rule is decided
before the allergy check; the allergy check itself is unchanged, so an
allergy match on a first activation still answers `409
ALLERGY_ACKNOWLEDGEMENT_REQUIRED` until the acknowledgement is sent. For lab
requests and visits, a change that can never go without a typed reason
answers the `400` before the request reaches the database; one that might
(a lab request's first activation or draft edit, a visit's start or finish)
is decided under the row lock (Q105).

### Audit

When a fixed reason is used, the update's audit row (`ehr.note.update` or
`ehr.prescription.update`) carries `fixedReason: "first_signature"` or
`"first_activation"`. Q105 adds `"draft_edit"`, `"visit_start"` and
`"visit_finish"`, and the same field on `ehr.lab-request.update`,
`ehr.encounter.update` and `ehr.note-revision.create`. With a typed reason
the audit details are unchanged (the typed text is never in the audit row).

### Extended by Q105

Owner question 6 was answered yes on 18 November 2026: the first activation
of a lab request, starting and finishing a visit, and edits to drafts no
longer need a typed reason. The request bodies, the table, the `400` and
the audit above include it; the Q105 section has the conditions and the
recorded reasons. For notes and prescriptions, a draft edit (and an edit
sent with the first signature or first activation) now records a fixed
reason too.

### Screen change needed (Akos frontend branch)

The note "Sign" and prescription "Activate" actions may send no
`changeReason`. Since Q105, starting or finishing a visit, a lab request's
first send and draft edits may send none too (see Q105's Website section).
Every other change keeps asking for a reason and shows the server's plain
message on `CHANGE_REASON_REQUIRED`.

## EHR-C1. The open visit today, and starting a visit without a duplicate (wave 1, no migration)

Akos P0-2 and N-3. ehr-api only; no migration, no new setting. "Today" is
the calendar day in Lagos (`Africa/Lagos`, UTC+1) until international
settings (P2-4). Both routes still need the patient's consent (normal
`read_records` or `write_records` grant) until the waiting list (EHR-C7)
lands; a refusal is `403 CONSENT_REQUIRED` and is audited as today.

### `GET /ehr/patients/:patientId/encounters/open-today`

Permission `ehr.encounter.read`. `patientId` is the UUID (never a Health
ID). Answers `200`:

```json
{ "day": "2026-11-18", "timeZone": "Africa/Lagos", "encounter": { ...visit... } }
```

`encounter` is the newest visit of this patient at this facility that is
open (`planned`, `in_progress` or `on_hold`) and was started on today's Lagos
day (from 00:00 to before 24:00 Lagos time), or `null` when there is none.
The imported paper records visit is never returned. The visit has the same
fields as `GET .../encounters/:encounterId`. Audited as
`ehr.encounter.open-today` with `day` and `found` (true or false).

### `POST /ehr/patients/:patientId/encounters` with `reuseOpenVisit`

The create body gains `reuseOpenVisit` (optional boolean, never `null`).

- Absent or `false`: exactly as before (the Idempotency-Key digest of a body
  without it is unchanged, and the answer has no new field).
- `true`: only with `status` `planned` or `in_progress` (otherwise `400
  REUSE_OPEN_VISIT_NEEDS_OPEN_STATUS`, "To use the open visit today, start
  the visit as planned or in progress."), and only with a `startedAt` on
  today's Lagos day by the server's clock (otherwise `400
  REUSE_OPEN_VISIT_STARTED_AT_NOT_TODAY`, "To use the open visit today, the
  visit must start today (Lagos time). Check the date and time on this
  device."). So a device whose clock is behind cannot create a visit dated
  yesterday that no later lookup finds, and a planned visit for another day
  is booked without `reuseOpenVisit`. Both checks run before the database
  is touched. The server takes a transaction
  lock for this patient at this facility
  (`pg_advisory_xact_lock(hashtextextended('ehr.open-visit:<facility>:<patient>', 0))`)
  **before** it looks for today's open visit, and holds it until the
  transaction ends. If an open visit today exists, it is answered and
  nothing is created; otherwise the visit is created. Two requests at the
  same moment therefore give one visit.

The answer is `201` with the visit plus `reusedOpenVisit: true` (an
existing visit) or `false` (a new one). When `reusedOpenVisit` is `true`,
the answer is the existing visit as it is: its `encounterType`, `status`,
`startedAt` and `chiefComplaint` are the existing visit's, not the request's
(an `emergency` request can get back an `ambulatory` visit that is
`on_hold`); the screen shows the visit it got back. An idempotent replay of
the same request answers the same visit, with `reusedOpenVisit: false` only
when that request created it: the visit's create version in
`ehr.record_versions` has the same correlation id and account as the
Idempotency-Key's create version (both are written by the request that
created them). Only if either version cannot be read does the replay fall
back to comparing creation times. A client must not send the same
`X-Correlation-Id` on two different requests. The audit row
(`ehr.encounter.create`) carries `reusedOpenVisit` and `day`.

### Screen change needed (Akos frontend branch)

Before "Start visit", read `open-today` and offer to continue the open
visit; when starting, send `reuseOpenVisit: true` so a double tap or two
staff at once do not make two visits.

## EHR-C3. Latest vitals for a patient (wave 1, no migration)

Akos P1-14. ehr-api only; no migration, no new setting.

### `GET /ehr/patients/:patientId/vitals/latest`

Permission `ehr.vital.read`. `patientId` is the UUID (never a Health ID).
Read under the patient's consent (`read_records`), like every vitals read.
A refusal answers `403 CONSENT_REQUIRED` and is audited (`ehr.vital.latest`,
outcome `denied`); a read is audited as `ehr.vital.latest` with
`measureCount` (never the values). Answers `200`:

```json
{
  "facilityId": "<uuid>",
  "measures": {
    "bloodPressure": { "value": { "systolicMmhg": 128, "diastolicMmhg": 84 }, "recordedAt": "...", "vitalId": "<uuid>", "encounterId": "<uuid>", "corrected": false },
    "pulseBpm": { "value": 76, "recordedAt": "...", "vitalId": "<uuid>", "encounterId": "<uuid>", "corrected": true },
    "temperatureC": { "value": 37.2, "...": "..." }
  }
}
```

Rules:

- Only this facility's vitals for this patient.
- For each measure (`heightCm`, `weightKg`, `temperatureC`, `pulseBpm`,
  `respiratoryRate`, `bloodPressure`, `oxygenSaturationPercent`) the newest
  reading (by `recordedAt`, then entry time) that has that measure. A measure
  with no reading is left out of `measures`.
- The vital's current correction is applied first (the correction's values
  over the original ones, as the patient record already applies them);
  `corrected` says whether the reading's current correction set this measure
  (per measure, not per reading: a correction that changes only the pulse
  leaves the weight of the same reading `corrected: false`; for
  `bloodPressure`, true when the correction set either half of the pair).
- Blood pressure is one measure and is always the systolic and diastolic
  pair from the same reading; it is never mixed across readings.
- Vitals of a visit entered in error are left out. (A single vital entered
  in error waits for EHR-C8b, migration 0142.)
- Values are JSON numbers (the per-visit vitals list still returns numeric
  columns as strings, unchanged).

### Screen change needed (Akos frontend branch)

The patient header or chart may show "Latest vitals" from this route, one
call per patient, and label each value with its date.

## EHR-C8a. A completed visit entered in error (wave 1, no migration)

QA open question. ehr-api only; no migration, no new setting.

### `PATCH /ehr/patients/:patientId/encounters/:encounterId`

A `completed` visit may now move to `entered_in_error` (before, a completed
visit could not change status). The body is the usual UpdateEncounter body,
and **a typed `changeReason` is required** (3 to 500 characters; it is
recorded in `ehr.record_versions` as for every change). Since Q105 the body
may leave `changeReason` out, but only to start or finish a visit; entering
a visit in error still needs a typed one:

```json
{ "expectedRowVersion": 3, "status": "entered_in_error", "changeReason": "Wrong patient chosen" }
```

Refusals. The two `400`s come first, before the visit is read; the `409`s
are checked under the visit's row lock, before anything is written:

| Answer | When |
| --- | --- |
| `400` (validation) | A `changeReason` shorter than 3 characters after trimming (a blank one included), longer than 500, or `null` |
| `400 CHANGE_REASON_REQUIRED` "Please say why you are changing this." | No `changeReason` (Q105 lets the body leave it out, but only for a start or finish) |
| `409 IMPORTED_VISIT_NOT_ENTERED_IN_ERROR` "The imported paper records visit cannot be marked as entered in error." | The visit is the patient's imported paper records visit (0113) |
| `409 VISIT_HAS_OPEN_ORDERS` "Cancel or stop this visit's prescriptions and lab requests, drafts included, before marking it as entered in error." | The visit still has a `draft`, `active` or `on_hold` prescription or lab request (so no pharmacy or lab keeps acting on a visit that should not exist; a draft counts because it could otherwise be activated later) |
| `409 VISIT_HAS_SIGNED_NOTES` "Mark this visit's signed notes as entered in error before marking the visit as entered in error." | The visit still has a `signed` or `amended` note (so the patient's own record never lists a note of the visit; see below) |
| `409 INVALID_ENCOUNTER_TRANSITION` | A completed visit to any status other than `entered_in_error` (unchanged) |

On success the audit row (`ehr.encounter.update`) carries
`completedVisitEnteredInError: true`. Entering a planned, in-progress or
on-hold visit in error is unchanged.

### Nothing new on a visit entered in error (any visit, not only a completed one)

Every path that adds to a visit or starts something on it now reads the
visit first, under a `FOR SHARE` row lock, and refuses a visit entered in
error with
`409 VISIT_ENTERED_IN_ERROR` "This visit was marked as entered in error. Nothing new can be added to it or started on it."

| Route | Refused on a visit entered in error | Still allowed |
| --- | --- | --- |
| `POST .../encounters/:encounterId/prescriptions` | always | |
| `PATCH .../prescriptions/:id` | activate, resume, complete, any edit | `on_hold`, `cancelled`, `entered_in_error` |
| `POST .../prescriptions/:id/pharmacy-work-item` | always (before the pharmacy is called) | |
| `POST .../encounters/:encounterId/lab-requests` | always (before the laboratory is called) | |
| `PATCH .../lab-requests/:id` | activate, resume, complete, any edit | `on_hold`, `cancelled`, `entered_in_error` |
| `POST .../lab-requests/:id/lab-work-item` | always (a read, no lock: this route writes nothing in the EHR) | |
| `POST .../encounters/:encounterId/clinical-notes` | always | |
| `PATCH .../clinical-notes/:id` | sign, title change | `entered_in_error` |

The visit is locked before the order or note row, in every path. Marking a
completed visit as entered in error locks the visit `FOR UPDATE` before it
counts orders and signed notes, so a concurrent activation, resume or
signature either commits first (and the count refuses with 409) or waits and
then gets `409 VISIT_ENTERED_IN_ERROR`. `FOR SHARE` does not conflict with the
`FOR KEY SHARE` that foreign keys take, so orders on the same visit do not
wait for each other. A replay of an Idempotency-Key that was already
completed is answered as before.

### What the patient sees afterwards

- The patient's own record (`GET` patient self records) lists only completed
  visits, so the visit disappears from it.
- The notes in that read are unchanged for the patient: a signed note of a
  visit that is not completed yet is still listed, as before. The read leaves
  out a note only when its visit can be seen and is entered in error
  (`not exists (... status = 'entered_in_error')`). The patient-self policy on
  `ehr.encounters` hides every visit that is not completed, so for the patient
  this changes nothing; a completed visit entered in error has no signed note
  left (`VISIT_HAS_SIGNED_NOTES`), so its notes never reach the patient.
- The emergency read (staff, who can see every visit at the facility) now
  leaves out notes of a visit entered in error.
- Known gap, unchanged from before: a planned, in-progress or on-hold visit
  can still be entered in error with signed notes in it (that path has no new
  check), and the patient's record still lists those notes. Closing it needs
  a database helper the patient's read can call (a migration), or the same
  `VISIT_HAS_SIGNED_NOTES` rule on that path: an owner decision.
- The patient chat reads visits, notes, prescriptions, tests, diagnoses and
  vitals only from completed visits (unchanged; the database's patient-self
  policies hide diagnoses and vitals of other visits).

### Screen change needed (Akos frontend branch)

Offer "Entered in error" on a completed visit, ask for the reason, and show
the plain message of each `409` (for open orders, link to the visit's
prescriptions and lab requests).

## ID-0. NIN status on staff answers, and the NIN service breaker (Akos wave 1, no migration)

Owner decision of 18 November 2026: screens say "NIN Verified" or "NIN Not
Verified". The service answers one field with two values and the screen
shows the words.

### `ninStatus`

`ninStatus` is `"verified"` or `"not_verified"`. No other value is ever
returned, and no stored verification value is passed through as it is.

- `"verified"`: the patient holds a NIN that was checked and has not been
  revoked (`identity.patient_identifiers`: `identifier_type = 'nin'`,
  `verified`, `revoked_at is null`).
- `"not_verified"`: everything else, including a NIN that was revoked.

Added to:

- `POST /api/v1/identity/patient-lookup`: `patient.ninStatus`, beside
  `patient.version`. The lookup is audited as before
  (`identity.patient.lookup`).
- Every registration-case answer (`POST identity/nin/resolve`,
  `GET identity/registration-cases/:caseId`, `approve-new`,
  `link-existing`, and their replays): top-level `ninStatus`. A case is
  `"verified"` when its NIN was checked and, once the case points at a
  patient, that patient still holds a checked NIN that is not revoked. Every
  case today has a checked NIN; `"not_verified"` cases arrive with ID-2.
- Desk search cards (ID-3a, lane B) use the same rule:
  `services/identity-api/src/identity/nin-status.ts` exports
  `patientHasVerifiedNinSql()` and `ninStatusOf()`.

### `GET /api/v1/identity/registration-capabilities`

Same permission and headers as before (`identity.registration.write`,
`X-Facility-Id`). The answer gains `nin.available` and `withoutNin`:

```json
{
  "nin": { "enabled": true, "state": "test-only", "available": true },
  "withoutNin": { "enabled": false },
  "newPatientRegistrationRequiresNin": true
}
```

Staging (deferred) answers
`{"nin":{"enabled":false,"state":"deferred","available":false},"withoutNin":{"enabled":false},"newPatientRegistrationRequiresNin":true}`.

- `nin.available` is `false` when NIN checks are off (`enabled: false`) or the
  breaker below is tripped; otherwise `true`.
- `withoutNin.enabled` is `false` until ID-2 (0130) ships desk registration
  without a NIN. `newPatientRegistrationRequiresNin` stays `true` until then.

### The breaker

Kept in memory in each Identity process (no table, no secret, no setting).

- A `503` from the NIN service trips it at once.
- Three other failures (a `5xx`, a bad answer, a network error) within 5
  minutes trip it.
- A NIN that does not match (`422 NIN_VERIFICATION_FAILED`) is an answer, not
  a failure, and does not count. Nor does a `4xx`.
- While tripped, `POST identity/nin/resolve` answers `503` with code
  `NIN_PROVIDER_UNAVAILABLE` and detail "The NIN service is not answering
  right now. Please try again in a minute." without calling the service. The
  refusal is audited (`identity.nin.verify`, outcome `failure`). A replay of
  an earlier request is still answered.
- After 60 seconds one check is let through. While that check waits for its
  answer, other checks are refused as above (so a busy desk does not send a
  burst of charged checks to a service that may still be down). Success
  closes the breaker and clears the count; a failure trips it again; a `4xx`
  leaves it as it was and lets the next check through. A check with no
  answer after 60 seconds no longer holds the place.
- NIN checks switched off (`NIN_PROVIDER_MODE=unavailable`) are a setting,
  not an outage: the breaker is not touched and no warning is logged. The
  desk gets `503` `NIN_PROVIDER_UNAVAILABLE`, "NIN verification is not
  configured", every time (not "try again in a minute"), audited as below.
  Deferred staging is unchanged (`NIN_PROVIDER_DEFERRED`).

Every failed `identity.nin.verify` audit row says whether the NIN was sent
to the NIN service. Details are `{ provider, errorType, code, providerCalled }`:
`providerCalled: true` when the service was asked and the check failed;
`providerCalled: false` when nothing was sent (deferred, switched off, or the
breaker refused it, which also adds `breaker: "open"`). `code` is the problem
code (for example `NIN_PROVIDER_UNAVAILABLE`). No NIN is ever written.

Every counted failure writes one warning log line with
`event: "identity.nin_provider.unavailable"`, the provider name, the error
code, the HTTP status, the failures in the last 5 minutes, the breaker state
and the correlation id. It never holds a NIN, a name or a date of birth.

### Screen change (Akos's frontend branch)

Show `ninStatus` as "NIN Verified" or "NIN Not Verified" on the patient
lookup and registration-case screens. When `nin.available` is `false`, tell
the desk the NIN service is not answering and to try again in a minute. Do
not offer registration without a NIN until `withoutNin.enabled` is `true`.

### Tests

`services/identity-api/src/identity/nin-status.spec.ts` (verified,
not_verified and revoked on the lookup and the case answer; breaker trip,
window, retry, recovery, log event; one check at a time while retrying, with
two desks at once; checks switched off do not trip it; the audit row says
whether the NIN was sent; capabilities; no answer contains the word the
owner ruled out). `nin-deferred-staging.spec.ts` exact bodies updated.

## SX-10. Registration-case list for the desk and approvers (Akos wave 1, no migration)

Default agreed in the 18 November plan: the desk sees its own cases, approvers
see every case at the facility.

```text
GET /api/v1/identity/registration-cases?view=mine|facility[&status=...][&limit=...][&cursor=...]
```

- Permission `identity.registration.write`, `X-Facility-Id`, and
  `X-Purpose-Of-Use` (`direct-care`, `emergency` or `healthcare-operations`,
  as on `GET registration-cases/:caseId`). `Cache-Control: no-store`.
- `view=mine` (the default): the cases this member's account started at this
  facility.
- `view=facility`: every case at this facility. It also needs
  `identity.registration.approve`; without it the answer is `403`
  `REGISTRATION_CASE_LIST_DENIED`, "Only staff who approve registrations can
  see every case at this facility." (audited, outcome `denied`).
- `status` (optional): one of `pending_new_identity_approval`,
  `review_required`, `resolved_existing_identity`, `linked_existing`,
  `approved_new_identity`, `rejected`, `cancelled`.
- `limit`: 1 to 100, default 50. `cursor`: the `nextCursor` of the previous
  page, as given. A cursor that is not one we gave answers `400`
  `REGISTRATION_CASE_CURSOR_INVALID`, "This page link is not valid. Start
  again from the first page."
- Any other query parameter (for example a Health ID) answers `400`. Health
  IDs are never taken in the URL.
- Only cases of the facility in `X-Facility-Id` are read, whatever else the
  member may read; another facility sees nothing.

Answer, newest first:

```json
{
  "view": "mine",
  "cases": [
    {
      "caseId": "uuid",
      "status": "approved_new_identity",
      "version": 2,
      "candidateCount": 0,
      "contactRecorded": true,
      "ninStatus": "verified",
      "patient": { "patientId": "uuid", "hid": "HID-QX7K2M" },
      "fullName": "Ada Fictional",
      "dateOfBirth": "1991-04-05",
      "createdAt": "2026-11-18T10:00:58.000Z",
      "updatedAt": "2026-11-18T10:05:58.000Z",
      "createdByMe": true
    }
  ],
  "nextCursor": null
}
```

The item has the same fields as `GET registration-cases/:caseId` (with
`ninStatus` from ID-0; `patient` only once the case points at a patient), plus
`fullName`, `dateOfBirth`, `createdAt`, `updatedAt` and `createdByMe`. No NIN
digits are read or returned (not even the last four), and candidates are not
listed; open one case for them.

Audit: one `identity.registration-case.list` row per answer, outcome
`success`, details `{ view, status, page: "first" | "next", count, caseIds,
patientIds }` (the patients the page shows). No names or dates of birth are
written to the audit row.

The facility view uses `registration_cases_facility_status_idx`
(facility, status, created_at desc) when filtered by status; the mine view
filters on the facility and the creating account.

### Screen change (Akos's frontend branch)

A "My registrations" list for the desk (`view=mine`) and an "All
registrations" list for approvers (`view=facility`), with "NIN Verified" /
"NIN Not Verified" from `ninStatus`, and "Load more" while `nextCursor` is
not null. Opening a row calls `GET registration-cases/:caseId`.

### Tests

`services/identity-api/src/identity/registration-case-list.spec.ts`: mine and
facility views, another facility sees nothing, the refusal and its audit row,
the success audit row, no NIN digits in the answer or the query, paging and
bad cursors, and query parameters (a Health ID is refused). Those run on a
fake database; one test checks that the Postgres suite below runs the read
the service sends, word for word.

`services/ehr-api/test/database/registration-case-list.integration.sql`
(rollback-only, run with the other ported suites by
`scripts/run-container-database-acceptance.sh`): the exact read, under
row-level security as `hid_identity_api_runtime` in Identity's transaction
context. A registration member of facility B reads none of facility A's
cases (also when naming facility A); a member without
`identity.registration.write` reads nothing; a platform reviewer, whom
row-level security lets read every facility, still gets only A's cases in
A's list; `view=mine` shows only the member's own cases; the status filter;
paging one case at a time through two cases with the same `created_at`, with
the cursor's text in Africa/Lagos time; and `ninStatus` for a case with no
patient yet (verified), a patient with a checked NIN (verified), a patient
whose NIN was revoked (not verified) and one with none (not verified).

`services/identity-api/src/identity/registration-case-list.http.spec.ts`
(supertest, the real security guard, audit interceptor and the global
validation pipe as `main.ts` sets it): `200` with `Cache-Control: no-store`
and the audit row; `403 PERMISSION_DENIED` without
`identity.registration.write`; `400 VALIDATION_FAILED` for
`?hid=HID-QX7K2M`, with nothing read and the Health ID written nowhere;
`400 PURPOSE_OF_USE_REQUIRED` without `X-Purpose-Of-Use`.

## SX-5. My staff profile, read only (no migration)

Akos P1-8, read part. The account menu's "My profile" for staff. Changing a
password while signed in (SX-6), preferences and home shortcuts (SX-7) come
later; until then `canChange` answers `false` for each, and the screen shows
no edit control.

| Route (under `/api/v1`) | Who | Answer |
| --- | --- | --- |
| `GET /identity/me/staff-profile` | Any staff session, by bearer or cookie, including a platform administrator with no facility membership. `X-Facility-ID` is optional; when sent it must be one of the caller's own facilities and only marks that facility as current. No permission is needed: it reads the caller's own account. | `200` below. A patient session: `403 PATIENT_SCOPE_DENIED`. An outreach account-only session (no facility membership): `403 NO_ACTIVE_FACILITY_MEMBERSHIP`. An `X-Facility-ID` that is not one of the caller's own facilities: `403 FACILITY_ACCESS_DENIED`. An account that is no longer active: `401 AUTHENTICATION_REQUIRED`. |

```json
{
  "accountId": "uuid",
  "name": "Ada Fictional",
  "email": "ada@example.test",
  "signIn": { "method": "password", "hasPassword": true, "passwordChangedAt": "2026-10-01T09:00:00.000Z" },
  "licence": { "numberHint": "4567" },
  "memberSince": "2026-01-05T08:00:00.000Z",
  "currentFacilityId": "uuid or null",
  "facilities": [
    { "id": "uuid", "membershipId": "uuid", "name": "Fictional Clinic", "roles": ["doctor"], "isPrimary": true, "isCurrent": true }
  ],
  "products": ["ehr", "migrate"],
  "canChange": { "name": false, "password": false, "preferences": false }
}
```

- `name` is the account's display name, else the staff record's full name.
- `signIn.method` is `password` or `single_sign_on` (how this session was
  signed in). `hasPassword` is `false` for a login that has never set one
  (Google only); `passwordChangedAt` is then `null`.
- `licence` is `null` when no licence number is recorded, or when the
  recorded one has no letter or digit (for example `--`), so `numberHint` is
  never `null`. Only the last four letters or digits are answered (the same
  rule as `identity.licence_number_hint`), never the full number.
- `facilities` and `products` are the session's own (every active
  membership this site admits, section 53), so the profile never shows a
  facility the session itself cannot use.
- The read is by the session's account id and subject together, active
  accounts only. The password hash is never selected.
- `currentFacilityId` is `null`, and every `isCurrent` is `false`, when no
  `X-Facility-ID` is sent.
- Audited on success and on refusal or failure (one row each time) as
  `auth.staff-profile.read`, resource `session`, at the `X-Facility-ID`
  facility when one is sent and with no facility otherwise; outcome
  `success`, `denied` (401 or 403) or `failure`. It is not audited as an
  `api.` request row: such a staff row needs a facility, and this route must
  answer without one. No patient is read.

Screen change (Akos frontend branch): the account menu gains "My profile",
which shows these fields; the licence is shown as "Licence number ending
4567".

## SX-9. Saved lists: this facility's OCR jobs and staff names (no migration)

Akos P1-10. OCR jobs no longer disappear when the page is left: the Migrate
desk reads this facility's jobs, newest first, a page at a time, and shows
who started each one by name. (The registration-case list is SX-10, lane A;
it uses the same names route.)

| Route (under `/api/v1`) | Who | Answer |
| --- | --- | --- |
| `GET /ocr/job-list[?status=<status>][&mine=true][&limit=<1-50>][&cursor=<nextCursor>]` | Staff with `ocr.job.read` at the `X-Facility-ID` facility (doctor, clinician, nurse, lab, admin). Purpose is always `healthcare-operations`, whatever `X-Purpose-Of-Use` says. | `200 { items, nextCursor }` below. No `X-Facility-ID`: `400 FACILITY_REQUIRED`. A facility the caller is not active at: `403 FACILITY_ACCESS_DENIED`. No `ocr.job.read`: `403 PERMISSION_DENIED`. Any other query key, a status that does not exist, `mine` other than `true`, a limit outside 1-50: `400 VALIDATION_FAILED`. A cursor this route did not make: `400 OCR_JOB_LIST_CURSOR_INVALID`, "This page of the list can no longer be opened. Start the list again." |
| `GET /identity/facility-staff-names[?membershipIds=<id>,<id>,…]` | Any staff member active at the `X-Facility-ID` facility. No permission beyond membership. | `200 { facilityId, staff, complete }` below. No `X-Facility-ID`: `400 FACILITY_REQUIRED`. A facility the caller is not active at: `403 FACILITY_ACCESS_DENIED`. A patient session: `403 PATIENT_SCOPE_DENIED`. More than 100 ids, or anything but comma-separated UUIDs: `400 VALIDATION_FAILED`. |

`status` is one of `queued`, `processing`, `extracted`,
`awaiting_validation`, `validated`, `rejected`, `failed`, `cancelled` (the
`ocr.jobs` status check as 0016 left it); an item's `status` is always one of
these. `mine=true` lists
only the jobs the caller started at this facility. `limit` defaults to 25.

```json
{
  "items": [
    {
      "id": "uuid",
      "documentId": "uuid",
      "status": "awaiting_validation",
      "createdAt": "2026-11-18T10:00:00.123Z",
      "createdByMembershipId": "uuid",
      "createdByMe": false,
      "attemptCount": 1,
      "maxAttempts": 3,
      "completedAt": null,
      "failedAt": null,
      "failureCode": null
    }
  ],
  "nextCursor": "opaque string, or null on the last page"
}
```

- Only this facility's jobs are read: the query filters on the request's
  facility, and row-level security on `ocr.jobs` (0013) allows only that
  facility as well. Another facility's jobs are never listed.
- No patient field is answered and no patient or document table is read.
  A job's patient is shown only when the job is opened with
  `GET /ocr/jobs/:jobId`, which checks access to that patient as today.
  No Health ID is ever accepted in this URL.
- `failureCode` is the stored code only (for example `PROVIDER_TIMEOUT`); the
  stored free-text summary is not answered.
- Paging is by `(createdAt, id)`, newest first, kept to the microsecond, so a
  page never repeats or skips a job. Pass `nextCursor` back as `cursor` with
  the same filters.
- Each answer writes one audit row, `ocr.job.list` (resource
  `ocr-job-list`), in the same transaction as the read (an ordinary
  READ COMMITTED transaction, not a read-only one: PostgreSQL refuses an
  insert in a read-only transaction), with the count, the job ids shown, the
  filters and whether it was the first page; if that row cannot be written
  nothing is answered. The route changes no job. The request itself is
  audited as `api.ocr.job.list.request`, on success and failure, with
  purpose `healthcare-operations` whatever `X-Purpose-Of-Use` or a `purpose`
  query key says (a `purpose` key is still refused as an unknown key).

```json
{
  "facilityId": "uuid",
  "staff": [
    { "membershipId": "uuid", "name": "Bola Fictional", "current": true },
    { "membershipId": "uuid", "name": null, "current": false }
  ],
  "complete": true
}
```

- The facility is the request's own, never one the caller names.
- `staff` holds the facility's members past and present, current members
  first, then by name. `current` is `false` once the membership, the staff
  record or the login has ended. `name` is `null` for a login that was
  deleted; the screen shows "Former staff member".
- Only names are answered: no email, role, licence or account id.
- Without `membershipIds`, at most 500 names; `complete` is `false` when
  there are more, and the screen then asks for the ids on its page with
  `membershipIds`.
- Audited on success and refusal as `api.identity.facility-staff-names.read`,
  with purpose `healthcare-operations` (the purpose it always reads under)
  whatever `X-Purpose-Of-Use` says.

Screen change (Akos frontend branch): the Migrate desk gains a "Documents
read here" list (status filter, "Only mine", "Load more"), showing "Started
by <name>" from the names route; a row opens the job as today.

## ORD-3. Own pharmacy and laboratory progress on prescriptions and lab requests (wave 1, no migration)

Akos items N-1b and N-8 (build plan of 18 November 2026, lane D). A
clinician sees, on each prescription and lab request, where it is in this
facility's own pharmacy or laboratory, for example "Dispensed 11:05". No
migration, no new setting and no new secret: the internal calls use the
ehr-api to pharmacy-api and ehr-api to lab-api workload identity that
already exists (`PHARMACY_*` and `LAB_*` settings in ehr-api).

### Internal routes (ehr-api only)

`POST /api/v1/pharmacy/work-items/progress` and
`POST /api/v1/lab/work-items/progress`. Read-only: they change nothing.
Internal caller `ehr-api` only (`x-hid-internal-caller` plus the service
token or workload JWT, as `accept-ehr-prescription` and `accept-ehr-order`),
sent with the clinician's own bearer token or cookie, `X-Facility-Id` and
`X-Purpose-Of-Use` (`direct-care` or `emergency`). Permission:
`ehr.prescription.read` (pharmacy) and `ehr.lab-request.read` (lab), the
clinician's EHR permissions, not a pharmacy or lab one. The read depends on
the clinician's own consent grant (row-level security and Identity's
decision), never on a pharmacist's or laboratory member's grant. Because the
browser request behind them is a read, the guard does not ask Identity for
the browser-write (Origin and CSRF) check of a forwarded cookie on these two
routes only (`ReadOnlyPost`), and the patient check
(`service/authorization/check`, scope `read_records`) reports the browser
method as `GET` (`X-HID-Original-Method`), not the POST of the internal
call: the website sends no CSRF token on a read, so a reported POST would be
refused. Answer `200`, `Cache-Control: no-store`.

Request (ids only, in the body; never a Health ID, never in the URL):

| Field | Pharmacy | Lab |
| --- | --- | --- |
| `patientId` | the patient's UUID | the patient's UUID |
| ids | `sourceEhrPrescriptionIds`: 1-100 distinct UUIDs | `sourceEhrOrderIds`: 1-100 distinct UUIDs |

Any other field is refused (`400 VALIDATION_FAILED`).

Answer: `{ "items": [...] }`, one item per id asked, in the order asked.

Pharmacy item: `sourceEhrPrescriptionId`, `status`, `receivedAt`,
`dispensedAt`, `reversedAt` (ISO times or `null`).

| `status` | Meaning |
| --- | --- |
| `not_received` | no work item here that the clinician may read |
| `received` | the pharmacy has it and has not dispensed it |
| `dispensed` | dispensed at `dispensedAt` |
| `dispensing_reversed` | dispensed, then the dispensing was reversed at `reversedAt` |

Lab item: `sourceEhrOrderId`, `status`, `receivedAt`, `collectedAt`
(the first sample taken), `lastResultAt` (the latest released result).

| `status` | Meaning |
| --- | --- |
| `not_received` | no work item here that the clinician may read |
| `received` | the laboratory has it; no sample taken yet |
| `sample_collected` | a sample was taken (collected or received; not rejected, cancelled or entered in error) |
| `some_results_ready` | some of its tests have a released result |
| `results_ready` | every test it asks for has a released result |

A result counts only while its current version is released and not marked
entered in error (the laboratory work list's rule). Only this facility's
own work is read: work on an order route to another facility is left out
(its progress is on the EHR item's `orderRoute`).

Refusals: `401` without the internal caller proof; `403 PERMISSION_DENIED`
without the EHR read permission; `403 PHARMACY_ACCESS_DENIED` or
`403 LAB_WORK_ITEM_ACCESS_DENIED` when Identity refuses the patient read,
or Identity's own `403` passed on (both audited with outcome `denied`); `400`
for a bad body or purpose.

Runtime proof: `services/ehr-api/scripts/verify-order-routes-runtime.mjs`
step 10b signs a doctor in with the cookie, reads through ehr-api a
prescription dispensed by the hospital's own pharmacist (`dispensed`, with
the dispensing's time) and a lab request with results released by its own
laboratory (`results_ready`), each under the doctor's own grant only; a
routed prescription and lab request stay `not_received`; a doctor without a
grant gets `403` from ehr-api, pharmacy-api and lab-api, and the denials are
audited with the patient.

Audit: every lookup writes one row naming the patient,
`pharmacy.work-item.progress.read` or `lab.work-item.progress.read`
(resource `*-work-item-collection`, the facility), with `requestedCount`,
`foundCount`, the work item ids found and `breakGlass`, in the read's
transaction. The Lab request row `api.lab.work-item.progress.request` is
written as for other Lab routes.

### ehr-api answers

`GET .../encounters/:encounterId/prescriptions` and
`GET .../prescriptions/:prescriptionId`: each prescription gains
`ownProgress` with the pharmacy fields above (`status`, `receivedAt`,
`dispensedAt`, `reversedAt`).

`GET .../encounters/:encounterId/lab-requests` and
`GET .../lab-requests/:requestId`: each lab request gains `ownProgress` with
the lab fields above (`status`, `receivedAt`, `collectedAt`, `lastResultAt`).

`ownProgress.status` is also:
- `not_received` for a draft (never sent, so not asked about);
- `unknown` (all times `null`) when the pharmacy or laboratory could not be
  asked or answered something unexpected: down, slower than 3 seconds,
  refused, or a malformed answer. The EHR answer itself never fails because
  of it.

ehr-api asks once per page (at most 100 ids per call), after its own read
and audit, with the clinician's own credentials. Nothing else in these
answers changes.

Screen change (Akos frontend branch): show `ownProgress` on each order row,
for example "Received 10:40", "Dispensed 11:05", "Sample taken 09:30",
"Results ready 11:05"; show "Progress not available right now" for
`unknown`, and nothing for `not_received` on a draft.

## ORD-10 phase 1. Same-medicine warning when prescribing (wave 1, no migration)

Akos items N-9c and P0-5 (build plan of 18 November 2026, lane D). A
warning, never a block. Phase 2 (with Release B) adds medicines of the same
class (ATC).

### The check before saving

`POST /api/v1/ehr/patients/:patientId/duplicate-medicine-check`, direct care
only, permission `ehr.prescription.write` (as the allergy check). Read-only;
answer `200`, `Cache-Control: no-store`.

Request: `medicationDisplay` (1-500 characters), optional
`medicationCodeSystem` (up to 255), `medicationCode` (up to 100) and
`excludePrescriptionId` (a UUID: the prescription being changed or
activated, left out). Any other field is refused.

Answer:

| Field | Value |
| --- | --- |
| `checked` | `true` when the check ran |
| `matches` | the current prescriptions of the same medicine, newest first |
| `message` | plain words for the form, or `null` when there are no matches |

Each match: `prescriptionId`, `encounterId`, `medicationDisplay`, `status`
(`draft`, `active` or `on_hold`), `startsOn`, `endsOn` (`YYYY-MM-DD` or
`null`), `createdAt`, `matchedBy` (`code` or `name`).

Messages: "This patient already has a current prescription for this
medicine. Check it before you continue." or "This patient already has N
current prescriptions for this medicine. Check them before you continue."

What is compared: only this patient's prescriptions at this facility that
the clinician may read under consent, and only current ones (draft, active
or on hold, not ended before today in Lagos), at most 500, newest first.
They match when the codes are the same (and the code systems are the same,
or one is missing), or when the two name a medicine in common once
numbers, units, dose form and anything in brackets are set aside
(`matchedBy: name`). A strength ends the name of its medicine and a
separator (`/`, `+`, `&`, `,`, "and", "with", "plus") starts the next, so a
combination product names each of its medicines. A number is set aside on
its own: the word after it is kept, and a name such as B12 or D3 keeps its
digits. Examples: "Amoxicillin 500 mg capsules" and "amoxicillin 250mg"
match; "Codeine 30 paracetamol 500" and "Paracetamol 1 g" match (both hold
paracetamol); "Amoxicillin" and "Ampicillin" do not; "Vitamin B12 1000 mcg"
and "Vitamin B6 50mg" do not; "Insulin 70/30 mixtard" and "Insulin" do not
(words after the last strength with no separator before them belong to the
medicine before it).

Refusals: `403 CONSENT_REQUIRED` when Identity refuses the read, or when the
database does not allow this patient's records to be read here (so "no
match" never stands for "could not read"); `400` for a bad body or purpose.

Audit: `ehr.prescription.duplicate-check` naming the patient, with
`comparedCount` and `matchCount` only, never the medicine.

### On a new prescription

`POST .../encounters/:encounterId/prescriptions` (unchanged request and
status) gains `duplicateMedicines` with the same shape, compared with the
patient's other current prescriptions (the new one left out). It never
fails the create: when the check cannot run, `duplicateMedicines` is
`{ "checked": false, "matches": [], "message": null }`. A prescription
created already cancelled, completed or entered in error gets
`{ "checked": true, "matches": [], "message": null }` without a check.

Screen change (Akos frontend branch): run the check when a medicine is
chosen and show `message` with the matches (medicine, status, dates) above
Save; Save stays enabled. After Save, show `duplicateMedicines.message` if
present.

## Q105. No typed reason for a lab request's first activation, starting and finishing a visit, and draft edits (no migration)

Owner decision of 18 November 2026 (owner question 6, answered yes; Akos
N-12: reasons only for things already signed or active). It extends FR-1 in
ehr-api only: no migration, no new setting, `schema.integration.sql`
unchanged. The rule and the fail-closed "first" check are FR-1's: "never
signed or active" is read from the record's version history
(`ehr.record_versions`), and if its create version cannot be read, a typed
reason is required.

### Request bodies

`changeReason` may now also be left out of `PATCH
/ehr/patients/:patientId/encounters/:encounterId` (UpdateEncounter) and `POST
.../clinical-notes/:noteId/revisions` (new note text). When sent, the rules
are unchanged (trimmed, 3 to 500 characters, never `null`). Diagnosis
updates and vital corrections still require it in the body.

### When the server records a fixed reason

| Change (no typed reason sent) | Condition | Recorded reason (`change_reason`) | Audit `fixedReason` |
| --- | --- | --- | --- |
| Lab request `status: "active"` from `draft` (may also change `priority` or `clinicalInformation`); it is then sent to Lab as before | never active, on hold or completed | `First activation (no reason needed)` | `first_activation` |
| Lab request `priority` or `clinicalInformation` while it stays `draft` | never active, on hold or completed | `Draft edit (no reason needed)` | `draft_edit` |
| Prescription `frequency`, `instructions` or `endsOn` while it stays `draft` | never active, on hold or completed | `Draft edit (no reason needed)` | `draft_edit` |
| Prescription `status: "active"` from `draft` together with those edits | as FR-1 | `First activation (no reason needed)` | `first_activation` |
| Note `title` while it stays `draft` | never signed or amended | `Draft edit (no reason needed)` | `draft_edit` |
| Note signed together with a `title` change | never signed or amended | `First signature (no reason needed)` | `first_signature` |
| New note text (`revisions`) on a `draft` note; the revision row's `change_reason` holds the same text | never signed or amended | `Draft edit (no reason needed)` | `draft_edit` (on `ehr.note-revision.create`) |
| Visit `status: "in_progress"` from `planned`, no other field | never in progress, on hold or completed | `Visit started (no reason needed)` | `visit_start` |
| Visit `status: "completed"` from `in_progress`, with or without `endedAt`, no `chiefComplaint` | never completed | `Visit finished (no reason needed)` | `visit_finish` |

A typed reason, when sent, is always recorded instead, and the audit details
are then unchanged (the typed text is never in the audit row).

### Still needs a typed reason

`400 CHANGE_REASON_REQUIRED`, "Please say why you are changing this.",
before anything is written, for: putting on hold, resuming after a hold,
cancelling (drafts included), entering in error (drafts and visits
included), completing a lab request or prescription, amending a signed note,
any change to an active, held or ended order, a visit's chief complaint, and
any of the changes in the table when the history shows the record was
signed or active before or cannot be read. For lab requests, a change to
`on_hold`, `completed`, `cancelled` or `entered_in_error` without a reason
answers the `400` before the request reaches the database; a draft's
activation or edit is decided under the request's row lock. For visits, a
change without a reason that can be neither a start (`in_progress`, no other
field) nor a finish (`completed`, with at most `endedAt`) answers the `400`
before the visit is read, so before EHR-C8a's `409`s (`VISIT_HAS_OPEN_ORDERS`
and the others); a move to `in_progress` or `completed` is decided under the
visit's row lock (a resume after a hold, or a start or finish the history
shows happened before, then answers the `400`). The allergy check on a prescription's activation is unchanged (409
`ALLERGY_ACKNOWLEDGEMENT_REQUIRED` until acknowledged). For notes and
prescriptions, EHR-C8a's 409 `VISIT_ENTERED_IN_ERROR` is unchanged and comes
first; for lab requests and visits, the early `400` above comes before it.

### Website

Akos's frontend may leave the reason box out for these changes. Every
other change keeps it.

## Q100 B. "No such patient" on the staff Health ID lookup (no migration)

Owner decision of 18 November 2026 (Q100, option B): a Health ID that no
patient has answers "No such patient" distinctly. identity-api only: no
migration and no new setting.

### `POST /api/v1/identity/patient-lookup`

Body unchanged (`hid` in the body, never in a URL; `purpose`). Answers:

| Case | Status | Body |
| --- | --- | --- |
| The patient opens (unchanged) | `200` | as before |
| No patient record of any status has this Health ID, and the Health ID is on the member's facility's side of the seals (below) | `404` | `{ "code": "PATIENT_NOT_FOUND", "detail": "No patient has this Health ID." }` |
| The patient exists but is not available here (another facility's patient without consent, not active, sealed tenant) | `404` | today's answer, unchanged (`code` `NOT_FOUND`, "Patient was not found or is not available") |
| The Health ID is on another side of the seals than the member's facility, or starts `ZDEM` or `ZQA` without being a sealed one, or the facility's side cannot be told (below) | `404` | today's answer, whether or not any record has the Health ID, never `PATIENT_NOT_FOUND` |
| The patient can be seen here but this lookup is not authorized | `403` | today's answer, unchanged; never counted toward the limit below |
| The staff account has had 30 lookups answered `404` in 10 minutes, at any of its facilities | `404` | today's answer (`404` `NOT_FOUND`) for 10 minutes to every lookup that finds no patient, never `PATIENT_NOT_FOUND` and never a `429`; a `403` stays today's `403` |

"No record has this Health ID" is read with
`identity.support_health_id_matches` (0109), which identity-api's runtime
may already execute: it answers only whether the one Health ID asked is
issued (any status), nothing else about any patient. Note: 0109's comment
names the support route as its caller; this is a second caller of the same
function, with no database change.

Every lookup that finds no patient (every `404`) is counted for the person
before anything is said about the Health ID (`auth.otp_rate_limits`,
`account` bucket keyed by an HMAC of the staff account with the existing
`OTP_HMAC_KEY_B64`). It is one limit per account, not per membership: a
member of several facilities gets no fresh 30 by changing `X-Facility-ID`.
A lookup that opens a patient is not counted, and neither is today's `403`:
the issued check is never asked for it and a limited account gets the same
`403`, so counting it would only limit a desk working through patients who
have not yet given consent. A limited account keeps getting today's `404`,
never a new status: the website ends access and closes an open record on any
`403` or `404` from this lookup (its check before every save), so a `429`
there would leave a record open after access has ended. If the member cannot be counted, the side of
the member's facility cannot be told, or the issued check cannot be read
(or answers anything but the one Health ID or nothing), the answer is
today's `404`, never `PATIENT_NOT_FOUND`.

### The seals (demo 0098, QA 0123)

Nothing in a sealed tenant ever finds a real patient, and nothing real finds
a sealed one (0098 D2, 0123). The issued check reads past row-level
security, so it is asked only when the Health ID and the member's facility
are on the same side:

| Health ID | Its side |
| --- | --- |
| `HID-ZDEM` and 4 more Health ID characters (8 in all, 0098 D7) | demo |
| `HID-ZQA` and 5 more Health ID characters (8 in all, 0123 D7) | QA |
| Any other Health ID starting `ZDEM` or `ZQA` (any length) | none: always today's `404` |
| Every other Health ID | real |

Identity's generator has never issued an 8-character Health ID and, since
Q60, never starts one with `ZDEM` or `ZQA`; a real Health ID issued earlier
that starts so is never answered `PATIENT_NOT_FOUND` (it gets today's `404`
when it does not open).

The member's facility's side is read with `identity.sealed_demo_facility`
(0098) and `identity.sealed_qa_facility` (0123), which identity-api's runtime
may already execute: demo when only the first says yes, QA when only the
second does, real when neither does. When both say yes, when either cannot
be read, or when the request has no facility, the side cannot be told and
the answer is today's `404`. So a demo or QA member learns nothing about
real Health IDs, a real member nothing about demo or QA ones, and the demo
and QA tenants nothing about each other; each learns only whether a Health
ID of its own side is issued. Nothing is asked about the Health ID (no side
query and no issued check) when it is malformed or starts `ZDEM` or `ZQA`
without being a sealed one.

### Audit

Every answer writes `identity.patient.lookup` as before (`success`, or
`denied`), never with the Health ID. A `denied` row now carries
`details.lookupResult`: `no_such_patient`, `not_available`,
`not_authorized` (with the patient id, as before; a `403`, never counted)
or `limited` (a `404` while the account is limited).
`not_available` is every `404` that is not `PATIENT_NOT_FOUND` and not
limited: a record has the Health ID, the Health ID is of another side of the
seals, or it could not be told.

### Not changed

Access requests, the Access PIN and emergency access by Health ID keep
their answers (`404 CONSENT_RESOURCE_NOT_FOUND` and so on). They are lane A's
(`src/consent/*`) and are being changed by hid-system#264 (0128).

### Website

Find a patient shows the owner's words, "No patient has this Health ID."
(the answer's `detail`), with Register for roles that register (health repo,
`PatientsWorkspace.tsx`), only on `PATIENT_NOT_FOUND`. Every other `404` and
every `403` stays a refused lookup, as today. A limited account gets today's
`404`, never a `429`.

## Wave 0: answers for the EHR screens (R-1 to R-4, P2-5, P2-6)

**These are answers, not new behaviour.** Nothing in any service, migration,
grant or setting changes. They answer the questions in Akos's note "Health ID
EHR QA (Doctor role): backend needs" (17 Nov 2026), items R-1, R-2, R-3, R-4,
P2-5 and P2-6. The only new files are the HID-LAB code list
(`docs/codes/hid-lab-codes.json`) and its check
(`scripts/tests/hid-lab-codes.test.mjs`).

Every statement was checked against `staging-novu-ci-20261005` at `964fabdf`
(19 Nov 2026). File references are to that branch, and a migration number
such as `0004:181` means `services/ehr-api/database/migrations/0004_*.sql`,
line 181. Infrastructure facts come from the Terraform on the `dev` branch at
`4e64b064`, which is the source of production AWS (`infra/aws/README.md:3-9`
on this branch); they are marked "dev". Anything marked **Planned** is in the
18 Nov build plan and is not built.

Rules shared by the three order bodies below: every text field is trimmed of
outer spaces before it is checked (`clinical.dto.ts:23`), lengths count
characters after trimming, an optional field may be left out but `null` is
refused, and a field the body does not declare is refused with `400
VALIDATION_FAILED` (`services/ehr-api/src/common/validation.ts:3-9`,
`common/validation-pipe.ts:11-28`). `clinical.dto.ts` is
`services/ehr-api/src/ehr/shared/clinical.dto.ts`.

### R-1. Diagnoses: "ICD-10" and dotted codes

`POST /api/v1/ehr/patients/:patientId/encounters/:encounterId/diagnoses`
(`diagnoses.controller.ts:8,27`).

| Field | Required today | What is accepted | Source |
| --- | --- | --- | --- |
| `codeSystem` | Yes | Any text, 1 to 255 characters. There is no list and nothing checks it. `ICD-10` is stored exactly as sent. | `clinical.dto.ts:299-302`, `0004:180` |
| `code` | Yes | Any text, 1 to 100 characters. There is no pattern, so dotted codes such as `B50.9`, `O14.9` and plain ones such as `B54` are accepted. | `clinical.dto.ts:304-307`, `0004:181` |
| `display` | Yes | Any text, 1 to 500 characters. | `clinical.dto.ts:309-312`, `0004:182` |

- **Yes:** code system `ICD-10` exactly as written, and WHO codes with a dot,
  are accepted.
- **A diagnosis must have a code today.** A body without `code` gets `400
  VALIDATION_FAILED`, and the column is `NOT NULL` (`0004:181`). Free text is
  allowed for the name only. Until this changes, the screen should ask for a
  code, or say the diagnosis cannot be saved without one.
- Send the code system as `ICD-10`. The patient's own record chat leaves out
  sensitive diagnoses by their ICD-10 code only when the code system contains
  "ICD" (`services/ehr-api/src/ehr/patient-records/patient-evidence.policy.ts:135,156`);
  it also checks the name.
- The code and code system cannot be changed after saving
  (`UpdateDiagnosisDto`, `clinical.dto.ts:335-353`, has no code fields). A
  wrong code is corrected by marking the diagnosis entered in error and
  saving a new one.
- **Planned (0145, Release B):** ICD terminology search, and a diagnosis
  saved with a name and no code. It waits for owner question 8 (ICD-10
  licence or ICD-11). The route Akos suggested,
  `GET /api/v1/ehr/terminology/icd10`, does not exist today.

### R-2. Lab tests: "LOINC", and local codes for tests without one

`POST /api/v1/ehr/patients/:patientId/encounters/:encounterId/lab-requests`
(`lab-requests.controller.ts:14,41`).

| Field | Required today | What is accepted | Source |
| --- | --- | --- | --- |
| `testCodeSystem` | Yes | Any text, 1 to 255 characters. No list; nothing checks it. | `clinical.dto.ts:562-565`, `0004:242` |
| `testCode` | Yes | Any text, 1 to 100 characters. No pattern. | `clinical.dto.ts:567-570`, `0004:243` |
| `testDisplay` | Yes | Any text, 1 to 500 characters. | `clinical.dto.ts:572-575`, `0004:244` |
| `specimenTypeCode` | No | Any text up to 100 characters. | `clinical.dto.ts:584-588`, `0004:247` |

When the request is sent to the facility's own lab, Lab takes the same
lengths (`services/lab-api/src/lab/dto/accept-ehr-order.dto.ts:15-17`,
`0018:27-29`), so every request EHR saves can be sent.

- **Yes:** `LOINC` is accepted as the test code system (as text, like any
  other).
- **A test must have a code today.** A request with a name and no code gets
  `400 VALIDATION_FAILED`, and the column is `NOT NULL` (`0004:243`). So the
  13 tests the screen fills by name only are refused unless the clinician
  types a code.
- **Answer for tests with no LOINC code: use the local code system
  `HID-LAB`.** Send `testCodeSystem: "HID-LAB"`, the code from the table as
  `testCode`, and the name from the table as `testDisplay`. The codes are
  fixed: a code is never changed and never re-used for another test. They
  use only capital letters A to Z, digits and single hyphens. The same list is
  in `docs/codes/hid-lab-codes.json`, and `scripts/tests/hid-lab-codes.test.mjs`
  checks that its codes are unique and well formed and that this table matches
  it. The specimen is a plain-words suggestion; the screen may send it as
  `specimenTypeCode` (optional).

The list is every test in the screen's built-in list that has no LOINC code
(health repo, `main` at `14779584`,
`apps/patient-web/src/ehr-blue/clinical/parts/vocabulary.ts:77-104`). Akos's
note names three of them (malaria smear, Widal, genotype).

| HID-LAB code | Test name (`testDisplay`) | Specimen |
| --- | --- | --- |
| `MP-SMEAR` | Malaria parasite (blood film) | Blood (EDTA) |
| `MP-RDT` | Malaria rapid diagnostic test | Blood |
| `WIDAL` | Widal test | Serum |
| `URINALYSIS` | Urinalysis | Urine |
| `HB-GENOTYPE` | Haemoglobin genotype | Blood (EDTA) |
| `HIV-SCREEN` | HIV screening | Blood |
| `HBSAG` | Hepatitis B surface antigen | Serum |
| `HCV-AB` | Hepatitis C antibody | Serum |
| `EUCR` | Electrolytes, urea and creatinine | Serum |
| `LFT` | Liver function test | Serum |
| `LIPID-PROFILE` | Lipid profile | Serum |
| `STOOL-MICRO` | Stool microscopy | Stool |
| `SPUTUM-AFB` | Sputum for AFB | Sputum |

- Keep these names as they are. The patient's own record chat leaves out
  sensitive tests. For a code that is not LOINC it checks both the name and
  the code text against its word list (`patient-evidence.policy.ts:62-75,146-148`),
  and the database filter checks the name only
  (`patient-evidence.query.ts:120-121`). "HIV screening",
  "Hepatitis B surface antigen", "Hepatitis C antibody" and "Haemoglobin
  genotype" all match that list.
- **Planned (0144, Release B):** a lab test catalogue with LOINC codes, into
  which the HID-LAB codes move, and a lab request saved with a name and no
  code.

### R-3. Prescriptions: route words, frequency, medicine code

`POST /api/v1/ehr/patients/:patientId/encounters/:encounterId/prescriptions`
(`prescriptions.controller.ts:15,49`).

| Field | Required today | What is accepted | Source |
| --- | --- | --- | --- |
| `medicationDisplay` | Yes | Any text, 1 to 500 characters. | `clinical.dto.ts:368-371`, `0004:211` |
| `medicationCodeSystem` | No | Any text up to 255 characters. | `clinical.dto.ts:356-360`, `0004:209` |
| `medicationCode` | No | Any text up to 100 characters. | `clinical.dto.ts:362-366`, `0004:210` |
| `routeCode` | No | Any text up to 100 characters. There is no code list. | `clinical.dto.ts:384-388`, `0004:214` |
| `frequency` | Yes | Free text, 1 to 240 characters. | `clinical.dto.ts:390-393`, `0004:215` |
| `doseUnit` | No | Any text, 1 to 80 characters. | `clinical.dto.ts:378-382` |
| `instructions` | Yes | Free text, 1 to 4000 characters. | `clinical.dto.ts:395-398` |

- **`routeCode` takes plain words** such as "oral", "intravenous" or
  "intramuscular", up to 100 characters. No HL7 or SNOMED CT route list is
  checked, so the screen does not need to switch.
- **`frequency` is free text**, 1 to 240 characters: "Twice daily" and
  "Every 8 hours" are accepted as written.
- **The medicine code and its code system are optional.** A prescription can
  be saved with the generic name only.
- Leave an optional field out rather than sending an empty string. EHR
  accepts `""` for `routeCode`, `medicationCode` and `medicationCodeSystem`
  (only a maximum is checked), but EHR passes the value on unchanged when the
  prescription is sent to the facility's pharmacy
  (`prescriptions.service.ts:347-352`), and Pharmacy needs at least one
  character in each (`services/pharmacy-api/src/pharmacy/dto/accept-ehr-prescription.dto.ts:13-14,18`,
  `0023:63-64,68`). Such a prescription could not be sent.
- The medicine and route cannot be changed after saving. An update changes
  only status, frequency (1 to 240), instructions and end date
  (`UpdatePrescriptionDto`, `clinical.dto.ts:499-530`).
- **Planned (0144, Release B):** formulary search from the catalogue.

### R-4. Rate limits on the pages the drawers re-read

**Answer: yes, one extra read when a drawer closes stays inside every limit.**
No per-route limit applies to the reads a page makes (visits, vitals,
diagnoses, notes, lab requests, prescriptions, allergies, access requests,
registration cases, pharmacy work items). The one limit that counts them is
the AWS firewall's general limit, and one re-read per drawer close adds very
little to it.

Every limit on the path from the website to the services:

| Where | What is limited | Limit | Counts a drawer re-read? | Source |
| --- | --- | --- | --- | --- |
| AWS firewall on the public load balancer (dev) | Every API request | 2,000 requests in 5 minutes per connecting address, then blocked (AWS's default 5-minute window; the rule sets no other) | Yes | `infra/terraform/modules/application/ingress.tf:380-401,403-407` (dev) |
| Gateway | Patient record chat `POST /api/v1/ehr/me/chat` and support chat `POST /api/v1/support/chat` | 6 a minute per address, 2 extra at once, then `429` | No | `gateway/nginx.conf.template:1,103-120` |
| Gateway | Staff record chat `POST /api/v1/ehr/patients/:patientId/chat` | 20 a minute per address, 5 extra at once, then `429` | No | `gateway/nginx.conf.template:12,140-148` |
| Identity | Health ID lookups answered `404` (no such patient, or a patient this facility may not see) | 30 in 10 minutes per staff account, then `404` for 10 minutes (never `429`). A lookup that opens a patient, or is refused with `403`, is not counted. | No | `services/identity-api/src/identity/patient-lookup-miss.service.ts:15-26,53` |
| Identity | Order destination search `GET /api/v1/identity/order-destinations` | 60 an hour per staff membership, then `429` | No: it is a typed search, not re-read when a drawer closes | `services/identity-api/src/identity/order-destinations.controller.ts:17`; `order-destinations.service.ts:44-46,78` |
| Identity | Emergency access activation | Database limit, then `429 EMERGENCY_RATE_LIMITED` | No | `services/identity-api/src/consent/consent.service.ts:425-430` |
| EHR | Sending orders to another facility | Daily limits, then `429` | No | `services/ehr-api/src/ehr/order-routes/order-route.problems.ts:22-23` |
| Services | Other actions: sign-in and sign-up codes, enrolment, invitations, outreach sign-up and Health IDs, contact changes, share searches, shares and share invitations, web push, offline key escrow, the patient record chat, and accepting, correcting or ending orders at Lab and Pharmacy | Each its own limit, then `429` (or `404` as above) | No: none of these is a page read | For example `services/identity-api/src/auth/rate-limit.ts:18` and its callers; `services/ehr-api/src/offline/offline.service.ts:298`; `services/ehr-api/src/ehr/patient-records/patient-chat.service.ts:162`; `services/lab-api/src/lab/lab-order-route.mapping.ts:134,175,190`; `services/pharmacy-api/src/pharmacy/pharmacy-order-route.mapping.ts:143,181` |
| Gateway and services | The page reads listed above | None | — | No `limit_req` in `gateway/nginx.conf.template:61-101,121-149`; none of these reads has a limit in its service |

The website reaches AWS through the Cloudflare Worker (this contract,
"Current browser and notification boundary"), and the firewall refuses any
request without Cloudflare's origin secret (`ingress.tf:299-333`, dev). So the
address the firewall counts is the one Cloudflare connects from, not the
clinic's own. The 2,000 in 5 minutes is not set aside per clinic: it is
shared by all traffic Cloudflare sends from that same address, from every
clinic, patient and page. One re-read per drawer close still adds very little
to it. Re-reading only after a drawer saved something keeps the load lower
still.

### P2-5. Coding systems and FHIR today

- **No code checking.** Diagnoses, lab tests and medicines accept any code
  system and any code as text, within the lengths in R-1 to R-3. ICD-10,
  ICD-11, SNOMED CT, LOINC and HID-LAB are all accepted the same way; none is
  looked up or checked against a code list.
- Code systems are read in one place only: the patient's own record chat
  recognises LOINC (`patient-evidence.policy.ts:78-98`) and ICD
  (`patient-evidence.policy.ts:134-135,156`) to leave out sensitive tests and
  diagnoses.
- **No FHIR API.** No service on this branch has a FHIR route or returns
  FHIR resources.
- **Planned:** the lab test catalogue with LOINC and HID-LAB codes (0144) and
  ICD terminology search (0145, after owner question 8: ICD-10 licence or
  ICD-11). The 18 Nov build plan has no FHIR item.

### P2-6. Where data is kept, and compliance

Facts, as configured:

| Topic | Fact | Source |
| --- | --- | --- |
| Region | Production runs in AWS `eu-west-1` (Ireland), in two zones, `eu-west-1a` and `eu-west-1b`. Releases deploy there. | `infra/terraform/environments/production.tfvars:19,50` (dev); `scripts/production_deployment_core.py:21` |
| Database | PostgreSQL 16 on RDS, not reachable from the internet, storage encrypted with its own KMS key (key rotation on), a standby copy in a second zone, automated backups kept 30 days. | `infra/terraform/modules/data/main.tf:2-6,368-394` (dev); `infra/terraform/variables.tf:125-128` (dev); `production.tfvars:301` (dev) |
| Documents | S3, encrypted with a KMS key, versioned, all public access blocked. | `modules/data/main.tf:75-108` (dev) |
| In transit | The public and internal load balancers listen only on HTTPS, with the TLS 1.2 and 1.3 policy. Encryption ends at the load balancer: it passes requests to the containers inside the private network over plain HTTP. The database refuses connections without TLS (`rds.force_ssl`), and services connect with the RDS certificate. | `modules/application/ingress.tf:29-35,51-56,212-216,231-237` (dev); `modules/data/main.tf:326-333` (dev); `modules/application/workloads.tf:74` (dev) |
| Audit | Clinical and identity actions are written to `audit.events`, which refuses every update and delete. ehr-api writes an audit row for each request through a global audit interceptor, except on routes marked as not audited; routes marked to audit failures only write a row only when they fail. | `0003:210,277-282`; `services/ehr-api/src/app.module.ts:28`, `services/ehr-api/src/audit/audit.interceptor.ts:21-41` |
| Logs | Application logs are kept 90 days, Identity and security logs 365 days. | `infra/terraform/variables.tf:136-150` (dev); `modules/application/workloads.tf:527` (dev) |

Data that leaves `eu-west-1`, as configured:

| What | Where it goes | Source |
| --- | --- | --- |
| Record chat (the patient's "ask about my records" and staff "Ask about this patient"): text from the record | The Claude API, processed in the United States | `production.tfvars:257-261` (dev); `services/ehr-api/src/ehr/patient-records/claude-ai.service.ts:197-202` |
| Paper records read for Migrate: text read from the page | The Claude API, processed in the United States | `production.tfvars:262-265` (dev); `services/ocr-worker/src/reading/claude.client.ts:12-13`, `services/ocr-worker/src/config.ts:73` |
| Error reports | Sentry, EU (Germany) host; scrubbed errors only | `production.tfvars:303-307` (dev) |
| NIN checks | QoreID | `production.tfvars:46` (dev) |
| Notifications | Novu (`api.novu.co`), with email through Brevo | `production.tfvars:26-27` (dev) |
| Google sign-in | Google | `production.tfvars:44` (dev) |
| Every website and API request | Cloudflare, in front of AWS | this contract, "Current browser and notification boundary" |

This repository does not record where QoreID, Novu, Brevo, Google or
Cloudflare keep data.

Not done, said plainly:

- **No in-country hosting.** All Health ID data is kept in one AWS region,
  `eu-west-1` (Ireland), not in Nigeria. There is no option today to keep a
  country's data in that country, and the 18 Nov build plan has no item for
  it (it lists P2-6 among the gaps no design covers yet).
- **Certification is held outside this repository.** Health ID told us on
  19 Nov 2026 that it holds NDPA (formerly NDPR) certification, and that the
  service is aligned with GDPR and HIPAA. The certificate and any assessment
  papers are kept by Health ID, not here; ask Health ID for them. When you
  describe this to buyers, use exactly those words: "NDPA certified" and
  "GDPR- and HIPAA-aligned". Do not say "GDPR certified" or "HIPAA certified".
- The AWS Backup plan is off (`production.tfvars:58`, dev); RDS's own
  automated backups above still run.
- The Terraform defines no CloudTrail trail of its own; whether the AWS
  account has one is not recorded here.
- Traffic between the load balancers and the containers is not encrypted
  (it stays inside the private network; see "In transit" above).

## EHR-C4: chart summary

Akos P1-1 and N-11 (wave 1, lane C). ehr-api only; no migration, no new
permission, no new grant, no new setting. One call returns the sections a
doctor's chart opens with. Each section follows the rules of the route that
already reads it; nothing here lets anyone read more than those routes allow.

### `GET /ehr/patients/:patientId/chart-summary`

`patientId` is the patient's UUID (never a Health ID). `Cache-Control:
no-store`. The caller needs at least one of `ehr.encounter.read`,
`ehr.diagnosis.read`, `ehr.prescription.read`, `ehr.lab-request.read`,
`ehr.vital.read` or `ehr.note.read`, or the answer is `403
PERMISSION_DENIED`. `X-Purpose-Of-Use` is `direct-care` or `emergency`; any
other value is `400 PURPOSE_OF_USE_REQUIRED`.

Each section is included only when the caller holds the permission of the
route that reads it today:

| Section | Permission | What it holds | At most |
| --- | --- | --- | --- |
| `demographics` | `identity.patient.read` | `patientId`, `fullName`, `firstName`, `lastName`, `dateOfBirth`, `gender` (the patient card Identity already gives the EHR; no Health ID, no NIN) | 1 |
| `problems` | `ehr.diagnosis.read` | diagnoses that are `active`, `recurrence` or `relapse`, not `refuted` or `entered_in_error`, newest first | 50 |
| `medications` | `ehr.prescription.read` | prescriptions `active` or `on_hold`, not ended before today (Lagos), newest first, each with `ownProgress` (ORD-3) | 50 |
| `allergies` | `ehr.note.read` | active recorded allergies (any facility, most serious first, `recordedHere`) and the patient's own allergy text, as the emergency read answers them | 200 |
| `latestVitals` | `ehr.vital.read` | exactly the EHR-C3 answer (`facilityId`, `measures`) | 7 measures |
| `recentVisits` | `ehr.encounter.read` | this facility's visits, newest first | 10 |
| `openLabRequests` | `ehr.lab-request.read` | lab requests `active` or `on_hold`, newest first, each with `ownProgress` (ORD-3) | 50 |
| `recentResults` | `lab.result.released.read` | the newest, by release time, of the released results the summary reads from Lab (see `complete` below) | 10 |

Lists answer `{ "items": [...], "more": true | false }`; `more` says there
were more than the limit. `recentResults` also has `complete` (false when Lab
had more pages than the summary reads: at most 5 pages of 200). Lab gives its
pages in record order, not by time. So when `complete` is false (more than
1,000 released results), the items are the newest of the 1,000 read, and may
not be the patient's newest results. The pages are read one after another,
each with the Lab client's own 10-second limit, and the summary sets no
overall limit on them: a slow Lab can make the whole answer slow, though a
Lab that fails or times out only leaves `recentResults` out as
`unavailable`.

Each section reads the same records as its own route: this facility's
visits, diagnoses, prescriptions, lab requests and vitals; the patient's
allergies from any facility, as the allergy list does; and the results Lab
gives the EHR, as the staff record does. Anything entered in error is left
out: a visit entered in error, and every diagnosis,
prescription, lab request and vital recorded in it; a diagnosis or allergy
entered in error; a prescription or lab request entered in error, cancelled
or completed.

Answer `200`:

```json
{
  "patientId": "<uuid>",
  "facilityId": "<uuid>",
  "purposeOfUse": "direct-care",
  "limits": { "recentVisits": 10, "problems": 50, "medications": 50, "openLabRequests": 50, "allergies": 200, "recentResults": 10 },
  "sections": {
    "demographics": { "patientId": "<uuid>", "fullName": "...", "firstName": "...", "lastName": "...", "dateOfBirth": "1990-01-01", "gender": "female" },
    "problems": { "items": [{ "id": "<uuid>", "encounterId": "<uuid>", "codeSystem": "ICD-10", "code": "B50.9", "display": "...", "clinicalStatus": "active", "verificationStatus": "confirmed", "onsetAt": null, "notes": null, "createdAt": "..." }], "more": false },
    "medications": { "items": [{ "id": "<uuid>", "encounterId": "<uuid>", "medicationDisplay": "...", "medicationCodeSystem": null, "medicationCode": null, "doseQuantity": "1", "doseUnit": "tablet", "routeCode": "oral", "frequency": "...", "instructions": "...", "startsOn": "2026-11-18", "endsOn": null, "status": "active", "createdAt": "...", "ownProgress": { "status": "dispensed", "receivedAt": "...", "dispensedAt": "...", "reversedAt": null } }], "more": false },
    "allergies": { "recorded": [{ "source": "recorded", "id": "<uuid>", "substance": "...", "reaction": "...", "severity": "severe", "recordedHere": true, "recordedOn": "..." }], "patientReported": { "source": "patient_reported", "allergies": null, "updatedAt": null } },
    "latestVitals": { "facilityId": "<uuid>", "measures": { "pulseBpm": { "value": 76, "recordedAt": "...", "vitalId": "<uuid>", "encounterId": "<uuid>", "corrected": false } } },
    "recentVisits": { "items": [{ "id": "<uuid>", "encounterNumber": "...", "encounterType": "ambulatory", "status": "in_progress", "startedAt": "...", "endedAt": null, "chiefComplaint": "...", "importedPaperRecords": false }], "more": false },
    "openLabRequests": { "items": [{ "id": "<uuid>", "encounterId": "<uuid>", "testCodeSystem": "HID-LAB", "testCode": "MP-SMEAR", "testDisplay": "...", "priority": "routine", "status": "active", "specimenTypeCode": null, "clinicalInformation": null, "createdAt": "...", "ownProgress": { "status": "received", "receivedAt": "...", "collectedAt": null, "lastResultAt": null } }], "more": false },
    "recentResults": { "items": [{ "id": "<uuid>", "version": "...", "title": "...", "recordedAt": "...", "effectiveAt": "...", "fields": {} }], "more": false, "complete": true }
  },
  "leftOut": [
    { "section": "recentResults", "reason": "unavailable", "message": "This part of the chart could not be loaded just now. Try again in a moment." }
  ]
}
```

### Sections left out

A section that is not in `sections` is listed in `leftOut` with a reason and
a plain sentence to show:

| `reason` | When | `message` |
| --- | --- | --- |
| `permission` | the caller does not hold the section's permission, or the other service (Identity or Lab) refused (`403`) | "You do not have permission to see this part of the chart." |
| `permission` | an emergency read (below), for every section it does not show | "Emergency access shows allergies and past visits only. This part of the chart is not shown." |
| `unavailable` | Identity or Lab could not be reached, timed out or answered something unexpected | "This part of the chart could not be loaded just now. Try again in a moment." |

When the pharmacy or the laboratory cannot tell the progress of an item, the
section is still answered, each such item carries `ownProgress: { "status":
"unknown" }` (as on the per-visit lists), and `leftOut` lists
`medications.ownProgress` ("Pharmacy progress could not be loaded just now.
The medicines are shown without it.") or `openLabRequests.ownProgress`
("Laboratory progress could not be loaded just now. The lab requests are
shown without it."), reason `unavailable`. A laboratory that is down never
fails the answer.

### Consent and audit

One consent check for the whole call, the same as every EHR read: Identity
decides `read_records` for this patient, member, facility and purpose, and
the database applies its own row checks as well. Without consent the answer
is `403 CONSENT_REQUIRED`, audited as `ehr.chart-summary.read` with outcome
`denied`, and nothing is read. A read writes one EHR success audit row,
`ehr.chart-summary.read` (resource `chart-summary`, the patient's UUID), with
the sections asked for and a count per EHR section; never a value, a name, a
Health ID or a NIN. The route is marked to audit failures only, as the
emergency read and the staff record chat are, so the request's own row is
written only when the request fails.

The patient card and the results are read after that, from Identity and Lab,
through the reads the staff record chat already uses. Identity and Lab check
access themselves, and record these reads under the staff record chat's
action names: Identity writes `identity.staff.chat.profile.read` once per
chart open, and Lab writes `lab.staff.chat.released-results.read` once per
page of results (up to 5 per chart open, each page with its own Identity
access check). So an auditor sees them as staff record chat reads, not chart
reads; chart-specific action names in Identity and Lab are a follow-up. The
pharmacy and laboratory progress is read the same way the per-visit lists
read it.

### Emergency (break-glass)

With `X-Purpose-Of-Use: emergency`, the summary shows exactly what the
emergency read (`GET /ehr/patients/:patientId/emergency-records`) shows
today, under the same rules: the caller needs both `ehr.encounter.read` and
`ehr.note.read` (else `403 PERMISSION_DENIED`), and an active break-glass
grant (else `403 CONSENT_REQUIRED`, audited as denied). It answers
`allergies` and `recentVisits` (completed visits at this facility, with the
emergency read's columns: no chief complaint); every other section is in
`leftOut` with reason `permission`. The audit row is the same action with
purpose `emergency`.

### Screen change needed (Akos frontend branch)

"Open chart" calls this route once per patient and shows each section in
`sections`. For each entry in `leftOut`, show its `message` where that
section would be. Re-read after a drawer closes, as the per-section lists
are.

## EHR-C5: one-call consultation

Akos N-5 ("Start consultation" saves only the complaint; "Save the rest" is
needed for the diagnosis and the notes). ehr-api only; no migration, no new
grant, no new setting. It uses only tables, functions and grants that exist
today (`ehr.encounters`, `ehr.clinical_notes`, `ehr.clinical_note_revisions`,
`ehr.vitals`, `ehr.diagnoses`, `ehr.idempotency_keys`, `audit.events`).
Prescriptions and lab requests are not part of this call; they keep their own
routes. Draft auto-save (EHR-C6, 0141) is separate.

### `POST /ehr/patients/:patientId/consultations`

`patientId` is the UUID (never a Health ID or NIN). Headers as for every
clinical write: `X-Facility-ID`, `X-Purpose-Of-Use: direct-care` and an
`Idempotency-Key` (16 to 128 URL-safe characters, otherwise `400
IDEMPOTENCY_KEY_REQUIRED`).

Body (each part is exactly the body of its own route, with the same
validation; an unknown field is `400 VALIDATION_FAILED`):

```json
{
  "visit": { "encounterType": "ambulatory", "status": "in_progress", "startedAt": "2026-11-18T09:30:00.000Z",
             "chiefComplaint": "Fever for two days" },
  "note": { "noteType": "consultation", "title": "Consultation", "status": "signed", "content": "..." },
  "vitals": { "recordedAt": "2026-11-18T09:35:00.000Z", "temperatureC": 38.4, "systolicMmhg": 120, "diastolicMmhg": 80 },
  "diagnoses": [ { "codeSystem": "ICD-10", "code": "B50.9", "display": "Malaria", "clinicalStatus": "active",
                   "verificationStatus": "provisional" } ]
}
```

- `visit` (required): the body of `POST .../encounters`. A consultation is
  always saved on the open visit today (EHR-C1): `reuseOpenVisit` may be
  left out or be `true`; `false` is `400 CONSULTATION_USES_OPEN_VISIT` ("A
  consultation is saved on the open visit today. Leave out reuseOpenVisit or
  set it to true."). The EHR-C1 rules apply unchanged: `status` `planned` or
  `in_progress` (`400 REUSE_OPEN_VISIT_NEEDS_OPEN_STATUS`), `startedAt` on
  today's Lagos day (`400 REUSE_OPEN_VISIT_STARTED_AT_NOT_TODAY`), and the
  same transaction lock for this patient at this facility, taken before the
  lookup. If the patient has an open visit today it is used and nothing new
  is created; otherwise the visit is created.
- When the open visit today is used (`encounter.reusedOpenVisit: true`), the
  `visit` fields sent (`chiefComplaint`, `encounterType`, `startedAt` and the
  rest) are not saved: the open visit keeps the values it already has, and
  the answer shows those. The complaint the doctor typed is then not on the
  visit. Put it in the note, or save it as a visit edit (`PATCH
  .../encounters/:encounterId`, which needs a typed reason for a complaint
  change) after this call. This is the EHR-C1 rule;
  the call does not refuse or warn about it.
- `note` (optional): the body of `POST .../clinical-notes`, `draft` or
  `signed`. A note signed here needs no reason (FR-1: a first signature never
  does).
- `vitals` (optional): the body of `POST .../vitals`, with the same checks
  (`400 VITAL_MEASUREMENT_REQUIRED`, `400 BLOOD_PRESSURE_INCOMPLETE`).
- `diagnoses` (optional): up to 20 bodies of `POST .../diagnoses`. A code is
  still required (Wave 0 R-1).

### All or nothing

Every part is saved in ONE database transaction. If any part is refused (a
diagnosis the database refuses, the visit entered in error, and so on), no
part is saved: no visit, note, vitals, diagnosis, Idempotency-Key row or
part's audit row. The request's own failure audit row is still written, as
for any refused request, and a consent refusal
writes its `denied` rows (Audit, below). The answer is the refused part's
own error (for example `400 INVALID_CLINICAL_DATA`, `409
VISIT_ENTERED_IN_ERROR`). It does not always say which part was refused: a
database refusal such as `400 INVALID_CLINICAL_DATA` names no part, and a
validation error inside a part names only that part's top-level field
(`visit`, `note`, `vitals` or `diagnoses`), not the field within it. The
same Idempotency-Key can then be sent again with the corrected body.

### Permissions and consent

Permission `ehr.encounter.write` always, plus the write permission of each
part sent: `ehr.note.write` for `note`, `ehr.vital.write` for `vitals`,
`ehr.diagnosis.write` for a non-empty `diagnoses`. If one is missing, the
whole call is `403 PERMISSION_DENIED` ("Required permission is missing")
before the body is validated and before anything is read or saved. The
refusal is audited as a missing permission on the part's own route is: one
`security.authorization.denied` row (`http-request`, outcome `denied`, the
method and route), and no other row
(`services/ehr-api/src/ehr/consultation/consultations.controller.ts`,
`ConsultationPartsGuard`). Consent is checked once, as for each
part's own route (`write_records` for this patient; `403 CONSENT_REQUIRED`
otherwise). The checks each part's own route makes before the database
(above) also run before the consent check, except the `startedAt` day
check, which runs after it (Idempotency-Key, below).

### Answer

`201`:

```json
{
  "encounter": { "...visit...": "...", "reusedOpenVisit": true },
  "note": { "...note, as POST .../clinical-notes answers...": "..." },
  "vitals": { "...vitals, as POST .../vitals answers...": "..." },
  "diagnoses": [ { "...diagnosis, as POST .../diagnoses answers...": "..." } ]
}
```

`note` and `vitals` are `null` and `diagnoses` is `[]` when not sent.
`encounter.reusedOpenVisit` is `true` when the open visit today was used and
`false` when this call created the visit (EHR-C1).

### Idempotency-Key

Required. The same key with the same body answers the saved consultation
again (`201`, the same visit, note, vitals and diagnoses, as they are now;
`reusedOpenVisit` as first answered) and saves nothing new. A body that
differs only by `reuseOpenVisit: true` is the same body. The same key with
another body is `409 IDEMPOTENCY_KEY_REUSED`; while the first request with
the key is still running, the second waits for it, as on every clinical
create. A retry after Lagos midnight, when `startedAt` is no longer today,
is answered the same way from its key; only a consultation not yet saved
under its key gets `400 REUSE_OPEN_VISIT_STARTED_AT_NOT_TODAY`. That check
now runs after the consent check, so without consent such a request is
`403 CONSENT_REQUIRED`. A key, once used, keeps answering this consultation
(or `409` for another body) for as long as its row exists: the rows are
never deleted and the check does not look at their expiry time. Use a fresh
key for each new consultation. The key is stored once for the
whole call (operation `consultation.create`) and once per part
(`consultation.encounter`, `consultation.clinical-note`,
`consultation.vital`, `consultation.diagnosis.1` to `.20`), so a key used on
a single route never clashes with a consultation.

### Audit

Each part writes the audit row its own route writes, in the same
transaction: `ehr.encounter.create` (with `reusedOpenVisit`, `day` and
`idempotentReplay`), `ehr.note.create`, `ehr.vital.create`, and one
`ehr.diagnosis.create` per diagnosis (each with `idempotentReplay`). A replay
writes the same rows with `idempotentReplay: true`. A consent refusal writes
one `denied` row per part sent (reason `identity_authorization`). No row
carries a Health ID, a NIN or clinical text.

### Screen change needed (Akos frontend branch)

"Start consultation" sends the visit, note, vitals and diagnoses in this one
call with a fresh Idempotency-Key per consultation (kept for a retry of the
same save), instead of creating the visit first and asking for "Save the
rest". On an error, nothing was saved. Show the error's message; when it
names a part (`visit`, `note`, `vitals` or `diagnoses`), show it with that
section. After a `201` with `encounter.reusedOpenVisit: true`, the complaint
typed in "Start consultation" is not on the visit (above): save it as a
visit edit, or put it in the note before sending.

## SX-1: modules map per facility

Akos N-2b, N-2e and P1-5 (wave 1, no migration, no new setting). The session
answer already lists each facility's `roles` (every active role of the
membership) and `permissions`. Each facility now also carries `modules`: the
product areas the screens should show at that facility, so the website can
hide what a role cannot use. The server still checks every route on its own;
`modules` changes no permission and refuses nothing.

### Where it appears

`actor.facilities[*].modules` and, when a facility is selected,
`actor.facility.modules`, in these `{ actor, ... }` session answers of
identity-api: `POST /api/v1/auth/login`, `POST /api/v1/auth/oidc/exchange`
(Google sign-in), `POST /api/v1/auth/refresh`, `GET /api/v1/auth/session`,
`POST /api/v1/auth/facility` and the workload
read of the same answer (`GET` and `POST /api/v1/auth/service-session`).

- `modules` is added after every existing field of the facility. Every
  other field is unchanged, `roles[0]` (and so `actor.role`) included, and
  so is the order of the actor's fields.
- A patient session and an account-only outreach session have no facility,
  so their answers are unchanged, byte for byte.
- It is not an access-token claim and is not stored: it is worked out from
  the facility's `permissions` each time the answer is built.
- `POST /api/v1/auth/google/link` answers `{ linked: true }` to a patient
  session, with no actor, so it has no `modules`.
- Three routes that sign staff in answer an `actor` without `modules`,
  unchanged: `POST /api/v1/identity/provider-enrollments/activate` (a new
  administrator), `POST /api/v1/identity/outreach-organisers/activate` and
  `POST /api/v1/identity/outreach-invitations/accept` (outreach
  memberships). After them the website reads `GET /api/v1/auth/session`,
  which carries `modules`.

### The map

Every key is always present, `true` (show the area) or `false` (hide it), in
this order. Each area is shown when the facility's `permissions` hold every
code in the "Shown when the facility holds" column. These are the codes the
area's routes already require.

```json
{
  "patients": true, "registration": false, "accessRequests": true, "emergencyAccess": true,
  "triage": true, "consultation": true, "orders": true, "lab": false, "labResults": true,
  "pharmacy": false, "prescriptions": true, "migrate": true, "outreach": true,
  "admin": false, "audit": false
}
```

| Key | Akos's row | Shown when the facility holds |
| --- | --- | --- |
| `patients` | Find patient | `identity.patient.read` |
| `registration` | Register and check in | `identity.registration.write` |
| `accessRequests` | Access requests and PIN | `identity.consent.write` |
| `emergencyAccess` | Emergency access | `identity.consent.write` and `identity.break-glass.write` |
| `triage` | Triage and vitals (and Nursing observations) | `ehr.vital.read` |
| `consultation` | Consultation and diagnosis | `ehr.diagnosis.read` |
| `orders` | Order labs and prescribe | `ehr.lab-request.write` and `ehr.prescription.write` |
| `lab` | Lab queue and results entry | `lab.result.enter` |
| `labResults` | Lab results | `lab.result.released.read` |
| `pharmacy` | Dispense medicines | `pharmacy.dispensing.create` |
| `prescriptions` | Prescriptions | `ehr.prescription.read` |
| `migrate` | Scan paper records | `ocr.job.read` and `ocr.publication.write` |
| `outreach` | Outreach | `outreach.campaign.read` |
| `admin` | Facility profile and staff | `workforce.manage` |
| `audit` | The "View (audit)" cells | `audit.read` |

- The map is a pure function of the facility's own `permissions`
  (`services/identity-api/src/auth/facility-modules.ts`): the same codes
  always give the same map, whatever their order. A membership with two
  roles shows what either role shows.
- Akos's row "Nursing observations" has no key: no permission tells it apart
  from "Triage and vitals" today, so the screens use `triage` for both.
- P1-5: doctor, clinician, nurse, receptionist, lab and pharmacist never hold
  `workforce.manage` or `audit.read`, so `admin` and `audit` are `false` for
  them. A facility administrator (admin, org_admin, and the administrator
  awaiting review) sees both.
- The map shows what today's role rows allow, not Akos's proposed table. For
  example a doctor's `registration` is `true`, because the doctor role holds
  `identity.registration.write` today. The role rows change only in a later
  migration that the owner picks from the matrix below (0136).

Example answers for today's seeded roles (fictional facility):

| Role | Areas shown (`true`) |
| --- | --- |
| receptionist | patients, registration, accessRequests, outreach |
| nurse | patients, registration, accessRequests, emergencyAccess, triage, consultation, labResults, prescriptions, migrate, outreach |
| doctor, clinician | the nurse's areas and orders |
| lab | patients, accessRequests, lab, labResults |
| pharmacist | patients, accessRequests, pharmacy, prescriptions |
| admin | registration, labResults, outreach, admin, audit |
| org_admin | registration, outreach, admin, audit |
| outreach organiser or volunteer | outreach |

### The role matrix (Akos's table against today's role rows)

`services/identity-api/test/role-matrix.json` is Akos's proposed table,
checked in. The jest test `src/auth/role-matrix.spec.ts` compares each role's
seeded permissions (every `insert into auth.role_permissions` in
`services/ehr-api/database/migrations`, read the same way as the product gate
tests) with the table, one row at a time through the areas above, and names
each difference: **wider** (today gives more than the table) or **narrower**
(today gives less). Today's middle level is written "shown, without" the
area's missing codes, not "view only": an area is shown when its show codes
are held, and some of those are writes (`identity.consent.write` for access
requests). Today there are 20, recorded in the fixture's `todayDifferences`,
for example:

- `receptionist (Front desk), Access requests and PIN: narrower. Today shown, without identity.patient-access-pin.verify; Akos's table full.`
  (the front desk can already make access requests, a write, but cannot check a patient's PIN)
- `doctor (Doctor), Register and check in: wider. Today full; Akos's table hidden.`
- `lab (Lab), Find patient: wider. Today full; Akos's table with lab orders only.`

The test passes today. It fails when a migration adds or removes a
`role_permissions` row for a role of the table (`todayRolePermissions` pins
every seeded code of receptionist, nurse, doctor, clinician, lab, pharmacist,
admin and org_admin) or when the differences change, until the same pull
request updates the fixture. Packages that add role rows (0131, 0133, 0134,
0136) update it.

Clinician is compared with Akos's Doctor column (it holds the same codes
today); admin and org_admin with the Facility admin column.

### Audit

No new audit row. The session reads are audited as before
(`auth.session.read`, `auth.facility.select`, `auth.login`, `auth.refresh`),
with nothing added. No patient is read.

### Website (Akos frontend branch, not changed here)

Read `actor.facility.modules` (or the chosen facility's entry in
`actor.facilities`) and hide each menu item and home tile whose key is
`false`; P1-5 hides Facility settings when `admin` is `false`. Treat a
missing `modules` (an older backend) as today: show what is shown now.

## 0136. Who can do what: role-table changes (Release A, owner decisions Q103 A, Q111 A, Q112 A, Q113 A)

Owner decisions, verbatim: "Q103 A" (the five changes; the admin's "approve
new patient" and the nurse's note writing unchanged), then "Q111 A, Q112 A,
Q113 A":

- **Q111 A**: doctors keep checking a scanned paper record and confirming its
  patient; only starting a new scan (a reading) moves from doctors to the
  front desk.
- **Q112 A**: the front desk uploads scans and sees its own uploads, but does
  not open other stored documents or read the text taken from them (and still
  reads no note, diagnosis, prescription or lab request).
- **Q113 A**: no real (non-sealed) staff are active yet, so 0136 may touch
  none. Its maximums are 0 at real facilities on every line, written in the
  file; nothing is filled in at signing. At apply the release prints the
  counts and stops, changing nothing, if any real staff would be affected.

Migration `0136_role_permission_changes.sql` adds three permission codes,
changes rows of `auth.role_permissions` and closes the open records-processing
requests that the change makes useless (see "Open records-processing requests"
below). ehr-api and ocr-api change with it (see "What the services check"); no
function, policy, grant or table changes, so `runtime-grants.sql` is
unchanged. Permissions are read on every request, so each change applies from
a staff member's next request; nobody is signed out. Pharmacists and
`org_admin` are not changed; nurses and clinicians only gain the new
`ocr.job.start`, which keeps them starting readings as today.

### The three new permission codes

| Code | Gives | Held by |
| --- | --- | --- |
| `ocr.job.start` | starting or retrying a reading (`POST /ocr/jobs`, `POST /ocr/jobs/:jobId/retry`), together with `ocr.job.write` | receptionist, nurse, clinician |
| `ocr.job.read-own` | following the readings of documents this login uploaded at the facility (`GET /ocr/jobs/:jobId`, `GET /ocr/jobs?documentId=`, `GET /ocr/job-list`, which then lists only the readings it started), and letting ocr-api read such a document to start its reading. Never the text: extractions, validations and publications still need `ocr.job.read` | receptionist |
| `ehr.document.read-own` | listing and opening only the documents this login uploaded at the facility (`GET /ehr/documents`, `GET /ehr/documents/:id/download`) | receptionist |

A login that holds the full code (`ehr.document.read`, `ocr.job.read`)
through any role keeps the full read; the "-own" codes narrow nobody.

**Why a new code for Q111 A.** Checking a reading and confirming its patient
run under records processing, and records processing needs `ocr.job.write` at
each use (0104 D8, 0108, 0113), so the doctor's `ocr.job.write` row has to
stay. Starting a reading therefore needs a second code that doctors do not
hold. A permission row (rather than a check on the role's name in ocr-api) is
read the same way by every service and screen, shows in the role table the
owner reviews, applies to a doctor who is also a nurse exactly as to anyone
else (the nurse role gives `ocr.job.start`), and is undone by a row.

### Permission keys before and after, per role (only the codes 0136 touches)

| Role | Before 0136 | After 0136 |
| --- | --- | --- |
| `receptionist` (front desk) | none of these | `ehr.document.write`, `ehr.document.read-own`, `ocr.job.write`, `ocr.job.start`, `ocr.job.read-own`, `ehr.vital.read`. Not `ehr.document.read`, `ocr.job.read`, `ocr.validation.write`, `ocr.patient.confirm`, `ocr.publication.write` |
| `doctor` | `ocr.job.write`, `ocr.job.read`, `ocr.validation.write`, `ocr.patient.confirm`, `ocr.publication.write`; `outreach.campaign.read`, `outreach.campaign.write`, `outreach.registration.read`, `outreach.registration.write`; `lab.work-item.read`, `pharmacy.work-item.read` | `ocr.job.write`, `ocr.job.read`, `ocr.validation.write`, `ocr.patient.confirm`, `ocr.publication.write` (all kept, Q111 A); no `ocr.job.start`; no Outreach code; neither work list |
| `nurse` | `ocr.job.write`, `ocr.job.read`, `ocr.validation.write`, `ocr.patient.confirm`, `ocr.publication.write` | the same, plus `ocr.job.start` |
| `clinician` | the same as the nurse | the same, plus `ocr.job.start` |
| `lab` | `ehr.encounter.read`, `ocr.job.read`, `ocr.job.write`, `ocr.validation.write` | none of these |
| `admin` (hospital administrator) | `lab.work-item.read`, `pharmacy.work-item.read`, `ocr.job.read` | `ocr.job.read` only |

Rows: twelve removed (doctor's four Outreach codes and two work lists; lab's
`ehr.encounter.read`, `ocr.job.read`, `ocr.job.write`,
`ocr.validation.write`; admin's two work lists), eight added (the six
front-desk rows, nurse and clinician `ocr.job.start`). Kept on purpose and
asserted: `admin` `identity.registration.approve`, `workforce.manage`,
`organization.manage`, `audit.read`; `nurse` `ehr.note.write`; `doctor`
`ocr.job.write`, `ocr.validation.write`, `ocr.patient.confirm`.

### What the services check (same release)

- ocr-api: `POST /ocr/jobs` and `POST /ocr/jobs/:jobId/retry` need
  `ocr.job.write` and `ocr.job.start`. `GET /ocr/jobs/:jobId`, `GET
  /ocr/jobs?documentId=` and `GET /ocr/job-list` need `ocr.job.read` or
  `ocr.job.read-own` (a new any-of check in ocr-api's guard, as ehr-api
  already has). With `ocr.job.read-own` only, the job list shows only the
  readings this member started (as `mine=true`), and a job whose document
  this login did not upload answers 404 `OCR_JOB_NOT_FOUND`.
  `GET /ocr/jobs/:jobId/extractions`, `GET /ocr/jobs/:jobId/validations` and
  `GET /ocr/validations/:validationId/publications` still need
  `ocr.job.read`.
- ehr-api: `GET /ehr/documents` and `GET /ehr/documents/:id/download` need
  `ehr.document.read` or `ehr.document.read-own`; with the "-own" code only,
  the list holds only the documents this login uploaded here (bound in the
  query), and any other document answers 404 "Document not found", as an
  unknown one does, before Identity is asked about its patient. ocr-api's
  source read (`GET /ehr/internal/ocr/documents/:id/source`) needs
  `ocr.job.read` or `ocr.job.read-own`, with the same "own uploads only"
  rule for the "-own" code. Uploading (`ehr.document.write`) is unchanged:
  only the uploader completes an upload.
- Every refusal is audited as today (`security.authorization.denied` for a
  403, the request row with outcome failure for a 404). The release applies
  migrations before it starts the new service images, so the new checks
  never run against the old role table. If a release stopped after the
  migration and before the new images, the old images would be narrower for
  the desk (no full read) and doctors could still start readings until the
  new images run.

### What answers 403 PERMISSION_DENIED from now on

| Who | Routes (under `/api/v1`) |
| --- | --- |
| Doctor | `POST /ocr/jobs`, `POST /ocr/jobs/:jobId/retry` (no `ocr.job.start`); every Outreach route of outreach-api (campaigns, registrations, screening, exports, Health ID steps) and `GET`/`POST /identity/outreach-invitations` and its revoke; `GET /lab/work-items`, `GET /lab/work-items/:id`; `GET /pharmacy/work-items`, `GET /pharmacy/work-items/:id` |
| Laboratory staff | `GET /ehr/patients/:patientId/encounters`, `.../encounters/open-today`, `.../encounters/:encounterId`; every `ocr/*` route (`ocr/jobs`, `ocr/job-list`, validations, extractions) |
| Hospital administrator | `GET /lab/work-items`, `GET /lab/work-items/:id`; `GET /pharmacy/work-items`, `GET /pharmacy/work-items/:id` |
| Front desk | `GET /ocr/jobs/:jobId/extractions`, `GET /ocr/jobs/:jobId/validations`, `GET /ocr/validations/:validationId/publications`, `POST /ocr/jobs/:jobId/validation(s)`, `POST /ocr/jobs/:jobId/patient-confirmation`, `POST /ocr/validations/:validationId/publications`, and every note, diagnosis, prescription and lab-request read |

The front desk now passes the permission check on `POST
/ehr/documents/upload-intents`, `POST /ehr/documents/:id/complete`, `GET
/ehr/documents` and `GET /ehr/documents/:id/download` (its own uploads only),
`POST /ocr/jobs`, `POST /ocr/jobs/:jobId/retry`, `GET /ocr/jobs`, `GET
/ocr/jobs/:jobId` (readings of its own uploads), `GET /ocr/job-list` (SX-9:
its "Who" is now doctor, clinician, nurse, admin and, for its own readings,
receptionist; no longer lab), and the vitals reads (`GET
/ehr/patients/:patientId/vitals/latest`, `GET
.../encounters/:encounterId/vitals`, `/:vitalId`, `/:vitalId/corrections`).
Every one of these still needs the patient's access exactly as for anyone
else (a consent grant, or the records-processing cover of 0104/0108/0113),
and is audited as today, refusals included.

### What still works (checked route by route)

- Doctors check readings (`POST /ocr/jobs/:jobId/validation`), confirm their
  patient and ask a patient for records processing (`POST
  /identity/access-requests`, purpose `healthcare-operations`), as before
  (Q111 A); they read jobs and publish a checked reading into the chart.
- A doctor's own orders' progress (ORD-3): `POST /lab/work-items/progress`
  and `POST /pharmacy/work-items/progress` need `ehr.lab-request.read` /
  `ehr.prescription.read`, which doctors keep.
- Activating a lab request still sends it to the hospital's own laboratory:
  that hand-off needs `lab.work-item.accept`, which doctors keep. 0133's
  automatic send to the own pharmacy uses its definer function and adds no
  doctor row, as planned.
- Released results: `lab.result.released.read`, kept by doctors.
- Laboratory staff keep their whole own job: work list, accept, accessions,
  specimens, runs, results, verification, release, receiving from other
  facilities, and `ehr.lab-request.read`/`write`.
- Nurses and clinicians start, check, confirm and publish readings as today.
  Pharmacists are unchanged. Administrators keep staff, settings, audit,
  approving new patients and reading jobs (`ocr.job.read`, unchanged by
  Q112 A). Sign-in sites (Q97's product gate) are unchanged: the lab site
  admits lab staff by `lab.work-item.read`/`accept`, which they keep, and
  administrators by `organization.manage`.

**Facilities left with nobody who can check a reading.** Doctors keep
checking, so a clinic with doctors still checks its readings. A laboratory
loses checking for readings its staff already started, and a facility whose
only staff with paper readings are the front desk can start a reading (it
uses the facility's paid OCR pages, 0107) that nobody there can check or
confirm, so it is never put into the chart and its scan is deleted after 7
days (0112). The counts' lines 22 to 26 show how many facilities and
readings this touches.

**Open records-processing requests.** 0104's trigger checks `ocr.job.write`
only when a request is made, and 0104 D8, 0108 and 0113 check it again at
each use. A request a laboratory member made before 0136 that the patient has
not answered would, if approved, show in the patient's access history but
never work. 0136 closes those requests (status `expired`, as 0086 and 0096
do), writing one audit row each (`identity.access-request.close`, system
actor, reason "This staff member can no longer process records", ids only).
Doctors keep `ocr.job.write`, so their requests stay open. A request whose
staff member keeps `ocr.job.write` through another role, a direct-care
request and an answered request are left as they are. The undo does not
reopen them. Locks: 0136 takes SHARE ROW EXCLUSIVE on `auth.permissions`,
`auth.role_permissions` and `identity.access_requests`, so a new access
request or a patient's answer waits for the few seconds 0136 runs.

### Staff counts and the stop (Q113 A: no real staff affected)

In plain words: the owner says no real (non-sealed) staff are active yet,
so 0136 may touch none of them. When the release applies 0136 it counts how
many staff each change would touch; if any real staff member (or, for lines
22-24, any real facility) would be affected, 0136 stops and changes nothing,
and the owner decides again with the printed counts. The sealed QA and demo
tenants' fictional staff are counted apart and never stop it.

`docs/rollback/0136_affected_staff_counts.sql` is the counts file. It is read
only (its first statement makes the session read only, and it holds no write
statement), prints numbers only (no name, email or id), takes a few seconds
and stops nobody's work. It prints a short header saying what each line
means, then:

- **Table 1**, 26 lines, each with a number at real facilities, the distinct
  staff logins behind it (lines 1-21) and the same number at the sealed QA
  and demo tenants (fictional staff, printed only):
  1-8 what the front desk, nurses and clinicians gain; 9-20 what doctors,
  laboratory staff and administrators lose (a membership that keeps the code
  through another role is not counted); 21 doctors who can start a reading
  today and cannot after 0136; 22 facilities where someone can check a
  reading today and nobody can after; 23 facilities where after 0136 someone
  can start a reading and nobody can check it; 24 the same for confirming its
  patient; 25 open records-processing requests 0136 closes; 26 readings not
  yet checked at the facilities of line 22.
- **Table 2**, lines 1-24 in the exact form the owner writes into 0136:
  `(line, at real facilities, staff logins)`, with `null` for staff logins on
  lines 22-24 (they count facilities).

DevOps runs it once, with the database owner's login (the one the migrations
use) in a read-only session (row security hides rows from any other login;
the file then stops with a plain message instead of printing numbers that are
too low):

    psql "<production, database owner's login, read-only session>" -v ON_ERROR_STOP=1 \
      -f docs/rollback/0136_affected_staff_counts.sql

and sends both tables to the owner. If 0136 has already run on that
database, the file says so and counts nothing.

**Nothing is filled in at signing.** In 0136, section "1. THE OWNER'S
MAXIMUMS" holds the 24 rows `( 1, 0, 0),` to `(21, 0, 0),` and `(22, 0, null),`
to `(24, 0, null)` (lines 22-24 count facilities). DevOps may run the counts
file against production before signing to see that lines 1-24 are 0 at real
facilities; if any is not, 0136 would stop, and the owner decides first. A
changed number changes the file and needs a new signature. An ehr-api test
checks the 24 rows' shape and that 0136's count block is the counts file's
block, character for character.

**What happens at apply.** Before changing anything, 0136 runs the same count
block (the same text as the counts file) and prints each line as a NOTICE
`0136 count n: ...: N at real facilities (M staff logins), S at the sealed QA
and demo tenants; the owner's maximum: ...`, in the release's dry-run and apply
logs. Then, for lines 1-24, if a number at real facilities (or its staff
logins) is above the owner's 0, 0136 stops with error 55000 "0136 stopped,
nothing was changed: real staff would be affected, and the owner approved
0136 only while none are active (Q113 A): line N (...) is now ..., more than
the owner's 0 (0)". The release's dry run runs
first, so the stop shows there and the apply never starts; the release stops
before starting new service images. The sealed tenants and lines 25-26
(requests and readings, which change by the hour) are printed, not compared.
A fresh database (tests, rehearsals) has only the sealed tenants' fictional
staff, so 0136 applies there; in production it applies while no real staff
would be affected.

### Undo

`docs/rollback/0136_rollback.sql` (not in the ledger) gives doctors,
laboratory staff and administrators back exactly what they could do before
0136: it puts back the twelve removed rows and adds `ocr.job.start` for
doctors and laboratory staff (from this release on, starting a reading needs
it). It leaves the three codes, the nurse's and clinician's `ocr.job.start`
and the six front-desk rows (the desk keeps scanning with its own uploads
only; the file shows the delete that would take those back too). It can run
twice safely. It becomes a migration (next free number, ledger entry, owner
signature) only if needed.

Screen change (Akos frontend branch): show the scan steps (upload, "Extract
with OCR", the job list) and vitals to the front desk, with the document and
reading lists showing its own uploads only (`ehr.document.read-own`,
`ocr.job.read-own`) and no extracted text, checking or publishing; show "start
reading" only to staff holding `ocr.job.start` (front desk, nurses,
clinicians), and keep doctors' "check reading" and "confirm patient" (they
hold `ocr.job.write` and `ocr.validation.write`); hide the Laboratory and
Pharmacy department pages (work list, results, prescriptions) from doctors
and administrators; hide Outreach from doctors; hide visits and the Migrate
desk from laboratory staff. Screens already follow the permissions list in the
session, so most of this happens by itself.
