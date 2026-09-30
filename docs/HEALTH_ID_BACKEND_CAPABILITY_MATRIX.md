# Health ID frontend to HID backend capability matrix

Reference: `D-Eminence/Health-id` public web and product routes (inspected at `8903e68`), `D-Eminence/hid-1.0` for historical behavior, and this repository as the authoritative implementation. This matrix records backend readiness; it does not make the frontend integration part of PR #5.

| Future Health-id journey | Authoritative hid-system capability | State after this PR |
| --- | --- | --- |
| Patient signin, session, `/identity/me`, profile and self-service | Identity API patient authentication, secure cookie/bearer session, patient-scoped records and QoreID evidence | Existing; guarded by patient context and session checks. |
| Get your Health ID / patient signup with NIN | Governed NIN registration cases, duplicate checks, HID generation, enrollment, OTP credential setup | **Partial:** staff-led registration exists. Public self signup cannot safely issue a HID while the registration NIN provider is deferred and QoreID's path-only result does not bind supplied demographics to an individual. Do not convert a status-only check into identity issuance. |
| EHR, Migrate, Laboratory, Pharmacy signup | One public organization application intake, restricted CAC review, canonical organization/facility, product enrollment, first admin | Added by migration `0046` and Identity API. No duplicate product-specific account stores. |
| Existing organization adds a product | CAC binding and explicit reuse review | Added; requires an existing active facility administrator with the submitted email. |
| Outreach campaigns, workspace members, status and field registration | Outreach API, canonical staff memberships, facility authorization, registration cases and events | Existing campaigns and field cases extended with optional campaign association and exact membership checks in `0045`. Existing facility-only cases remain valid. |
| EHR, Migrate, Laboratory, Pharmacy clinical workflows | Existing EHR, OCR/Migrate, Laboratory and Pharmacy services | Existing; no duplicate backend introduced here. |
| Public Book Demo and product-specific interest, including API | Identity API commercial demo intake and protected admin processing | Added by `0044`; API is an interest code, not self-service API credentials. |
| Public prices and protected admin editing | Single platform commercial catalog, product/context prices, immutable change events, optimistic versions and idempotency | Added by `0043`. Initially contact-sales with no invented monetary amounts. Changes become effective immediately; scheduled future pricing is not represented. |
| Admin signin and administration | Existing protected admin session and platform role model | Existing; there is no public admin signup. New demo, pricing and organization review routes require explicit platform permissions. |
| Health-id page structure, product copy, visuals and frontend calls | Frontend repository | Later integration. Hardcoded public frontend prices must be replaced with the backend catalog when that integration is undertaken. |

The main external dependency for patient self signup is an approved NIN assurance contract that returns authenticated demographics or another verified binding signal, plus the approved staging configuration. `docs/QOREID_VERIFICATION_CONTRACT.md` explicitly limits current QoreID NIN verification to evidence on an existing patient. The backend must preserve that limit. The AWS CDK dependency audit remains a separate release gate while the official package still bundles vulnerable `brace-expansion`.
