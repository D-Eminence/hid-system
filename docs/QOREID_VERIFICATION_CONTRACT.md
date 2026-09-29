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
| NIN | `POST https://api.qoreid.com/v1/ng/identities/nin/{idNumber}` with the 11-digit NIN only in the path and an OAuth Bearer token. There is no body and no asserted first name, last name, middle name, DOB, phone, email, or gender. |
| CAC Basic V2 | `POST https://api.qoreid.com/v2/ng/identities/cac-basic`, JSON body exactly `{ "regNumber": "RC1234" }`, with the OAuth Bearer token. |

The adapter parses only the documented transaction status and an optional safe
numeric transaction ID. It never logs, returns, or persists a raw QoreID
payload. HID maps `status.state === "complete" && status.status === "verified"`
to `verified`; a completed non-verified result becomes `not_verified`; any
other syntactically valid state becomes `incomplete`. It does not infer success
from partial provider data.

Malformed payloads, OAuth failure, network failure, timeout, and unavailable
provider responses become static HID Problem Details codes. Provider response
bodies, token values, identifiers, and diagnostic strings are never exposed.
Automatic retries are deliberately disabled because the provider POST contract
does not publish an idempotency mechanism.

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

1. Obtain an approved QoreID account, entitlement, test contract, and the
   provider's current consent/privacy review; do not treat this document as
   authorization to make a provider request.
2. Create a distinct environment-scoped AWS Secrets Manager JSON secret with
   `clientId` and `secret`; grant only the Identity task execution role read
   access through the ECS secret reference.
3. Keep `NIN_PROVIDER_MODE=deferred` in staging. This QoreID self-verification
   route is independent of legacy registration and does not require NIN
   encryption/HMAC keys.
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
[NIN (With NIN)](https://docs.qoreid.com/docs/nin-with-nin), and
[CAC (Basic)](https://docs.qoreid.com/docs/cac-1).
