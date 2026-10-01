# QoreID verification contract

**PR #5 state:** implemented with deterministic fixtures; provider calls remain disabled by default. QoreID credentials and staging/production entitlements are absent. No live QoreID verification, deployment, or database migration has been performed.

QoreID supplies external identity evidence. HID owns the account, contact verification, password, patient identity, Health ID, organization approval, and administrator setup.

## Public patient enrollment

`Get your Health ID` opens `/patient/enroll`. The browser submits only an 11 digit NIN and a Turnstile token to `POST /api/v1/identity/patient-enrollments`; it cannot submit names, birth date, gender, address, or a QoreID phone value. Identity validates exactly 11 numeric digits and sends only the NIN through a separate NIN-only adapter operation. The project owner reports direct QoreID confirmation that QoreID performs the identity/details matching and returns first name, last name, date of birth, gender, phone number, NIN, photo, and address. HID treats those returned fields as authoritative; applicant input cannot override them. The adapter accepts the existing response success fields `status.state=complete` and `status.status=verified`, requires the returned NIN to equal the submitted NIN, and requires first name, last name, birth date, and gender. If `summary.nin_check.status` appears, it must be `EXACT_MATCH`; any explicit false field match rejects the result. Phone, address, and photo are retained only when present and valid, since the exact NIN-only response schema has not been provided. The current persistence model requires a safe numeric response `id` as its provider reference; absence fails closed. A failed, mismatched, incomplete, or malformed response stops enrollment.

**The NIN-only input is directly confirmed; its live transport remains untested.** The existing adapter uses `POST /v1/ng/identities/nin/{idNumber}`, putting only the 11-digit NIN in the path and sending no request body. [QoreID's published NIN-with-NIN documentation](https://docs.qoreid.com/docs/nin-with-nin) shows that same path but requires first and last names in its request body. The public page therefore does not establish that the directly confirmed NIN-only variant accepts this body-free call. A separate written NIN-only endpoint/response specification and environment entitlement details are not present in this PR. HID must not invent names to fill the published request. Successful QoreID details matching is the authoritative identity verification for enrollment; there is no separate holder-proof step. The HID OTP later proves control of the selected account contact only. `QOREID_NIN_ONLY_ENROLLMENT_ENABLED=false` is a separate default-off gate, including when general `QOREID_ENABLED=true`. Before live activation, validate the adapter request and strict response mapping with authorized staging credentials and the relevant QoreID entitlement.

On success, migration `0051_public_patient_enrollment.sql` stores a single pending enrollment keyed by the same NIN lookup HMAC used by governed NIN bindings. It stores NIN and the normalized returned registry profile encrypted at rest. It does **not** create an account, patient, or HIDCode. Existing active NIN bindings, duplicate pending NINs, concurrent starts, and replayed idempotency keys are rejected or resumed without a second HID.

The user then chooses exactly one HID account contact: phone **or** email. This contact is independent of QoreID's phone evidence. A purpose- and enrollment-bound six digit OTP is sent through the existing Notification API, with expiry, attempt limit, cooldown, rate limits, single use, and an audit trail. Only after that OTP succeeds can the user set a password. A single database transaction then creates the active account, canonical patient, NIN binding, authoritative profile, assurance state, HIDCode, and semantic audit event. The patient can sign in with email or the issued HIDCode; normal sign-in never repeats NIN verification. Recovery sends a code to the verified HID account contact, including SMS for a phone-only account.

The enrollment cookie is HttpOnly, Secure in deployed environments, SameSite Strict, and scoped to the enrollment route. Mutations require an allowed Origin; starting also requires server-side Turnstile validation. The browser stores only a retry UUID across refreshes, never a NIN, provider payload, OTP, or secret. Pending state can be resumed through `GET /current`. Identity's request audit records success/failure without registry fields or codes.

## QoreID access token lifetime

QoreID directly confirmed that its token response's `expiresIn` is the **API access token lifetime**. The currently reported response is numeric `"expiresIn": 7200`: 7,200 seconds, or 120 minutes. HID reads the value from each token response; it must not hardcode 7,200 seconds or change QoreID's returned expiry. HID's internal maximum-use window is 5,400 seconds (90 minutes), capped further if QoreID supplies a shorter lifetime: `effectiveTokenLifetime = min(expiresIn, 5400 seconds)`. The internal window is a cache/refresh policy, not a modification of the provider token.

The server must refresh or re-authenticate before using an internally stale token. A verification request that receives an unexpected QoreID `401` invalidates the cached token, obtains a new one, and retries that eligible request once; a second failure is returned safely without duplicate enrollment. Concurrent requests should share a refresh within the running server instance. Access tokens and credentials remain server-side, never appear in frontend responses, database rows, source control, or logs. Token behavior is verified with synthetic responses; the reported 7,200-second value has not been tested against a live QoreID token in this PR.

## Existing-patient NIN evidence

`POST /api/v1/identity/me/verification/nin` remains a separate governed route for a signed-in patient with an existing verified NIN binding. It uses canonical patient names and birth date for QoreID's documented name-matching request, and records evidence only. It cannot create or relink a patient. Migration `0050` removed the earlier unbound evidence command.

## Organization application and CAC

`POST /api/v1/identity/organization-applications` accepts product, organization type, an `RC`/`BN`/`IT` registration identifier, and administrator contact. It does not accept an applicant-entered legal company name. An admin with the exact review permission and expected row version invokes `POST /api/v1/admin/organization-applications/{id}/verify-cac`. The QoreID CAC Basic V2 adapter sends `{ "regNumber": "RC1234" }` to [the documented endpoint](https://docs.qoreid.com/docs/copy-of-cac-basic).

A verified response must have an attributable transaction, exact submitted registration identifier, company name, entity type, valid registration date, address, and active registry status. These fields become the only legal-entity identity source. Migration `0052_authoritative_cac_identity.sql` persists them and prevents approval of status-only or incomplete historical evidence. Migration `0054_complete_existing_cac_evidence_binding.sql` also requires the existing-organization evidence route to match all six registry fields against the stored binding; incomplete legacy bindings fail closed. A unique registry identifier binding and locked governance command prevent a second organization; replayed approval returns the existing result. QoreID verification alone leaves the application awaiting platform review. Reviewer approval, product enrollment, and first administrator account setup remain separate actions. The administrator's name and email are contact/authentication fields, not registry identity.

The published CAC example shows a prefixed input and an unprefixed `rcNumber` output. HID does not infer that mapping for `RC`, `BN`, or `IT`. Ambiguous returned numbers fail the exact binding until QoreID confirms the normalization rule.

## Availability and secrets

`QOREID_ENABLED=false` and `QOREID_NIN_ONLY_ENROLLMENT_ENABLED=false` are the defaults. QoreID OAuth credentials remain server-only ECS Secrets Manager fields in the Identity task. When QoreID is paused in Admin Settings → Integrations, new NIN enrollment and CAC verification fail closed; existing verified identities and Health IDs remain valid. No unapproved provider substitution occurs.

The Identity API uses these configuration names for QoreID patient enrollment; no credential or key value belongs in this document:

| Name | Purpose |
| --- | --- |
| `QOREID_ENABLED` | General server-side provider gate. |
| `QOREID_NIN_ONLY_ENROLLMENT_ENABLED` | Separate patient NIN-only gate; keep disabled until the confirmed provider behavior is validated with authorized staging credentials. |
| `QOREID_BASE_URL` | Approved QoreID API origin. |
| `QOREID_CLIENT_ID`, `QOREID_CLIENT_SECRET` | Server-only OAuth credentials supplied through the Identity task's secret configuration. |
| `QOREID_TIMEOUT_MS` | Bounded provider request timeout. |
| `QOREID_MAX_RETRIES` | Must remain `0` for general provider retries; the adapter's single re-authentication retry after an explicit verification `401` is separate. |
| `NIN_LOOKUP_HMAC_KEY_B64`, `NIN_ENCRYPTION_KEY_B64` | Server-only keys for duplicate lookup and encrypted NIN/profile storage. |
| `NIN_KEY_VERSION` | Version identifier for encrypted NIN material. |
| `OTP_HMAC_KEY_B64`, `OTP_HMAC_KEY_VERSION` | Server-only OTP verifier key and version; the key is required in production. |
| `OTP_EXPIRY_SECONDS`, `OTP_MAX_ATTEMPTS`, `OTP_RESEND_COOLDOWN_SECONDS`, `OTP_RATE_WINDOW_SECONDS`, `OTP_RATE_MAX_REQUESTS` | Existing bounded contact-code and rate-limit policy. |
| `TURNSTILE_MODE`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITEVERIFY_URL` | Server-side start-request verification; production requires `required` mode and a server-only secret. |
| `NOTIFICATION_API_URL`, `NOTIFICATION_SERVICE_IDENTITY_MODE`, `NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE` | Existing OTP delivery route and production workload authentication. Local mode uses `NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN` instead. |

The browser needs the public `VITE_TURNSTILE_SITE_KEY`; it never receives QoreID credentials or the Turnstile secret. For QoreID-enabled staging, the Identity task receives both the NIN lookup HMAC key and NIN encryption key from the existing Identity sensitive secret. The NIN-only gate remains off until the body-free request and response mapping pass an entitled live staging check. No raw provider payload, NIN, CAC number, address, photo, OAuth token, or OTP is placed in audit details or browser responses. Existing provider connection tests only check OAuth; they do not prove NIN-only or CAC entitlement.

Automated tests use fixture responses and a disposable PostgreSQL database. Live provider tests remain pending valid credentials, approved entitlement, validation of the body-free NIN-only request and response, CAC identifier mapping, and a separately reviewed staging rollout. The production rollout requires its own approval.
