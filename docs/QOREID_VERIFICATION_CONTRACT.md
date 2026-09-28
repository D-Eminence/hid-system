# QoreID verification — deferred external integration

**Status: DEFERRED / DISABLED. Not a staging deployment or acceptance gate.
Production remains locked.**

QoreID is HID's selected future verification provider. This document records the
intended scope only; it does not authorize credential onboarding, a provider
request, a deployment, or an assertion that an identity or organization has been
verified.

## Intended mappings

| HID subject | Intended QoreID check | Current state |
| --- | --- | --- |
| Patient | NIN verification | Disabled; HID's generic NIN boundary remains deferred. |
| EHR/Hospital | CAC verification | No CAC product/domain implementation exists. |
| Laboratory | CAC verification | No CAC product/domain implementation exists. |
| Pharmacy | CAC verification | No CAC product/domain implementation exists. |

## Official references, not an HID integration contract

The following official QoreID documentation and endpoints are references for a
future, separately reviewed implementation only. HID has not selected a request
shape, authentication flow, result mapping, callback model, retry policy, or
assurance rule from these pages.

| Check | Official QoreID reference | Documented endpoint reference |
| --- | --- | --- |
| NIN | [NIN (With NIN)](https://docs.qoreid.com/docs/nin-with-nin) | POST https://api.qoreid.com/v1/ng/identities/nin/{idNumber} |
| CAC | [CAC (Basic)](https://docs.qoreid.com/docs/cac-1) | POST https://api.qoreid.com/v1/ng/identities/cac-basic |
| Authentication | [Get client token](https://docs.qoreid.com/reference/get-client-token) | POST https://api.qoreid.com/token |

## Current HID boundary

- Staging keeps NIN_PROVIDER_MODE=deferred. It starts without QoreID credentials
  or NIN cryptographic keys, and it makes no QoreID network request.
- The active NIN dependency-injection boundary is provider-neutral. There is no
  QoreID NIN adapter, secret configuration, or runtime provider mode.
- Existing generic NIN database fields and governed registration behavior are
  unchanged.
- CAC has no HID model, route, storage, verification lifecycle, or provider
  adapter. No CAC implementation is implied by this selection.

## Required before activation

1. Onboard credentials through an approved secret-management design; do not add
   credentials to source, templates, or local environment examples.
2. Verify the exact QoreID authentication and entitlement contract for the
   approved environment.
3. Review the exact authentication response/header handling and a versioned NIN
   request/result contract, including assurance, correlation, error, timeout,
   and privacy requirements, before writing an adapter or result mapping.
4. Design and approve a separate CAC organization domain and lifecycle for EHR,
   hospitals, laboratories, and pharmacies before adding CAC storage, routes, or
   verification behavior.
5. Add bounded adapter, contract, failure, privacy, and authorization tests; then
   obtain a separate activation/deployment decision.

No credential, provider account action, live QoreID request, AWS change, or
production action is required for the current deferred staging posture.
