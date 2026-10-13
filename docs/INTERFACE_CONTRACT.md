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
`/api/v1/identity/outreach/*`, `/api/v1/ehr/internal/*`, and the Lab and
Pharmacy `accept-ehr-*` and `imports/from-ocr` routes) in any letter case or
spelling nginx normalizes. Public IP-keyed limits (recovery start, patient
enrollment start and contact, provider enrollment, organization application
intake and profile completion) count per client network: an IPv4 address or an
IPv6 /64. Without a usable client address, or, in production, with an address
of one of the platform's own proxies, they answer their 503
(`OTP_RATE_LIMIT_UNAVAILABLE` for recovery start,
`ENROLLMENT_RATE_LIMIT_UNAVAILABLE`,
`PROVIDER_ENROLLMENT_RATE_LIMIT_UNAVAILABLE`,
`APPLICATION_RATE_LIMIT_UNAVAILABLE`) instead of sharing one bucket. The
gateway passes a backend `503` to the browser as `503 UPSTREAM_UNAVAILABLE`
(its `error_page` intercepts backend 502, 503 and 504), so clients must treat
any 503 as unavailable rather than rely on the backend code.

Authentication OTP commands are purpose-bound and use three stages: start
returns a generic challenge, verify accepts exactly six digits and returns an
opaque one-time completion credential, and complete consumes that credential.
Identity calls Notification API directly over workload authentication; these
credentials never use the ordinary-notification event path. In production the
Notification API runs the `otp-email-sms` profile (ADR-053,
BRANCH:launch/infra-launch-config): `POST /notifications/otp` delivers
`email` through SES and `sms` through Termii and answers `400` for `whatsapp`
without a provider attempt; Identity sends only `email` and `sms`. The `202`
response's `requestId` is also the correlation id of the one PHI-free
`notification.otp.outcome` log line written per send. Ordinary domain
events remain minimum-necessary versioned envelopes delivered through outbox,
Event Dispatcher, EventBridge/SQS, Notification Worker, and Novu.

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
the existing ones, unchanged in shape. This comes from
D-Eminence/hid-system#61, not yet deployed; the threshold is an
open product decision.

### Auth session contract

This is the browser contract of staff and patient sessions. Sign-out without
a live access token, the `X-HID-Client` check and the refresh-token lookup
rules below come from D-Eminence/hid-system#39, which is not yet deployed. Platform administration sessions use their own cookies and
`/auth/admin/*` routes (`PHASE_4_STAGE_2A_BACKEND_SECURITY.md` §1). The
enrollment cookie rule and the lookups' actor condition come from
D-Eminence/hid-system#50, also not deployed.

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

Every response that sets these cookies (a staff or patient sign-in by
password or Google, provider enrollment activation, and a refresh) or clears
them also expires the public patient enrollment cookie `hid_enrollment` on its
path, `/api/v1/identity/patient-enrollments` (HttpOnly, `SameSite=Strict`,
`Secure` as above). That cookie lets `GET /identity/patient-enrollments/current`
and an activation replay show the enrollment's HID on the enrolling device for
up to 24 hours ([QoreID verification contract](QOREID_VERIFICATION_CONTRACT.md));
a signed-in patient reads the HID from `GET /identity/me`, and the enrollment
routes refuse while session cookies are present. Every other response leaves
it: a refused sign-in, a pending Google enrollee (`202`), and each refresh or
sign-out refusal that leaves the session cookies untouched or kept (below).
Activation itself keeps it. Platform administration sign-in does not touch it.

`POST /api/v1/auth/refresh` takes no body. It reads the refresh and CSRF
cookies, `X-CSRF-Token` and, optionally, `X-HID-Client`, and checks them in
this order:

| Outcome | When | Cookies |
|---|---|---|
| `403 ORIGIN_DENIED` | `Origin` is missing or not in `CORS_ORIGINS` | Untouched |
| `403 CSRF_VALIDATION_FAILED` | The refresh cookie is missing, or `X-CSRF-Token` and the CSRF cookie are missing, differ, or are not the value derived from the refresh token | Untouched |
| `403 SESSION_CLIENT_MISMATCH` | `X-HID-Client` names the other kind of sign-in (below). Nothing is rotated | Kept |
| `401 AUTHENTICATION_REQUIRED` | Rotation refuses the token: unknown, ended, expired, reused (reuse ends the whole sign-in), a platform token, or an account that is no longer active, is disabled or has a new token version. Any other failure during rotation also clears the cookies | Cleared |
| `200` `{ actor, expiresAt }` with a new `X-CSRF-Token` header | The refresh token is rotated into a new session of the same sign-in | Replaced |

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
`503 DEPENDENCY_UNAVAILABLE`.

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
  (`identity.current_patient_account`).

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
`GET /api/v1/identity/me/access-history` returns at most 50 safe grant summaries;
grant status does not assert notification delivery. `GET /api/v1/ehr/me/records`
returns at most 50 completed encounters and 50 current signed/amended note
revisions of completed encounters (since 0084), after fresh Identity
authorization through the EHR workload caller.
It names the other five record categories as withheld from the patient, not as
absent (§11, "Record summaries").
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
at launch (owner default, deny by default; release checklist P10 and P11): `break_glass_enabled`
is false and no `emergency` code exists.
The summary's sections, the read permission each needs, its limits and audit
counts are in §11, "Record summaries".

Patient access-request decisions are session-bound patient commands:
`GET /api/v1/identity/me/access-requests`,
`POST /api/v1/identity/access-requests/:requestId/approve` and
`POST /api/v1/identity/access-requests/:requestId/deny` (`{ "reason" }`) require
a patient session and no facility context. `POST
/api/v1/identity/me/consent-grants/:grantId/revoke` (`{ "reason" }`) revokes a
grant the patient authorized (patient-approved or PIN-derived); break-glass and
workforce grants return `409`. Access-history items include `breakGlass` and
`patientRevocable`. `GET /api/v1/identity/me/notifications` and
`POST /api/v1/identity/me/notifications/:id/read` serve the patient inbox.

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
and `closed`, and matches the request status or the effective status. Until the role bootstrap of this
fix, the Identity runtime could not execute `identity.list_my_staff_access_requests`,
and every caller got `403 CONSENT_COMMAND_DENIED`.

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

Recovery completion atomically consumes the account/token-bound OTP credential,
sets an Argon2 password and revokes sessions. Disabled, stale, expired and replayed
credentials fail closed. Completion returns to login rather than opening a session.

Recovery start (`POST /api/v1/auth/otp/start`, every purpose) answers every
identifier alike: `202 { accepted, challengeId, deliveryChannels: ['email', 'sms'],
expiresInSeconds, resendAfterSeconds }`, before any code is delivered. Within
`resendAfterSeconds` a repeat for the same purpose and identifier (email or HID,
any case) answers the same `challengeId` whether or not an account exists, and
sends nothing. A start for the account's other identifier in that window, or for
an account whose code budget is spent, gets a new `challengeId` and no code, as
an unknown identifier does. Clients keep the `challengeId` of their latest start.
Verification (`POST /api/v1/auth/otp/verify`) counts wrong codes against one
budget per account across its challenges and purposes: by default the fifth wrong
code within 15 minutes (`OTP_VERIFY_FAILURE_MAX`,
`OTP_VERIFY_FAILURE_WINDOW_SECONDS`) refuses every code of that account, a correct
one too, for 15 minutes. Every refusal is `403 OTP_INVALID_OR_EXPIRED`; start
limits are `429 OTP_RATE_LIMITED`, unchanged.

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
issuer/JWKS-validated, audience-bound, unexpired ES256 JWT with an exact
configured caller subject, `exp` and `iat` (at most 300 seconds old and not
issued in the future, 5 seconds of clock tolerance) and `token_use: workload`;
any other token is refused `401` (ADR-047). Local per-caller secrets are
development-only.

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
decision. A skip is recorded as the reported method in
`request.delegatedBrowserMethod`. On `POST /api/v1/identity/outreach/authorize`
the handler still requires the `outreach-api` workload (`authenticateOutreach`,
so another approved caller is refused `401`), and after a skip it authorizes
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
EHR's `GET /api/v1/ehr/me/records` is). A missing or malformed header is
`400 FACILITY_REQUIRED`. A facility where the actor has no active membership,
such as a stale tab after the membership ended, is
`403 FACILITY_ACCESS_DENIED`. Before binding, EHR also applies the runtime
controls (`503 PLATFORM_MAINTENANCE`, `423 PLATFORM_PORTAL_DISABLED`, and
`503 PLATFORM_CONTROL_UNAVAILABLE` when the control cannot be read, a database
fault included) and refuses a patient on a workforce route
(`403 PATIENT_SCOPE_DENIED`). A permission missing from the bound membership is
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
the request fails closed with `503 DEPENDENCY_UNAVAILABLE`. Before
D-Eminence/hid-system#46, every refusal of a staff actor before a facility was
bound answered that `503` and was not audited, `PLATFORM_CONTROL_UNAVAILABLE`
included: its row carried the default membership but no facility, and a staff
row without a facility is accepted only as an `auth.*` event on
`authentication` or `session` (migration 0067). A database fault in EHR's
runtime-control check answered a patient `401 AUTHENTICATION_REQUIRED`.

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
purpose is its own authorization.

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

Lab, Pharmacy, OCR and Outreach are off at launch (decision D17); EHR
prescriptions and lab requests are records only. Migration 0084 withdrew
`ehr.lab-request.write`, `lab.work-item.accept`, `lab.accession.create`,
`pharmacy.work-item.accept` and `pharmacy.dispensing.create` from every role,
so these routes answer `403 PERMISSION_DENIED` before any write or call to Lab
or Pharmacy:

- `POST` and `PATCH .../lab-requests` and `POST .../lab-requests/:requestId/lab-work-item`;
- `POST .../prescriptions/:prescriptionId/pharmacy-work-item`;
- Lab's EHR-order acceptance and accession creation, and Pharmacy's
  acceptance and dispensing.

The read permissions stay, so existing lab requests, prescriptions and Lab and
Pharmacy records remain readable. Prescriptions are still created and changed
in the EHR. An existing lab request changes status only through its
encounter: cancelling the encounter cancels its open lab requests, and marking
it entered in error marks them entered in error ("Encounter status and its
records"). An open lab request of a completed encounter that is not
retracted, or of an encounter that was already cancelled or entered in error,
stays as it is. Re-enabling a module takes its own decision, its fixes, a
staging acceptance run and a reviewed migration granting the permissions
again; the sections on the Lab and Pharmacy handoffs below describe the routes
as they work then.

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
its diagnoses' `verificationStatus` `entered_in_error`, and its draft, active
and on-hold prescriptions and lab requests `entered_in_error`. Cancelling an
encounter cancels its draft, active and on-hold prescriptions and lab
requests, and leaves its notes and diagnoses. Completed orders and vitals keep
their state. Each changed record gets a version carrying the request's
`changeReason`, and the encounter's audit event (`ehr.encounter.update`)
records `cascade`: the new status and the ids changed in each category
(`clinicalNoteIds`, `diagnosisIds`, `prescriptionIds`, `labRequestIds`). The
response is the encounter, as before; list the records to see the change.
Lab and Pharmacy are not told (they are off at launch; Pharmacy refuses to
dispense a prescription that is no longer active, 0080).

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
refuses any other update of them (D8). The database enforces each of these
rules too, so a writer that bypasses the API gets the same refusal
(`DATABASE.md`, "EHR clinical safety and launch module set (0084)").

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
`vitals`, `diagnoses`, `prescriptions`, `labRequests` and `documents`.

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

**Patient summary.** Only encounters and notes are released to the patient:
`released` is `["encounters","notes"]` and `withheld` is
`["vitals","diagnoses","prescriptions","labRequests","documents"]`. A note is
released only once its encounter is completed (decision D7, since 0084): the
notes of an encounter in progress, on hold, cancelled or entered in error are
not returned, whatever the note's own status, and row-level security refuses
them to the patient's session as well. Which other
categories are released, and on which conditions, is an open product decision;
this is the current default. The audit event `ehr.patient.self.records.read`
records `encounterCount`, `noteCount` and `withheldCategories`.

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
- `vitals` are returned as first recorded (the vital row's eight measurement
  columns, which no API route changes and, since 0084, the database refuses
  to change), with the same fields as before; a
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
  `200`.
- A caller that fails the route checks, uploader or not, gets their answer
  first, as on every route: `400 FACILITY_REQUIRED` without a valid
  `X-Facility-ID`, `403 FACILITY_ACCESS_DENIED` when not active at that
  facility, `403 PERMISSION_DENIED` without `ehr.document.write`.
- `GET /api/v1/ehr/documents` still lists an `initiated` document to every
  holder of a read grant, so a member can see an upload they cannot complete.
- The uploader's answers are unchanged: `200` with the document view, `403`
  without a write grant, `409` when the stored object does not match or the
  document is no longer completable. A repeat after completion answers `200`
  with the current view while the status is `uploaded`, and `409` once the
  scan is clean or rejected (status `available` or `rejected`).
- A refusal is recorded only by the request audit
  (`api.ehr.document.upload-complete.request`, outcome `failure`, without the
  document id); no `ehr.document.upload.complete` event is written.

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
GET /api/v1/admin/principals?query=&page=&pageSize=&status=
GET /api/v1/admin/identity/reviews?page=&pageSize=&status=
GET /api/v1/admin/audit/events?limit=&beforeSequenceId=&actor=&facilityId=&action=&correlationId=&outcome=&from=&to=
GET /api/v1/admin/operations/services
GET /api/v1/admin/operations/events
```

Principal search requires at least two characters. Facility, principal, and
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
