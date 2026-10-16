# HID Interface Contract

## Current browser and notification boundary

Production browsers call relative `/api/v1/*` URLs on their own approved app
hostname. The app-specific Cloudflare Worker proxies only that versioned
namespace to the fixed AWS origin and never accepts an upstream from browser
input. Cookie sessions are host-only; browser token storage is prohibited.

The client address reaches the APIs through the edge only
(D-Eminence/hid-system#65). The Worker replaces any caller-supplied
`X-Real-IP` with the address Cloudflare reports, and the AWS gateway trusts
that header only from the VPC and sends it on as `X-Forwarded-For`. In staging
and production the gateway refuses an API request without a usable client
address with `403 CLIENT_ADDRESS_REQUIRED`; a browser that reaches the API
through a Worker with this change never sees it (a Worker built earlier sends
no client address, so its API requests are refused). Every proxied API request
whose target holds a backslash before the query or a `#` anywhere answers
`400 INVALID_REQUEST_TARGET`; a browser's URL parser never sends either. The
gateway proxies only the modules named in `HID_ENABLED_API_ROUTES`: at launch
Identity (`/api/v1/auth`, `/identity`, `/audit`, `/admin`, `/commercial`) and
EHR (`/api/v1/ehr`). Lab, Pharmacy, OCR and Outreach prefixes answer
`404 API_ROUTE_NOT_FOUND`, as do the service-to-service routes
(`/api/v1/auth/service-session`, `/api/v1/identity/service/*`,
`/api/v1/identity/outreach/*`, `/api/v1/ehr/internal/*`, the document
scanner's callback `POST /api/v1/ehr/documents/scan-events` (ADR-055; the
scanner calls ehr-api on its private service name when uploads ship), and the
Lab and Pharmacy `accept-ehr-*` and `imports/from-ocr` routes) in any letter
case or spelling nginx normalizes. Public IP-keyed limits (recovery start, patient
enrollment start and contact, provider enrollment, organization application
intake and profile completion) count per client network: an IPv4 address or an
IPv6 /64. Without a usable client address, or, in production, with an address
of one of the platform's own proxies, they answer their 503
(`OTP_RATE_LIMIT_UNAVAILABLE` for recovery start,
`ENROLLMENT_RATE_LIMIT_UNAVAILABLE`,
`PROVIDER_ENROLLMENT_RATE_LIMIT_UNAVAILABLE`,
`APPLICATION_RATE_LIMIT_UNAVAILABLE`) instead of sharing one bucket.

The gateway passes every backend answer through unchanged, 5xx included
(ADR-055, A8): the status, the Problem Details body with its `code`,
`Set-Cookie`, `Retry-After` and `X-Correlation-ID`. Clients see the service's
own code (for example `503 PLATFORM_MAINTENANCE`, `503 MFA_UNAVAILABLE`,
`503 TURNSTILE_UNAVAILABLE`, `503 OTP_DELIVERY_UNAVAILABLE`,
`503 QOREID_DISABLED`) and any `502`. Only when the gateway gets no answer at
all (the service refuses or resets the connection, times out, has no running
task or closes without responding) does it answer
`503 UPSTREAM_UNAVAILABLE` with `Cache-Control: no-store`; the Worker answers
`502 API_ORIGIN_UNAVAILABLE` when it cannot reach the AWS origin. Clients
should branch on the codes they know and treat any other 5xx as unavailable.
A `POST /api/v1/auth/refresh` that fails with a 5xx keeps the session cookies
and rotates nothing (ADR-059, A6; table below), and the gateway passes that
answer through unchanged.

The gateway refuses a request body over 512 KiB with
`413 PAYLOAD_TOO_LARGE` Problem Details before any service sees it (the
largest JSON body a launch service accepts; Identity refuses more than
256 KiB with the same code). The public API WAF limits each client network
(an IPv4 address, or an IPv6 /64, which the Worker sends as
`X-HID-Client-Network` and the gateway does not pass on; a caller's own value
is replaced) to 2,000 requests per 5 minutes and answers a request over the
limit with `403` and the WAF's own non-JSON body; clients should treat it as
rate limiting. Devices sharing one IPv6 /64 share that limit. The WAF's 8 KB request-body rule does not
apply to `POST` and `PATCH` on the encounter-scoped clinical writes
(`/api/v1/ehr/patients/:patientId/encounters`, `/:encounterId`, and its
`clinical-notes` with `/:noteId/revisions`, `diagnoses`, `prescriptions` and
`lab-requests`), so a note up to the 100,000-character limit is accepted;
any other request with a body over 8 KB is refused by the WAF with `403`
(ADR-055, WAF-CRS-BODY).

The Health-id hosts (www, the staging web host and admin.*) answer with
`Strict-Transport-Security: max-age=31536000` and a Content-Security-Policy
that allows script only from the page's own origin and
`https://challenges.cloudflare.com` (Turnstile), frames and connections only to
that origin besides its own, styles, fonts and images (plus `data:` images)
only from its own origin, and no inline script, `eval`, plugins, workers or
framing by another site. Every `/api/v1` and edge answer carries
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` and the
same HSTS (ADR-055, D6). The page policy allows no storage origin: document
uploads (off at launch) send the file straight to the presigned S3 URL, so the
release that switches them on adds the documents bucket's origin to
`connect-src`.

Authentication OTP commands are purpose-bound and use three stages: start
returns a generic challenge, verify accepts exactly six digits and returns an
opaque one-time completion credential, and complete consumes that credential.
Identity calls Notification API directly over workload authentication; these
credentials never use the ordinary-notification event path. In production the
Notification API runs the `otp-email-sms` profile (ADR-053,
D-Eminence/hid-system#66): `POST /notifications/otp` delivers
`email` through SES and `sms` through Termii and answers `400` for `whatsapp`
without a provider attempt; Identity sends only `email` and `sms`. The `202`
response's `requestId` is also the correlation id of the one PHI-free
`notification.otp.outcome` log line written per send; when the fallback ran,
that line also names the primary provider and its safe code. Ordinary domain
events remain minimum-necessary versioned envelopes delivered through outbox,
Event Dispatcher, EventBridge/SQS, Notification Worker, and Novu
("Notification worker to Novu" below).

Public patient enrollment proves the chosen contact with a six-digit code
(`POST /api/v1/identity/patient-enrollments/contact`, then `/contact/verify`;
[QoreID verification contract](QOREID_VERIFICATION_CONTRACT.md)). Besides each
challenge's attempt limit, wrong codes spend one failure budget per recipient
across its challenges and enrollments, never per client IP. By default the
fifth wrong code within 15 minutes blocks the recipient for 15 minutes
(`PATIENT_ENROLLMENT_CONTACT_FAILURE_MAX`,
`PATIENT_ENROLLMENT_CONTACT_FAILURE_WINDOW_SECONDS`): `/contact/verify`
answers `422 OTP_INVALID` for every code, a correct one too, and `/contact`
answers `429 ENROLLMENT_RATE_LIMITED` and sends no code. Both responses are
the existing ones, unchanged in shape. Since this change (A21) the `429`
carries the same `Retry-After` as the contact step's request limits (§6), so
a spent budget and a request limit cannot be told apart; the `422` carries
none. This comes from
D-Eminence/hid-system#61, not yet deployed; the threshold is an
open product decision.

### Notification worker to Novu

No HID route changes. The worker calls Novu as below (ADR-064, migration
0095).

- Main's trigger: `POST {NOVU_API_URL}/v1/events/trigger` with
  `idempotency-key: <event id>` and the body `{"name": <workflow>, "to":
  {"subscriberId": <canonical patient UUID>}, "payload": {"message": "You have
  a new update in HID. Sign in securely to view it."}}`. With
  `NOVU_SUBSCRIBER_SYNC=disabled` (the default, and the only value production
  accepts) this is the only call, for every event, as on main. With
  `NOVU_SUBSCRIBER_SYNC=email` it is sent after the subscriber call below,
  except in two cases: when a clear is not confirmed the worker sends the
  email-withheld trigger instead, and when the claim is lost (55000) it sends
  no trigger at all.
- With `NOVU_SUBSCRIBER_SYNC=email` the worker first asks the database,
  through `integration.notification_recipient_for_claim(event, claim token,
  patient)`, for its live claim's answer: `email` with the verified login
  email, or `withhold`. Names are never part of the answer or of any call.
  Each subscriber key below includes the attempt's claim token (unique per
  attempt), because Novu answers a seen idempotency key from its cache for
  24 hours, success or error, without processing it again; a retry of the
  event is therefore a new request. The key holds neither the token nor the
  address.
  - `email`: `POST /v2/subscribers` with exactly `{"subscriberId": <patient
    UUID>, "email": <address>}` and `idempotency-key` = lowercase hex
    sha256(`hid-novu-subscriber-email-v1` U+001F event id U+001F claim token
    U+001F sha256(address)). Then the worker asks the database again under
    the same claim. If it answers the same address, main's trigger follows,
    whatever the subscriber call answered. Any other answer (withheld,
    another address or a failed lookup) is handled as `withhold` below, so
    an upsert that reached Novu after another event's clear is cleared again.
  - `withhold` (opted out; a login that is not active, is suspended
    (`disabled_until` ahead), is due for deletion or is deleted; a patient
    who is not active; no verified email; no login; a phone-only login; no
    outbox envelope bound to the claim (`unbound`); or a lookup that failed):
    `PATCH /v2/subscribers/{patient UUID}` with exactly `{"email": null}` and
    `idempotency-key` = sha256(`hid-novu-subscriber-email-clear-v1` U+001F
    event id U+001F claim token). After a `2xx` or `404` (no such
    subscriber), main's trigger. Otherwise the email-withheld trigger: `"to":
    {"subscriberId": <patient UUID>, "email": null}`, the same workflow and
    message, and `idempotency-key` = sha256(`hid-novu-trigger-email-withheld-v1`
    U+001F event id).
  - A claim lost at the first lookup sends nothing. A claim lost at the
    second lookup, after a sync, sends the clear above and nothing else. In
    both cases the message is neither completed, failed nor acknowledged.
  - Each call has a 5-second timeout. A subscriber call answering `2xx` is
    confirmed; `408`, `409`, `429`, `5xx`, a timeout or no answer is unknown;
    any other `4xx` is refused. No subscriber answer decides whether the
    trigger is sent: the inbox outcome is the trigger's, as on main (accepted
    completes; `408`, `429`, `5xx` or no answer retries; another `4xx` is
    terminal).
- The worker writes one stdout line per flag-on event attempt:
  `{"event":"notification.worker.outcome","eventType":...,"correlationId":...,
  "recipient":"email|withhold|unbound|lookup_failed|withdrawn|claim_lost",
  "subscriber":"synced|sync_failed|cleared|clear_failed|not_run",
  "subscriberCode"?,"trigger":"standard|email_withheld|not_sent",
  "triggerOutcome"?,"triggerCode"?,"inbox":"processed|retry_scheduled|failed_terminal|claim_lost"}`.
  `withdrawn` means the first lookup answered `email` and the second did not
  confirm it, so the email was cleared. It never holds the address, the
  patient, the event id or a key; a correlation id outside the outbox's own
  pattern is written as `invalid`.
- Turning the flag off does not clear what it synced: main's trigger then
  goes to subscribers that may still hold an address. Release checklist §9
  clears them before the flag is turned off or the worker is rolled back.

### Turnstile verification

Identity verifies a Cloudflare Turnstile token on eleven public or
first-step routes (table below), each with its own action. Identity never
trusts the widget: it sends the token to Cloudflare Siteverify itself, with
its own secret, and accepts it only if Cloudflare reports success for the
request's own host and the route's action. A route not in the table does
not check a token.

The browser sends, in the JSON body:

- `turnstileToken`: the widget's token, at most 2048 characters;
- `turnstileAction`: the action the widget was rendered with, which must be
  the route's action (below).

The `Origin` header must be the page's own origin and one of `CORS_ORIGINS`.
Identity refuses at the first failed check:

1. The body is valid for the route and names the route's action: else
   `400 VALIDATION_FAILED`, with these exceptions. `POST /auth/login`
   answers a `patient-login` or `admin-login` action
   `400 INVALID_LOGIN_ACTION`. `POST /auth/patient/login` and
   `POST /auth/google/link` answer any action but `patient-login` (for
   patient sign-in, a missing one too) `400 INVALID_LOGIN_ACTION`.
   `POST /auth/oidc/exchange` answers `staff-login`
   `403 GOOGLE_STAFF_SIGN_IN_DISABLED`. The `Origin` is allowed: else
   `403 ORIGIN_DENIED`. Some routes make their own checks here too, such as
   the `Idempotency-Key` of a demo request or the signed-out state of a
   provider enrollment.
2. A token is present: else `400 TURNSTILE_REQUIRED`. A missing token and an
   empty one get the same answer on every route.
3. The host of the `Origin` may present this action in this deployment
   (table below): else `403 TURNSTILE_CONTEXT_MISMATCH`.
4. Cloudflare Siteverify accepts the token, and reports the same host and
   action: else one of the `403` or `503` answers below.

Steps 1 to 3 never call Cloudflare, so the token is not spent and the widget
can be submitted again. Once step 4 runs, the token is spent (or, after a
`503`, may be), whatever the route answers afterwards (a wrong password,
`409`, `429`). **A token is good for one request.** The browser
resets the widget after every submission and sends a new token with the next
one, including a retry of the same request under the same `Idempotency-Key`
and a request repeated after a session refresh.

| Answer | Meaning | What the browser does |
|---|---|---|
| `400 TURNSTILE_REQUIRED` | No token, or (`POST /auth/login`) no action | Complete the check and submit |
| `403 TURNSTILE_CONTEXT_MISMATCH` | This host may not present this action | A build or configuration error: the page uses the wrong action for its host |
| `403 TURNSTILE_REJECTED` | Cloudflare refused the token | Reset the widget, complete it again |
| `403 TURNSTILE_EXPIRED_OR_REPLAYED` | The token is over 300 seconds old or was already used | Reset the widget, complete it again |
| `403 TURNSTILE_HOSTNAME_MISMATCH` | The token was issued on another host | Reset the widget; a configuration error if it repeats |
| `403 TURNSTILE_ACTION_MISMATCH` | The token was issued for another action | Reset the widget; the page renders the widget with the wrong action if it repeats |
| `503 TURNSTILE_UNAVAILABLE` | Siteverify was unreachable or failed, or refused Identity's own secret | Reset the widget and let the user try again later |

These are Problem Details with their `code`. The API WAF's own `403` for rate
limiting has a non-JSON body and no `code`; a client tells the two apart by
the `code`.

Identity asks Siteverify at most twice per check: once more, with the same
idempotency key, after a network failure, a timeout (`TURNSTILE_TIMEOUT_MS`,
3 seconds by default) or a `5xx`. Cloudflare answers that retry with the
first result, so a token spent by an attempt whose answer was lost is not
refused as a replay. A new request never reuses another request's key.
Siteverify refusing Identity's own request (Cloudflare answers HTTP 400 with
`missing-input-secret`, `invalid-input-secret` or `bad-request`) and
Cloudflare's `internal-error` are `503`, not a rejection: the fault is the
server's.

Each refusal at step 3 or 4 and each `503` writes one log line,
`event=turnstile_verification`. A refusal line has the outcome code, the
action and Cloudflare's error codes; a `503` line also has a `reason` and
the number of Siteverify attempts. The reasons are `siteverify_unreachable`,
`siteverify_http_<status>` (a 5xx or 429), `siteverify_unreadable`,
`siteverify_internal_error` (Cloudflare's own fault, warning level),
`siteverify_refused_configuration` and `secret_missing` (Identity's own
configuration, error level; the `codes` field tells a wrong secret,
`invalid-input-secret`, from a missing one or a malformed request). A line
never contains the token, the secret, the `Origin` or the client address.

**Routes and actions.** At launch only the web host (`www`, staging:
`staging`) and the admin host (`admin`, `admin.staging`) are deployed
(ADR-052); the other product hosts keep their entries for when they ship.

| Route | `turnstileAction` | Hosts (production; staging adds `.staging`, and the web host is `staging`) |
|---|---|---|
| `POST /api/v1/auth/patient/login` | `patient-login` | `www` |
| `POST /api/v1/auth/login` (staff password step) | `staff-login` | `www`, `ehr` |
| | `ehr-login`, `lab-login`, `pharmacy-login`, `ocr-login`, `outreach-login` | `ehr`, `lab`, `pharmacy`, `migrate`, `outreach` respectively |
| `POST /api/v1/auth/admin/login` | `admin-login` | `admin`, `www` |
| `POST /api/v1/auth/otp/start` | `patient-reset-start`, `legacy-recovery`, `staff-reset` | `www` |
| | `admin-reset` | `admin`, `www` |
| `POST /api/v1/auth/oidc/exchange` (Google; off at launch, P19) | `patient-login` | `www` |
| `POST /api/v1/auth/google/link` (signed-in patient; off at launch) | `patient-login` | `www` |
| `POST /api/v1/identity/patient-enrollments` | `patient-enrollment` | `www` |
| `POST /api/v1/identity/provider-enrollments` | `provider-enrollment` | `www` |
| `POST /api/v1/identity/organization-applications` | `organization-application` | `www` |
| `POST /api/v1/identity/organization-applications/completion/start` | `organization-completion` | `www` |
| `POST /api/v1/commercial/demo-requests` | `book-demo` | `www` |

`POST /auth/login` takes only the six workforce actions: a `patient-login`
or `admin-login` action is `400 INVALID_LOGIN_ACTION` before Cloudflare is
called, so a token from the patient or platform sign-in page never reaches
the staff password step.

**Routes without Turnstile, by design.** Each later step of a gated flow is
bound to the challenge, cookie or session its first step created, and has its
own attempt and rate limits: the MFA steps (`/auth/mfa/*`,
`/auth/admin/mfa/*`, including `mfa/enroll/email-code`), `otp/verify` and
`otp/complete`, the patient enrollment contact, verify, activate, Google and
current steps, provider enrollment verify and activate, organization
completion verify and profile, `GET /auth/google/nonce`, and refresh,
session and logout. `GET /identity/patient-enrollments/availability` is a
public read with no input.

**Deployments.** In `TURNSTILE_MODE=disabled` (local development and tests
only) Identity accepts any request without calling Cloudflare. Every
`NODE_ENV=production` task, and any task with the production deployment
profile whatever its `NODE_ENV`, refuses to start unless Turnstile is
required, its secret is set, Siteverify is Cloudflare's, and every
`CORS_ORIGINS` host has at least one action in the table for the task's
deployment profile. The Turnstile secret is server-only; the widget's site
key is the frontend's (`VITE_HID_TURNSTILE_SITE_KEY`, P14).

### Auth session contract

This is the browser contract of staff and patient sessions. Sign-out without
a live access token, the `X-HID-Client` check and the refresh-token lookup
rules below come from D-Eminence/hid-system#39, which is not yet deployed. Platform administration sessions use their own cookies and
`/auth/admin/*` routes (`PHASE_4_STAGE_2A_BACKEND_SECURITY.md` §1). The
enrollment cookie rule and the lookups' actor condition come from
D-Eminence/hid-system#50, also not deployed. Staff sign-in with an
authenticator, the `STAFF_MFA_REQUIRED` refusals and the refusal of a staff
Google exchange (below) come from D-Eminence/hid-system#71 (launch blocker
MFA-1, migration 0088), also not deployed. `facilitySelection` on staff session
responses ("Working facility per sign-in", below) comes from
D-Eminence/hid-system#73 (ADR-046, migration 0089), also not
deployed. The refusal and fault answers of
ADR-059 ("Refusals and faults", below) and the refresh fault row come from
D-Eminence/hid-system#76 (no migration), also not deployed.

Identity sets three cookies at sign-in and on every refresh (`setCookies` in
`services/identity-api/src/auth/auth.controller.ts`). Their names derive from
`AUTH_COOKIE_NAME` (default `hid_access`). All three are `SameSite=Strict`,
carry no `Domain` attribute (host-only), and are `Secure` when
`AUTH_COOKIE_SECURE` is set, which production requires.

| Cookie | HttpOnly | Path | Expires |
|---|---|---|---|
| `hid_access` (access token) | Yes | `/` | With the access token: `AUTH_ACCESS_TTL_SECONDS`, 15 minutes by default, never past the sign-in's absolute end |
| `hid_access_refresh` (refresh token) | Yes | `/api/v1/auth` | End of the refresh window: `AUTH_REFRESH_TTL_SECONDS`, 8 hours by default after sign-in or the last refresh. A refresh never extends it past the sign-in's absolute end (`AUTH_ABSOLUTE_TTL_SECONDS`, 24 hours by default) |
| `hid_access_csrf` (CSRF token) | No | `/` | Same as the refresh cookie |

The CSRF token is derived from the refresh token. Sign-in and refresh also
return it in the `X-CSRF-Token` response header, and cookie mutations send it
back in the `X-CSRF-Token` request header.

Every response that sets these cookies (a patient sign-in by password or
Google, the second factor or enrolment activation of a staff sign-in, and a
refresh) or clears them also expires the public patient enrollment cookie
`hid_enrollment` on its
path, `/api/v1/identity/patient-enrollments` (HttpOnly, `SameSite=Strict`,
`Secure` as above). So does every successful public enrollment activation
response (`200`, a replay's included; D-Eminence/hid-system#68,
not deployed). If that response is lost, the cookie lets
`GET /identity/patient-enrollments/current` and an activation replay show the
enrollment's HID on the enrolling device for 15 minutes after activation;
after that both answer `404 ENROLLMENT_NOT_FOUND`
([QoreID verification contract](QOREID_VERIFICATION_CONTRACT.md)). A
signed-in patient reads the HID from `GET /identity/me`, and the enrollment
routes refuse while session cookies are present. Every other response leaves
it: a refused sign-in or activation, a pending Google enrollee (`202`), the
staff password step and the email-code and enrolment-start steps, and each
refresh or sign-out refusal that leaves the session cookies untouched or kept
(below). Provider enrollment activation (which now opens a staff MFA
enrolment, below) expires it. Platform administration sign-in does not touch
it.

#### Staff sign-in with an authenticator (MFA-1, 0088)

A staff session is issued only after the password and a second factor: a TOTP
code (RFC 6238, SHA-1, six digits, 30-second steps) or one unused recovery
code, as a platform session is (`PHASE_4_STAGE_2A_BACKEND_SECURITY.md` §1).
The account has one factor whichever kind of session it signs in to, so an
administrator who also works at a facility uses the same authenticator for
both, provided it was enrolled at staff sign-in: only a factor that records a
staff enrolment proof (below) verifies a staff sign-in. A factor enrolled at
platform sign-in, on the password alone, verifies platform sign-in only. There
is no permission or role allowlist: every staff sign-in needs it.

| Route | Body | Answer |
|---|---|---|
| `POST /api/v1/auth/login` | `{ email, password, turnstileAction: 'staff-login', turnstileToken? }` | `200 { status: 'mfa_required' \| 'mfa_enrollment_required', expiresAt }` with only the challenge cookie `hid_access_mfa` (HttpOnly, `SameSite=Strict`, `Secure` as above, path `/api/v1/auth/mfa`, 5 minutes for `mfa_required`, 10 minutes for enrolment) and `Cache-Control: no-store`. No session cookie, no `X-CSRF-Token`, no actor. A wrong password, and an account with neither a staff record nor a facility membership, get the same `401` ("Invalid credentials") and count against the sign-in budget below. The right password of an active account that has a staff record or a membership, none of them eligible, gets `403 NO_ACTIVE_FACILITY_MEMBERSHIP` (below) |
| `POST /api/v1/auth/mfa/verify` | `{ code }` or `{ recoveryCode }` | `200 { actor, expiresAt, facilitySelection: 'default' }` with the three session cookies, `X-CSRF-Token`, and the challenge cookie cleared (`facilitySelection`: "Working facility per sign-in", below) |
| `POST /api/v1/auth/mfa/enroll/email-code` | none | First sign-in without an authenticator: sends a six-digit code to the account's email address. `200 { accepted: true, channel: 'email', expiresAt }`. A resend replaces the code |
| `POST /api/v1/auth/mfa/enroll/start` | `{ emailCode? }` | `200 { secret, otpauthUri, algorithm, digits, periodSeconds, expiresAt }`, once (`Cache-Control: no-store`). Needs the emailed code, or a challenge opened by provider enrollment activation (no code) |
| `POST /api/v1/auth/mfa/enroll/activate` | `{ code }` (the first TOTP code) | `200 { actor, expiresAt, facilitySelection: 'default', recoveryCodes }` (ten codes, shown once) with the session cookies and `X-CSRF-Token`, and the challenge cookie cleared |

Every step requires an allowed `Origin` (`403 ORIGIN_DENIED`) and the
challenge cookie (`401 MFA_CHALLENGE_INVALID` without it, or when it is
expired, consumed, superseded by a newer password step, or a platform
challenge). A staff challenge is accepted by no `/auth/admin/mfa/*` step and a
platform challenge by no staff step. Refusals:

| Code | When |
|---|---|
| `403 STAFF_MFA_FACTOR_UNPROVEN` | `POST /auth/login` with the right password, but the account's authenticator was enrolled at platform sign-in on the password alone (before 0088, or before the account held a staff membership), so it records no staff proof. No challenge or cookie is issued; a denied `login_failed` session event (reason `staff_mfa_factor_unproven`) is recorded. The remedy is a two-person MFA reset (0070), after which the account enrols at staff sign-in; the new factor then verifies platform sign-in too. The same answer at `/auth/mfa/verify` if such a factor is met there |
| `403 NO_ACTIVE_FACILITY_MEMBERSHIP` | `POST /auth/login` with the right password of an active, enabled account that has a staff record or a facility membership but no membership eligible for staff sign-in: every one ended, suspended or held, the staff record not active or its verification not accepted, or the organization or facility not active (`eligibleStaffMembershipJoins`). Launch decision NO-MEMBERSHIP-SIGN-IN, owner default (a), ADR-059. No challenge or cookie and no session. A denied `login_failed` session event (reason `no_active_membership`) is recorded. It is not counted as a failed sign-in. Like any right password it ends the account's own failure window (SIGNIN-LOCKOUT); the window of the identifier typed is unchanged. The detail asks the user to contact their organization administrator. Checked before the factor, so it answers the same with or without an authenticator. An account with neither (a patient or a platform-only account) keeps the uniform `401` |
| `401 MFA_INVALID_CODE` | A wrong, reused (the same 30-second step twice) or already used code; a wrong email code. Each counts against the challenge (five attempts), the account's MFA failure budget and the source address's staff budget |
| `429 MFA_RATE_LIMITED` | A failure budget is spent, and while it is every code is refused, a correct one too, until its 15-minute window passes: the account's (the fifth failed code within 15 minutes, staff and platform together), or the source address's staff budget (the 100th failed staff code from one address within 15 minutes; it is the staff sign-in's own, apart from platform sign-in's per-address budget of 20, and sized for a facility whose staff share one address). Also more than five enrolment-code sends or enrolment starts in 15 minutes. Since this change (A21) it carries `Retry-After: 900`, the whole window, whichever budget refused (§6) |
| `403 MFA_ENROLLMENT_PROOF_REQUIRED` | Enrolment start or activation without a verified proof (no email code, and the challenge was not opened by provider activation). No factor is created |
| `409 MFA_ENROLLMENT_PROOF_COMPLETE` | An email code asked for once the proof is verified |
| `409 MFA_ENROLLMENT_PROOF_UNAVAILABLE` | The account has no email address |
| `503 MFA_ENROLLMENT_CODE_UNDELIVERABLE` | The notification service refused the code definitively, or no notification client is configured |
| `503 MFA_UNAVAILABLE` | `MFA_SECRET_KEY_B64` is not configured: no staff or platform session can be issued |
| `400 MFA_CODE_REQUIRED` | `verify` with neither or both of `code` and `recoveryCode` |

Only a keyed digest of the email code is stored, bound to its challenge. The
code goes to the account's email address (`auth.accounts.email`) whether or
not `email_verified_at` is set: no flow marks a staff address verified (it is
the work address that provisioning or onboarding set, as for staff password
recovery), so the code itself proves control of that address. The code, or
the provider activation, is the fresh proof of a first enrolment, and the new
factor records it (`enrollment_proof`). So the password alone never enrols a
staff authenticator, and a stolen password cannot be turned into a staff
session on an account that has none. The database enforces what it can see
(0088): a staff enrolment challenge is consumed only once it records a
verified proof, a factor records a proof only from such a challenge of its own
account, and a staff session's MFA assurance must name a factor that records
one. It cannot check the emailed code itself; Identity does.

The email code proves the same mailbox that staff password recovery uses. For
an account without a factor, control of that mailbox is therefore enough on
its own: `staff-reset` recovery sets a new password and the enrolment code
goes to the same address. Accounts provisioned without a password
(organization onboarding, 0046, and governed workforce provisioning, 0087) set
their first password that way, by design. Once an account has a factor,
recovery keeps it, and a mailbox alone never yields a staff session. Until a
second enrolment channel exists (an open decision, D14 in
`PHASE_3_LAUNCH_DECISIONS.md`), existing clinical accounts enrol before
clinical roles are enabled, and operators review enrolments that followed a
recovery (`PHASE_4_STAGE_5_RELEASE_READINESS.md` P22, `MIGRATION_RUNBOOK.md`
§6).

A platform first enrolment (`POST /api/v1/auth/admin/mfa/enroll/start`) of an
account that holds an eligible staff membership answers `409
MFA_ENROLLMENT_STAFF_SIGN_IN_REQUIRED` and creates no factor: such an account
enrols at staff sign-in, with the proof, and then uses that factor for
platform sign-in. A platform administrator without a staff membership enrols
at platform sign-in as before (`PHASE_4_STAGE_2A_BACKEND_SECURITY.md` §1).

`POST /api/v1/identity/provider-enrollments/activate` sets the administrator's
password and answers `200 { activated: true, organizationId, facilityId,
accountId, status, expiresAt }` with the `hid_access_mfa` challenge cookie of
an enrolment whose proof is the activation itself (the administrator's email
was verified by that enrollment), and no session cookie. It clears the
provider enrollment cookie and `hid_enrollment`. The client continues with
`/auth/mfa/enroll/start` (no email code) and `/auth/mfa/enroll/activate`,
which issues the session. If the account already has an authenticator the
status is `mfa_required` and the client continues with `/auth/mfa/verify`.

**Provider enrollment answers a client should handle** (all Problem Details;
the `detail` of a `4xx` is written for the applicant and may be shown as it
is):

| Step | Status and code | Meaning |
| --- | --- | --- |
| Start | `422 CAC_NOT_VERIFIED` | QoreID did not verify the CAC number. |
| Start | `409 PROVIDER_CAC_PROFILE_INCOMPLETE` | QoreID verified the CAC, but its record lacks the company name, type, registration date or address, or the company is not active. It cannot be registered automatically. Detail, true in both cases: "We could not register your organization automatically from its CAC record. The record is missing details we need or does not show the company as active. Contact Health ID support." Nothing is recorded, no email code is sent, and the lookup counts against the CAC lookup quota as any lookup does. |
| Start | `409 PROVIDER_ENROLLMENT_REQUIRES_REVIEW` | The CAC already has another application for this product (a governed one, or one with another administrator email), or is already registered. Also the answer when another application for the same CAC and product is opened at the same moment (a unique violation at start). |
| Start | `429 VERIFICATION_QUOTA_EXCEEDED`, `429 APPLICATION_RATE_LIMITED` | A lookup or email-code limit was reached; try later. |
| Start | `502 QOREID_PROVIDER_RESPONSE_INVALID` | QoreID's answer was malformed. Treat as unavailable. |
| Start | `503 QOREID_DISABLED`, `503 INTEGRATION_PAUSED`, `503 PROVIDER_CAC_VERIFICATION_UNAVAILABLE` | CAC verification is off or unavailable. |
| Verify | `401 ORGANIZATION_COMPLETION_CODE_INVALID` | Wrong or expired email code. |
| Activate | `401 ORGANIZATION_COMPLETION_SESSION_INVALID` | No valid enrollment cookie; start again. |
| Activate | `409 PROVIDER_EMAIL_ALREADY_REGISTERED` | The administrator email already belongs to a Health ID account or staff record (a patient account counts). Detail: "The administrator email is already associated with an HID account". Nothing is created. |
| Activate | `409 ORGANIZATION_REVIEW_REQUIRED` | The CAC is already bound to an organization, an organization has the same name, or the application is no longer ready. |
| Any step | `409 PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT` | A session cookie or bearer token was sent; sign out first. |

`PROVIDER_EMAIL_ALREADY_REGISTERED` comes only from activation, after the
emailed code proved control of that mailbox, so it tells a stranger nothing.
Start does not check whether an email has an account. A unique violation at
start can only be another application for the same CAC and product, so it
answers `409 PROVIDER_ENROLLMENT_REQUIRES_REVIEW`; before
D-Eminence/hid-system#81 it answered the email code, which was
not true. The application stays
bound to that email: starting again for the same CAC with another email
answers `409 PROVIDER_ENROLLMENT_REQUIRES_REVIEW`, so the applicant signs in
with the existing account or asks Health ID support. Whether one person may
use one email for both a patient account and a provider administrator is an
open owner decision. Any other unique violation at activation keeps `503
ORGANIZATION_COMPLETION_UNAVAILABLE`.

`PROVIDER_CAC_PROFILE_INCOMPLETE` does not point to the governed organization
application (`POST /api/v1/identity/organization-applications` and its
profile completion), which can take a sparse record: the route is open, but
no launch page uses it (Health-id's public site, `apps/public-web`, is not
deployed at launch). A retry repeats the lookup, within the CAC lookup quota.

A staff session is authorized only while its sign-in has live MFA assurance:
an `auth.session_assurance` row for its family whose factor is still active.
Without it (every staff sign-in from before this change, or one whose
authenticator was reset by a two-person MFA reset), every route behind
`SecurityGuard` answers `403 STAFF_MFA_REQUIRED`, audited as
`auth.authorization.denied` (before any facility is bound). That includes
`GET /auth/session`, `POST /auth/facility` and the
`/auth/service-session` checks that EHR, Lab, Pharmacy, OCR and Outreach make,
which relay the `403 STAFF_MFA_REQUIRED` to the browser. Refresh ends such a
sign-in (below). Sign-out still works. Clients sign in again with password and
authenticator on `STAFF_MFA_REQUIRED`.

`POST /api/v1/auth/oidc/exchange` signs in patients only: any
`turnstileAction` other than `patient-login` is `403
GOOGLE_STAFF_SIGN_IN_DISABLED`, before Turnstile, the nonce or the Google
token are checked, and is audited. With `AUTH_MODE=oidc`, OIDC bearer tokens
carry no MFA assurance and are refused for staff (`403 STAFF_MFA_REQUIRED`).

Audit: `auth.staff.mfa.enrolled` (with the proof method),
`auth.staff.mfa.failed`, `auth.staff.mfa.recovery-code.used` (with the codes
left; platform: `auth.admin.mfa.recovery-code.used`), and `auth.login` with
`mfaMethod` (`totp` or `recovery_code`) at the second factor. Session events
record `mfa_challenge_issued`, `login_succeeded` (with `session_kind` and
`mfa_method`) and `mfa_rate_limited`. Enrolment, recovery-code use and a
two-person MFA reset are offered to an owner notice sink (`MFA_NOTICE_SINK`)
after commit; no delivery route is bound yet, so today they are audited only.

`POST /api/v1/auth/refresh` takes no body. It reads the refresh and CSRF
cookies, `X-CSRF-Token` and, optionally, `X-HID-Client`, and checks them in
this order:

| Outcome | When | Cookies |
|---|---|---|
| `403 ORIGIN_DENIED` | `Origin` is missing or not in `CORS_ORIGINS` | Untouched |
| `403 CSRF_VALIDATION_FAILED` | The refresh cookie is missing, or `X-CSRF-Token` and the CSRF cookie are missing, differ, or are not the value derived from the refresh token | Untouched |
| `403 SESSION_CLIENT_MISMATCH` | `X-HID-Client` names the other kind of sign-in (below). Nothing is rotated | Kept |
| `403 STAFF_MFA_REQUIRED` | A staff sign-in without live MFA assurance (MFA-1, 0088): one from before staff MFA, or whose authenticator was reset. Nothing is rotated; the whole sign-in is ended (revocation reason `staff_mfa_required`, a denied `refresh` session event) | Cleared |
| `401 AUTHENTICATION_REQUIRED` | Rotation refuses the token: unknown, ended, expired, reused (reuse ends the whole sign-in), a platform token, or an account that is no longer active, is disabled or has a new token version | Cleared |
| `5xx` | A fault while rotating (ADR-059): `503 DEPENDENCY_UNAVAILABLE` when the `auth.refresh` audit row cannot be written, `500` for another database fault. The audit row is written in the rotation's own transaction, so the rotation commits with it or not at all: nothing is rotated and the presented refresh token stays live. Before, such a fault cleared the cookies and signed the user out, and a rotation could commit without its audit row. The client may retry | Untouched |
| `200` `{ actor, expiresAt }` with a new `X-CSRF-Token` header, plus `facilitySelection` for a staff sign-in (below) | The refresh token is rotated into a new session of the same sign-in. A staff sign-in's facility selection is read in the rotation's transaction, and the `auth.refresh` audit row records the facility the response reports. If the selection cannot be read, the read is rolled back to its savepoint and the rotation still commits: it is still `200`, with `facilitySelection: 'unavailable'` (below) | Replaced |

The cookies are cleared only for a `4xx` refusal of the refresh token itself
(`refreshRefused` in `services/identity-api/src/auth/refresh-refusal.ts`).
`POST /auth/admin/refresh` follows the same rule for the platform cookies: a
refused platform token (`401 PLATFORM_SESSION_EXPIRED`,
`PLATFORM_SESSION_REVOKED`, `AUTHENTICATION_REQUIRED`) clears them, a fault
keeps them.

`POST /api/v1/auth/logout` takes no body and answers `204` with no content
when it does not refuse. It is public at the guard and authenticates the
request itself, so platform maintenance (`503 PLATFORM_MAINTENANCE`) and a
disabled portal (`423 PLATFORM_PORTAL_DISABLED`) no longer block sign-out.

- **Bearer** (`Authorization: Bearer <access token>`). No Origin, CSRF or
  `X-HID-Client` check. A live staff or patient token ends its own sign-in. A
  token that is no longer live is `401 AUTHENTICATION_REQUIRED`; a platform
  token is `403 PLATFORM_SESSION_SCOPE_DENIED`.
- **Cookie** (no bearer token). `Origin` must be in `CORS_ORIGINS`; otherwise
  the answer is `403 ORIGIN_DENIED` and nothing changes, cookies included.
  Then:
  - A live access cookie decides. It needs its own CSRF token, else
    `403 CSRF_VALIDATION_FAILED` and nothing ends. When it passes, its sign-in
    ends; a platform token is `403 PLATFORM_SESSION_SCOPE_DENIED`. A refresh
    cookie sent with it is not used, so a request carrying one account's access
    cookie and another account's refresh cookie ends only the first.
  - Without a live access cookie (it expired, or the sign-in rotated in another
    tab), the refresh cookie ends its sign-in. The CSRF cookie and
    `X-CSRF-Token` must both equal the value derived from that refresh token,
    else `403 CSRF_VALIDATION_FAILED` and nothing ends. Another account's
    refresh cookie therefore cannot be ended with this session's CSRF token.
    A refresh token whose sign-in has nothing left to end (below) still
    answers `204`.
  - With neither cookie, `204`.

Every sign-out outcome clears the three cookies, and expires the enrollment
cookie, except `ORIGIN_DENIED` and `SESSION_CLIENT_MISMATCH`. A CSRF refusal therefore clears the browser's
cookies without ending the sign-in, which stays live on the server until it is
signed out with valid evidence or lapses. Ending a sign-in takes the
account's lock and revokes every unrevoked session of the presented session's
family, with revocation reason `logout` (a rotated presented session keeps
`rotated`). When that revoked anything, it records an `auth.session_events`
`logout` event (marked `presented: refresh_token` on the refresh-cookie path)
and audits `auth.logout`. Two sign-outs at once with one browser's cookies
(two tabs), by either path, therefore record one sign-out. A refused sign-out
made with a live access token is audited against that actor, as an
`auth.logout` failure on resource type `session` naming its session, with no
facility, membership or organization. Refusals on the other session routes
raised after the `SecurityGuard` (by validation or the handler) are audited the
same way, as their `auth.*` session events (`AuditSessionEvent` in
`common/decorators.ts`): `POST /auth/facility` as `auth.facility.select`,
`GET /auth/session` as `auth.session.read`, `GET` and `POST
/auth/service-session` as `auth.service-session.read` and
`auth.service-session.validate`, and `POST /auth/google/link` as
`auth.google.link`. The guard's own refusals never reach the interceptor and keep
their own audit rows. No facility is bound to sign-out. The other session routes
bind one only when the request names one of the actor's facilities in
`X-Facility-ID`; the refusal row then carries that facility, membership and
organization, and otherwise none. A staff audit row without a facility is
accepted only as an `auth.*` session event; recorded as a generic `api.*`
request, a staff refusal failed its own audit and answered
`503 DEPENDENCY_UNAVAILABLE`. Each such refusal row carries `details.status`
and `details.code`, the status and code answered (A17, this change), and a
patient's row records purpose `patient-self`.

The refresh-token lookups are in `refreshSessionKind` and
`revokeByRefreshToken` (`services/identity-api/src/auth/token.service.ts`).
A staff or patient sign-in is one refresh could renew now when:

- the account is `active`, not disabled (`disabled_until` empty or past) and
  on the session's token version;
- the sign-in's absolute end has not passed;
- the token's own session is live (unrevoked and within its idle window), or
  the token was rotated within the last 60 seconds into a session of its
  family that is live. The 60 seconds cover one app's refresh racing the
  other app's tab. An older rotated token is reuse; and
- refresh could resolve its actor: a staff sign-in's account has an active
  facility membership without a migration hold, with an active staff record
  whose verification status is accepted and an active organization and
  facility (`eligibleStaffMembershipJoins` in
  `current-staff-context.service.ts`, the joins staff resolution uses); a
  patient sign-in's patient is still the account's active patient
  (`identity.current_patient_account`); and
- a staff sign-in has live MFA assurance (0088): an `auth.session_assurance`
  row for its family whose factor is still active (`STAFF_ASSURED`).

On refresh, the kind lookup answers only for such a sign-in. Any other token
gets no kind and goes on to rotation, which refuses it with `401`; for an
older rotated token that is reuse, which ends the whole sign-in. A sign-in
whose actor does not resolve is refused without being ended, so it is
renewable again once its membership or patient is active again.

Sign-out by refresh cookie reads the sign-in under its account's lock, after
any sign-out or revocation that got there first. It ends the sign-in if
anything of it is left: the token's own session is unrevoked, or the token was
rotated into a session of its family that is unrevoked. Neither expiry nor
the account's state matters, so a sign-out during a timed account suspension
leaves nothing to renew once the suspension lapses. A sign-in with nothing
left, including one a concurrent sign-out has just ended, records no second
sign-out and answers `204`.

`X-HID-Client` names the browser application on a cookie `POST /auth/refresh`
or `POST /auth/logout`. The staff and patient applications can share these
cookies on one origin, and the header keeps one from refreshing (rotating) or
ending the other's sign-in:

| `X-HID-Client` | Its own kind: the other kind is refused while refresh could renew it |
|---|---|
| `staff-web` | Staff. Identity's resolved staff actor carries no kind, so on the access-cookie path any live sign-in that is neither patient nor platform counts as staff |
| `patient-web` | Patient |
| Absent or any other value | Either, as before the header existed |

The check runs after the Origin and CSRF checks. A sign-in of the other kind is
refused when refresh could renew it now (above): on refresh, any other token
goes on to rotation; a live access cookie's sign-in always can be renewed. On a
sign-out by refresh cookie, the kind and whether refresh could renew the
sign-in are read from the same session row that would be ended. Any other
sign-in that has something left is ended whichever application asks, with
`204`, the cookies cleared and its kind not named, as refresh ends a sign-in
whose older rotated token comes back. So an old rotated token tells nobody
whether, or as which application, its sign-in is still live. A bearer sign-out
ignores the header. The header is a self-declaration of the calling
application, not authentication, and grants nothing. Identity's CORS allow-list
(`services/identity-api/src/config/cors.ts`) admits `x-hid-client` on every
route. Health-id `main` names its portal in `X-HID-Client` on cookie refresh
and sign-out (since `22e8664`). Earlier Health-id builds and
`packages/identity-browser-client` send none; for them the check is inert, and
a cookie sign-out without a live access cookie ends whichever staff or patient
sign-in the refresh cookie holds.

#### Refusals and faults (ADR-059)

From D-Eminence/hid-system#76 (no migration, not deployed)
Identity tells a refused credential from a fault, so that a client signs a
user out only when the credential itself was refused. Health-id signs out on
`401` and retries a `5xx`.

| Answer | When |
|---|---|
| `401 AUTHENTICATION_REQUIRED` | No credential, or the access token is refused: unknown, ended, expired, badly signed, or of an account that is no longer active, is disabled or has a new token version. The client signs in again |
| `503 AUTHENTICATION_UNAVAILABLE` | `SecurityGuard` could not decide: a database or other fault while verifying the session, resolving the actor or reading the platform session's assurance, or (with `AUTH_MODE=oidc`) the OIDC key set cannot be fetched or used. The denial is audited first where a row can be written. Nothing is ended; the client retries. Before, every such fault answered `401` and signed the user out |
| `503 PLATFORM_CONTROL_UNAVAILABLE` | A runtime control (`maintenance_mode`, the patient and provider portal switches) cannot be read for any reason other than the control being disabled (SQLSTATE `55000` `PLATFORM_CONTROL_DISABLED`, which keeps `503 PLATFORM_MAINTENANCE` and `423 PLATFORM_PORTAL_DISABLED`): a statement or pool timeout, a lost connection, a missing grant. Before, Identity answered those `401` and Outreach `500` |
| `403 PATIENT_SESSION_REQUIRED` | A staff or platform session on a patient-only route ("Patient sessions and self service", below), refused by the guard before the handler runs. Audited as `auth.authorization.denied` on resource type `authentication` with no facility, membership or organization |
| `403 NO_ACTIVE_FACILITY_MEMBERSHIP` | Staff sign-in only, with the right password (refusals table above). A live session whose membership ends is refused `401`: its credential no longer resolves, and Health-id returns the user to sign-in, where the `403` explains |
| `403 ORIGIN_DENIED` | A cross-origin request whose `Origin` is not in `CORS_ORIGINS`, refused by the CORS layer before routing, with no `Access-Control-Allow-*` header. The same in Identity, EHR, Lab, OCR, Outreach and Pharmacy (`config/cors.ts` in each); all six answered `500` before |
| `403 MFA_INVALID_CODE`, `403 PLATFORM_SESSION_REQUIRED` on step-up | `POST /api/v1/admin/mfa/step-up` and `POST /api/v1/admin/mfa/recovery-codes/regenerate` run under an accepted platform session. A wrong or replayed step-up code is `403 MFA_INVALID_CODE` (counted, as before); a session that lost its MFA assurance while the request waited for the account lock is `403 PLATFORM_SESSION_REQUIRED`, as `requirePlatformAssurance` answers it. Both were `401` before this change (A20; `MFA_INVALID_CODE`, `MFA_CHALLENGE_INVALID`), which the console read as an ended session. The unauthenticated challenge steps, platform `/auth/admin/mfa/*` and staff `/auth/mfa/verify` and `/auth/mfa/enroll/*`, keep `401 MFA_INVALID_CODE` and `401 MFA_CHALLENGE_INVALID` |

Identity's audit rows tell these answers apart too (A17, this change). Every
`SecurityGuard` refusal row (`security.authorization` once a facility is
bound or on a platform route, `auth.authorization.denied` before a facility
is bound, and the `system` `security.authorization.denied` without an actor)
carries `details.status` and `details.code`, the status and code answered,
next to `method` and `route`; platform rows keep `highRiskAction`. Every
request-audit failure row (`api.<method>.<route>` on `http-request`, the
`auth.*` session events and the facility-less staff row of the patient-only
defence below) carries them too, next to `method`, `route` and `durationMs`.
Before, only a platform guard row carried the code (and only a
`DomainProblem`'s), no guard row the status, and a request-audit failure row
neither (the facility-less staff row had the status), so a refused
credential (`401 AUTHENTICATION_REQUIRED`), a refusal (`403`, `409`, `429`)
and a fault (`503 AUTHENTICATION_UNAVAILABLE`, `500 INTERNAL_ERROR`) read
alike. Only the status and the code are recorded, never the message. The
routes of 0093 and 0094 (`/patient-enrollments/holder`, `/holder/verify`,
`/facility-code`, `POST /identity/assisted-verifications` and the admin
designation `/admin/facilities/:facilityId/assisted-registration`) record
their refusals through the same guard and request audit, so their rows carry
the status and code too (never `422 ASSISTED_VERIFICATION_NOT_MATCHED`'s
`fields`). One of their answers has no row: `503 ASSISTED_REGISTRATION_DISABLED`
on `/identity/assisted-verifications` comes from a route guard, which runs
after `SecurityGuard` has passed and before the request audit, so the
switched-off route is answered without an audit row. The
outcomes are unchanged: a guard row is `denied`, a `503` fault included; a
request-audit failure row is `failure` whatever its status; the
facility-less staff row is `denied` below `500` and `failure` from `500`.
EHR records its refusals as `denied` by status ("Extracted Identity
boundary", below). Whether the two services should share one rule is an
open owner decision (`PHASE_3_LAUNCH_DECISIONS.md` §2, AUDIT-OUTCOME).

Sign-in answers every refused credential alike. `POST /auth/login` (the staff
password step) and `POST /auth/patient/login` answer any refusal of the
credential (an unknown account, a wrong password, a staff-only account at
patient sign-in, an account deactivated or whose credentials changed during
sign-in) with `401 AUTHENTICATION_REQUIRED` and the one detail "Invalid
credentials", and counts it against the sign-in budget. Before, the internal
reason reached the browser as the detail (for example "Patient account is
unavailable" for a staff account's right password at patient sign-in), which
told the caller that the password was right. The
named refusals keep their codes: `429` budgets, `403 STAFF_MFA_FACTOR_UNPROVEN`,
`403 NO_ACTIVE_FACILITY_MEMBERSHIP`, Turnstile and Origin refusals.
`POST /auth/oidc/exchange` answers any refused Google sign-in or enrolment
`401 GOOGLE_SIGN_IN_DENIED` ("Google sign-in could not be completed for this
HID account"), as it already did for a missing nonce.

Runtime controls apply to every staff and patient session. Only a platform
administration session (`/auth/admin/*` sign-in, `/admin/*` routes) is exempt
in Identity, so the console works during maintenance. Before, any actor whose
account held `platform.admin.access` was exempt, so an administrator's
clinical staff session kept reading and writing records during maintenance and
with the provider portal off. EHR and Outreach exempt no session (they never
see a platform session).

EHR's document routes give each refusal its own code since this change
(A15), where they answered the generic `409 CONFLICT` or
`403 ACCESS_DENIED`: `400 IDEMPOTENCY_KEY_REQUIRED`, `423 UPLOADS_DISABLED`
(the upload intent and completion while `uploads_enabled` is off),
`403 CONSENT_REQUIRED`, and `409` with `REQUEST_IN_PROGRESS`,
`IDEMPOTENCY_KEY_REUSED`, `DOCUMENT_INTEGRITY_MISMATCH`,
`DOCUMENT_NOT_COMPLETABLE` or `DOCUMENT_NOT_AVAILABLE` (§16, "Document route
answers"). None is a `401`, so none signs a user out. An `uploads_enabled`
control that cannot be read still answers `500 INTERNAL_ERROR` on those two
routes, not `503 PLATFORM_CONTROL_UNAVAILABLE` as EHR's guard answers its
own control reads (an open follow-up).

### Staff facility binding (N5, migration 0087)

A staff actor lists one entry per active membership (`actor.facilities`), and
`X-Facility-ID` binds the entry whose `id` equals it. From 0087 an account
holds at most one active, unheld membership per facility
(`staff_memberships_one_active_per_facility_uq`), so a facility binds exactly
one membership, its roles, its permissions and its consent grants. Entries are
ordered by primary first, then facility name, facility id and membership id.
Should two active memberships of one account at one facility ever be read
anyway, Identity refuses to resolve the actor at all: sign-in, refresh,
`GET /auth/session`, the service-session routes the other services call, and
every staff request answer `409 FACILITY_MEMBERSHIP_AMBIGUOUS` until a platform
administrator ends one of them. Nothing is bound by row order.

A facility entry's `roles` are the codes of the membership's live, effective
facility role assignments, the same assignments its `permissions` come from;
the actor's `roles` and `role` and the access token's `roles` claim are those
of the bound entry. A membership with no effective role is still listed, with
`roles: []` and `permissions: []`. From 0087 the stored membership labels
(`membership_role`, `app_role`) are not read for the actor. A facility role
granted through workforce provisioning (§19) is effective only while the
credential attestation it was granted on is current: when the attestation
lapses, or the role is revoked, the role and its permissions disappear from
`actor.facilities` at the next request (and from the token's `roles` claim
when it is next issued). The workforce profile still lists a lapsed role, with
`effective: false`. The principals list (`GET /admin/principals`) shows each
membership's stored labels as `role` and `appRole`: the role it was activated
with, which later grants and revokes do not change.

#### Working facility per sign-in

Not yet deployed (ADR-046, migration 0089, D-Eminence/hid-system#73,
ported from D-Eminence/hid-system#47). A staff member who works at more
than one facility chooses one with `POST /api/v1/auth/facility`
`{ "facilityId": "<uuid>" }`. Identity keeps the choice for the sign-in in
`auth.session_facility_selection`, keyed by the session family: refresh
rotates the session but keeps the family, so it keeps the choice, and another
sign-in of the same account has its own. A reload therefore reports the chosen
facility instead of moving the user back to the primary one. A staff sign-in
is the session issued after its second factor (MFA-1, 0088): the password step
issues no session, so it has no choice to keep and reports none.

Staff session responses carry `facilitySelection`:

| `facilitySelection` | When | `actor.facility` |
|---|---|---|
| `selected` | The sign-in chose a facility that is still one of the actor's active facilities. Facilities are compared by id: if the membership at that facility was replaced by another active one, the choice is still `selected`, with the new membership's roles | The chosen facility, with that membership's `roles`, `role` and `permissions`: the actor `POST /auth/facility` returns. On `GET /auth/session` with a valid `X-Facility-ID`, the facility that header binds instead (below) |
| `default` | The sign-in has not chosen one; every new sign-in | The default, as before: the primary facility, else the first by name, or the facility a valid `X-Facility-ID` binds on `GET /auth/session` |
| `reselect` | The chosen facility is no longer one of the actor's active facilities: the membership ended, or the staff record, facility or organization is no longer active | As for `default`. The client asks the user to choose again instead of working elsewhere silently |
| `unavailable` | `POST /auth/refresh` only: the stored choice could not be read in the rotation's transaction; the rotation still commits | As for `default`, and not a choice: the client asks where the user is working (Health-id treats a value it does not name as unconfirmed and asks). The stored choice is kept and reported on the next read |

`facilitySelection` always describes the sign-in's stored choice. A valid
`X-Facility-ID` on `GET /auth/session` still binds the facility it names, as
before, so `actor.facility` is then that bound facility while
`facilitySelection` describes the stored choice, which may differ.

| Route | `facilitySelection` |
|---|---|
| `POST /auth/mfa/verify`, `POST /auth/mfa/enroll/activate` (the staff session) | `default` |
| `POST /auth/login` (the staff password step, no session) | Absent; nothing is read or stored |
| `GET /auth/session`, `POST /auth/refresh` | Read for the sign-in, as above |
| `POST /auth/facility` | `selected` |
| Patient and platform sessions (`POST /auth/patient/login`, `POST /auth/oidc/exchange`), `GET` and `POST /auth/service-session` | Absent; nothing is read |

If the stored choice cannot be read, Identity never reports a facility as
chosen when the user did not choose it. `GET /auth/session` answers
`503 DEPENDENCY_UNAVAILABLE` and leaves the cookies untouched. A refresh reads
the choice on its rotation's own transaction, which already holds the rotated
session, as a plain read under a savepoint: a read that fails is rolled back
to the savepoint, and the rotation still commits with its `auth.refresh` audit
row. The refresh answers `200` with the rotated session's cookies and
`X-CSRF-Token`, as a successful refresh does, the actor as resolved (its
default facility) and `facilitySelection: 'unavailable'`. It does not answer a
`5xx`, which would leave the sign-in unrenewable for as long as the choice
stays unreadable. (Before the read moved into the rotation, a `5xx` would also
have carried the rotated cookies, which an edge that replaces an upstream
`5xx` drops, as the gateway did before D-Eminence/hid-system#72,
`proxy_intercept_errors`.) A transaction the savepoint cannot restore fails
the audit write instead: the refresh is the refresh table's `5xx`, with
nothing rotated and the cookies untouched.

The `auth.refresh` audit row records the actor the refresh reports: for
`selected`, the chosen facility with that membership and organization; for
`default`, `reselect` and `unavailable`, the default facility. Before this
change (A6) the row was written in the rotation (D-Eminence/hid-system#76)
with the default facility even when the response reported the chosen one, so
a facility's audit list showed a clinician's refresh at their primary
facility.

`POST /auth/facility` (cookie mutations need Origin and CSRF as any other):

| Outcome | When |
|---|---|
| `400 VALIDATION_FAILED` | `facilityId` is missing or not a UUID, or another field is sent |
| `403 PATIENT_SCOPE_DENIED` | A patient session |
| `403 STAFF_MFA_REQUIRED` | A staff session without live MFA assurance (MFA-1, 0088), including any `AUTH_MODE=oidc` bearer token: refused before anything is read or stored |
| `403 FACILITY_ACCESS_DENIED` | The facility is not one of the actor's active facilities when the request is authorized, or its membership is no longer active when the choice is written: the database guard checks the membership, migration hold, staff record, organization and facility again, as `CurrentStaffContextService` does (the account's status was checked when the request was authorized) |
| `401 AUTHENTICATION_REQUIRED` | The presented session is no longer live when the choice is written: the sign-in was signed out or revoked, or another tab's refresh rotated the presented session after it was authorized. The client refreshes and, if the sign-in is still live, selects again |
| `503` | The audit could not be written; nothing is stored |
| `200` `{ actor, facilitySelection: "selected" }` | Stored for the sign-in, replacing any earlier choice, and audited as `auth.facility.select` in the same transaction |

A refusal writes no selection row and no successful `auth.facility.select`
audit. The global `AuditInterceptor` records it once as a failed
`auth.facility.select` event on `session`, with no facility, membership or
organization unless the guard bound one from `X-Facility-ID`, as for the other
session routes (D-Eminence/hid-system#42). Its details carry the status and
code answered (A17, this change): a selection refused while it waited for the
account lock records `401 AUTHENTICATION_REQUIRED` or
`403 FACILITY_ACCESS_DENIED`, and a `GET /auth/session` answered
`503 DEPENDENCY_UNAVAILABLE` because the selection cannot be read records
that status and code on its failed `auth.session.read`. The write takes the
account lock first, as sign-out and revocation do, and is made only while the presented
session is a live staff session of the account.

The choice is only the facility the session reports by default; it authorizes
nothing. Every facility-scoped request still carries `X-Facility-ID`, which
Identity checks against the actor's active memberships on each request, and
services authorize a delegated request by it (`/auth/service-session` ignores
the choice). The stored facility is checked against the actor's active
facilities each time it is read.

The choice belongs to the sign-in, not to a tab: every tab holding the
sign-in's cookies reads the same choice, and the last choice made in any tab
wins. A client should therefore keep the facility it is working at in memory
across a refresh, as long as that facility is still in `actor.facilities`,
rather than adopt `actor.facility` from the refresh response, which reports
the sign-in's last choice and may come from another tab. It uses the reported
facility when it has none of its own: after a reload or a new tab. `reselect`
keeps the stored choice until the user chooses again, so if the membership
becomes active again first, the choice is reported as `selected` again.
Sign-out and revocation leave the stored row, but a signed-out or revoked
sign-in never reads or changes it again. Since staff MFA (0088) a staff token
without MFA assurance, an `AUTH_MODE=oidc` bearer token included, is refused
by the guard (`403 STAFF_MFA_REQUIRED`), so only an MFA-verified Identity
staff sign-in reaches the choice; the controller still answers an actor
without an Identity sign-in as before, audited and without
`facilitySelection`, storing nothing.

Release note: apply migration 0089 and the role bootstrap before deploying this
Identity API. Without the table every staff `GET /auth/session` answers `503`,
every staff refresh answers `unavailable` (so Health-id asks where the user is
working at each refresh of a reload), and `POST /auth/facility` fails with a
`5xx`. The previous Identity API ignores the table. Clients that ignore the
new field keep working as before; to keep the user at their facility after a
reload they use `actor.facility` from `GET /auth/session`, and on any value
other than `selected` (or `default` with one facility) ask the user to choose.
Health-id 82b474e already does (`apps/patient-web/src/staff/facilitySelection.ts`).

### Patient sessions and self service

`POST /api/v1/auth/patient/login` accepts an email address or the issued HIDCode
(sent in the `email` field; both are matched case-insensitively) with a
password, and the `patient-login` Turnstile action. It binds a separate
patient session to the existing canonical Identity patient; its actor has no
staff roles, facility memberships or platform permissions. Existing session,
refresh and logout routes retain that binding,
host-only Secure/HttpOnly cookies, Origin/CSRF checks and refresh-family reuse
revocation. The server rechecks account eligibility, token version, session and
patient mapping on use.

`GET /api/v1/identity/me` returns the authenticated patient's profile and HID.
`GET /api/v1/identity/me/access-history` returns `{ items, truncated }`: the
latest 50 safe grant summaries, newest first, and `truncated` (`true` when the
patient has more than 50 grants; since 0091, additive). Since 0091 each item
also names who holds the grant: `requesterDisplayName` (the display name of the
clinician's account, or `null`) and `requesterRole` (the membership role at the
facility, for example `doctor`, or `null`), next to `facilityName`. Grant
status does not assert notification delivery. `GET /api/v1/ehr/me/records`
returns at most 50 completed encounters and 50 current signed/amended note
revisions of completed encounters (since 0084), after fresh Identity
authorization through the EHR workload caller.
It names the other five record categories as withheld from the patient, not as
absent (§11, "Record summaries"). Since the patient record release (0096,
owner decision 4 of 2026-10-16, D7) a deployment may also release vitals,
diagnoses, prescriptions, Lab results and documents, one flag per category,
each off by default and refused in the production profile until its P36
sign-off; with every flag off the response is exactly the one above. `GET /api/v1/ehr/me/documents/:documentId/download` returns a 60 s
attachment URL for one released document (§11, "Patient document
download"). Only a patient session may use either route: EHR's
guard answers any other session `403 PATIENT_SESSION_REQUIRED` before the
handler runs and records `auth.authorization.denied` (§7). Before
D-Eminence/hid-system#74 a staff session there got `503 DEPENDENCY_UNAVAILABLE` and nothing was
audited.
These routes accept no browser-selected patient identity. Patient record access
is read-only and owning-service disclosure/audit is atomic. The internal
`GET /api/v1/identity/service/patient-self-authorization` requires both the
current patient session and the exact authenticated EHR workload caller.

`POST /api/v1/identity/me/verification/nin` is a separate patient-session
command for QoreID evidence verification. Its body is exactly `{ "nin":
"<11-digit-NIN>" }`; it returns only a normalized provider/result state, optional
opaque provider reference, and timestamp. It does not accept patient identity
attributes, create a patient, or modify a canonical identity. The integration
is disabled by default and does not expose provider credentials or tokens.

Patient-only routes refuse any other session in `SecurityGuard`, before the
handler, with `403 PATIENT_SESSION_REQUIRED` (ADR-059), audited as
`auth.authorization.denied` on resource type `authentication` with no
facility. They are every `/api/v1/identity/me` route of `PatientSelfController`
(`GET /me`, `GET /me/access-history`, `GET /me/notifications`,
`POST /me/notifications/:id/read`, `POST` and `DELETE /me/access-pin`) and
`GET /identity/service/patient-self-authorization`, `POST
/me/verification/nin`, the emergency contact routes
(`/identity/me/emergency-contacts/*`), the account deletion routes
(`/identity/me/account-deletion/*`) and the patient consent decisions
(`GET /identity/me/access-requests`, `POST
/identity/access-requests/:requestId/approve` and `/deny`, `POST
/identity/me/consent-grants/:grantId/revoke`). Before, a staff session reached
these handlers, and their refusal of a staff actor with no facility failed its
own audit row (0067): the answer was `503 DEPENDENCY_UNAVAILABLE` with nothing
recorded. The audit interceptor now records
any other staff failure that has no facility bound, on a route that is neither
a session event nor platform administration, as `auth.authorization.denied`
(a `4xx`, outcome `denied`) or `auth.request.failed` (a `5xx`, outcome
`failure`) on `authentication`, with the request's own `api.*` action in its
details, instead of answering `503`. Since this change (A17) that row's
details are `method`, `route`, `status`, `code` (the code answered),
`requestAction` (the request's `api.*` action) and `durationMs`, and the
guard's own `403 PATIENT_SESSION_REQUIRED` row's are `method`, `route`,
`status` and `code`.

`GET /api/v1/ehr/patients/:patientId/emergency-records` requires current workforce
permissions, emergency purpose and a freshly checked break-glass grant authorizing
the `read_records` action for the exact facility and patient. Activation requires a reason, expires
within the configured 5–240 minute bounds, permits at most ten new activations
per account per hour, and atomically emits `EmergencyAccessActivated.v1` for
notification and review. Idempotent replay does not extend expiry. Expiry,
revocation and failed authorization/audit prevent further disclosure.
Activation also requires the platform `break_glass_enabled` control inside the
activation transaction; a disabled control returns `423 BREAK_GLASS_DISABLED`.
It also requires an active `emergency` purpose of use, which no migration seeds
(0082 seeds only `direct-care`); without it activation also returns
`423 BREAK_GLASS_DISABLED` ("Emergency access is not enabled on this
platform"), where it returned `400 INVALID_CONSENT_COMMAND`. Break-glass is off
at launch (owner default, deny by default; release checklist P10 and P11): since
0091 no role holds `identity.break-glass.write`, so `POST
/api/v1/identity/break-glass` answers `403 PERMISSION_DENIED` before the
control or purpose check, and
Health-id 82b474e disables its Emergency method with the permission
explanation; `break_glass_enabled` starts false (0091) and no `emergency` code
exists. Re-enabling it takes decision D9, a reviewed migration granting the
permission again, the `emergency` code and the control.
The summary's sections, the read permission each needs, its limits and audit
counts are in §11, "Record summaries".

Patient access-request decisions are session-bound patient commands:
`GET /api/v1/identity/me/access-requests` (at most 100, newest first; since
0091 each item also carries `requesterDisplayName` and `requesterRole`, the
requesting clinician's display name and membership role, next to
`facilityName`: approval grants that one clinician access; additive),
`POST /api/v1/identity/access-requests/:requestId/approve` and
`POST /api/v1/identity/access-requests/:requestId/deny` (`{ "reason" }`) require
a patient session and no facility context. Since 0086 an approval grants
access only from a session family first issued within the last 10 minutes (as
an access-PIN change does), else `403 PATIENT_RECENT_AUTH_REQUIRED` with the
detail "For your security, sign out, sign in again, and approve within 10
minutes."; the client signs the patient out and in again and repeats it.
Health-id shows that detail as it is on Approve, so it says what to do (FE-8;
it was "Sign in again before approving access to your records", which left a
patient who was already signed in no way forward). For 24 hours after an OTP account
recovery of the account (any recovery purpose) an approval is `403
PATIENT_RECENT_RECOVERY_HOLD`, checked before recent sign-in, because signing in
again does not end it. A denial or a revocation is never held. `POST
/api/v1/identity/me/consent-grants/:grantId/revoke` (`{ "reason" }`) revokes a
grant the patient authorized (patient-approved or PIN-derived); break-glass and
workforce grants return `409`. Access-history items include `breakGlass` and
`patientRevocable`. `GET /api/v1/identity/me/notifications` and
`POST /api/v1/identity/me/notifications/:id/read` serve the patient inbox. Its
`notificationCode` values are `ACCESS_REQUEST_RECEIVED` (resource
`access-request`), `EMERGENCY_ACCESS_ACTIVATED` and, since 0091,
`PATIENT_ACCESS_PIN_USED` (both resource `consent-grant`, `resourceId` the
grant, `metadata` `{ consentGrantId, reviewRequired: true }`): one item each
time a clinician opens the patient's record with the patient's access PIN
(`POST /api/v1/identity/standard-access/pin` creating a grant; a replay of an
existing grant adds none), written in the PIN transaction without the
notification worker. Health-id 82b474e shows an unknown code with its generic
title ("An update about your Health ID account").

The requesting clinician's own list is `GET /api/v1/identity/access-requests`
(optional `?status=pending|approved|denied|revoked|expired`). It needs
`identity.consent.write` at the `X-Facility-ID` facility and `X-Purpose-Of-Use`
`direct-care` or `healthcare-operations`; without that header it returns
`400 PURPOSE_OF_USE_REQUIRED`. It returns at most 100 non-break-glass requests,
newest first, made by the caller's account, membership and facility. A caller
without `identity.consent.write` gets `403`. Each item also carries
`consentGrantId`, `grantExpiresAt`, `authorizationMethod`
(`patient_access_pin` or `patient_approval`) and `effectiveStatus`: for an
approval with a grant, whichever ended it first, `active`, `expired` (also when
it was revoked only after it lapsed), `closed` (by the requesting clinician) or
`revoked` (by anyone else); otherwise the request `status` (0074). The `status`
filter accepts `pending`, `approved`, `denied`, `revoked`, `expired`, `active`
and `closed`, and matches the request status or the effective status. Since
0086 (PSEARCH-1) an item's `patientId` is the patient's id only while its
`effectiveStatus` is `active`; for every other item (pending, denied, expired,
closed, revoked) it is the non-identifying string
`withheld-<last four characters of accessRequestId>`, and each item carries
`patientIdWithheld` (`true` when withheld). The withheld value is derived from
the request, never from the patient, and is a string rather than `null` so
that a client rendering its last characters keeps working (Health-id
`AccessRequests.tsx`). Before 0086, every item named its patient, so one
request for a guessed HID and one list call disclosed the patient id before
the patient answered. Until the role bootstrap of this
fix, the Identity runtime could not execute `identity.list_my_staff_access_requests`,
and every caller got `403 CONSENT_COMMAND_DENIED`.

Staff patient search (0086, launch blocker PSEARCH-1). Searching by HID never
grants access by itself, and its answers do not tell whether an HID exists:

| Route | Contract |
|---|---|
| `POST /api/v1/identity/patient-lookup` | `identity.patient.read` at the `X-Facility-ID` facility; body `{ hid, purpose }` (`direct-care`, `emergency` or `healthcare-operations`; anything else `400`). `200 { patient: { patientId, hid, firstName, lastName, fullName, dateOfBirth, gender, version }, authorization: { decision: 'allow', facilityId, membershipId, scope, purpose, consentGrantId, expiresAt, breakGlass } }` only with an active grant for this account, membership, facility and purpose (before 0086 a success answered `201`). Every refusal, whether the HID is unknown, the patient has no grant, or the grant is held at another facility or for another purpose, is the same `404 PATIENT_NOT_AVAILABLE` ("The patient is not available"); before 0086 a patient visible to the caller without a grant (any patient, for a registration member) answered `403`, and an unknown or hidden one `404`. The audit event `identity.patient.lookup` keeps the true outcome: `success`, or `denied` with `details.reason` `not_found` or `not_authorized` and, for the latter, the patient |
| `POST /api/v1/identity/access-requests` | `identity.consent.write` at the `X-Facility-ID` facility, `X-Purpose-Of-Use` `direct-care` or `healthcare-operations`; body `{ hid, scope: read_records\|write_records, reason (8–500), durationMinutes (5–1440) }`. `201 { accessRequestId, status: 'pending', scope, purpose, durationMinutes, requestedAt, existingRequest }`, which no longer carries `patientId`. An unknown HID gets the same `201` shape (a new `accessRequestId`, `existingRequest: false`) instead of `404 CONSENT_RESOURCE_NOT_FOUND`; nothing is persisted for it, and the audit records `identity.access-request.refused` (`denied`, no patient, `details.reason: patient_not_available`) under that `accessRequestId`. The clinician's own list (above) shows only recorded requests, and names the patient only once a grant made from the request is active |

Both commands have budgets in `auth.otp_rate_limits`, per actor account
(across facilities) and per facility. An access request is counted before it
runs, whatever its outcome. A patient lookup reads its two budgets first and,
while either is blocked, answers `429 PATIENT_LOOKUP_RATE_LIMITED` before it
reads anything, a lookup of a patient the caller holds a grant for included.
Otherwise only a refused lookup is counted: an unknown HID, a patient without a
grant and a grant held at another facility or for another purpose alike, after
its audit event and before its `404`. A lookup that answers `200` is never
counted, nor is one that fails on a dependency (`5xx`), so Health-id's lookup
before each clinical read and write of a granted patient spends nothing (FE-10;
until this change every lookup was counted, so the about ten lookups of one
consultation could leave a clinician's saves refused with `429`). Defaults: 60
refused lookups per actor and 600 per facility in 5 minutes
(`PATIENT_LOOKUP_RATE_WINDOW_SECONDS`, `PATIENT_LOOKUP_ACTOR_MAX_REQUESTS`,
`PATIENT_LOOKUP_FACILITY_MAX_REQUESTS`); 20 access requests per actor and 200
per facility in 15 minutes (`ACCESS_REQUEST_RATE_WINDOW_SECONDS`,
`ACCESS_REQUEST_ACTOR_MAX_REQUESTS`, `ACCESS_REQUEST_FACILITY_MAX_REQUESTS`;
windows 60–86400 s, actor maxima 1–10000, facility maxima 1–100000). The
refused lookup or the access request after a maximum is `429
PATIENT_LOOKUP_RATE_LIMITED` (instead of the `404`, for an unknown and an
unauthorized HID alike) or `429 ACCESS_REQUEST_RATE_LIMITED`, and blocks that
budget for one window: until it ends, every lookup by that actor, or at that
facility, and every access request by that actor, or at that facility, is
`429`. A call refused for the actor's own budget does not count against the
facility's. Since this change (A21) both `429`s carry `Retry-After`, the
operation's whole window (`PATIENT_LOOKUP_RATE_WINDOW_SECONDS` or
`ACCESS_REQUEST_RATE_WINDOW_SECONDS`), which the actor's and the facility's
budgets share, never the time left (§6).

Patient login/account deletion (Phase 3, ADR-036) closes the login only:

| Route | Contract |
|---|---|
| `GET /api/v1/identity/me/account-deletion` | `{ waitingPeriodSeconds, confirmationTtlSeconds, request: { requestId, state, requestedAt, confirmationExpiresAt, scheduledFor, blockedReasonCode, cancelledAt, cancellable } \| null }` |
| `POST /api/v1/identity/me/account-deletion` | Session issued within 10 minutes; returns `{ requestId, confirmationToken, confirmationExpiresAt, waitingPeriodSeconds }` once. `409` when a deletion is already scheduled; `429` when rate limited |
| `POST /api/v1/identity/me/account-deletion/confirm` | `{ requestId, confirmationToken, confirmation: "DELETE MY ACCOUNT" }`, session issued within 10 minutes; returns `{ requestId, state: pending\|blocked\|completed, scheduledFor, blockedReasonCode }`; invalid, replayed, foreign, or expired proof returns `403` |
| `POST /api/v1/identity/me/account-deletion/cancel` | `{ requestId }`; idempotent before the scheduled time |

`state` is one of `awaiting_confirmation`, `pending`, `blocked`, `cancelled`,
`completed`, `expired`, `superseded`; `blockedReasonCode` is `LEGAL_HOLD`,
`RETENTION_POLICY_UNAVAILABLE`, or `WORKFORCE_ACCOUNT`.

Patient emergency contacts (POST-only commands):

| Route | Contract |
|---|---|
| `GET /api/v1/identity/me/emergency-contacts` | Active contacts: `contactId, name, relationship, channel (email\|sms), destinationHint, status (unverified\|verified), verifiedAt, notifyOnEmergencyAccess, eligibleForEmergencyNotification, version, pendingVerification, lastNotification`. The full destination is never returned |
| `POST /api/v1/identity/me/emergency-contacts` | `{ name, relationship, channel, destination, notifyOnEmergencyAccess? }`; at most five; duplicates return `409` |
| `POST /api/v1/identity/me/emergency-contacts/:contactId` | `{ expectedVersion, name?, relationship?, notifyOnEmergencyAccess? }`; the destination is immutable |
| `POST /api/v1/identity/me/emergency-contacts/:contactId/deactivate` | Idempotent; pending alerts are suppressed |
| `POST /api/v1/identity/me/emergency-contacts/:contactId/verification` | Sends a six-digit code to the contact; `503 EMERGENCY_CONTACT_DELIVERY_UNAVAILABLE` while delivery is disabled |
| `POST /api/v1/identity/me/emergency-contacts/:contactId/verification/confirm` | `{ challengeId, code }`; single use, expiring, attempt-limited |

For 24 hours after an OTP account recovery (0086, REC-NOTIFY), adding or
changing an emergency contact and setting the access PIN
(`POST /api/v1/identity/me/access-pin`) answer `403
PATIENT_RECENT_RECOVERY_HOLD`, as does an access-request approval (above).
Deactivating a contact, verifying one already added and removing the PIN
(`DELETE /api/v1/identity/me/access-pin`) stay available.

Recovery completion atomically consumes the account/token-bound OTP credential,
sets an Argon2 password and revokes every session of the account (patient,
staff and platform). Since 0086 it also revokes every external sign-in identity
(today only Google links) of the account not already revoked, so a link another
party made stops signing in; the audit event `auth.otp.recovery.completed`
records how many (`details.external_identities_revoked`). The legacy importer's
provenance record (issuer `legacy-identity`) is not a sign-in: it is kept and
not counted. The revoked Google subject cannot be linked again (the link
commands answer `GOOGLE_IDENTITY_ALREADY_LINKED` for any subject ever linked),
so after a recovery the owner can link only a different Google account.
Recovery never touches the account's authenticator: the TOTP factor and its
recovery codes stay, so a staff or platform account that recovered its
password still needs its authenticator at the next sign-in, and for an account
with a factor a mailbox alone never yields a staff session (MFA-1, pinned by
`staff-mfa.integration.sql` and `verify-staff-mfa-runtime.mjs`). An account
without a factor enrols on a code sent to the same mailbox, so for it the
mailbox is enough (staff sign-in, above). A lost authenticator is reset only by the
two-person MFA reset (0070), for staff accounts as for administrators.
Disabled, stale, expired and replayed credentials fail closed. Completion
returns to login rather than opening a session.
The owner notice of a completed recovery ("your password was changed", to every
verified contact, with an inbox entry) is not sent yet: Identity offers each
completion, after commit, to a bound `ACCOUNT_RECOVERY_NOTICE_SINK`, which the
notification route will provide.

Recovery start (`POST /api/v1/auth/otp/start`, every purpose) answers every
identifier alike: `202 { accepted, challengeId, deliveryChannels: ['email', 'sms'],
expiresInSeconds, resendAfterSeconds }`, before any code is delivered. Since 0086
(REC-AUDIENCE, REC-UNVERIFIED-CONTACT) a start reaches only the account kind of
its page, named by `turnstileAction`: `patient-reset-start` and
`legacy-recovery` an account with an active patient record, `staff-reset` one
with an active staff record, `admin-reset` a platform administrator. A
patient's code goes only to a verified contact: the account email once
`email_verified_at` is set, else the verified phone of its public enrollment. A
start for an account of another kind, or for a patient with no verified
contact, is answered and counted exactly as for an unknown identifier and sends
nothing. A staff or platform account's code goes to its provisioned work email.
Within `resendAfterSeconds` a repeat for the same purpose, page and identifier
(email or HID, any case) answers the same `challengeId` whether or not an account exists, and
sends nothing. A start for the account's other identifier in that window, or for
an account whose code budget is spent, gets a new `challengeId` and no code, as
an unknown identifier does. Clients keep the `challengeId` of their latest start.
Verification (`POST /api/v1/auth/otp/verify`) counts wrong codes against one
budget per account across its challenges and purposes: by default the fifth wrong
code within 15 minutes (`OTP_VERIFY_FAILURE_MAX`,
`OTP_VERIFY_FAILURE_WINDOW_SECONDS`) refuses every code of that account, a correct
one too, for 15 minutes. Every refusal is `403 OTP_INVALID_OR_EXPIRED`; start
limits are `429 OTP_RATE_LIMITED`, unchanged, with `Retry-After` set to
`OTP_RATE_WINDOW_SECONDS` since this change (A21, §6); the `403` carries none.

Password sign-in (`POST /api/v1/auth/login`, `POST /api/v1/auth/patient/login`,
the platform password step and the password check of a Google link) counts a
failure per identifier as typed (email or HID, any case) and, since 0086
(SIGNIN-LOCKOUT), per resolved account, so the email and the HID of one account
share a budget. The fifth failure within 15 minutes of a budget's first locks it
for 15 minutes; a refused attempt within that window extends the lock.
While the account's budget is locked the correct password is refused too, by
either identifier. Every refusal is the same `401` ("Invalid credentials"); a
correct password while the budget is open ends that budget's window.

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
X-HID-Client
X-Purpose-Of-Use
```

`X-HID-Client` (`staff-web` or `patient-web`) names the browser application on
cookie `POST /api/v1/auth/refresh` and `POST /api/v1/auth/logout`, so neither
refreshes nor ends the other's sign-in while refresh could renew it (see "Auth
session contract" above). Identity ignores other values and the header on
other routes.

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

A `400 VALIDATION_FAILED` answer also carries `errors`, one
`{ "field", "messages" }` entry per refused field. Identity and EHR name a
nested property, or an array element, by its dotted path
(`replacementValues.systolicMmhg`, `items.0.code`; A23, this change), for
example `{ "field": "replacementValues.systolicMmhg", "messages":
["systolicMmhg must not be greater than 350"] }`. A parent that failed only
through its nested fields has no entry of its own; one that failed its own
rule keeps its entry, followed by its nested ones. At most 50 entries are
listed (`MAX_FIELD_ERRORS`), in the order class-validator reports them, so a
body that refuses many array elements cannot produce a large answer. Before
this change a nested refusal named only the top-level property, with
`messages: []`.
Top-level entries and their order, the code, the status and the detail are
unchanged. `field` is a DTO property name, or the unknown key the client
sent; `messages` are the validators' own and never contain a submitted
value. Lab, Pharmacy, OCR and Outreach, off at launch (D17), still name only
the top-level property. The patient routes of the patient record release
(`GET /api/v1/ehr/me/records` and `/ehr/me/documents/:documentId/download`,
0096) take no body; a malformed document id is the UUID pipe's
`400 BAD_REQUEST` with no `errors`, as on every EHR route with an id, so no
`VALIDATION_FAILED` answer arises there.

Do not leak:

* secrets
* database details
* stack traces
* NIN
* access tokens
* protected clinical information

Identity replaces the `detail` of every `5xx` answer with "The service could
not complete the request.", because an unexpected failure's message can carry
internal state. The one exception is a problem raised as `PublicDetailProblem`:
a fixed sentence written for the person using the client, which keeps its
`detail` whatever its status. The closed public enrollment gate uses it
(`503 QOREID_DISABLED` and `503 QOREID_NIN_ONLY_DISABLED`, section 8,
"Public patient enrollment"; D-Eminence/hid-system#68, FE-4). So do, from
0093 (D-Eminence/hid-system#84), `503 PATIENT_REGISTRATION_NOT_OPEN`,
`409` and `503 NIN_HOLDER_ROUTE_UNAVAILABLE`,
`503 QOREID_PATIENT_NIN_BINDING_DISABLED` and a NIN lookup that fails with
`502`, `503` or `504`; and, from 0094
(D-Eminence/hid-system#85),
`503 ASSISTED_REGISTRATION_DISABLED` and
`503 ASSISTED_VERIFICATION_UNAVAILABLE`.

A problem may carry an optional `fields` member: an object of field names to
short result codes, never a submitted or stored value. From 0094 only
`422 ASSISTED_VERIFICATION_NOT_MATCHED` sends it
(`{ "firstName", "lastName", "dateOfBirth" }`, each `match`, `no_match` or
`not_in_record`).

Identity sets `Retry-After`, in whole seconds, on the rate-limit answers
whose window its own code owns (A21, this change); the Problem Details body
is unchanged. The value is the limit's full configured window, an upper bound
whichever bucket refused, never the time left in a bucket:

| Answer | Where | `Retry-After` |
|---|---|---|
| `429 OTP_RATE_LIMITED` | `POST /api/v1/auth/otp/start` | `OTP_RATE_WINDOW_SECONDS` (default 900) |
| `429 ENROLLMENT_RATE_LIMITED` | patient enrollment start, the holder code send (`POST .../holder`, from 0093; the network budget it shares with start and the contact step) and activation | `OTP_RATE_WINDOW_SECONDS` |
| `429 ENROLLMENT_RATE_LIMITED` | patient enrollment contact step, every refusal (its request limits and a spent contact-code budget alike) | the larger of `OTP_RATE_WINDOW_SECONDS` and `PATIENT_ENROLLMENT_CONTACT_FAILURE_WINDOW_SECONDS` |
| `429 OTP_RESEND_COOLDOWN` | patient enrollment holder code send (from 0093) and contact step | the seconds left of the cooldown of this enrollment's own last code of that step (`OTP_RESEND_COOLDOWN_SECONDS`) |
| `429 MFA_RATE_LIMITED` | platform and staff sign-in, enrolment and its email code, step-up and recovery-code regeneration | 900, the length of every MFA window |
| `429 PATIENT_LOOKUP_RATE_LIMITED` | `POST /api/v1/identity/patient-lookup` | `PATIENT_LOOKUP_RATE_WINDOW_SECONDS` (default 300) |
| `429 ACCESS_REQUEST_RATE_LIMITED` | `POST /api/v1/identity/access-requests` | `ACCESS_REQUEST_RATE_WINDOW_SECONDS` (default 900) |

No other answer carries it. A refusal answered like a wrong code carries
none: a spent recovery or contact code budget (`403 OTP_INVALID_OR_EXPIRED`,
`422 OTP_INVALID`), a wrong or spent holder code (`422 OTP_INVALID`) and the
sign-in lockout (`401`). Neither do the limits counted in SQL
(`VERIFICATION_QUOTA_EXCEEDED`, `APPLICATION_RATE_LIMITED`,
`EMERGENCY_CONTACT_VERIFICATION_RATE_LIMITED`,
`ACCOUNT_DELETION_RATE_LIMITED`, `EMERGENCY_RATE_LIMITED`, and from 0094
`ASSISTED_VERIFICATION_LIMITED`, the staff and facility checks of the last
24 hours), whose command does not report which window refused,
`QOREID_RATE_LIMITED`, or `503 PLATFORM_MAINTENANCE`, for which no end time
is recorded. Two `429`s of the sign-up routes are not "try again later"
answers and carry none either: `NIN_HOLDER_ROUTE_LIMITED` (0093) sends the
patient to a participating facility, and its budgets are the enrollment's
three codes, which never come back, and the phone's and the NIN's, counted in
SQL over 24 hours, 30 days or a year (a bound kept for a NIN would also tell
of other people's attempts on it); `ASSISTED_DESK_CODE_LIMITED` (0094) is
the enrollment's five desk codes, which never come back, so the patient
starts again. EHR, Lab,
Pharmacy, OCR and Outreach set none; EHR has no rate limit of its own, and the
patient routes of the patient record release (0096) answer no `429`. Identity's CORS policy exposes
`retry-after` to allowed origins. Before this change no answer carried the
header and CORS did not expose it.

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
issuer/JWKS-validated, audience-bound, unexpired ES256 JWT with an exact
configured caller subject, `exp` and `iat` (at most 300 seconds old and not
issued in the future, 5 seconds of clock tolerance) and `token_use: workload`;
any other token is refused `401` (ADR-047). Local per-caller secrets are
development-only.

Identity's workload refusals carry their own codes, never a user refusal's
(ADR-059), so a calling service can tell "Identity refused my workload
credential" (a fault between services) from "Identity refused the user's
session" (which it relays):

| Answer | When |
|---|---|
| `503 WORKLOAD_IDENTITY_UNAVAILABLE` | The issuer's JWKS cannot be fetched (network error, timeout) or holds no usable key set, workload authentication is not configured, or local-secret mode is configured in production |
| `401 WORKLOAD_AUTHENTICATION_FAILED` | No workload credential, an unknown caller name, or a token that fails verification (signature, issuer, audience, expiry, age, `token_use`) or a wrong local secret |
| `403 WORKLOAD_CALLER_DENIED` | A valid workload token whose subject is not the configured subject of the named caller |
| `401 DOCUMENT_SCANNER_AUTHENTICATION_FAILED` | A document scanner token is refused. It is the browser caller's own credential, not EHR's, so EHR relays it |

`@hid/api-client` exports `WORKLOAD_REFUSAL_CODES` and `isWorkloadRefusal`.
EHR answers any Identity refusal of its own workload credential (a `401`,
`403` or `503` with one of those codes, or the older
`INTERNAL_SERVICE_AUTH_REQUIRED`, `INVALID_WORKLOAD_IDENTITY` and
`WORKLOAD_AUTHENTICATION_REQUIRED`) as `503 IDENTITY_SERVICE_AUTH_UNAVAILABLE`
(`translate` in `services/ehr-api/src/integrations/identity-api.service.ts`),
on the session check and the patient authorization check alike. Before, it
relayed Identity's `401`, and Health-id signed the user out. EHR also refuses
to send an Identity workload token file whose `exp` has passed: `503
IDENTITY_WORKLOAD_IDENTITY_UNAVAILABLE`, logged as
`identity_workload_token_expired` and counted, instead of a call Identity would
refuse. Lab, Pharmacy, OCR and Outreach still relay Identity's workload refusal
as it is; they are off at launch, and their mapping is a follow-up (ADR-059).

Internal actor/session validation uses `GET /api/v1/auth/service-session`, or
`POST` for cookie mutation revalidation. Patient decisions use
`POST /api/v1/identity/service/authorization/check`. These return API DTOs,
never database rows. Problem Details status/code, correlation, bounded timeout,
and safe JSON request bodies are preserved by the typed client.

The patient decision is a `POST` from the service even when the request it
serves is a read, and a same-origin browser `GET` carries neither `Origin` nor
`X-CSRF-Token`. EHR, Lab, OCR and Pharmacy therefore also report the method of
the request they are serving: each `requireRequestContext` records
`request.method` as `requestMethod`, and the typed Identity client sends it as
`X-HID-Original-Method`, upper-cased, and only when it is 1–16 letters. For a
browser call that is the browser's method. For a service hop that forwards the
user's cookie, such as OCR's
`GET /api/v1/ehr/internal/ocr/documents/:documentId/source` during job
creation, it is that hop's method (EHR reports `GET`); the originating browser
write was already revalidated by the first service. Outreach authorizes every
request with `POST /api/v1/identity/outreach/authorize`, forwarding the user's
cookie or bearer token, and its guard reports the browser's method on that call
the same way (ADR-045). On a cookie request, Identity's `SecurityGuard` skips its
browser-write `Origin` and CSRF check only when all of these hold:

* the route is marked `@DelegatedBrowserRequest()`; only
  `POST /api/v1/identity/service/authorization/check` and
  `POST /api/v1/identity/outreach/authorize` are;
* the reported method is exactly `GET`, `HEAD` or `OPTIONS` (the guard's
  existing safe-method set; case-sensitive);
* the same request authenticates through
  `WorkloadAuthService.authenticateService` as one of the approved callers
  (`ehr-api`, `lab-api`, `pharmacy-api`, `ocr-api`, `outreach-api`), with the
  workload JWT or, outside production, the caller's local secret.

Anything else keeps the check: a reported write, a missing, lower-case or
unknown method, missing or wrong workload credentials, or an unapproved caller
name. The header carries no authority by itself, so a browser that sends it
gains nothing. Every other route keeps the check, including
`POST /api/v1/auth/service-session`, through which EHR, Lab, OCR and Pharmacy
still revalidate a cookie write's `Origin` and CSRF before they act. Bearer
requests are unchanged. Skipping the check changes nothing else: the session,
runtime controls, exact facility and the handler's own workload authentication
still apply, and on the patient authorization check so do the
`identity.authorization.check` permission and the patient authorization
decision. After a skip, the patient authorization check decides only the
`read_records` scope: any other scope (`write_records`) is `403
CSRF_VALIDATION_FAILED`, so a reported read never yields a write decision
(ADR-059). When the workload issuer is unavailable, the check is not skipped
and the request is answered `503 WORKLOAD_IDENTITY_UNAVAILABLE` rather than the
browser's `403 ORIGIN_DENIED`; any other workload failure keeps the check, as
before. A skip is recorded as the reported method in
`request.delegatedBrowserMethod`. On `POST /api/v1/identity/outreach/authorize`
the handler still requires the `outreach-api` workload (`authenticateOutreach`,
so another approved caller is refused `401 WORKLOAD_AUTHENTICATION_FAILED`), and after a skip it authorizes
only a permission ending in `.read`, refusing a write permission with
`403 CSRF_VALIDATION_FAILED`. An Outreach write therefore still needs the
cookie's `Origin` and CSRF token, which Outreach's guard requires and Identity
verifies against the session on this call. Outreach's other Identity route,
`POST /api/v1/identity/outreach/patient-authorization`, is not marked, and its
link-existing patient authorization reaches
`POST /api/v1/identity/service/authorization/check` without a method, so the
check still applies there. Before this rule, every delegated patient-scoped
read from a same-origin cookie session was refused `403 ORIGIN_DENIED` at the
decision call, and every same-origin Outreach cookie read was refused
`403 CSRF_VALIDATION_FAILED` by Outreach's own guard (Outreach registration
boundary below).

EHR and OCR authenticate every request through that service session, then
their guards (`RemoteSecurityGuard`) bind the facility named by
`X-Facility-ID` on every route that is not marked facility-optional (only
EHR's patient-only routes are: `GET /api/v1/ehr/me/records` and, since the
patient record release, `GET /api/v1/ehr/me/documents/:documentId/download`). A missing or malformed header is
`400 FACILITY_REQUIRED`. A facility where the actor has no active membership,
such as a stale tab after the membership ended, is
`403 FACILITY_ACCESS_DENIED`. Before binding, EHR also applies the runtime
controls (`503 PLATFORM_MAINTENANCE`, `423 PLATFORM_PORTAL_DISABLED`, and
`503 PLATFORM_CONTROL_UNAVAILABLE` when the control cannot be read, a database
fault included) and refuses a patient on a workforce route
(`403 PATIENT_SCOPE_DENIED`). No session is exempt from the runtime controls:
before ADR-059, a clinical session whose account also held
`platform.admin.access` skipped them in EHR and Outreach. A permission missing from the bound membership is
`403 PERMISSION_DENIED`. Each guard refusal is audited before it is answered:

* refused before a facility is bound, with an actor: `auth.authorization.denied`
  on resource type `authentication`, as the `staff` or `patient` actor with
  subject and account, and no facility, membership or organization. This is how
  Identity's own `SecurityGuard` records it;
* refused after a facility is bound: `security.authorization.denied` on
  `http-request`, with the bound facility, its membership and organization;
* refused without an actor: a `system` `security.authorization.denied` on
  `authentication`.

A refusal keeps its own status and code. If its audit row cannot be written,
the request fails closed with `503 DEPENDENCY_UNAVAILABLE`. Since
D-Eminence/hid-system#74 each EHR refusal row carries `details.status` and `details.code`,
the status and code answered, next to `method` and `route`. A route marked
patient-only (EHR's `GET /api/v1/ehr/me/records` and `GET
/api/v1/ehr/me/documents/:documentId/download`) refuses any other session
with `403 PATIENT_SESSION_REQUIRED` before a facility is bound.

EHR's request audit (`api.<method>.<route>` on `http-request`) records a failed
request with `details.status` and `details.code` too, and with outcome `denied`
for a refusal (`401`, `403`, `409`, `412`, `423`, `429`) and `failure`
otherwise. A staff actor's failure on a facility-optional route, where no
facility is bound, is recorded as `auth.authorization.denied` (a refusal) or
`auth.request.failed` on `authentication`, without facility, membership or
organization, instead of failing with `503`. A clinical command refused inside
its database transaction (a refusal of row-level security, `409`, `412`, and
the other refusals of §11) is also recorded after the rollback as the
command's own semantic action (for example `ehr.encounter.update`), outcome
`denied` for a refusal and `failure` for `400` and `404`, with
`details.status`, `details.code` and, where the refusal names them, codes such
as `missingPermissions`; never clinical content. Before, the rollback removed
that row and only the request row, outcome `failure` without status or code,
remained. Before
D-Eminence/hid-system#46, every refusal of a staff actor before a facility was
bound answered that `503` and was not audited, `PLATFORM_CONTROL_UNAVAILABLE`
included: its row carried the default membership but no facility, and a staff
row without a facility is accepted only as an `auth.*` event on
`authentication` or `session` (migration 0067). A database fault in EHR's
runtime-control check answered a patient `401 AUTHENTICATION_REQUIRED`.

Identity's guard and request-audit rows carry `details.status` and
`details.code` the same way since this change (A17; "Refusals and faults
(ADR-059)"), but Identity keeps its own outcomes: a request-audit failure row
is `failure` whatever its status, where EHR's is `denied` for `401`, `403`,
`409`, `412`, `423` and `429` and `failure` otherwise. EHR therefore records
a `400` and a `404` as `failure`, the masked non-uploader completion
("Document upload completion") among them, while Identity's facility-less
staff row records any status below `500` as `denied`. One rule for both is
open (AUDIT-OUTCOME, `PHASE_3_LAUNCH_DECISIONS.md` §2). In both services
every request-audit row of a patient session records purpose `patient-self`,
whatever `purpose` query parameter or `X-Purpose-Of-Use` header the client
sends, as the patient's own service events already did
(`identity.patient.self.*`, `ehr.patient.self.records.read` and, since 0096,
`ehr.patient.self.document.download`); before this change a patient's request
rows recorded the client's value, so a patient's own approval sent with
`direct-care` read as direct care. A staff request keeps the purpose it
declares. The patient document download (0096) is audited by the request
audit on failure only: each refusal's row records its status and code
(`404 DOCUMENT_NOT_AVAILABLE`, `503 DOCUMENT_INTEGRITY_UNAVAILABLE`,
`503 DOCUMENT_STORAGE_UNAVAILABLE`, `403 PATIENT_ACCESS_DENIED`, a malformed
id's `400 BAD_REQUEST`) with purpose `patient-self`; a signed download is
recorded by its own `ehr.patient.self.document.download` row.

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

This is distinct from governed NIN resolution above. The browser sends only the
11-digit NIN; the server adds required first/last name and DOB claims from the
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

Public patient enrollment (`/api/v1/identity/patient-enrollments`) is also
specified there. `POST /api/v1/identity/patient-enrollments/activate` answers
`429 ENROLLMENT_RATE_LIMITED` once one enrollment has had
`OTP_RATE_MAX_REQUESTS * 3` activation attempts (default 15) within
`OTP_RATE_WINDOW_SECONDS` (default 900). Every attempt that passes the cookie
and stage checks counts, whatever its outcome: first activations, replays and
attempts that then fail (for example `503 ENROLLMENT_RECONCILIATION_REQUIRED`
or `409 CONTACT_ALREADY_REGISTERED`). A malformed password (`400`), a missing
or forged enrollment cookie (`404`) or an enrollment not yet at the password
step (`409`) is refused first and not counted. Success bodies are unchanged.
Since this change (A21) the `429` carries `Retry-After` set to
`OTP_RATE_WINDOW_SECONDS` (§6).

Changes of D-Eminence/hid-system#68 (migration 0085; not
deployed). Request and success bodies are unchanged:

- `POST /api/v1/identity/patient-enrollments` checks the QoreID gate after
  the Origin, Turnstile, signed-in-session and input checks and before
  anything that reads the NIN's registration: `503 QOREID_DISABLED`,
  `503 QOREID_NIN_ONLY_DISABLED` or `503 INTEGRATION_PAUSED`, the same for a
  bound, a pending and an unknown NIN. A same-key resume is refused the same
  way while the gate is closed. Before, a bound or pending NIN got
  `409 NIN_ALREADY_REGISTERED` whatever the gate's state; with the gate open
  it still does.
- The same route answers `429 VERIFICATION_QUOTA_EXCEEDED` ("Verification
  request limit reached; try again later") when the QoreID lookup quota
  refuses the lookup: per client network (an IPv4 address or an IPv6 /64)
  `PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX` (5) an hour and
  `PATIENT_ENROLLMENT_QOREID_NETWORK_DAILY_MAX` (15) a day, and
  `PATIENT_ENROLLMENT_QOREID_DAILY_CAP` (200) a day across the platform. It is
  charged only when QoreID is called: never for a resume, a duplicate or an
  earlier refusal. A quota fault answers `503 VERIFICATION_QUOTA_UNAVAILABLE`.
- `POST .../activate` answers `409 ENROLLMENT_CONTACT_REVERIFY_REQUIRED`
  ("Verify your contact again before setting a password") when the contact
  was proved more than 30 minutes earlier. The enrollment is back at the
  contact step (`GET .../current` answers `stage: verify_contact` without a
  contact): choose and prove a contact again (`POST .../contact`, then
  `/contact/verify`). Nothing is created, and the attempt is not counted
  against the activation budget unless the activation command made the
  decision.
- An enrollment activated more than 15 minutes ago answers
  `404 ENROLLMENT_NOT_FOUND` on every enrollment route (`GET .../current`,
  `POST .../activate`, `/contact`, `/contact/verify`, `/google`), without the
  HID, as an unknown enrollment does. Within those 15 minutes `GET .../current`
  and a replay still answer `stage: active` with the HID.
- A successful activation response (`200`) expires `hid_enrollment`
  ("Auth session contract", above).

Enrollment availability and the closed-registration answer (FE-4,
D-Eminence/hid-system#68; no migration; not deployed):

- `GET /api/v1/identity/patient-enrollments/availability` (new). Public: no
  session, Origin, Turnstile token, cookie or input; a signed-in caller gets
  the same answer. `200 { "open": boolean }`, nothing else. The route itself
  refuses no `Origin`, but Identity's CORS middleware (`main.ts`) runs first,
  as on every route: a request without an `Origin` or from one in
  `CORS_ORIGINS` (the Health-id hosts) gets the answer, and a request from
  any other `Origin` is refused `403 ORIGIN_DENIED` with no CORS permission
  before the route is reached ("Refusals and faults (ADR-059)"; a `500`
  before D-Eminence/hid-system#76). `open` is `true` only when a start would now pass the
  checks it makes before it reads a NIN: the enrollment keys are
  configured, `QOREID_ENABLED` and `QOREID_NIN_ONLY_ENROLLMENT_ENABLED` are
  on, and QoreID's `patient_nin` capability is not paused at runtime. It
  does not predict per-request
  refusals (Turnstile, rate limits, the lookup quota, a registered NIN,
  `503 ENROLLMENT_RECONCILIATION_REQUIRED`), so a client still handles every
  start answer. A fault reading the runtime pause answers `503` (generic
  detail), not `{ "open": false }`; a client treats any answer other than
  `200 { "open": true }` as not open. With either flag off the route reads
  nothing; with both on it makes the one runtime-state read that start makes.
  It writes no audit row (as `GET /commercial/pricing`) and sets no cookie.
  The `200` carries `Cache-Control: public, max-age=30` and no `Pragma`,
  `Expires` or `Surrogate-Control`; a failure keeps the no-store default.
  Behind the Cloudflare Worker every API response is `private, no-store`
  (`infra/cloudflare/src/frontend-worker.mjs`), so a browser on the
  Health-id hosts refetches it each time. Identity does not rate limit it,
  as it does not `GET /commercial/pricing`: a per-network counter would cost
  a database write per anonymous read. The WAF rate rule that covers every
  API request applies (keyed per client by ADR-055). The gateway
  serves it under the identity prefix only (`^~ /api/v1/identity/`; with the
  route switch of #65, only while `HID_ENABLED_API_ROUTES` names `identity`,
  otherwise `404 API_ROUTE_NOT_FOUND`).
- While `QOREID_ENABLED` or `QOREID_NIN_ONLY_ENROLLMENT_ENABLED` is off,
  `POST /api/v1/identity/patient-enrollments` still answers
  `503 QOREID_DISABLED` or `503 QOREID_NIN_ONLY_DISABLED`, now with
  `detail` "New Health ID registration is not open yet. If you already have a
  Health ID, sign in." Before, Identity replaced it with the generic 5xx
  detail (section 6), so a client calling Identity directly got "The
  service could not complete the request.". Production kept NIN-only
  enrollment off until the N1 holder step (`PHASE_3_LAUNCH_DECISIONS.md`).
  From 0093 (ADR-062) a start with no holder route open answers
  `503 PATIENT_REGISTRATION_NOT_OPEN` with the same detail before these
  gates, which with every flag at its default is every start. `503 INTEGRATION_PAUSED` (a runtime pause) and
  `503 ENROLLMENT_CONFIGURATION_UNAVAILABLE` keep the generic detail. The
  gateway passes every upstream answer through, `5xx` included, with its
  status, code, `detail`, `Set-Cookie` and `Retry-After` (ADR-055,
  D-Eminence/hid-system#72; `proxy_intercept_errors` stays off in
  `gateway/nginx.conf.template`), and so does the Cloudflare Worker. A
  browser gets these codes and details as Identity sends them. The gateway
  answers `503 UPSTREAM_UNAVAILABLE` ("A required platform service is
  temporarily unavailable.") only when Identity gives no answer (refused,
  reset, timed out or not resolved). The availability read is a `200` and
  is not affected.
- Health-id 55a50b0 reads availability before the NIN step and shows the
  not-open notice (`routes/Enrollment.tsx:155-158`), and its completion
  screen asks the patient to save the Health ID (`:78`, `:382`).

A NIN record without a date of birth or gender (ADR-061,
D-Eminence/hid-system#82, migration 0092; merged to main, not deployed). QoreID
may return only the name, the NIN and its reference. Before this change such
a record could not enroll: start answered
`502 QOREID_PROVIDER_RESPONSE_INVALID`. Now the patient enters what the
record lacks when they set their password:

- Every progress answer after the holder proof and before activation
  carries `requiredProfileFields`: the fields the NIN record did not
  provide, in the order `dateOfBirth`, `gender`. It is `[]` for a complete
  record. From 0093 (ADR-062) it comes first on the online holder proof
  answer (`POST .../holder/verify`),
  `200 { "stage": "verify_contact", "requiredProfileFields": [...] }`. After
  an in-person check (0094, ADR-063) it comes first on `GET .../current` at
  `verify_contact`: the staff answer never carries it. It is
  then on `GET .../current` at `verify_contact` and `set_password`, on a
  same-key start that resumes an enrollment at those stages, and on the
  contact proof answer, which is now
  `200 { "stage": "set_password", "requiredProfileFields": [...] }`. It is
  never on a new start, on any answer at `verify_holder` or on an `active`
  answer. Identity reads it from the stored profile and never returns a
  profile value.
- `POST .../activate` takes
  `{ "password", "dateOfBirth"?: "YYYY-MM-DD", "gender"?: "female" | "male" | "intersex" | "other" | "unknown" }`.
  A date that is not `YYYY-MM-DD`, or another gender, is
  `400 VALIDATION_FAILED`. A `null` field counts as not sent.
- For a first activation, after the stage, contact-age and budget checks
  and before the password is hashed:

  | Status and code | When | `detail` |
  | --- | --- | --- |
  | `400 ENROLLMENT_PROFILE_FIELD_VERIFIED` | A field the NIN record provided is sent | "Your date of birth comes from your NIN record and cannot be changed here" (or "Your gender comes…", or "Your date of birth and gender come…") |
  | `400 ENROLLMENT_PROFILE_REQUIRED` | A field in `requiredProfileFields` is not sent | "Enter your date of birth and gender", "Enter your date of birth" or "Enter your gender" |
  | `400 DATE_OF_BIRTH_INVALID` | The date is not a real calendar date, is before 1900-01-01 or is after today (UTC) | "Enter a real date of birth. It cannot be before 1 January 1900 or in the future." |

  Each refusal counts toward the activation budget, as every attempt past
  the stage check does, and creates nothing; the enrollment stays at
  `set_password`. The detail is plain and safe to show as sent.
- A replay of an active enrollment ignores well-formed `dateOfBirth` and
  `gender` values and answers the HID as before. A malformed one is still
  `400 VALIDATION_FAILED`, as on any call.
- The database command checks the same rules again. A refusal there that
  the checks above did not catch is `409 ENROLLMENT_STAGE_INVALID`
  ("Enrollment conditions are not complete"), as any other activation
  condition the database refuses.
- The patient's `dob` and `gender` are the record's value or the one
  entered. `GET /identity/me` returns them as for any patient. The
  authoritative profile stays what QoreID returned, and the activation audit
  event (`identity.public-patient-enrollment.activated`) records
  `selfReportedFields`: the names of the fields taken from the request,
  never their values (`[]` for a complete record).
- Production still refuses NIN-only enrollment by configuration
  (`QOREID_NIN_ONLY_ENROLLMENT_ENABLED`); this change does not lift it
  (`PHASE_3_LAUNCH_DECISIONS.md` N1). 0093 replaces that refusal with the
  holder route rules below (ADR-062).
- Health-id 55a50b0 sends only the password. A complete record keeps
  working unchanged. A record without a date of birth or gender gets
  `400 ENROLLMENT_PROFILE_REQUIRED` and cannot activate until Health-id asks
  for the fields (`PHASE_4_STAGE_5_RELEASE_READINESS.md` §3).

The NIN holder step (ADR-062, D-Eminence/hid-system#84, migration 0093;
merged to main, not deployed). A NIN lookup proves only that the NIN exists.
Before a contact or a password, the patient now proves that they hold the
NIN. The online route is a code sent by SMS to the phone the NIN record
lists. The facility route (ADR-063, D-Eminence/hid-system#85, migration
0094; merged to main, not deployed) is an in-person check at a
participating facility: see "Facility-assisted registration" below. No
Health ID can be activated without a holder proof; the database refuses it.

- `POST /api/v1/identity/patient-enrollments` answers
  `200 { "stage": "verify_holder", "expiresAt", "googleOnboardingRequired", "online": { "available": boolean }, "facility": { "available": boolean } }`.
  `facility.available` is `true` while the facility route is open
  (`ASSISTED_REGISTRATION_ENABLED` and at least one participating facility).
  It never answers `409 NIN_ALREADY_REGISTERED` and never reads whether the
  NIN is bound or pending. A start with another `Idempotency-Key` for the
  same NIN is a new enrollment with its own cookie. The same key resumes as
  before; the same key for another NIN is `409 IDEMPOTENCY_KEY_REUSED`.
  Before the holder proof no progress answer carries `requiredProfileFields`,
  a masked digit or any registry value.
- The order at start is: `503 PATIENT_REGISTRATION_NOT_OPEN` with the
  not-open detail when no holder route is open, then the QoreID gate, then
  `Idempotency-Key`, the network rate limit, readiness, a same-key resume,
  the QoreID lookup and the new enrollment. A missing key is now refused
  after the gate, so a closed gate answers first. With every flag at its
  default no holder route is open, so every start answers
  `503 PATIENT_REGISTRATION_NOT_OPEN`. Staging cannot open the online route
  (it sends email only). Production opens the online route only while the
  facility route is open: `ASSISTED_REGISTRATION_ENABLED` is on and at least
  one facility takes part (ADR-063). So until a facility is designated every
  start on staging and production answers this way, and suspending the last
  designation closes both routes in production.
- A QoreID lookup that fails with `502`, `503` or `504` keeps its code and
  shows one fixed `detail`: "We could not check your NIN now. Try again
  later."
- `online.available` is `false` while `NIN_HOLDER_SMS_ENABLED` is off, in
  production from 0094 while no facility takes part, when the record has no
  phone or one Identity cannot use, and when the record's date of birth shows
  an age under 18. A record without a date of birth is
  treated as an adult; its patient enters a date at activation, and an
  under-18 date is not refused there (an owner decision, ADR-062). Before any
  proof this tells a caller one fact about the record: usable phone and not
  shown under 18, or not. Identity accepts `0` + 10 digits,
  `234` + 10 digits and `+234` + 10 digits, with spaces, hyphens or
  brackets. It never returns or logs the phone.
- `POST /api/v1/identity/patient-enrollments/holder` (new). The enrollment
  cookie, an approved `Origin`, no HID session and no body (a body is
  ignored). It sends a six-digit code by SMS to the record's phone and
  answers `200 { "challengeId", "expiresInSeconds", "resendAfterSeconds" }`.
  Then `GET .../current` shows `online.challengeId`, `expiresInSeconds` and
  `resendAfterSeconds`. One code is open at a time. A resend inside the
  cooldown is `429 OTP_RESEND_COOLDOWN`. One enrollment sends at most three
  codes.
- `POST /api/v1/identity/patient-enrollments/holder/verify` (new). Body
  `{ "challengeId": uuid v4, "code": six digits }`. Readiness is checked
  first. A code allows five attempts and is used once. A correct code answers
  `200 { "stage": "verify_contact", "requiredProfileFields": [...] }`. Only
  then does Identity say whether the NIN already has a Health ID: if it
  does, the answer is `409 NIN_ALREADY_REGISTERED`, the enrollment is
  deleted and its cookie is expired with the answer.
- A correct code removes the NIN's other unfinished enrollments: every
  unproven one, and any one proven by an earlier code. A later proof wins.
- Budgets, checked when a code is sent: five sends to one phone in 24 hours
  (`NIN_HOLDER_SMS_DAILY_MAX`), ten wrong codes for one NIN in 24 hours and
  thirty in 30 days (`NIN_HOLDER_FAILURES_DAILY_MAX`,
  `NIN_HOLDER_FAILURES_MONTHLY_MAX`). A code is sent only while the NIN's
  wrong codes plus the attempts left on all its open codes, the new one
  included, stay within both, so a NIN never has more wrong codes in reach
  than its budgets, across any number of enrollments: with the defaults, two
  enrollments of one NIN with an open code each leave a third without a
  code until one is spent or expires. One phone proves at most five
  different NINs in a year (`NIN_HOLDER_DISTINCT_NINS_MAX`), checked at the
  proof. A code already sent keeps its five attempts.
- The contact step (`POST .../contact`) and activation answer
  `409 ENROLLMENT_STAGE_INVALID` before the holder proof. A first activation
  without a valid holder proof is refused by the database and answered
  `409 ENROLLMENT_HOLDER_PROOF_REQUIRED`.
- A NIN that becomes bound while an enrollment waits for its password
  answers `409 NIN_ALREADY_REGISTERED` at activation with the recovery
  text. No answer says "pending" or names a Health ID, patient or contact.
- `GET /api/v1/identity/patient-enrollments/availability` now answers
  `200 { "open": boolean, "online": boolean, "facility": boolean }`.
  `online` is `NIN_HOLDER_SMS_ENABLED`; in production from 0094 it is also
  `false` while `facility` is `false`. `facility` is
  `ASSISTED_REGISTRATION_ENABLED` with at least one participating facility
  (0094). `open` is `true` only when the gate is open and a
  holder route is on.
- The two `503` refusals of this change, `NIN_HOLDER_ROUTE_UNAVAILABLE` and
  `QOREID_PATIENT_NIN_BINDING_DISABLED`, carry their own fixed `detail`
  (not the generic 5xx text), safe to show as sent; the gateway passes them
  through (ADR-055). So do the others section 6 lists as a
  `PublicDetailProblem`, such as `503 PATIENT_REGISTRATION_NOT_OPEN` and a
  NIN lookup that fails with `502`, `503` or `504`. Every other `5xx` of
  these routes carries "The service could not complete the request.", for
  example `OTP_DELIVERY_UNAVAILABLE`, `ENROLLMENT_RECONCILIATION_REQUIRED`,
  `ENROLLMENT_UNAVAILABLE`, `ENROLLMENT_ACTIVATION_UNAVAILABLE`,
  `ENROLLMENT_EVIDENCE_UNAVAILABLE`, `ENROLLMENT_RATE_LIMIT_UNAVAILABLE`,
  `ENROLLMENT_CONFIGURATION_UNAVAILABLE` and `INTEGRATION_PAUSED`: a client
  keys its own text on the `code`.
- `POST /api/v1/identity/me/verification/nin` (the signed-in "Verify NIN")
  answers `503 QOREID_PATIENT_NIN_BINDING_DISABLED` ("Verifying a NIN from
  your account is not available") while
  `QOREID_PATIENT_SELF_NIN_BINDING_ENABLED` is off, the default. It is
  refused before any lookup, quota charge or evidence row. Production
  refuses the flag.

| Route | Status and code | When | The patient's next step |
| --- | --- | --- | --- |
| `POST .../patient-enrollments` | `503 PATIENT_REGISTRATION_NOT_OPEN` | No holder route is on | Try later, or sign in if they have a Health ID |
| `POST .../patient-enrollments` | `502`, `503` or `504` (QoreID code kept) | The NIN lookup could not be completed | Try again later |
| `POST .../holder` | `409 NIN_HOLDER_ROUTE_UNAVAILABLE` | No usable phone on the record, an age under 18, or not at the holder step | Register at a participating facility |
| `POST .../holder` | `503 NIN_HOLDER_ROUTE_UNAVAILABLE` | The online route is off (in production from 0094, also while no facility takes part) | Register at a participating facility, or try later |
| `POST .../holder` | `429 OTP_RESEND_COOLDOWN` | A code was sent less than `resendAfterSeconds` ago | Wait the `Retry-After` seconds (what is left of the cooldown, §6), then ask again |
| `POST .../holder` | `429 NIN_HOLDER_ROUTE_LIMITED` | A send or failure budget is spent, or three codes were sent | Register at a participating facility (no `Retry-After`, §6) |
| `POST .../holder` | `429 ENROLLMENT_RATE_LIMITED` | The network's request budget is spent | Try again after `Retry-After` (`OTP_RATE_WINDOW_SECONDS`, §6) |
| `POST .../holder` | `503 OTP_DELIVERY_UNAVAILABLE` | The SMS provider refused the code | Try again later; the attempt counts toward the phone's five sends a day and the enrollment's three codes |
| `POST .../holder/verify` | `422 OTP_INVALID` | Wrong, expired, used or closed code | Check the code, or ask for a new one |
| `POST .../holder/verify` | `409 NIN_ALREADY_REGISTERED` | The NIN already has a Health ID | Use account recovery to sign in. If they never registered, contact Health ID support quoting the `correlationId` |
| `POST .../holder/verify` | `409 NIN_HOLDER_PROOF_CONFLICT` | An in-person proof of this NIN is open at a facility | Finish at the facility |
| `POST .../holder/verify` | `429 NIN_HOLDER_ROUTE_LIMITED` | The phone already proved five other NINs this year | Register at a participating facility (no `Retry-After`, §6) |
| `POST .../holder/verify` | `503 ENROLLMENT_RECONCILIATION_REQUIRED` | Enrollment is paused for reconciliation | Try again later |
| `POST .../holder/verify` | `503 NIN_HOLDER_ROUTE_UNAVAILABLE` | The online route was turned off after the code was sent | Register at a participating facility, or try again later |
| `POST .../holder`, `/holder/verify` | `404 ENROLLMENT_NOT_FOUND` | No, a forged or a removed enrollment cookie (for example after a later proof of the same NIN) | Start again |
| `POST .../contact`, `/activate` | `409 ENROLLMENT_STAGE_INVALID` | The holder step is not done | Prove the NIN with the code first |
| `POST .../activate` | `409 ENROLLMENT_HOLDER_PROOF_REQUIRED` | The database finds no valid holder proof | Start again |
| `POST .../activate` | `409 NIN_ALREADY_REGISTERED` | The NIN was bound since the holder proof | Use account recovery to sign in. If they never registered, contact Health ID support quoting the `correlationId` |
| `POST /identity/me/verification/nin` | `503 QOREID_PATIENT_NIN_BINDING_DISABLED` | The signed-in binding is off | None; the route is closed |

Health-id 55a50b0 does not know the holder step. On 0093 it cannot
register a new patient: its start expects `verify_contact` and its contact
step is refused `409 ENROLLMENT_STAGE_INVALID`. It fails closed; sign-in is
unchanged (`PHASE_4_STAGE_5_RELEASE_READINESS.md` §3). What Health-id needs
is listed in `PHASE_4_STAGE_5_RELEASE_READINESS.md` §3, "Health-id
alignment".

Facility-assisted registration (ADR-063,
D-Eminence/hid-system#85, migration 0094; merged to main, not deployed).
A patient without a usable registry phone proves at a participating
facility that they hold the NIN. They start on their own device, show a
desk code at the desk, and a staff member checks one original photo ID.
The patient finishes on their own device. Every flag is off and no facility
is designated, so the route is closed until an operator opens it.

- `GET /api/v1/identity/patient-enrollments/participating-facilities`
  (new). Public, no input, no audit row, `Cache-Control: public,
  max-age=300`. Answers `200 { "facilities": [{ "name", "addressLine"?,
  "town", "lga", "state", "hours"? }], "whatToBring": [three fixed
  lines] }`. No ids. The list is empty while `ASSISTED_REGISTRATION_ENABLED`
  is false. The three lines: "Your own phone with this registration open";
  "One original photo ID: national ID card, international passport,
  driver's licence or voter's card"; "A phone number or email that can
  receive codes now".
- `POST /api/v1/identity/patient-enrollments/facility-code` (new). The
  enrollment cookie, an approved `Origin`, no HID session, no body. At
  `verify_holder` it answers the holder progress with
  `facility: { "available": true, "deskCode", "deskCodeExpiresAt" }`. The
  code is 10 Crockford base32 characters (50 bits). A new code replaces the
  last one; five per enrollment; it expires with the enrollment.
  `GET .../current` shows the same code to the cookie holder only. The
  database keeps only the code's keyed digest.
- `POST /api/v1/identity/assisted-verifications` (new, staff). A staff
  session with MFA, the `X-Facility-ID` facility, `Origin` and the CSRF
  token, the permission `identity.patient.assisted_registration` (doctor,
  clinician, nurse) and `Idempotency-Key`. Body `{ "deskCode", "method":
  "government_photo_id_in_person", "documentType": "national_id_card" |
  "international_passport" | "drivers_licence" | "voters_card",
  "document": { "firstName", "lastName", "dateOfBirth"? },
  "attestations": { "patientPresent", "originalDocumentSeen",
  "photoMatchesPerson", "codeShownOnPatientsOwnDevice", "patientConsents" }
  }`, each attestation `true`. Order: the guard, then
  `503 ASSISTED_REGISTRATION_DISABLED` while the route is off (before the
  body is read), then the body (`400`). The same key replays the stored
  outcome.
- A match answers `200 { "outcome": "verified" }` and moves the patient's
  enrollment to `verify_contact`. Names are compared after NFKD, with
  accents dropped and upper case, keeping only the letters A-Z and single
  spaces: hyphens and apostrophes are removed, but a space is kept. So
  "Synthetic-Okafor" matches "SYNTHETICOKAFOR" but not "Synthetic Okafor".
  First and last name match the record's in either order. The date of birth
  is compared only when the record has one. Staff never see the NIN, a
  registry value, the contact, the Health ID or the missing profile fields.
- The patient may start, or start again, at the facility: a registration
  lasts 24 hours. After a `200` the patient's device reads
  `GET .../current` again and continues at `verify_contact` (contact,
  password, activation), as online.
- `422 ASSISTED_VERIFICATION_NOT_MATCHED` carries
  `fields: { "firstName", "lastName", "dateOfBirth" }`, each `match`,
  `no_match` or `not_in_record`; never a registry value.
- Admin: `GET /api/v1/admin/facilities/:facilityId/assisted-registration`
  (`platform.facility.read`) answers `{ facilityId, designated, status,
  addressLine, town, lga, state, hours, reason, version, updatedAt }`,
  version `0` without a designation. `POST` the same path
  (`platform.facility.manage`, step-up, reason, `Idempotency-Key`,
  `If-Match` with the version, `0` to create) with `{ status: active |
  suspended, addressLine?, town, lga, state, hours?, reason }` answers
  `201 { facilityId, status, version, replayed }`.
- Budgets: 20 checks per staff member and 100 per facility in 24 hours,
  every outcome counted (`ASSISTED_VERIFICATION_STAFF_DAILY_MAX`,
  `ASSISTED_VERIFICATION_FACILITY_DAILY_MAX`).

| Route | Status and code | When | Next step |
| --- | --- | --- | --- |
| `POST .../facility-code` | `409 ASSISTED_REGISTRATION_UNAVAILABLE` | The facility route is closed (flag off or no participating facility) | Use the online route, or try later |
| `POST .../facility-code` | `409 ENROLLMENT_STAGE_INVALID` | The holder step is done | Continue with the contact step |
| `POST .../facility-code` | `429 ASSISTED_DESK_CODE_LIMITED` | Five codes were issued for this enrollment | Start again (no `Retry-After`, §6) |
| `POST .../facility-code` | `404 ENROLLMENT_NOT_FOUND` | No, a forged, an expired or a removed enrollment cookie | Start again, on the patient's own device |
| `POST .../facility-code` | `503 ENROLLMENT_CONFIGURATION_UNAVAILABLE` | Enrollment keys are not configured | Try later |
| `GET .../current` (patient's device) | `200`, `stage: verify_contact` | Staff recorded a match | Continue on the device: contact, password, activation |
| `GET .../current` (patient's device) | `404 ENROLLMENT_NOT_FOUND` | Staff were told the NIN has a Health ID (the registration is deleted), or the registration expired | Follow the staff member's direction: account recovery when the NIN has a Health ID; otherwise start again |
| `POST .../activate` (patient's device) | `409 ENROLLMENT_HOLDER_PROOF_REQUIRED` | After the check, the facility stopped taking part or the verifying staff member lost the permission, the attested grant, an active membership or an active account | Start again and check in person at a participating facility |
| `POST .../assisted-verifications` | `503 ASSISTED_REGISTRATION_DISABLED` | The route is off | None; the route is closed |
| `POST .../assisted-verifications` | `400 VALIDATION_FAILED` | The body is malformed: a desk code shorter than 10 or longer than 20 characters or with characters other than letters, digits, spaces and hyphens, a missing field, or an attestation that is not `true`. `errors` names a refused `document` or `attestations` field by its dotted path, for example `document.dateOfBirth` or `attestations.patientConsents` (A23, §6) | Correct the entry |
| `POST .../assisted-verifications` | `400 DESK_CODE_INVALID` | The code passes the form check but is not 10 Crockford characters once spaces and hyphens are removed (for example a `U`) | Ask the patient for the code again |
| `POST .../assisted-verifications` | `404 DESK_CODE_NOT_FOUND` | No enrollment waits for this code | Ask the patient to show the code on their phone again |
| `POST .../assisted-verifications` | `422 ASSISTED_VERIFICATION_NOT_MATCHED` | A field differs from the NIN record | Check the document. If only spelling or spacing differs (a hyphen or a space in a name), retry with the form the document allows, within the budget. Otherwise do not register |
| `POST .../assisted-verifications` | `403 ASSISTED_REGISTRATION_NOT_AUTHORIZED` | No MFA session in SQL, no attested grant, an inactive membership or account, or the facility does not take part | Ask a platform administrator |
| `POST .../assisted-verifications` | `409 NIN_ALREADY_REGISTERED` | The NIN already has a Health ID | Direct the patient to account recovery; if they never registered, Health ID support with the reference in `detail` |
| `POST .../assisted-verifications` | `409 ASSISTED_VERIFICATION_STALE` | The check can no longer prove the enrollment (another proof came first, or a new desk code) | Ask for a new desk code and check again |
| `POST .../assisted-verifications` | `409 IDEMPOTENCY_KEY_REUSED` | The key was used for another request | Use a new key |
| `POST .../assisted-verifications` | `429 ASSISTED_VERIFICATION_LIMITED` | A staff or facility budget is spent | Try again later (no `Retry-After`: counted in SQL, §6) |
| `POST .../assisted-verifications` | `503 ASSISTED_VERIFICATION_UNAVAILABLE` | The check could not be recorded, or its proof could not be completed | Retry with the same `Idempotency-Key`: it replays the stored check and completes the proof, and is not charged again |
| `POST .../assisted-verifications` | `503 ENROLLMENT_RECONCILIATION_REQUIRED` or `503 ENROLLMENT_UNAVAILABLE` | The check is recorded and charged, but the proof step could not run | Retry with the same `Idempotency-Key` within 10 minutes of the check |
| `GET /admin/facilities/:id/assisted-registration` | `404 ADMIN_FACILITY_NOT_FOUND` | No such facility | Check the facility id |
| `POST /admin/facilities/:id/assisted-registration` | `409 FACILITY_NOT_ACTIVE` | Making an inactive facility or organization active | Verify the facility first |
| `POST /admin/facilities/:id/assisted-registration` | `400 VALIDATION_FAILED` | A malformed body, for example an empty town or a reason under 8 characters | Correct the request |
| `POST /admin/facilities/:id/assisted-registration` | `400 ADMIN_COMMAND_INVALID` | A designation the command refuses, for example `If-Match: 0` with `status: suspended` | Correct the request |
| `POST /admin/facilities/:id/assisted-registration` | `400 IDEMPOTENCY_KEY_REQUIRED` | No `Idempotency-Key` of 16 to 128 URL-safe characters | Send one |
| `POST /admin/facilities/:id/assisted-registration` | `403 STEP_UP_REQUIRED` or `STEP_UP_EXPIRED` | No authenticator step-up in the last five minutes | Confirm with the authenticator code, then retry |
| `POST /admin/facilities/:id/assisted-registration` | `403 PERMISSION_DENIED` | No `platform.facility.manage` | Ask a Super Admin |
| `POST /admin/facilities/:id/assisted-registration` | `404 ADMIN_RESOURCE_NOT_FOUND` | No such facility | Check the facility id |
| `POST /admin/facilities/:id/assisted-registration` | `409 VERSION_CONFLICT` | `If-Match` is not the current version | Read the designation again, then retry with its version |
| `POST /admin/facilities/:id/assisted-registration` | `409 ADMIN_STATE_CONFLICT` | The designation would not change | None |
| `POST /admin/facilities/:id/assisted-registration` | `409 IDEMPOTENCY_CONFLICT` | The key was used for another designation | Use a new key |
| `POST /admin/facilities/:id/assisted-registration` | `428 IF_MATCH_REQUIRED` | No `If-Match`, or not a whole number | Send the version, or `0` to create |

Health-id 55a50b0 has none of these screens (facility list, desk code,
staff check, designation). It cannot use the facility route.

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
GET  /api/v1/outreach/registration-cases                                # outreach.registration.read
GET  /api/v1/outreach/registration-cases/:caseId                        # outreach.registration.read
POST /api/v1/outreach/registration-cases                                # outreach.registration.write
POST /api/v1/outreach/registration-cases/:caseId/link-existing          # outreach.registration.write
GET  /api/v1/outreach/registration-cases/campaigns                      # outreach.campaign.read
POST /api/v1/outreach/registration-cases/campaigns                      # outreach.campaign.write (refused by Identity: 400)
POST /api/v1/outreach/registration-cases/campaigns/:campaignId/status   # outreach.campaign.write (refused by Identity: 400)
GET  /api/v1/outreach/registration-cases/campaigns/:campaignId/members  # outreach.campaign.read
POST /api/v1/outreach/registration-cases/campaigns/:campaignId/members  # outreach.campaign.write (refused by Identity: 400)
```

All requests require authenticated Identity user context, an authorized exact
`X-Facility-ID`, `X-Purpose-Of-Use: direct-care`, and a correlation ID. Each
route requires exactly the one permission shown, which Outreach asks Identity
to authorize through `POST /api/v1/identity/outreach/authorize`; a `GET` or
`HEAD` route mapped to anything but a `.read` permission fails closed with
`500 OUTREACH_POLICY_INVALID`. A cookie read (`GET` or `HEAD`) needs no
`Origin` or CSRF token, as a same-origin browser read sends neither; one that
names a disallowed `Origin` is refused `403 ORIGIN_DENIED`. A cookie write
requires an allowed `Origin` and an `X-CSRF-Token`, else
`403 CSRF_VALIDATION_FAILED`, and Identity verifies the token against the
session (Extracted Identity boundary above; ADR-045). Registration-case writes
require a stable `Idempotency-Key`; a campaign status change requires
`If-Match` with the campaign's expected version. Registration-case creation
accepts a UUID-v4 local command ID and only a `tmp_<uuid-v4>` temporary patient
reference; it always returns `identity_resolution_pending` initially.

Identity does not authorize `outreach.campaign.write`: its validation refuses
it `400 VALIDATION_FAILED`, which Outreach relays. The three campaign write
routes marked above (create, status change, member add) therefore answer
`400 VALIDATION_FAILED`, as on `main`, for cookie requests with an allowed
`Origin` and the session's CSRF token and for bearer requests alike, and
change nothing. No campaign can be created through the API. They stay closed
pending campaign governance: who may create campaigns, change their status and
add members is an open product decision (ADR-045). Campaign reads are served.

`link-existing` requires a canonical Identity patient UUID, a reason, and the
exact expected Outreach row version. Outreach calls the Identity authorization
boundary with separate `outreach-api` workload evidence before opening the
mutation transaction. Stale versions return 412; a reused idempotency key with
different content returns 409; Identity/dependency failure never returns
success. There is no Outreach create-patient, HID, NIN, encounter, screening,
document, OCR, or EHR-ingestion endpoint in this slice.

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

The Identity, EHR, OCR, Lab and Pharmacy APIs take the purpose of a write from
its validated body where the body has one, and otherwise from
`X-Purpose-Of-Use`, which must be `direct-care`, `emergency` or
`healthcare-operations` exactly. A missing or unknown header value is
`400 PURPOSE_OF_USE_REQUIRED` before any read. Identity's consent and audit
routes and EHR's clinical, consent and audit routes already checked the header
against their own narrower list first, with that code (EHR's emergency record
answers `400 EMERGENCY_PURPOSE_REQUIRED`). Every other route that reads the
header answered `500 INTERNAL_ERROR` before
D-Eminence/hid-system#60: EHR's document routes and its internal
OCR routes, Identity's registration-case read, OCR's reads, and every Lab and
Pharmacy route without a body purpose. Whether a route then accepts that
purpose is its own authorization. A patient session acts on its own record:
the Identity and EHR request audit records its purpose as `patient-self` and
never the value it sends (A17, this change).

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
/api/v1/ehr/patients/:patientId/encounters/:encounterId/lab-requests
/api/v1/ehr/patients/:patientId/encounters/:encounterId/lab-requests/:requestId/lab-work-item
```

All writes require:

* verified actor
* facility context
* authorization
* validation
* audit
* appropriate concurrency protection

### Launch module set

Lab, Pharmacy, OCR and Outreach are off at launch (decision D17), and so are
break-glass (D9) and document uploads; EHR prescriptions and lab requests are
records only. Since 0091 no role holds any `lab.*`, `pharmacy.*`, `ocr.*` or
`outreach.*` permission, `identity.break-glass.write` or `ehr.document.write`
(ADR-058): the staff session's and staff context's permission lists no longer
carry them, every route that needs one answers `403 PERMISSION_DENIED` before
any write or call to another service (where the gateway routes it at all; in
production it answers `404 API_ROUTE_NOT_FOUND` for the Lab, Pharmacy, OCR and
Outreach APIs), and Health-id 82b474e hides Laboratory, Pharmacy, Document OCR
and Outreach, their dashboard tiles, released Lab results, Extract with OCR and
the upload card, and disables emergency access. Its ungated "Health ID Migrate"
dashboard card still links to a page the gateway refuses (cosmetic). The EHR
reads, `ehr.document.read` included, stay. Before 0091, migration 0084 withdrew
`ehr.lab-request.write`, `lab.work-item.accept`, `lab.accession.create`,
`pharmacy.work-item.accept` and `pharmacy.dispensing.create` from every role,
so these routes answer `403 PERMISSION_DENIED` before any write or call to Lab
or Pharmacy:

- `POST` and `PATCH .../lab-requests` and `POST .../lab-requests/:requestId/lab-work-item`;
- `POST .../prescriptions/:prescriptionId/pharmacy-work-item`;
- Lab's EHR-order acceptance and accession creation, and Pharmacy's
  acceptance and dispensing.

0084 kept the read permissions; 0091 withdraws the Lab and Pharmacy reads too
(the EHR's own `ehr.lab-request.read` and `ehr.prescription.read` stay), so
existing lab requests and prescriptions remain readable in the EHR, and a
production database built at launch holds no Lab or Pharmacy records. The
platform controls `uploads_enabled`, `outreach_portal_enabled` and
`break_glass_enabled` start off (0091, where still seeded). Prescriptions are
still created and changed in the EHR. No lab request can be created or changed
at launch. Since 0090 an encounter's cancellation or retraction needs the write
permission of every kind of record it changes, so an encounter that still holds
a lab request cannot be cancelled or retracted either (`403
ENCOUNTER_RETRACTION_NOT_PERMITTED`) until Lab ordering is enabled again
("Encounter status and its records"). Re-enabling a module takes its own
decision, its fixes and a reviewed migration granting the permissions again,
which applies to every environment (the role bootstrap refuses a permission
granted by hand), and then a staging acceptance run; the sections on the Lab
and Pharmacy handoffs below describe the routes as they work then.

With 0090 (D-Eminence/hid-system#74, ADR-056), marking an
encounter entered in error needs the write permission of each record it
retracts, `ehr.document.write` for a linked document whose upload was started
or completed. Since no role holds it after 0091, `PATCH
.../encounters/:encounterId` to `entered_in_error` for such an encounter
answers `403 ENCOUNTER_RETRACTION_NOT_PERMITTED` for every role and changes
nothing, until uploads are re-enabled; cancelling it is not affected. A
database on which no upload was ever started holds no such encounter.

### Encounter status and its records

An encounter's status decides what may still be recorded on it (CLIN-EIE,
migration 0084). `PATCH /api/v1/ehr/patients/:patientId/encounters/:encounterId`
moves an encounter only along these transitions; any other answers
`409 INVALID_ENCOUNTER_TRANSITION`:

| From | To |
|---|---|
| `planned` | `in_progress`, `cancelled`, `entered_in_error` |
| `in_progress` | `on_hold`, `completed`, `cancelled`, `entered_in_error` |
| `on_hold` | `in_progress`, `cancelled`, `entered_in_error` |
| `completed` | `entered_in_error` |
| `cancelled`, `entered_in_error` | none |

Marking an encounter entered in error (a wrong-patient retraction, possible
also after completion) marks, in the same transaction and under the
encounter's row lock, its draft, signed and amended notes `entered_in_error`,
its diagnoses' `verificationStatus` `entered_in_error`, its `final` vitals,
its draft, active, on-hold and (since 0090) completed prescriptions and lab
requests, and the `initiated` or `uploaded` documents linked to it
`entered_in_error`. Cancelling an encounter cancels its draft, active and
on-hold prescriptions and lab requests, and leaves everything else. Each
changed record gets a version carrying the request's `changeReason`, and the
encounter's audit event (`ehr.encounter.update`) records `cascade`: the new
status and the ids changed in each category (`clinicalNoteIds`,
`diagnosisIds`, `vitalIds`, `prescriptionIds`, `labRequestIds`,
`documentIds`; cancelling lists only the two order categories). Since 0090
the response is the encounter with the additive field `cascade`, the same
object, whenever the status change cancelled or retracted it; any other
update returns the encounter without it. Lab and Pharmacy are not told (they
are off at launch; Pharmacy refuses to dispense a prescription that is no
longer active, 0080).

Cancelling or retracting needs the write permission of every kind of record
the close changes (ENC-RETRACT-1, ADR-056, D-Eminence/hid-system#74): `ehr.note.write` for notes,
`ehr.diagnosis.write` for diagnoses, `ehr.vital.write` for vitals,
`ehr.prescription.write` for prescriptions, `ehr.lab-request.write` for lab
requests and `ehr.document.write` for documents. Without one of them the
`PATCH` answers `403 ENCOUNTER_RETRACTION_NOT_PERMITTED` with the fixed detail
"Cancelling or retracting this encounter changes records you may not write",
writes nothing, and is audited (§7) with the missing permission codes as
`missingPermissions`. The response does not name them: only a kind of record
the encounter holds is checked, so the names would tell a caller which kinds
of record it holds, records the caller's role may not read (a receptionist
reads none of them). An encounter that holds none of these records needs only
`ehr.encounter.write`, as the route always did; holding, resuming and
completing need no record permission. Only records the close would change
count: a note, diagnosis or order already entered in error, a cancelled
order, a rejected document and a vital entered in error do not. With the
seeded roles:

- **Marking entered in error.** Doctors and clinicians may retract any
  encounter unless it holds a draft, active, on-hold or completed lab request
  (no role holds `ehr.lab-request.write` since 0084). Nurses may retract one
  unless it holds a diagnosis not yet entered in error, or a draft, active,
  on-hold or completed prescription or lab request. Receptionists may retract
  only one that holds none of the records listed above (no note, diagnosis,
  final vital, open or completed order, or initiated or uploaded document).
- **Cancelling.** Anyone holding `ehr.encounter.write` may cancel an encounter
  whatever notes, vitals, diagnoses and documents it holds, unless it holds a
  draft, active or on-hold prescription (then only doctors and clinicians) or
  lab request (then no one, until Lab ordering is enabled again).

The database refuses the same close (`ehr.require_retraction_permission`,
0090); the EHR answers it the same `403` with the same detail.

A cancelled or entered-in-error encounter takes no further change: any
`PATCH` of one that is not a refused transition (which keeps
`409 INVALID_ENCOUNTER_TRANSITION`), a chief complaint or end time edit or
its own status sent again, answers `409 ENCOUNTER_NOT_OPEN` (ORDER-CLOSED-EDIT).
A completed encounter still takes header corrections.

Creates and order activations check the encounter, under a share lock, and
answer `409 ENCOUNTER_NOT_OPEN` without writing anything:

| Encounter | Notes (also OCR-imported), vitals, diagnoses, documents linked to it | New prescription or lab request; activating a draft one | Resuming an on-hold order |
|---|---|---|---|
| `planned`, `in_progress`, `on_hold` | allowed | allowed | allowed |
| `completed` | allowed (late documentation, versioned and audited) | `409 ENCOUNTER_NOT_OPEN` | allowed |
| `cancelled`, `entered_in_error` | `409 ENCOUNTER_NOT_OPEN` | `409 ENCOUNTER_NOT_OPEN` | `409 ENCOUNTER_NOT_OPEN` |

An idempotent replay of an earlier create still returns its record. Changes
to existing records are not checked against the encounter's status: a note
amendment, a diagnosis update and a vital correction follow their own rules. A
diagnosis whose `verificationStatus` is `entered_in_error` cannot be changed
at all: `409 DIAGNOSIS_NOT_AMENDABLE`. A vital's recorded values are changed
only by a correction (`POST .../vitals/:vitalId/corrections`); the database
refuses any other update of them (D8).

Closed orders are final (RX-FINAL, ORDER-CLOSED-EDIT, 0090). A prescription
moves only along these transitions; any other answers
`409 INVALID_PRESCRIPTION_TRANSITION` (`409 INVALID_LAB_REQUEST_TRANSITION`
for a lab request, which follows the same table):

| From | To |
|---|---|
| `draft` | `active`, `cancelled`, `entered_in_error` |
| `active` | `on_hold`, `completed`, `cancelled`, `entered_in_error` |
| `on_hold` | `active`, `cancelled`, `entered_in_error` |
| `completed` | `entered_in_error` (since 0090: a completed prescription written for the wrong patient is retracted) |
| `cancelled`, `entered_in_error` | none |

Any other change of a `completed`, `cancelled` or `entered_in_error`
prescription (its frequency, instructions or end date, or its own status sent
again, or a field together with `completed` to `entered_in_error`) answers
`409 PRESCRIPTION_NOT_AMENDABLE`, and of such a lab request
`409 LAB_REQUEST_NOT_AMENDABLE`; nothing is written. Before 0090 these edits
were stored.

Vitals carry `status`: `final`, or `entered_in_error` once retracted
(ENC-RETRACT-2, 0090). `POST
/api/v1/ehr/patients/:patientId/encounters/:encounterId/vitals/:vitalId/entered-in-error`
(`ehr.vital.write`; body `{ "expectedRowVersion": 2, "changeReason": "..." }`,
`changeReason` 3 to 500 characters; no `Idempotency-Key`) marks a final vital
entered in error and answers `200` with the vital at its next `rowVersion`.
It is versioned with the reason and audited as `ehr.vital.entered-in-error`.
A stale `expectedRowVersion` answers `412 VERSION_CONFLICT`. A vital entered in
error keeps its values and takes no further change: the route again, or a
correction, answers `409 VITAL_NOT_AMENDABLE`, and it gains no correction
(`GET .../vitals/:vitalId/corrections` lists only those made before its
retraction). The emergency summary leaves it out. A vital is never deleted.

A document linked to an encounter that is marked entered in error becomes
`entered_in_error` (ENC-RETRACT-2) and stays so: it is never `available` again,
so the emergency summary does not list it and `GET
/api/v1/ehr/documents/:id/download` answers `409` for it. The EHR routes
never change such a document; the database refuses it too (0090).

The database enforces each of these rules too, so a writer that bypasses the
API gets the same refusal (`DATABASE.md`, "EHR clinical safety and launch
module set (0084)" and "EHR retraction integrity (0090)").

### EHR lab requests sent to Lab

EHR saves a lab request, then, when it is active, asks Lab to accept it
(`POST /api/v1/lab/work-items/accept-ehr-order`, "Extracted Lab transport").
The save commits first, because Lab's guard reads the committed request; a Lab
answer cannot undo it. Lab holds one work item per request, at the version it
accepted. Paths are under
`/api/v1/ehr/patients/:patientId/encounters/:encounterId/lab-requests`
(D-Eminence/hid-system#56):

- `POST` (create). An active request answers `201` with the request,
  `labWorkItem` (Lab's work item) and `labHandoff: { state: 'accepted' }`; any
  other status answers both `null`. When Lab refuses the request (`400`, `403`
  or `409`), the request stays saved and active and the create answers
  `409 LAB_HANDOFF_REFUSED`; when Lab answers anything else (`401` when it
  cannot verify the EHR's workload identity, another `4xx`, `5xx`) or cannot be
  reached, `502 LAB_HANDOFF_UNCONFIRMED`. Each detail names the saved request
  and Lab's code; a `5xx` detail is hidden from users, its code is not. Send the request with `.../lab-work-item` below, or replay the
  create with the same `Idempotency-Key` and body, which loads the saved
  request and sends it again. A replay of a request Lab holds at an earlier
  version answers `201` with `labWorkItem: null` and
  `labHandoff: { state: 'already_accepted', code: 'LAB_ORDER_ALREADY_ACCEPTED' }`.
- `PATCH /:requestId` (update). After the update commits, a request that is
  active is sent to Lab at its new version: activating a draft, resuming a held
  request, and an edit (priority, clinical information) of an active one. It
  answers `200` with the request, `labWorkItem` and `labHandoff`: `null` when
  the request is not active; `{ state: 'accepted' }`;
  `{ state: 'already_accepted', code: 'LAB_ORDER_ALREADY_ACCEPTED' }` when Lab
  holds an earlier version, so the change is not in Lab (or a version that
  row-level security hides from the actor, which Lab cannot name: "Extracted
  Lab transport");
  `{ state: 'failed', status, code }` with Lab's answer, when the update stands
  and the request can be sent again with `.../lab-work-item` (`409
  LAB_ORDER_NOT_CURRENT` means the request changed again after this update, and
  Lab may hold that later version: reload it); and
  `{ state: 'not_sent', code: 'LAB_PERMISSION_ABSENT' }` when the actor lacks
  `lab.work-item.accept`.
- `POST /:requestId/lab-work-item` sends, or sends again, an active request.
  It needs `ehr.lab-request.write` and `lab.work-item.accept`, an
  `Idempotency-Key` (16–128 URL-safe characters) and the body
  `{ expectedRowVersion }` (an integer, at least 1, and nothing else). It reads
  the request without a lock and writes only its audit event
  (`ehr.lab-request.lab-handoff.eligibility-checked`), then calls Lab: a version
  that is not the stored one is `412 LAB_REQUEST_VERSION_CONFLICT` and a request
  that is not active `409 LAB_REQUEST_NOT_ELIGIBLE`, without calling Lab. Lab's
  work item and Lab's refusal of the request are returned as they are, since
  the EHR changed nothing: `201` with the work item (the same one again for a
  version Lab accepted), or Lab's `400`, `403` or `409`, such as
  `409 LAB_ORDER_ALREADY_ACCEPTED` (Lab holds an earlier version) or
  `409 LAB_ORDER_NOT_CURRENT` (the request changed after it was read). Any
  other Lab answer, and Lab unreachable, is `502 LAB_HANDOFF_UNCONFIRMED`,
  naming the request and Lab's code; send it again. Lab's `401` (it cannot
  verify the EHR's workload identity, for example while its JWKS is
  unreachable) is never passed on, since a browser takes a `401` for its own
  expired session. Lab keys its acceptance by request and version, whatever the
  key.
- Cancelling, holding, completing or marking a request entered in error after
  Lab accepted it is not sent to Lab, and Lab keeps working on the version it
  accepted. What Lab must do then is an open clinical workflow decision.

### EHR clinical list paging

Six lists are newest first and keyset-paged. Paths are under
`/api/v1/ehr/patients/:patientId`:

| Route | Rows | Order |
|---|---|---|
| `GET .../encounters` | the patient's encounters | `started_at` desc, then `id` desc |
| `GET .../encounters/:encounterId/clinical-notes` | the encounter's notes | `created_at` desc, then `id` desc |
| `GET .../encounters/:encounterId/diagnoses` | the encounter's diagnoses | `created_at` desc, then `id` desc |
| `GET .../encounters/:encounterId/lab-requests` | the encounter's lab requests | `created_at` desc, then `id` desc |
| `GET .../encounters/:encounterId/prescriptions` | the encounter's prescriptions | `created_at` desc, then `id` desc |
| `GET .../encounters/:encounterId/vitals` | the encounter's vitals | `recorded_at` desc, then `id` desc |

Every list returns only rows of the active facility (`X-Facility-ID`). Each
takes `limit` (1–100, default 50) and an optional `cursor`, and returns
`{ items, nextCursor }`. `nextCursor` is null on the last page; otherwise pass
it back as `cursor` to the same route. No total is returned.

A cursor is opaque. It names the last row of the page, by its sort key at
microsecond precision (as PostgreSQL stores it) and its id, and the list,
patient and, for the five encounter lists, encounter it was issued for. It is
a position, not a credential: every page re-applies the caller's
authorization, the active facility and the patient decision. The facility is
not part of the cursor.

- A cursor of 16–512 base64url characters that is not in the exact form EHR
  issues for that route, patient and encounter is `400 INVALID_CURSOR`. This
  includes a cursor issued for another list, patient or encounter, one that
  was altered or re-encoded, one that names an impossible time, and one in an
  earlier format, such as the millisecond cursors EHR issued before the
  current format (version 1). Clients reload the list from its first page.
- A `cursor` that is shorter, longer or contains other characters, or a
  `limit` outside 1–100, is `400 VALIDATION_FAILED`.

No EHR route changes a row's sort key, and rows tied on the sort key are
ordered by `id`, so paging neither repeats nor skips a row that existed when
the previous page was read. A row added while paging is listed on a later page
only if it sorts after the last row shown; reload the first page to see newer
rows. Before the microsecond cursor, rows that sort after the last row shown
within its millisecond (earlier in that millisecond, or tied with a lower
`id`) were skipped.

### Record summaries

Two read-only summaries return the same seven arrays, each newest first:
`encounters` (completed), `notes` (signed or amended, with the current
revision's content; which encounters' notes depends on the summary, below),
`vitals`, `diagnoses`, `prescriptions`, `labRequests` and `documents`. The
patient summary adds an eighth, `labResults`, only where Lab results are
released to patients (below); the emergency summary never has it.

- `GET /api/v1/ehr/me/records`: the patient's own records, from every facility.
- `GET /api/v1/ehr/patients/:patientId/emergency-records`: the break-glass
  summary of the active facility (`X-Facility-ID`, `X-Purpose-Of-Use: emergency`).

Both also return:

| Field | Meaning |
|---|---|
| `released` | the categories read for this caller, in the order above |
| `withheld` | the other categories. A withheld category is not read; its array is always empty and means "not released to this caller", never "no records" |
| `limits` | per released section, the most rows it shows: 50 encounters, 50 notes and 100 of each other section |
| `truncated` | per released section, `true` when more rows exist than its limit; the section then holds the newest `limits[section]` rows |
| `limit` | `50`, the smallest section limit, kept for existing clients; read `limits` and `truncated` instead |

**Patient summary.** Encounters and notes are always released to the
patient. A note is released only once its encounter is completed (decision
D7, since 0084): the notes of an encounter in progress, on hold, cancelled or
entered in error are not returned, whatever the note's own status, and
row-level security refuses them to the patient's session as well.

Since the patient record release (owner decision 4 of 2026-10-16, D7, ADR-065,
migration 0096) the patient may also see vitals, diagnoses, prescriptions,
Lab results and documents. Each category is released only when its own
ehr-api flag is on, and every flag is off by default:
`EHR_PATIENT_RELEASE_VITALS`, `EHR_PATIENT_RELEASE_DIAGNOSES`,
`EHR_PATIENT_RELEASE_PRESCRIPTIONS`, `EHR_PATIENT_RELEASE_LAB_RESULTS` and
`EHR_PATIENT_RELEASE_DOCUMENTS` (synth inputs `HID_EHR_PATIENT_RELEASE_*`).
The production profile refuses every one of them: Lab results while Lab is
off at launch (D17), the others until the clinical owner signs off each
category and its wording (release checklist P36); staging may set them.
Lab requests (orders, which carry the clinician's clinical information) are
never released. Every released item belongs to a completed encounter, matched
on patient and facility. The database follows the flags: its policies admit a
category's rows to the patient's transaction only when EHR names that
category as released in it, so with a flag off neither EHR nor the database
releases the category. Row-level security restricts rows, not columns: within
a released category the fields below are what EHR selects, and it is EHR that
leaves out the clinician's notes, storage locations and staff identities.

| Category | Released | Never released |
|---|---|---|
| `vitals` | `status` `final` and never corrected (`current_correction_no` 0), as first recorded, with the emergency summary's fields | a corrected vital, while D8 (correction semantics) is open; a vital entered in error |
| `diagnoses` | `verificationStatus` `confirmed`: `id`, `encounterId`, `facilityId`, `codeSystem`, `code`, `display`, `clinicalStatus`, `verificationStatus`, `onsetAt`, `abatementAt` | unconfirmed, provisional, differential, refuted and entered-in-error diagnoses; the clinician's `notes` (never returned) |
| `prescriptions` | `status` `active`, `on_hold` or `completed`, with the emergency summary's fields | drafts, cancelled and entered-in-error prescriptions |
| `labResults` | per Lab result, its latest released revision that was not invalidated, of an order still active, on hold or completed: `id` (Lab result), `encounterId` (source EHR encounter), `sourceEhrOrderId`, `facilityId` (ordering facility), `test` `{codeSystem, code, name}`, `version`, `revisionKind` (`original`, `correction` or `amendment`), `resultType`, `numericValue` (number or `null`), `textValue`, `unit`, `referenceRange`, `abnormalFlag`, `releasedAt` | unverified or unreleased revisions (a newer correction that is not released leaves the earlier released value, as for clinicians, D11); a result whose latest released revision was entered in error (Lab's staff view shows it marked, the patient does not see it); results of a cancelled or entered-in-error order; correction and release reasons and staff identities |
| `documents` | `classification` `phi`, uploaded, attached to an encounter, and `status` `available` (the latest scan of the exact stored object version and SHA-256 is clean): `id`, `encounterId`, `facilityId`, `fileName`, `mediaType`, `sizeBytes` (a JSON integer, as on every document answer, A15), `classification`, `status`, `scanStatus`, `createdAt` | restricted or internal documents, documents attached to no encounter, rejected, not yet scanned, initiated or entered-in-error documents; the storage location (the download route signs a URL) |

`released` lists `encounters`, `notes` and then each released category in
the order `vitals`, `diagnoses`, `prescriptions`, `labResults`, `documents`.
`withheld` lists the other categories of `vitals`, `diagnoses`,
`prescriptions`, `labRequests` and `documents`; it always holds
`labRequests`. The `labResults` array and name appear only when Lab results
are released, so with every flag off the response is exactly
`released: ["encounters","notes"]` and `withheld:
["vitals","diagnoses","prescriptions","labRequests","documents"]`, as before
the release. `limits` and `truncated` cover the released sections (100 rows
each beyond encounters and notes). A released item that is later entered in
error, refuted, invalidated or retracted with its encounter disappears from
the summary without a marker.

If the database refuses a released category's read (for example the role
bootstrap did not run after migration 0096) or the read passes the
database statement timeout, the summary answers `503
PATIENT_RECORDS_UNAVAILABLE`, discloses nothing and records no success. The
audit event `ehr.patient.self.records.read` records `encounterCount`,
`noteCount`, the count of each further category read (`vitalCount`,
`diagnosisCount`, `prescriptionCount`, `labResultCount`, `documentCount`) and
`withheldCategories`; counts only.

**Patient document download.** `GET
/api/v1/ehr/me/documents/:documentId/download` (patient sessions only,
facility-optional) answers `200 { url, expiresInSeconds: 60 }`: a URL for the
exact stored object version, served as an attachment with `Cache-Control:
private, no-store`. Every document the patient may not download answers the
same `404 DOCUMENT_NOT_AVAILABLE`: documents are not released, the document
is unknown or another patient's, it is not an available PHI document of a
completed encounter, or it is held in another bucket. The staff download
answers the same code `409` for a document that exists but is not available
(A15); the patient route answers `404` for every case, so it does not say
whether the document exists. A malformed id is the UUID pipe's
`400 BAD_REQUEST`. The audit event `ehr.patient.self.document.download` (resource type
`document`, the document id, `details.mediaType` and `details.sizeBytes`
only) commits before the stored object is checked; then the object's
version, size, SHA-256 and encryption are read back (HEAD with checksum
mode) and must match the record, else `503 DOCUMENT_INTEGRITY_UNAVAILABLE`
and no URL is signed; an object store that cannot be read is `503
DOCUMENT_STORAGE_UNAVAILABLE`. Identity's answers are as for the summary
(`403 PATIENT_ACCESS_DENIED`, `503 IDENTITY_SERVICE_AUTH_UNAVAILABLE`,
`503 IDENTITY_SERVICE_UNAVAILABLE`). Caregivers and other delegates have no
access to either route (no delegated-access model exists, ADR-018).

**Emergency summary.** Of the seven categories it returns those the reader
holds the read permission for, pending a decision on the break-glass scope.
The route requires `ehr.encounter.read` and `ehr.note.read`, so encounters and
notes are always read. Each other category needs the permission its own routes
require: vitals `ehr.vital.read`, diagnoses `ehr.diagnosis.read`, prescriptions
`ehr.prescription.read`, lab requests `ehr.lab-request.read` and documents
`ehr.document.read`, at the active facility. Break-glass is not an
authorization bypass: a category the reader lacks the permission for is
withheld. The seeded doctor, clinician and nurse roles hold all seven.

- `notes` leaves out the notes of an encounter entered in error (since 0084).
  Notes of open, completed and cancelled encounters are returned; whether
  cancelled encounters' notes belong in the summary is part of the open
  break-glass scope decision (D9).

- `documents` lists only documents whose effective status is `available`: the
  latest scan of the exact stored object version and SHA-256 is clean, the rule
  the download applies. Each has `status` `available`, `scanStatus` `clean`,
  and `mediaType` as the scan detected it (as declared if the scan named none).
  `sizeBytes` is a JSON integer; until this change (A15) it was the text
  PostgreSQL returns for a `bigint` (`"20480"`).
- `vitals` are returned as first recorded (the vital row's eight measurement
  columns, which no API route changes and, since 0084, the database refuses
  to change), with the same fields as before, and since 0090 without the
  vitals entered in error; a
  vital's corrections are not applied. Applying them is pending the product
  decision on correction semantics (proposed default: the current correction
  is the whole current set, as Health-id's clinician chart applies it); the
  implementation is preserved in commit `7401193` for when the decision lands.
- The audit event `ehr.emergency.records.read` records the count of each
  category read, and the categories withheld, and nothing else:
  `encounterCount`, `noteCount`, `vitalCount`, `diagnosisCount`,
  `prescriptionCount`, `labRequestCount`, `documentCount` (a withheld category
  has no count) and `withheldCategories`.

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

The database binds the acceptance to the EHR row (`pharmacy.validate_work_item`,
0080): the snapshot must equal the prescription exactly (patient, facility,
encounter, version, `active` status, medication, dose, route, frequency,
instructions and prescriber). Otherwise Pharmacy answers
`409 PHARMACY_PRESCRIPTION_NOT_ELIGIBLE` (`application/problem+json`) and
writes no work item, event, outbox or audit row; this covers a prescription
cancelled, put on hold or edited after EHR's eligibility check, which commits
before EHR calls Pharmacy. EHR passes the status and code through, so its
handoff command answers the same `409`. An identical replay is answered before
the check and returns the accepted work item, even after a cancel.
`prescribedAt`, `startsOn` and `endsOn` are stored as sent and not compared
in this release, so EHR builds that send the time at the millisecond, or the
dates a day early from a process east of UTC, still hand off; comparing them
exactly is a follow-up for a later release.

Dispensing is a separate Pharmacy command requiring an accepted work item,
expected work-item version, positive quantity/unit, reason, pharmacist
permission, non-break-glass write authorization, and idempotency. This slice
allows one full dispensing per work item; partial fills and refills are not
modeled. Reversal requires the exact dispensing version and appends a preserved
relationship rather than updating or deleting the original event.

Dispensing also requires the work item's EHR prescription to be `active` at the
version Pharmacy accepted (`pharmacy.validate_dispensing`, 0080). `POST
/api/v1/pharmacy/work-items/:workItemId/dispensings` answers, in order:
`404 PHARMACY_WORK_ITEM_NOT_FOUND`, `403 PHARMACY_ACCESS_DENIED`,
`412 PHARMACY_WORK_ITEM_VERSION_CONFLICT`, the replay of an identical earlier
dispensing (`201`, also after the prescription was cancelled: that dispensing
happened), `409 PHARMACY_WORK_ITEM_ALREADY_DISPENSED`, then
`409 PHARMACY_PRESCRIPTION_NOT_DISPENSABLE` when the prescription was cancelled,
marked entered in error, put on hold, completed or changed to a later version
(any EHR edit, or a hold and resume), or cannot be read; nothing is written. A
cancel committed while the dispensing runs is read on the transaction's retry
and refused the same way. A cancel committed after the dispensing does not undo
it and is reported to neither side. Reversal does not read the prescription.
Current default: work whose prescription changed after acceptance stays listed
as `accepted` but cannot be dispensed or accepted again (one work item per
prescription); the remedy is a new EHR prescription and handoff. Other database
refusals keep their earlier answers.

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
`ocr-api` workload identity. When EHR, Lab or Pharmacy refuses OCR's workload
identity with `401` or `403` and `INTERNAL_SERVICE_AUTH_REQUIRED`,
`INVALID_WORKLOAD_IDENTITY` (every JWT failure, a JWKS fetch failure
included), `WORKLOAD_CALLER_DENIED` or `WORKLOAD_IDENTITY_UNAVAILABLE`, OCR
answers `503 EHR_SERVICE_AUTH_UNAVAILABLE`, `LAB_SERVICE_AUTH_UNAVAILABLE` or
`PHARMACY_SERVICE_AUTH_UNAVAILABLE`, so a browser does not sign in again for a
fault between services. A refusal of the propagated user credential, facility
or permission keeps the owning service's status and code. Identity answers its
own workload refusals as `401 AUTHENTICATION_REQUIRED` or `403 ACCESS_DENIED`,
which OCR cannot tell apart from a user refusal and passes through. The source read returns only the document,
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

A failed attempt leaves the publication `failed` with a `failureCode`. An
owning service's `5xx` or outage, an error inside the attempt, and a refusal of
OCR's workload identity by EHR, Lab or Pharmacy (`503
<SERVICE>_SERVICE_AUTH_UNAVAILABLE` above) are stored as
`OWNING_SERVICE_UNAVAILABLE`, and the owning service's `409
REQUEST_IN_PROGRESS` under its own code; both are retryable. OCR finds an
earlier publication by facility, requesting account and `Idempotency-Key`, so a
retry is the original request resent by the same account in the same facility
with the same key and an identical body (the same key with another body answers
`409 IDEMPOTENCY_CONFLICT`). It claims a retryable failure again 15 seconds
after it, up to three attempts, and after the last one answers `409
OCR_PUBLICATION_IN_PROGRESS`. Any other `4xx`, including a refusal of the
user's credential, facility or permission and an authorization that has lapsed
since the request (`404 OCR_JOB_NOT_FOUND`), is terminal under its own code,
and every later request for that publication answers `409
OCR_PUBLICATION_TERMINAL`. Any other request to publish a validation that
already has a publication answers `409 OCR_ALREADY_PUBLISHED`: a new key, or the
original key sent by another account, another member of the same facility
included. The validation is not visible from another facility (`404
OCR_VALIDATION_NOT_FOUND`). Only the original requester, keeping the original
key, can retry, so a client keeps the key per validation and per requester and
offers a retry only to that requester.

## 16. Storage

Uploads should use controlled storage flows.

Never return permanent public healthcare document URLs.

Use:

* authorized upload intent
* signed upload
* completion confirmation
* authorized download
* short-lived signed access where appropriate

### Document upload completion

Document uploads are off at launch (0091, ADR-058): no role holds
`ehr.document.write`, so `POST /api/v1/ehr/documents/upload-intents` and
`POST /api/v1/ehr/documents/:id/complete` answer `403 PERMISSION_DENIED` (where
they answered `201` or `409 CONFLICT`) before any write, and Health-id
82b474e hides the upload card. `uploads_enabled` also starts off, and since
0091 completion checks it first, as an upload intent does: with the control off
it answers `423 UPLOADS_DISABLED` ("Document uploads are temporarily disabled";
`409 CONFLICT` from 0091 until this change, A15) before
Identity, the storage read or any write, so an upload started before the
control was turned off cannot complete either. The rules below apply once a
reviewed migration grants `ehr.document.write` again and the control is on.

`POST /api/v1/ehr/documents/:id/complete` confirms an upload. Only the
account that created the upload intent (`created_by`) may complete it, at the
facility it was created for (`X-Facility-ID`). This is the current default,
pending a product decision. There is no delegated completion: an intent its
uploader cannot complete stays `initiated`, and the remedy is a new upload.
The membership is not compared: an account with two memberships at one
facility may be bound to either.

- The uploader also still needs `ehr.document.write`, a `write_records` grant
  for the document's patient, and a stored object whose size, SHA-256 and
  media type match the intent.
- Any other caller that passes the route checks (active at the
  `X-Facility-ID` facility, with `ehr.document.write`), including a member
  with the same permission and grant, gets `404 NOT_FOUND` ("Document not
  found"), the same answer as for an unknown document, one at another
  facility, or one the caller cannot read. It is refused before the patient
  authorization check and the storage read, and nothing is written. After the
  uploader has completed, another caller still gets `404`, not the idempotent
  `201`.
- A caller that fails the route checks, uploader or not, gets their answer
  first, as on every route: `400 FACILITY_REQUIRED` without a valid
  `X-Facility-ID`, `403 FACILITY_ACCESS_DENIED` when not active at that
  facility, `403 PERMISSION_DENIED` without `ehr.document.write`.
- `GET /api/v1/ehr/documents` still lists an `initiated` document to every
  holder of a read grant, so a member can see an upload they cannot complete.
- The uploader's answers: `201` with the document view (a `POST` without an
  explicit status; this section said `200` until this change), `403
  CONSENT_REQUIRED` without a write grant, `409 DOCUMENT_INTEGRITY_MISMATCH`
  when the stored object does not match, and `409 DOCUMENT_NOT_COMPLETABLE`
  when the document is no longer completable. A repeat after completion
  answers `201` with the current view while the status is `uploaded`, and
  `409 DOCUMENT_NOT_COMPLETABLE` once the scan is clean or rejected (status
  `available` or `rejected`). Until this change (A15) the refusals were
  `403 ACCESS_DENIED` and `409 CONFLICT`, with the same details.
- A refusal is recorded only by the request audit
  (`api.ehr.document.upload-complete.request`, without the document id), with
  `details.status` and `details.code` and outcome `denied` for `403`, `409`
  and `423` and `failure` for `404` (§7, "Extracted Identity boundary"); no
  `ehr.document.upload.complete` event is written. Until
  D-Eminence/hid-system#74 every such row was outcome `failure` without status
  or code.

### Document route answers

Each document route answers the route checks first, as every EHR route does
(`400 FACILITY_REQUIRED`, `403 FACILITY_ACCESS_DENIED`,
`403 PERMISSION_DENIED`, `400 PURPOSE_OF_USE_REQUIRED`,
`400 VALIDATION_FAILED`), then, in this order:

- `POST /api/v1/ehr/documents/upload-intents`:
  - `400 IDEMPOTENCY_KEY_REQUIRED` ("Idempotency-Key must contain 16 to 128
    URL-safe characters") for a missing key or one that does not match the
    pattern the clinical routes use (`common/idempotency.ts`).
  - `423 UPLOADS_DISABLED` ("Document uploads are temporarily disabled")
    while the platform control `uploads_enabled` is off. Identity is not
    asked and nothing is written. A control that cannot be read stays
    `500 INTERNAL_ERROR`.
  - `403 CONSENT_REQUIRED` ("Patient write access is not authorized") when
    Identity refuses `write_records` for the patient.
  - `409 IDEMPOTENCY_KEY_REUSED` for the key with a different request, and
    `409 REQUEST_IN_PROGRESS` for the same request while the first has not
    completed. A completed repeat of the same request returns the stored
    document with a new signed upload.
  - `404 ENCOUNTER_NOT_FOUND` and `409 ENCOUNTER_NOT_OPEN` for the linked
    encounter (§11).
- `GET /api/v1/ehr/documents`: `403 CONSENT_REQUIRED` ("Patient read access
  is not authorized"). Each item's `sizeBytes` (or `null`) and `version` are
  JSON integers.
- `POST /api/v1/ehr/documents/:id/complete`: `423 UPLOADS_DISABLED` first, as
  for the intent ("Document upload completion" above); then `404 NOT_FOUND`
  for anyone but the uploader, unchanged; then `403 CONSENT_REQUIRED`,
  `409 DOCUMENT_INTEGRITY_MISMATCH` and `409 DOCUMENT_NOT_COMPLETABLE`.
- `GET /api/v1/ehr/documents/:id/download`: `404 NOT_FOUND`,
  `403 CONSENT_REQUIRED`, and `409 DOCUMENT_NOT_AVAILABLE` ("Document is not
  available for download") unless the document is `available` with a clean
  scan.
- `GET /api/v1/ehr/internal/ocr/documents/:documentId/source`: `404
  NOT_FOUND` and `403 CONSENT_REQUIRED`, which OCR passes through with its
  status and code.
- The patient routes of the patient record release (0096, ADR-065; §11,
  "Record summaries" and "Patient document download") follow the same rules:
  `GET /api/v1/ehr/me/records` returns each released document's `sizeBytes`
  as a JSON integer, and `GET /api/v1/ehr/me/documents/:documentId/download`
  answers its own codes (`404 DOCUMENT_NOT_AVAILABLE`,
  `503 DOCUMENT_INTEGRITY_UNAVAILABLE`, `503 DOCUMENT_STORAGE_UNAVAILABLE`).
  Until the merge of 0096 into this change the released documents' `sizeBytes`
  was the text PostgreSQL returns for a `bigint`.

Until this change (A15) the key refusal and the disabled control answered
`409 CONFLICT` (the key's detail was "A valid Idempotency-Key header is
required"), the consent refusals `403 ACCESS_DENIED`, and the other refusals
`409 CONFLICT`; the list returned `sizeBytes` and `version` as strings. Every
other detail is unchanged. The request audit records each refusal with its
status and code, `denied` for `403`, `409` and `423` and `failure` for `400`
and `404` (§7). A database error in a document write (a row-level security
refusal, a closed-encounter trigger refusal) and a stored object missing at
completion still answer `500`.

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

Reads of executions and their result revisions are patient-authorized. The
specimen execution list (`GET /api/v1/lab/specimens/:specimenId/executions`)
and the single execution read both require `lab.execution.read` and an Identity
`read_records` decision for the patient before any execution or result is
returned. The list resolves the patient from the specimen and authorizes before
reading executions; the single read resolves it from the execution row and
authorizes before reading results. A refusal returns
`403 LAB_EXECUTION_ACCESS_DENIED` (an Identity problem, such as
`503 IDENTITY_SERVICE_UNAVAILABLE`, is returned as is), and an emergency read
under an active break-glass grant is allowed. A specimen the caller cannot see
returns `404 LAB_SPECIMEN_NOT_FOUND`. Lab row-level security applies the same
consent check, so an absent or revoked grant normally hides the specimen and
returns that 404; the 403 applies when the row is visible but Identity refuses.

Released results are read with `lab.result.released.read` (granted to doctor,
clinician, nurse, lab and admin by 0021), active facility context and an
Identity `read_records` decision for the patient, through two routes:

```text
GET /api/v1/lab/results/:resultId/history
GET /api/v1/lab/ehr-orders/:sourceEhrOrderId/released-results
```

A reader who also holds `lab.execution.read` (Lab staff, admin) gets every
revision from the history read. Every other reader of the history, and every
reader of the order route, gets the released view: the released revisions only,
in version order, including one later marked entered in error
(`verificationStatus: entered_in_error`). `currentVersion` and
`currentReleasedVersion` name the latest released revision, and `status` is
`released`, or `entered_in_error` when that revision is. Nothing of a revision
newer than the latest released one is returned. Versions keep their stored
numbers, so a gap shows that an intermediate revision was never released; its
value and reason are never returned. A history with no released revision answers
`404 LAB_RESULT_NOT_FOUND`.
Every revision, in every Lab result response, also carries `releasedAt`
(`null` until released).

The order route takes the EHR lab request ID (UUID v4) the clinician ordered and
returns the Lab work item accepted from it, with the released view of each of
its results, in execution start order:

```json
{
  "workItemId": "…", "sourceEhrOrderId": "…", "sourceEhrOrderVersion": 1, "patientId": "…", "acceptedAt": "…",
  "test": { "codeSystem": "http://loinc.org", "code": "718-7", "name": "Haemoglobin" },
  "results": [{
    "id": "…", "executionId": "…", "status": "released", "verificationStatus": "verified",
    "currentVersion": 1, "currentReleasedVersion": 1,
    "revisions": [{ "version": 1, "resultType": "numeric", "numericValue": 13.4, "textValue": null, "unit": "g/dL",
      "referenceRange": "12.0-15.5", "abnormalFlag": "normal", "entrySource": "manual", "verificationStatus": "verified",
      "releaseStatus": "released", "enteredAt": "…", "releasedAt": "…", "correctionReason": null }]
  }]
}
```

A result with no released revision is left out, so an accepted order with
nothing released answers `200` with `results: []`. Refusals: without the
permission `403 PERMISSION_DENIED`; at a facility the actor has no membership of
`403 FACILITY_ACCESS_DENIED`; an order with no work item the caller can see (not
accepted by Lab, accepted at another facility, or no consent grant; row-level
security) `404 LAB_WORK_ITEM_NOT_FOUND`, before Identity is asked; an Identity
refusal `403 LAB_EXECUTION_ACCESS_DENIED` (an Identity problem is returned as
is). An emergency read under an active break-glass grant is allowed, as for the
other Lab reads; this is the current default.

Each released-result read writes one patient-linked audit event in its read
transaction, and a failed audit write fails the read: `lab.result.released.read`
on resource `lab-work-item` with details `{ sourceEhrOrderId, results: [{
resultId, versionsReturned }] }` for the order route, and on resource
`lab-result` with `{ versionsReturned }` for a released-view history read; a
full history read records `lab.result.history.read`.

### Extracted Lab transport

Public Lab routes remain `/api/v1/lab/*` through the gateway when the Lab module is enabled (`HID_ENABLED_API_ROUTES`; it is not in the launch set, so the gateway answers `404 API_ROUTE_NOT_FOUND` until it is). Internal EHR order acceptance uses `POST /api/v1/lab/work-items/accept-ehr-order`; governed OCR publication uses `POST /api/v1/lab/imports/from-ocr`. Lab accepts an EHR order only when the work item's `requested_at` equals the EHR order's `created_at` exactly (`lab.validate_work_item`, 0077), so EHR sends `requestedAt` as that `created_at` rendered by PostgreSQL at the microsecond (`YYYY-MM-DDTHH:MM:SS.ffffffZ`), never through a JavaScript `Date`, which keeps only milliseconds and is refused by the guard (SQLSTATE `23514`, `409 LAB_ORDER_NOT_CURRENT`) for almost every order (`lab-session-guards.integration.sql` checks both texts against the guard, and `verify-lab-runtime.mjs` both over HTTP as the Lab runtime). Lab's idempotency digest covers the text of `requestedAt`, so an order Lab accepted from an earlier EHR build (possible only when its stored microseconds were a whole millisecond) and replayed with the same `Idempotency-Key` at any time after the upgrade, while the order is still active, gets Lab's `409 IDEMPOTENCY_CONFLICT`, which the EHR create reports as `409 LAB_HANDOFF_REFUSED` (EHR's replay does not check the key's `expires_at`); the reverse holds for an order accepted from this build and replayed through an earlier one during a rolling deploy or after a rollback. Lab still has its work item. Both preserve bearer or Identity session-cookie user evidence, facility, purpose, correlation ID, and idempotency key and additionally require authenticated internal-caller identity. Cookie mutations also preserve the Cookie header, Origin, and CSRF header so Identity can revalidate the unsafe request through `POST /api/v1/auth/service-session`. User and workload credentials remain separate. Local development uses one process-generated ephemeral credential. Production requires a rotating asymmetric JWT from an injected token file, exact issuer/JWKS/audience validation, and distinct configured EHR/OCR subjects; local-secret mode is rejected.

Lab answers EHR order acceptance (D-Eminence/hid-system#56):

| Request | Answer |
| --- | --- |
| A version of an order Lab has not accepted, matching the EHR order | `201` with the new work item |
| The version Lab accepted, same body | `201` with the same work item (replay) |
| The version Lab accepted, another body | `409 IDEMPOTENCY_CONFLICT` |
| A later version of an order Lab accepted | `409 LAB_ORDER_ALREADY_ACCEPTED`, naming the version Lab holds; Lab holds one work item per EHR order, ever, and writes nothing |
| An earlier version than the one Lab accepted | `409 LAB_ORDER_NOT_CURRENT`: the EHR order changed since, and Lab may hold that change; Lab writes nothing and does not reach the guard |
| An order that is not the current active version exactly as EHR holds it (changed, not active, another field or `requestedAt`) | `409 LAB_ORDER_NOT_CURRENT` (`lab.validate_work_item`, `23514`) |
| An actor without a database consent to write the patient's records at the facility | `403 LAB_ACCESS_DENIED` (row-level security on the work-item insert, `42501`); Lab writes nothing |
| An order whose work item Lab holds but row-level security hides from the actor (for example under a consent directive that denies reading) | `409 LAB_ORDER_ALREADY_ACCEPTED`, naming no version (a `lab.work_items` unique key, `23505`, after the one retry); Lab writes nothing |

Its body takes the EHR lab-request limits: `testCodeSystem` 1–255,
`testCode` 1–100 and `testName` 1–500 characters, `clinicalIndication` up to
4000. Its ids (`sourceEhrOrderId`, `sourceEncounterId`, `patientId`,
`orderingFacilityId`, `requestedBy`) are UUIDs of any version (1–8, nil, max),
since a patient or account migrated from the legacy system keeps its source id.

Only this command maps database refusals, and only its own three above: the
`23514` and `42501` of its work-item insert and a `lab.work_items` unique
conflict left after the retry. Their codes and details are fixed and name no
row, value or constraint; Lab logs the SQLSTATE and route. Any other database
error of acceptance (a `23514` of a child guard, a missing grant on another
table, a data error) answers `500`. Every other Lab command answers a database
refusal `500 INTERNAL_ERROR` with a fixed detail, as before
D-Eminence/hid-system#56: a guard (`23514`), a unique key after the retry
(`23505`), row-level security (`42501`) or a data error. For
`POST /api/v1/lab/imports/from-ocr` OCR keeps storing that `500` as the
retryable `OWNING_SERVICE_UNAVAILABLE` and retries the publication up to
`max_attempts`, where a Lab `4xx` would end the reviewed publication as
terminal.

### Extracted Pharmacy transport

Public Pharmacy reads and pharmacist commands remain
`/api/v1/pharmacy/*` through the gateway when the Pharmacy module is enabled
(`HID_ENABLED_API_ROUTES`; it is not in the launch set, so the gateway answers
`404 API_ROUTE_NOT_FOUND` until it is). EHR prescription acceptance and OCR
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

Pharmacy accepts an EHR prescription only when the snapshot equals the EHR row
(`pharmacy.validate_work_item`, 0080), and a later release will also compare
`prescribedAt`, `startsOn` and `endsOn` exactly, once no EHR build that sends
them through a JavaScript `Date` can still be deployed or rolled back to. EHR
therefore sends `prescribedAt` as the prescription's `created_at` rendered by
PostgreSQL at the microsecond (`YYYY-MM-DDTHH:MM:SS.ffffffZ`) and `startsOn`
and `endsOn` as `YYYY-MM-DD`, never through a `Date`, which keeps only
milliseconds and turns a date into local midnight (the day before in a process
east of UTC). Pharmacy's idempotency digest covers the text of the request, so
an acceptance sent by an earlier EHR build and sent again with the same
`Idempotency-Key`, or for the same prescription, after the upgrade gets
`409 IDEMPOTENCY_CONFLICT`; the reverse holds during a rolling deploy or after
a rollback. Pharmacy still has its work item.

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
GET /api/v1/admin/principals?query=&page=&pageSize=&status=   (deprecated: POST /principals/search)
GET /api/v1/admin/identity/reviews?page=&pageSize=&status=
GET /api/v1/admin/audit/events?limit=&beforeSequenceId=&actor=&facilityId=&action=&correlationId=&outcome=&from=&to=
GET /api/v1/admin/operations/services
GET /api/v1/admin/operations/events
```

`POST /api/v1/admin/principals/search` (`200`) takes the same `query`,
`page`, `pageSize` and `status` in a JSON body and answers exactly what the
`GET` answers; it needs `platform.principal.read`, the allowed `Origin` and
the CSRF token of any platform cookie `POST`, and is registered as the
standard high-risk action `platform.principals.search` (no step-up, reason,
`If-Match` or `Idempotency-Key`). `POST /api/v1/admin/principals/export`
(`200`, the same CSV and headers) takes `reason`, `query` and `status` in the
body under `platform.principal.export` with step-up, and the guard reads and
audits the body's reason; a reason only in the query string is `400
REASON_REQUIRED`. The `GET` forms stay, unchanged, for one release because the
Health-id `82b474e` console calls them
(`apps/patient-web/src/admin/api.ts:354-357` and `:374-376`), and are then removed: they put names, emails and the export
reason in the URL (A24, ADR-059, D-Eminence/hid-system#76).
The gateway's access log omits query strings (D-Eminence/hid-system#72, ADR-055).

Principal search requires at least two characters. Facility, principal, and
review page sizes are bounded to 100; audit pages are bounded to 200 and use a
descending sequence cursor. Raw NIN, password material, tokens, event payloads,
patient audit identifiers, and free-form audit details are absent.

Own MFA endpoints (`platform.admin.access`):

```text
GET /api/v1/admin/mfa
POST /api/v1/admin/mfa/step-up                      { "code": "<six digits>" }
POST /api/v1/admin/mfa/recovery-codes/regenerate    (needs a fresh step-up)
```

These run under an accepted platform session, so a refusal there is never
`401` from the service ("Refusals and faults (ADR-059)"). A wrong or
already-used step-up code is `403 MFA_INVALID_CODE`: the session stays valid,
and the failure counts toward the account's and the network's second-factor
failure budgets. The fifth failure within 15 minutes blocks the account's
step-up, sign-in and enrolment activation for 15 minutes with
`429 MFA_RATE_LIMITED`; regeneration is limited to five per 15 minutes, also
`429 MFA_RATE_LIMITED`. Each `429` carries `Retry-After: 900` (A21, §6). A
step-up or regeneration whose session lost its MFA assurance while the
request waited for the account (its session row gone, or its factor no
longer the session's or no longer active) is `403 PLATFORM_SESSION_REQUIRED`,
as for every platform command. Before this change (A20) a wrong code was
`401 MFA_INVALID_CODE` and a lost assurance `401 MFA_CHALLENGE_INVALID`. A
`401` on these routes now comes only from the guard
(`AUTHENTICATION_REQUIRED`, `PLATFORM_SESSION_EXPIRED`,
`PLATFORM_SESSION_REVOKED`). The sign-in challenge routes
`POST /api/v1/auth/admin/mfa/verify`, `/mfa/enroll/start` and
`/mfa/enroll/activate` are unauthenticated and keep `401 MFA_INVALID_CODE`
and `401 MFA_CHALLENGE_INVALID`.

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

### Workforce provisioning (launch decision D14, migration 0087)

Clinicians are provisioned only by platform administrators holding
`platform.workforce.manage` (granted to `platform_super_admin` only). A
facility's `org_admin` has no route to grant itself or anyone a clinical role.
Every route below is a platform route: it needs an MFA-verified platform
session (`PLATFORM_SESSION_REQUIRED` otherwise) and the permission
(`PERMISSION_DENIED`). Every command also needs a TOTP step-up from the last
five minutes (`STEP_UP_REQUIRED` or `STEP_UP_EXPIRED`), `Idempotency-Key` (16
to 128 URL-safe characters) and a `reason` of 8 to 500 characters; commands on
an existing staff record or membership need `If-Match` with its version
(`428 IF_MATCH_REQUIRED`, `409 VERSION_CONFLICT`). An exact replay returns the
first answer with `replayed: true`; the same key with a different body is
`409 IDEMPOTENCY_CONFLICT`. Commands answer `201`. Each new command records a
platform-scoped audit event (`admin.workforce.membership.attached`,
`admin.workforce.credential.attested`, `admin.workforce.role.granted`,
`admin.workforce.role.revoked`, `admin.workforce.membership.ended`) with no
facility or membership bound; the facility is in `details`.

```text
GET  /api/v1/admin/workforce/accounts/:accountId
POST /api/v1/admin/workforce/memberships
POST /api/v1/admin/workforce/accounts/:accountId/attestations
POST /api/v1/admin/workforce/memberships/:membershipId/roles
POST /api/v1/admin/workforce/memberships/:membershipId/end
```

`GET .../accounts/:accountId` returns `{ account: { id, email, displayName,
status, version, patientAccount }, staff: { id, fullName, verificationStatus,
active, version } | null, attestations: [{ id, attestedRoles,
credentialReference, issuingAuthority, verificationMethod, evidenceReference,
validUntil, current, reviewerAccountId, recordedAt }], memberships: [{ id,
facilityId, facilityName, state, active, held, version, roles: [{ roleCode,
effective, grantedAt }] }] }`. `state` is `pending`, `active`, `ended`, or
`inactive` for an inactive membership the workforce commands never touched.
`staff.version` is the `If-Match` of an attestation; a membership's `version`
is the `If-Match` of its role and end commands.

`POST .../memberships` attaches a staff identity to a verified facility. The
body is `{ facilityId, accountId, reason }` for an existing staff account, or
`{ facilityId, email, fullName, reason }` for a new one, never both and no
password. The membership is created inactive (`state: pending`) and grants
nothing. A new account is `pending_reset` with no password and a new staff
record is `pending`: the clinician sets a password through the staff account
recovery flow (`/auth/otp/*`), and cannot sign in before a role is granted. The
answer is `{ membershipId, accountId, staffId, facilityId, state: "pending",
accountStatus, accountCreated, membershipVersion, staffVersion, replayed }`.

`POST .../accounts/:accountId/attestations` records a professional-credential
attestation: `{ attestedRoles, credentialReference, issuingAuthority,
verificationMethod: "manual_review", evidenceReference, validUntil, reason }`
with `If-Match` the staff version. `attestedRoles` is one to three of
`doctor`, `clinician`, `nurse`, each once. `validUntil` is an ISO 8601 time in
the future and at most three years ahead; set it no later than the licence's
expiry. `evidenceReference` names where the reviewed evidence is kept (a ticket
or document reference), never the document itself. The administrator who
records it is its reviewer and cannot attest for their own account. A
`pending` staff record becomes `verified`. The answer is `{ attestationId,
accountId, staffId, attestedRoles, verificationMethod, validUntil,
verificationStatus, staffVersion, replayed }`. The evidence text is not copied
into the audit event.

`POST .../memberships/:membershipId/roles` grants or revokes one role:
`{ facilityId, roleCode, action: "grant" | "revoke", reason }` with `If-Match`
the membership version. `facilityId` must be the membership's facility.
`grant` accepts `doctor`, `clinician` or `nurse`; `revoke` also accepts `lab`
and `pharmacist`. A grant needs a current attestation for that role by a
reviewer who is not the target, has no active membership at the facility and
is not the administrator granting it, so a clinical role always takes two
platform administrators. The first grant activates a pending membership. The
answer is `{ membershipId, facilityId, roleCode, roleActive, membershipActive,
state, version, attestationId, renewed, replayed }`; `attestationId` is null for
a revoke.

Renewal: a granted role rests on the attestation it was granted on, and a
later attestation does not extend it by itself. To keep a clinician's role,
record a new attestation (one administrator) and grant the role again (a
second administrator, under the same rules). The grant renews the role, with
`renewed: true`, when the role's attestation has lapsed, or before the lapse
when the best current attestation lasts longer: the old assignment is revoked
with the grant's reason and the new one rests on the new attestation, so the
role stays effective without a gap. Otherwise a grant of a held role is
`WORKFORCE_ROLE_ALREADY_ACTIVE`. A role granted by onboarding or the legacy
promotion never lapses and is never renewed. The audit event of a grant
carries `renewed` in `details`.

`POST .../memberships/:membershipId/end` ends a membership for good:
`{ facilityId, reason }` with `If-Match` the membership version. It
deactivates the membership, revokes its facility roles, expires its pending
access requests, revokes every active consent grant bound to it and, when the
membership was active, revokes all the account's staff sessions (a staff
session is not bound to one facility). A patient approval that commits while
the end runs is counted in `revokedGrants`, not `expiredRequests`. An access
request created and committed concurrently, after the end has read the
pending requests, stays pending on the ended membership; it, and any grant
approved from it, authorizes nothing, because every authorization needs an
active membership. The answer is `{ membershipId, facilityId, accountId,
state: "ended", revokedRoles, revokedGrants, expiredRequests, revokedSessions,
version, replayed }`. To give the person access again, attach them again: a
new membership starts pending.

| Status and code | When |
|---|---|
| `400 WORKFORCE_COMMAND_INVALID` | The body names both or neither identity form, or a field is out of range |
| `400 WORKFORCE_ROLE_NOT_GRANTABLE` | The role cannot be granted (or revoked) through this route |
| `403 WORKFORCE_SELF_CHANGE_DENIED` | The target is the caller's own account or membership |
| `403 WORKFORCE_FACILITY_CONFLICT` | The caller has an active membership at the facility (its `org_admin` included) and attaches or grants there |
| `403 WORKFORCE_SECOND_PERSON_REQUIRED` | The only current attestation for the role was recorded by the caller |
| `404 WORKFORCE_ACCOUNT_NOT_FOUND`, `WORKFORCE_STAFF_NOT_FOUND`, `WORKFORCE_FACILITY_NOT_FOUND`, `WORKFORCE_MEMBERSHIP_NOT_FOUND` | The named record does not exist |
| `409 WORKFORCE_ATTESTATION_REQUIRED` | No current attestation for the role by an independent reviewer |
| `409 WORKFORCE_ROLE_CONFLICT` | The membership holds `org_admin` or `admin`; an administering membership stays non-clinical |
| `409 WORKFORCE_ROLE_ALREADY_ACTIVE`, `WORKFORCE_ROLE_NOT_ACTIVE` | Granting a held role that is not due for renewal (its attestation is current and no current attestation lasts longer, or it was not granted on an attestation), or revoking one the membership does not hold |
| `409 WORKFORCE_MEMBERSHIP_EXISTS` | The account already has an active or pending membership at the facility |
| `409 WORKFORCE_MEMBERSHIP_ENDED`, `WORKFORCE_MEMBERSHIP_INACTIVE`, `WORKFORCE_MEMBERSHIP_HELD` | The membership has ended, is inactive and was not attached by these commands, or is held for migration review |
| `409 WORKFORCE_FACILITY_MISMATCH` | `facilityId` is not the membership's facility |
| `409 WORKFORCE_FACILITY_NOT_VERIFIED` | The facility or its organization is not verified and active |
| `409 WORKFORCE_ACCOUNT_INELIGIBLE`, `WORKFORCE_STAFF_INELIGIBLE` | The account is disabled, locked, deleted or a patient's own account, the staff record is inactive, or its verification status cannot be attested or granted |
| `409 WORKFORCE_EMAIL_IN_USE` | A new identity's email is already used by an account or staff record |

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
The production gateway proxies only the enabled modules (see the first
section); a browser application for a module that is not enabled receives
`404 API_ROUTE_NOT_FOUND` for its API calls.

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
