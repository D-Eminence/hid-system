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
`authorization/check`, `service/authorization/check`, `patient-lookup`),
Identity notes the access once per patient, facility and Africa/Lagos day (at
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
the `read_records` action for the exact facility and patient. Activation requires a reason, expires
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
`POST /api/v1/identity/service/authorization/check`. These return API DTOs,
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
| "Your Health ID password reset code": greets the patient by first name, names their Health ID, shows the code and its expiry in minutes | `POST /api/v1/auth/otp/start` with `PASSWORD_RESET` for a patient account with an email, patients migrated from hid-1.0 included since 0093 (key `otp:<challengeId>`). Staff, admin, legacy recovery and SMS keep the generic code message | `POST /api/v1/notifications/password-reset-code` `{ channel: "email", recipient, code, firstName?, healthId, expiresInMinutes (1-60), plan }` |
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
success. There is no Outreach create-patient, HID, NIN, campaign, encounter,
screening, document, OCR, or EHR-ingestion endpoint in this slice.

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

Patient confirmation is a separate idempotent command bound to the canonical
Identity patient already governing the source document. The server rechecks
write authorization and rejects break-glass, facility mismatch, wrong-patient,
and stale job versions.

Publication requires `Idempotency-Key`, `direct-care`, an explicit validation
ID/version, and the latest confirmation ID. Current operations are EHR
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

## 25. The sealed demo tenant (0098)

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
`patient1@healthidentitydirectory.com` (`HID-ZDEMAAA2`) and
`patient2@healthidentitydirectory.com` (`HID-ZDEMAAA3`); eight
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
`patient1@healthidentitydirectory.com` or `patient2@healthidentitydirectory.com`
is delivered to that mailbox but can never be accepted (acceptance needs a staff
login whose own verified address it is). Migrate's OCR
job creation is not available to testers, nor to any tenant: `POST
/api/v1/ocr/jobs` needs a `healthcare-operations` grant, which no portal path
issues (a platform-wide limitation tracked separately; 0098 widens nothing).
The owner can check production's purposes with `select code, active from
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
  `patient1@healthidentitydirectory.com` and
  `patient2@healthidentitydirectory.com`, the demo logins' own addresses.
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
