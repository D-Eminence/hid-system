# Health-id frontend backend gap audit

This audit compares `Health-id` at `aae86664571d2cd84a74902f24fbd669a98c9c59`
(`docs/HEALTH_ID_COMPLETE_FRONTEND_GAP_MAP.md` and `docs/OPEN-QUESTIONS.md`
in that checkout) with the merged backend baseline
`c4b5445ed589217bb8b4529d69e268ca56842609`. The two source documents
are not present in this repository. References to a simulated Dashboard and
historical `hid-1.0` screens are workflow examples, not current API contracts.

The classifications below use **A** for a backend defect in a supported flow,
**B** for the smallest missing backend capability needed by a supported flow,
**C** for provider or environment work, and **D** for a proposed workflow with
no current HID contract. No category D workflow was implemented here.

| Gap | Existing backend support | Exact deficiency at baseline | Required change and verification | Class |
| --- | --- | --- | --- | --- |
| Patient consent decisions | Identity access requests and patient decisions; consent grants and access history | Patient routes required a staff facility context; SQL approval omitted `purpose_of_use`; runtime role lacked EXECUTE on decision/list functions | Patient session context, forward-only SQL repair and grants; ownership, approval, denial, expiry and audit tests | A |
| Patient consent context and revocation | Staff request has exact patient, membership, facility, scope and reason | Patient request list omitted requester/organization/purpose/expiry; only staff could close a grant | Extend the existing request projection and add patient-owned revocation; test wrong patient and revoked access | B |
| Organization application SQL arguments | Intake, CAC reconciliation, profile completion, review, binding | The report compares migration `0046`'s old six-argument function with the service; migration `0052` already replaced it with the five-argument function used by the service and runtime grant | Keep the accepted interface; regress the final signature and full hospital, laboratory, pharmacy, approval/rejection and binding transactions | No current defect |
| Facility selection | Session exposes authorized facilities; `POST /auth/facility` validates selection | Selected facility was returned once but not persisted or restored | Persist on staff session, revalidate active membership at every session/refresh and retain per-request `X-Facility-ID` checks | A |
| Lab draft handoff | EHR draft/active lab requests and Lab exact-source work items | Updating a draft to active did not hand the order to Lab | Accept the committed exact active version with retry-safe idempotency; test handoff, conflict and replay | A |
| Lab queues and result visibility | Lab RLS, specimen/execution/result APIs, released-result permission | Some lists lacked the same Identity patient check as detail reads; released history could include a later unreleased correction | Reauthorize before disclosure, exclude break-glass from detailed Lab reads, and show released revisions only to non-Lab readers; test denial and audit | A |
| Provider released-result discovery | `lab.result.released.read` and released history by result UUID | A provider could not discover released result IDs by patient | Bounded patient-scoped released-results list under facility and patient read authorization | B |
| Detailed emergency chart | Identity time-bounded audited break-glass and EHR emergency summary | Ordinary chart routes reject emergency purpose; no explicit detailed read contract | Narrow read-only completed-encounter route with fresh exact break-glass authorization, selected-facility scope, final-row filtering and negative tests | B |
| Registration case continuity | Governed case detail/review/enrollment and facility RLS | No facility case list; detail did not state whether account enrollment had started | Bounded facility list with cursor and account state on case results; test authorization and pagination | B |
| Browser preflight | Origin allowlist, cookie/CSRF guards | Identity omitted PATCH/DELETE; Pharmacy omitted `x-csrf-token` | Correct CORS declarations and exercise actual preflight responses | A |
| Facility audit | Identity `GET /audit/events` and EHR's duplicate controller query the shared `audit.events` facility function | Gateway sends the public route to Identity, as designed; the EHR duplicate is unreachable at that path but does not hide EHR audit rows | Keep Identity as public owner; no new route needed | No current defect |

## Remaining dependencies and unsupported contracts

**C — provider/environment:** A disposable local test can validate the code,
but full acceptance still needs a non-production gateway, seeded principals,
allowed frontend origins and portal hostname, Turnstile, Google and OTP
configuration, and entitled QoreID/CAC/NIN provider configuration. NIN flows
remain behind their existing release and security gates. Production publishing
and provider activation are outside this code-only task.

**D — no current contract:** General patient profile editing, patient-created
shares/invitations, account deletion and patient-authored structured history;
staff notification inbox; appointments, triage, inpatient/ICU, maternity,
surgery, radiology, claims/insurance, inventory, referrals, shifts/HR, quality,
telemedicine, ambulance, blood bank, dental and procurement; general provider
reports/trends; facility invitation/branch/department/setup-progress and staff
profile/credential/presence workflows; Lab analyzer/QC and patient self-service
Lab result aggregation; Migrate bulk/project/intelligence operations; public
Outreach worker signup/visits/screenings; subscriptions, trials, promotions,
payments and global AI administration; and offline lease/sync/conflict APIs.
The frontend reference screens do not define authorization, persistence or
clinical semantics for these capabilities. Platform administration currently
requires an active staff facility membership, even for platform permissions;
a facility-free administrator is not a supported principal contract.

Existing patient `GET /identity/me/access-history` is a consent grant timeline.
It does not represent every clinical chart read. The public facility audit route
is permissioned staff access to shared audit events.
