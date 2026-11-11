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
`removedItems` (up to 200 `{ itemId, removalReason }`, reason
`not_on_paper` | `duplicate` | `not_needed` | `unreadable` | `other_patient`),
`rejectionReasonCode` (only with `rejected`, else 400
`OCR_REJECTION_REASON_NOT_ALLOWED`: `wrong_patient`, `wrong_document`,
`unreadable`, `duplicate_document`, `pages_missing`, `reading_unusable`,
`not_clinical`, `other`), and on any `corrections[]` entry `itemId`, `fields`
(1-9 distinct of `name`, `strength`, `dose`, `frequency`, `route`, `duration`,
`date`, `value`, `unit`) and `changeReason` (`misread` | `clinical_update`).
They enter the review outcome as counts only. When sent they join the request
digest (the same `Idempotency-Key` with different signals answers 409
`IDEMPOTENCY_CONFLICT`); when absent the digest is exactly as before.

`GET /api/v1/ocr/quality/summary` (platform administrators only: platform
permissions `platform.admin.access` and `platform.operations.read`, staff
actor; anyone else 403 `PERMISSION_DENIED`) sums stored review outcomes by ISO
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
`ocr.quality.summary.read` with the range and counts only. Row-level security
limits it to the facility named by `X-Facility-ID` (`scope: 'bound_facility'`);
a cross-facility read needs a database change that is not part of this phase
(0119 adds it: Identity's `GET /api/v1/admin/ocr/quality-summary`, section 43).

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
  60 minutes today, so today the grant's end comes first). (0108 D-a: from
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
records processing, also under a PIN grant, which is read only for direct care:
bringing in paper records means creating, validating, confirming and retrying
OCR jobs. Direct care itself is unchanged: the PIN still opens the chart for
reading only, and publishing into the chart still needs the publisher's own
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
PIN command (direct care, read only; its grant covers records processing as
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
UPDATE are refused; a non-member's same UPDATE finds no row on both); the
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

## 43. OCR learning from reviews: correction rules and suggestions (0118, 0119)

Owner decision Q43 of 2026-11-11. The reading learns from the corrections staff
already make. Staff do no extra work: there are no approvers, no check-box and
no re-check. Phase 1 (section 15) only measured; this section adds rules and
suggestions.

**What is learned.** On an accepted validation (`disposition: validated`) ocr-api
looks at each linked reading item:
- a Pharmacy medicine saved with its `itemId`: fields `name`, `strength` and
  `frequency`;
- a Lab result saved with its `itemId`: fields `test` and `unit`.

For each field the reviewer changed, ocr-api sends `ocr.record_correction_observations(validationId, [{ field, readDigest, suggestValue }])`:
- `readDigest` is the SHA-256 of `hid.ocr.learning/v1|<field>|<normalised value read>`.
- `suggestValue` is the saved value when it is a closed-list value, else NULL (a
  conflict). Closed-list values are:
  - the drug list's generic or brand spelling, exact match only;
  - a strength such as `500mg`;
  - a frequency code (`od`, `bd`, `tds`, `qds`, `nocte`, `mane`, `stat`, `prn`);
  - a lab test name from the lab list;
  - a lab unit from the `LAB_UNITS` list.

Nothing from the paper reaches the database: only a digest and list values.
The database stores the digest only as its HMAC under its own key, and the
validation id likewise, so a row can be neither checked against guessed text
nor joined to a validation without the key.

These are not sent:
- a field saved unchanged (neither support nor conflict), including another
  spelling of the same list entry (a synonym);
- a field where a suggestion was shown: an accepted suggestion is recorded as a
  showing, never as new evidence, so a rule cannot re-arm from its own
  suggestions.

Two items with one key saved to different values are one conflict. Nothing
is learned from:
- EHR notes (whole text);
- unlinked entries;
- rejections;
- any document whose reading holds a sensitive item or page line. The classes
  are ARVs and HIV, TB, psychiatric and sickle cell, with words, regimens and
  tests; `services/ocr-api/src/ocr/learning/sensitive-classes.ts` is the
  versioned list, `hid.ocr.sensitive/v1`;
- any review that saves a sensitive value.

A suggestion of a sensitive value is never shown, whatever a rule holds.

The staff key is HMAC-SHA-256(account id) under a 32-byte key that 0118 creates
inside the database (`ocr.learning_key`). The owner of the OCR functions alone
reads it. It counts distinct staff, never who.

**Switch-on, retirement and kill switches** happen inside the database
(`ocr.learning_after_validation`). ocr-api calls it in its own READ COMMITTED
transaction after the validation committed, under a transaction advisory lock
per key and per rule.

A facility rule switches on when, at that facility, the evidence holds:
- at least 5 corrections to one value;
- from at least 3 staff;
- no conflict.

A platform rule switches on on the same terms with every facility combined,
from at least 2 facilities. The evidence counted is from the last 180 days and
after the rule's last retirement.

A rule retires itself when 3 of its last 10 showings were not taken. It re-arms
only from new evidence.

The owner kill switch exists per rule set: one for the platform and one per
facility. It is on when there is no row. The platform's switch off hides the
platform's rules everywhere. A facility's switch off hides every suggestion at
that facility, the platform's included: off means off for the people there. A
switch stops what is shown only: corrections are still counted (content-free,
no cost to users) and rules still switch on (coordinator, 2026-11-11). The
admin wording for a switched-off set is: "Suggestions are hidden. Health ID
still counts corrections so suggestions are ready if you switch them back on." `PUT /admin/ocr/learning-switches`
(Identity, platform super admin only) sets it, and the change is audited as
`admin.ocr.learning-switch.set`.

Retention:
- observations and showings are deleted after 180 days, by the learning
  commands and by the OCR worker's 7-day sweep (`ocr.purge_correction_observations`,
  `ocr.purge_learning_showings`);
- rules hold no paper text and are kept.

**Suggestions** appear on `GET /api/v1/ocr/jobs/:jobId/extractions`:
- Each `paperReading.items[]` entry may carry `suggestion: { field, value, text, ruleId, scope }`.
  - `field` is one of `name`, `strength`, `frequency`, `test`, `unit`, `diagnosis`.
  - `value` is the list value.
  - `text` is "Possibly <value>? Check the paper".
  - `scope` is `facility` or `platform`.
- Each item shows at most one suggestion, in this order: name, test, strength,
  frequency, unit.
- The facility's rule comes before the platform's. Nothing shows at a facility
  switched off, and no platform rule shows while the platform is switched off.
- There is no suggestion for a deleted source, for a sensitive reading, or when
  the lookup fails.

The website shows `text` as a plain hint beside the field: no click, no dismiss,
and never prefilled. The saved value is whatever the reviewer leaves. The
client sends nothing back: at validation ocr-api works out whether each
suggestion shown was taken (saved list value equals `value`). The
suggestions are worked out again at save time, so a rule that switched on,
retired or was switched off while the reviewer had the page open is counted as
it stands at the save. The suggestion is
never put in the reader's prompt.

**Failure never blocks.** Learning from a review runs after the validation
committed, in a separate transaction. Suggestions run in their own savepoint
of the read. On failure, including on a database without 0118/0119, the review
is saved and the reading shown. ocr-api logs only `ocr.learning.review_failed` or
`ocr.learning.suggestions_failed`, with the SQLSTATE and the job id. The OCR
worker logs `ocr.learning.purged { removed }` or `ocr.learning.purge_failed { code }`.

**Platform-wide quality summary** (the phase-2 part of section 15):
`GET /api/v1/admin/ocr/quality-summary?from&to` (Identity).
- Access: `platform.admin.access` and `platform.operations.read`, in a platform
  session. Anyone else gets 403.
- Range: UTC days, default the last 28, at most 92, widened to whole ISO weeks.
  Otherwise 400 `OCR_QUALITY_RANGE_INVALID`.
- Answer: `{ schema: 'hid.ocr.quality-summary/v1', scope: 'platform', from, to, minGroupSize: 20, itemGroups, reviewGroups }`.
  It is summed in the database (`ocr.review_outcome_summary`) over every
  facility's phase-1 outcomes:
  - item groups per week, facility, kind and prompt version, with `decisions`;
  - review groups with `counts`: reviews, validated, rejected, estimated,
    summary_failed;
  - a group under 20 is `{ ...keys, suppressed: true }`.
- Codes outside `^[a-z][a-z0-9_]{0,63}$` count as `other`.
- The read is audited as `admin.ocr.quality-summary.read`, with counts only.

`GET /api/v1/admin/ocr/learning` (`platform.admin.access`) answers
`{ ruleSets: [{ scope, facilityId, enabled, activeRules, retiredRules, showingsLast180Days, notTakenLast180Days }] }`.

Problems:

| Status | Code | When |
| --- | --- | --- |
| 400 | `OCR_QUALITY_RANGE_INVALID` | the summary's range |
| 400 | `OCR_LEARNING_SWITCH_INVALID` | `facilityId` given without scope `facility`, or missing with it |
| 400 | `OCR_LEARNING_REQUEST_INVALID` | the database refused the input (22023) |
| 403 | `PLATFORM_SUPER_ADMIN_REQUIRED` | a switch set by anyone but a platform super admin |
| 403 | `PERMISSION_DENIED` | the database refused the session (42501) |
| 404 | `FACILITY_NOT_FOUND` | a switch for an unknown facility |
| 503 | `OCR_LEARNING_UNAVAILABLE` | anything else |
