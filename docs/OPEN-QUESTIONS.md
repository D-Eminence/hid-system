# Health-id integration questions after the backend gap pass

Source: the `Health-id` checkpoint
`aae86664571d2cd84a74902f24fbd669a98c9c59` and its
`docs/OPEN-QUESTIONS.md`, compared with this backend's PR #5 baseline
`c4b5445ed589217bb8b4529d69e268ca56842609`. See the
[backend gap audit](HEALTH_ID_FRONTEND_BACKEND_GAP_AUDIT.md) for evidence and
A/B/C/D classification. This file tracks the backend state; it does not alter
the separate frontend checkout.

## Resolved in the backend code

| Question | Resolution |
| --- | --- |
| Patient consent list, approval and denial fail without a facility | **Resolved.** Patient-only session context and exact patient ownership are used. Migration `0061` repairs approval purpose, adds requester context and patient grant revocation; runtime command grants and negative tests cover the path. |
| Organization application SQL arity | **Resolved before this branch.** Migration `0052` replaced migration `0046`'s six-argument function with the five-argument signature used by the service. This branch adds regression evidence for that final interface and governed review. CAC number/legal-entity reconciliation is unchanged. |
| Facility selection disappears after reload | **Resolved.** Migration `0062` stores the selected facility on a staff session. Session reads and refresh recheck current membership, and every clinical request still verifies its own `X-Facility-ID`. |
| Lab draft cannot hand off when activated | **Resolved.** The EHR draft-to-active PATCH now accepts the exact committed order version in Lab with a stable retry key. |
| Lab queue/result privacy | **Resolved.** Lab list and history paths apply patient authorization before detailed disclosure; non-Lab readers see released revisions only. Detailed Lab reads reject emergency break-glass. A bounded patient-scoped provider released-result route is available. |
| Emergency detailed chart | **Resolved for one completed encounter at a time.** The new dedicated EHR read requires emergency purpose, current break-glass authorization and exact patient/facility/encounter scope. Ordinary chart routes remain direct-care only. |
| Provider registration case continuity | **Resolved.** Identity offers a bounded facility-scoped case list and reports account-enrollment-started state in case results. |
| Identity PATCH/DELETE and Pharmacy CSRF preflight | **Resolved.** Approved-origin CORS responses now include existing mutation methods and headers. Cookie CSRF and Origin checks remain in force. |
| Facility audit route shadowing | **No functional backend defect.** Identity owns public `/api/v1/audit/events`; it reads the shared `audit.events` facility function, including EHR-originated events. EHR's duplicate controller path is not the gateway owner. |

## Remaining for non-production acceptance

| Item | Type | Needed to close |
| --- | --- | --- |
| No staging gateway or seeded test actors | Staging/environment | Provision a non-production route to each service, synthetic patients, staff, facilities and organizations; run browser end-to-end acceptance without production data. |
| Same-origin authenticated API forwarding | Staging/environment | Route each deployed frontend's `/api/v1/*` to the gateway while preserving host-only cookies, Origin, CSRF, facility and purpose headers. |
| Portal hostname and allowed origins | Staging/environment | Choose the portal host and configure Turnstile/CORS allowlists for that host and the local test origins. |
| QoreID/CAC/NIN, Google, OTP and Turnstile configuration | External provider | Set up entitled non-production accounts, safe test identities and secrets. NIN stays behind its existing security/release gate; no real OTP or provider call is part of this code pass. |
| Health-id UI integration with changed contracts | Frontend work | Consume the patient consent context/revocation, persisted session facility, registration case list, restricted emergency encounter and provider released Lab result routes. Update its contract registry and tests at the frontend checkpoint. |

## Still unsupported by a current backend contract

These are **unsupported capabilities**, not regressions in the supported
flows: patient-created shares/invites and account deletion; patient-authored
clinical history and general profile editing; patient self-service Lab result
aggregation; staff notifications; facility invitation, department, branch and
setup-progress flows; provider reports/trends, appointments and the other
hospital reference modules; Migrate bulk/project/intelligence workflows;
public Outreach worker signup and visits; subscriptions, promotions, billing
and payment; and offline lease/sync/conflict workflows. The current platform
administrator contract requires an active staff facility membership. A
facility-free platform administrator and role-specific OTP recovery audiences
need a separate product/security decision before any new contract is added.

`GET /api/v1/identity/me/access-history` is an existing consent-grant timeline.
It does not claim to list every clinical chart read. All sensitive reads remain
audited through their owning service and the shared audit trail.
