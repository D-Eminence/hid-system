# QoreID verification contract

**Status: implemented in the Identity API; disabled by default.** No QoreID
credential, provider request, AWS deployment, staging activation, or production
activation is performed by this change.

QoreID is an external evidence provider, not a HID identity authority. The
integration is deliberately separate from the legacy governed NIN-registration
flow (`NIN_PROVIDER_MODE`), which remains deferred in staging and must not use
this adapter.

## HID routes and authority

| HID route | Actor and authority | Input | Existing record selected by HID | Effect |
| --- | --- | --- | --- | --- |
| `POST /api/v1/identity/me/verification/nin` | Current patient session only | `{ "nin": "<11-digit-NIN>" }` | The patient bound to the verified session | Records verification evidence only. It never creates, merges, links, enrolls, or relinks a patient. |
| `POST /api/v1/identity/organizations/verification/cac/hospital` | Workforce actor with `organization.manage` at the active facility | `{ "regNumber": "RC1234" }` | The active facility's existing organization | Records CAC evidence only. `hospital` covers hospital/EHR use. |
| `POST /api/v1/identity/organizations/verification/cac/laboratory` | Same | `{ "regNumber": "BN1234" }` | Same | Records CAC evidence only. |
| `POST /api/v1/identity/organizations/verification/cac/pharmacy` | Same | `{ "regNumber": "IT1234" }` | Same | Records CAC evidence only. |

The patient route accepts exactly 11 digits after whitespace/hyphen removal.
The CAC route accepts normalized `RC`, `BN`, or `IT` registration numbers. The
global request validator rejects unexpected fields; no caller can select a
patient ID, organization ID, or facility by request body.

Patient verification requires no workforce facility header. Organization
verification requires the ordinary active-facility security boundary and a
`healthcare-operations` purpose; the database command independently rechecks
the exact active membership, permission, facility, and organization.

## Server-only QoreID adapter

`QoreIdVerificationAdapter` is the single server-side component that knows the
provider URLs and payloads. Browsers receive only HID-normalized results and
never receive OAuth credentials or access tokens.

| Step | Exact request contract |
| --- | --- |
| OAuth token | `POST https://api.qoreid.com/token`, JSON body `{ "clientId": "…", "secret": "…" }`; the documented response fields are `accessToken`, `expiresIn` (for example `"7200 secs"`), and `tokenType` (`"Bearer"`). |
| NIN | `POST https://api.qoreid.com/v1/ng/identities/nin/{idNumber}` with the 11-digit NIN in the path, an OAuth Bearer token, and JSON `firstname`, `lastname`, and `dob` taken from the session-bound HID patient profile. QoreID documents first and last name as required and DOB as optional; HID requires DOB to bind the result to its existing patient. |
| CAC Basic V2 | `POST https://api.qoreid.com/v2/ng/identities/cac-basic`, JSON body exactly `{ "regNumber": "RC1234" }`, with the OAuth Bearer token. |

The NIN response sample contains `summary.nin_check.status`, per-field match
flags, and a `nin` object with NIN, names, date of birth, phone, gender, photo,
and address. QoreID's documented match states include `EXACT_MATCH`,
`PARTIAL_MATCH`, `TRANSPOSED_MATCH`, and `NO_MATCH`; a transaction with
`status.status = "verified"` can still report a partial name match. HID therefore
accepts NIN verification only when the transaction is complete and verified,
the summary reports `EXACT_MATCH` with both name flags true and no explicit DOB mismatch, returned NIN,
names, and birth date match the submitted NIN and canonical patient profile,
and the submitted NIN's keyed lookup HMAC matches that session-bound patient's
prior verified, unrevoked NIN identifier. A demographic match alone cannot
attach verified evidence to another patient. The exact NIN binding is checked
before the provider call and again by the evidence database command.
The provider birth date sample uses `DD-MM-YYYY`; HID converts and validates it
as a real ISO date. A missing or malformed authoritative field fails closed.

CAC Basic V2 documents `summary.cac_check` and a `cac` object containing
`rcNumber`, `companyName`, and registry `status`. The adapter retains only those
bounded binding fields in server memory alongside the normalized state and an
optional safe numeric transaction ID. A verified transaction ID identifies the
verification request, not a person or legal entity. The adapter never logs,
returns to the browser, or persists a raw QoreID payload. A completed
non-verified result becomes `not_verified`; any other syntactically valid state
becomes `incomplete`.

QoreID's published CAC sample sends an `RC`-prefixed number but shows bare
digits in `cac.rcNumber`. HID cannot assume the prefix semantics for RC, BN,
and IT from this sample. Organization onboarding requires an exact binding to
the submitted registration number and an active registry status; an ambiguous
bare-number result stays unverified until the provider confirms a safe
normalization rule for all supported registration types.
CAC registry identity also does not establish that the person who supplied an
administrator email can act for the company. A platform reviewer must confirm
that authority through an approved separate process before approving a new
organization. Existing-organization reuse requires an active administrator
account at the exact facility and matching verified legal name.

Malformed payloads, OAuth failure, network failure, timeout, and unavailable
provider responses become static HID Problem Details codes. Provider response
bodies, token values, identifiers, and diagnostic strings are never exposed.
Automatic retries are deliberately disabled because the provider POST contract
does not publish an idempotency mechanism.

Migration `0049_qoreid_request_quotas.sql` limits new NIN and CAC attempts
across Identity API instances before they reach QoreID. Patient requests are
limited by account; existing organization and application checks are limited
by both administrator account and target. An exhausted quota returns 429
without a provider call or a misleading verification result. Connection tests
also have an account quota and a reserved idempotency key. Expired counters
are pruned after 48 hours and contain no submitted identifier or payload.

When QoreID is enabled in staging, the Identity task also receives the
existing `ninLookupHmacKeyB64` field from `IdentitySensitiveSecretArn`. It
does not receive the NIN encryption key in that profile. A missing lookup key
makes existing-patient NIN evidence unavailable; it does not relax the binding
rule or affect CAC verification. Migration `0050` removes the old
five-argument evidence command that could record an unbound result.

These existing-patient and organization-evidence routes do not provide public
patient self signup. The published NIN response can supply registry demographics
but does not, by itself, prove that the browser user controls the NIN identity.
The current HID account setup uses an email chosen by the applicant, so public
Health ID issuance remains deferred until an approved possession or consent
signal, an authoritative stable NIN binding for duplicate protection, and the
corresponding server-side enrollment flow are implemented and tested. QoreID
documents a user-generated vNIN token, but its sample does not establish a
stable raw NIN or other HID-approved duplicate key in the response; entitlement
and binding semantics need provider confirmation. Status-only verification must
never create a patient or Health ID.

## Minimal evidence and audit

Migration `0034_qoreid_verification_evidence.sql` adds the append-only
`identity.verification_evidence` table and two narrowly scoped
security-definer commands. They record only:

- subject type and the already-existing patient or organization reference;
- verification type (`nin` or `cac`), provider (`qoreid`), normalized result,
  timestamp, correlation ID, source system, and optional provider transaction
  reference;
- active actor/membership/facility attribution for organization checks; and
- a bounded failure category when applicable.

Each command appends the semantic audit event in the same transaction. Neither
the table nor audit detail contains a raw NIN, CAC number, raw provider payload,
address, date of birth, photograph, OAuth credential, or access token.

## Configuration and AWS secret boundary

Identity API configuration is server-only:

```text
QOREID_ENABLED=false
QOREID_BASE_URL=https://api.qoreid.com
QOREID_TIMEOUT_MS=5000
QOREID_MAX_RETRIES=0
QOREID_CLIENT_ID=<injected only when enabled>
QOREID_CLIENT_SECRET=<injected only when enabled>
```

When `QOREID_ENABLED=false`, no request is made and the request fails closed
with `QOREID_DISABLED` after recording only disabled evidence. When enabled,
startup requires both credential fields and the approved `https://api.qoreid.com`
origin.

The CDK default leaves the feature disabled and emits no QoreID credential
reference. An explicitly reviewed synth with `HID_QOREID_ENABLED=true` adds the
`QoreIdCredentialsSecretArn` parameter and injects only the `clientId` and
`secret` fields from that AWS Secrets Manager JSON secret into the Identity API
task. No browser task, EHR, Lab, Pharmacy, OCR, worker, or migration task gets
those fields. Do not place credentials in source, `.env.example`, `VITE_*`,
`NEXT_PUBLIC_*`, client bundles, logs, issue trackers, or shell history.

## Staging and production activation checklist

1. Obtain an approved QoreID account, NIN and CAC Basic V2 entitlements, test contract, and the
   provider's current consent/privacy review; do not treat this document as
   authorization to make a provider request.
2. Create a distinct environment-scoped AWS Secrets Manager JSON secret with
   `clientId` and `secret`; grant only the Identity task execution role read
   access through the ECS secret reference. For enabled staging patient NIN
   evidence, provision `ninLookupHmacKeyB64` in the separate Identity sensitive
   secret using the same key material as governed NIN identifiers. A new key
   cannot match existing bindings.
3. Keep `NIN_PROVIDER_MODE=deferred` in staging. This QoreID self-verification
   route is independent of legacy registration and does not require the NIN
   encryption key, but existing-patient evidence requires the lookup HMAC key.
4. Explicitly set `HID_QOREID_ENABLED=true` for the approved staging synth,
   supply `QoreIdCredentialsSecretArn`, and deploy only through the normal
   reviewed release procedure.
5. Run synthetic NIN and CAC success/non-match/incomplete/timeout/401/5xx
   checks; verify no sensitive request/response data reaches logs, audit
   details, metrics, or browser traffic.
6. Obtain a separate production approval, privacy/security review, incident
   handling plan, and rollout/rollback decision before enabling any production
   task. This implementation did not make that decision or perform that
   deployment.

Official provider references: [Get client token](https://docs.qoreid.com/reference/get-client-token),
[NIN (With NIN)](https://docs.qoreid.com/docs/nin-with-nin),
[Virtual NIN](https://docs.qoreid.com/docs/vnin),
[verification result semantics](https://docs.qoreid.com/docs/webhook-payload-structure),
and [CAC (Basic) V2](https://docs.qoreid.com/docs/copy-of-cac-basic).
