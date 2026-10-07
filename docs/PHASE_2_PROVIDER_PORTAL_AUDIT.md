# Phase 2 Provider Portal Audit

## Scope

Phase 2 is the Provider Portal integration gate. The objective is to make the provider experience consume the authoritative hid-system identity, facility, authorization, consent, clinical, laboratory, pharmacy, document, audit and emergency infrastructure.

This audit separates existing capabilities from genuine missing capabilities. It does not port legacy endpoints and does not weaken facility or patient isolation.

## Existing authoritative backend capabilities

| Capability | Status | Evidence / contract |
| --- | --- | --- |
| Provider/staff identity | Existing | Staff sessions expose actor identity, roles, permissions and facilities |
| Facility context | Existing | Facility-scoped request context and facility headers |
| RBAC | Existing | Permission guards such as identity.patient.read, identity.consent.write, ehr.* and pharmacy.* |
| Patient lookup | Existing | POST /api/v1/identity/patient-lookup |
| Consent/access request | Existing | Access request and consent grant services |
| Patient PIN access | Existing | Standard access PIN verification |
| Break-glass | Existing | Emergency grant plus emergency purpose and audited access |
| EHR encounters | Existing | Facility-scoped encounter routes |
| Clinical notes | Existing | Notes, revisions, signing/status lifecycle |
| Vitals | Existing | Facility and patient constrained records |
| Diagnoses | Existing | Facility and patient constrained records |
| Prescriptions | Existing | Prescription lifecycle and Pharmacy handoff |
| Laboratory | Existing | Work items, accession, specimens, execution, results, verification, release and history |
| Pharmacy | Existing | Work items, dispensing and reversal |
| Documents | Existing | Upload intent, completion, scan-gated download |
| Audit | Existing | Facility-scoped audit events with actor, action, outcome and correlation |
| Authorization recheck | Existing | Provider actions revalidate server-side authorization before sensitive reads/writes |
| Idempotency | Existing | Mutation paths use idempotency keys where required |

## Genuine Phase 2 gaps

1. Provider self-service CAC enrollment is already implemented separately in draft PR #10 on branch `provider-cac-self-enrollment`.
2. Health ID frontend wiring for that enrollment is already implemented separately in draft PR #4 on branch `provider-cac-self-enrollment`.
3. Those two onboarding PRs were based on the earlier provider-enrollment baseline, not this Phase 1 branch. They must be reconciled and reviewed before merge. Do not duplicate their logic here.
4. The remaining Phase 2 work is therefore integration verification and reconciliation, not rebuilding the provider clinical stack.

## Required Phase 2 acceptance gates

- Provider account can establish an authenticated staff session.
- Active facility is explicit and all provider requests are facility scoped.
- Patient lookup never exposes patient data before authorization.
- Request, PIN and emergency paths produce the correct authorization state.
- Clinical reads and writes revalidate access server-side.
- Emergency access is read-only for the supported emergency summary.
- Laboratory and pharmacy operations remain facility and permission scoped.
- Documents remain scan-gated.
- Audit records include actor, facility, purpose, action, outcome and correlation.
- No legacy or Supabase provider API is introduced.

## Ownership

- Backend: HID system team
- Frontend: Health ID frontend team
- Provider onboarding: Identity/backend owner plus frontend owner
- Security acceptance: HID security/admin owner
- Merge/deploy: repository owner only after review

## Decision

Phase 2 backend is predominantly **EXISTING**. The provider self-service onboarding path is **IMPLEMENTED SEPARATELY** and requires reconciliation, not duplication.

No deployment, merge, DNS or live database change is part of this audit.
