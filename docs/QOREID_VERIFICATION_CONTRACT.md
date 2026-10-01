# QoreID verification contract

**PR #5 state:** implemented with deterministic, sanitized fixtures; provider calls remain disabled by default. The project owner has empirically verified the body-free NIN-only call with an entitled QoreID sandbox account and observed HTTP 200. This PR's automated tests use fixtures; no production verification, deployment, or live database migration has been performed. No sandbox credential or identity data is stored in the repository.

QoreID supplies external identity evidence. HID owns the account, contact verification, password, patient identity, Health ID, organization approval, and administrator setup.

## Public patient enrollment

`Get your Health ID` opens `/patient/enroll`. The browser submits only an 11 digit NIN and a Turnstile token to `POST /api/v1/identity/patient-enrollments`; it cannot submit names, birth date, gender, address, or a QoreID phone value. Identity validates exactly 11 numeric digits and sends only the NIN through a separate NIN-only adapter operation. QoreID performs the identity/details matching. HID accepts the authoritative identity result only when `summary.nin_check` is the string `verified`, `status.state` is `complete`, `status.status` is `verified`, and `nin.nin` equals the submitted NIN. It validates and normalizes the returned identity fields rather than accepting applicant-supplied demographics. A failed, mismatched, incomplete, or malformed response stops enrollment. The entitled sandbox response also confirmed a numeric top-level `id` as the provider transaction/reference identifier. HID requires that field, stores its safe normalized reference, and fails closed if it is absent or malformed; the actual sandbox value is not recorded here.

**Entitled sandbox verification:** The project owner sent `POST https://api.qoreid.com/v1/ng/identities/nin/{11-digit-NIN}` with a sandbox bearer token and **no request body**. QoreID returned HTTP 200 with the success fields, exact returned NIN, and numeric top-level `id` above. The observed response also contained `nin.firstname`, `nin.lastname`, `nin.middlename`, `nin.phone`, `nin.gender`, `nin.photo`, `nin.birthdate`, and `residence.address1`, `residence.town`, `residence.lga`, and `residence.state`. This establishes the body-free transport and response shape for the entitled sandbox account. [QoreID's published NIN-with-NIN documentation](https://docs.qoreid.com/docs/nin-with-nin) shows the same path with first and last names in a request body; the sandbox result establishes that this entitled NIN-only variant accepts a body-free call. HID must not invent name inputs to fill the published request. Successful QoreID details matching is the authoritative identity verification for enrollment; the response has no separate holder-possession or consent-proof field, and HID does not require one. The later HID OTP proves control of the selected account contact only. `QOREID_NIN_ONLY_ENROLLMENT_ENABLED=false` remains the default, including when general `QOREID_ENABLED=true`, until the remaining release and security gates are cleared.

The adapter normalizes the observed registry fields as `nin.nin` → `nin`, `nin.firstname` → `firstName`, `nin.lastname` → `lastName`, `nin.middlename` → `middleName`, `nin.birthdate` → `dateOfBirth`, `nin.gender` → `gender`, `nin.phone` → `phoneNumber`, and `nin.photo` → `photo`. It retains the `residence.address1`, `residence.town`, `residence.lga`, and `residence.state` components in `residence` and uses `residence.address1` as the flat `address` compatibility field. Optional returned fields must be valid when present. These registry values are server-only and are encrypted in the pending enrollment profile; the QoreID phone does **not** select or verify an HID account contact. The patient independently chooses one phone or email for HID's OTP.

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
| `QOREID_NIN_ONLY_ENROLLMENT_ENABLED` | Separate patient NIN-only gate; keep disabled until remaining release and security gates are cleared. Entitled sandbox transport and response shape are empirically verified. |
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

The browser needs the public `VITE_TURNSTILE_SITE_KEY`; it never receives QoreID credentials or the Turnstile secret. For QoreID-enabled staging, the Identity task receives both the NIN lookup HMAC key and NIN encryption key from the existing Identity sensitive secret. The NIN-only gate remains off pending the remaining release and security gates, despite the successful entitled sandbox check. No raw provider payload, NIN, CAC number, address, photo, OAuth token, or OTP is placed in audit details or browser responses. Existing provider connection tests only check OAuth; they do not prove NIN-only or CAC entitlement.

Automated tests use sanitized fixture responses and a disposable PostgreSQL database. The project owner's entitled sandbox call verified the NIN-only request and response. CAC identifier mapping, the CAC Basic V2 entitlement, remaining release and security gates, and a separately reviewed staging rollout remain open. The production rollout requires its own approval.
