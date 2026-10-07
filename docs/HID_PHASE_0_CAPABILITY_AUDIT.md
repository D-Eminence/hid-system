# HID Phase 0 Capability Audit

## Scope

This is the Phase 0 baseline for the authoritative backend branch `capability-gap-closure-clean`.

Principle: business-capability parity, not endpoint-for-endpoint parity with legacy systems.

## Repository reality

The authoritative implementation is a service-oriented monorepo with separate identity, EHR, lab, pharmacy, OCR, notification, event-dispatch and outreach services. The repository also contains admin, EHR, lab, pharmacy, OCR and outreach applications.

Key service boundaries confirmed:
- `services/identity-api`
- `services/ehr-api`
- `services/lab-api`
- `services/pharmacy-api`
- `services/ocr-api`
- `services/ocr-worker`
- `services/notification-api`
- `services/notification-worker`
- `services/event-dispatcher`
- `services/outreach-api`

## Capability matrix

| Capability | Backend status | Evidence / boundary | Phase |
|---|---|---|---|
| Patient identity/authentication | Existing | identity-api, auth/session, patient enrollment migrations | 1 |
| Google authentication | Existing | identity-api auth and Google onboarding routes | 1 |
| QoreID NIN | Existing | NIN provider/evidence and enrollment migrations | 1 |
| QoreID CAC | Existing | CAC binding/evidence migrations and identity flows | 2 |
| Provider/facility identity | Existing | organization onboarding and CAC identity binding | 2 |
| Staff/facility membership | Existing | facility/membership and platform authorization | 2 |
| Patient profile/HID | Existing | identity service and patient profile contracts | 1 |
| EHR encounters/notes/vitals/diagnoses/prescriptions | Existing | ehr-api clinical modules and migrations | 1/2 |
| Clinical documents | Existing | document scan/object binding and file contracts | 1/2 |
| Consent/access/grants/revocation | Existing | consent/access migrations and services | 1/2 |
| Patient access PIN | Existing | access-pin migration and identity contract | 1 |
| Break-glass | Existing | break-glass authorization and emergency controls | 2/3 |
| Audit/security audit | Existing | audit services, interceptors and platform audit controls | 1/2 |
| Laboratory | Existing | lab-api plus lab migrations 0017-0022 | 1/2 |
| Pharmacy | Existing | pharmacy-api plus pharmacy foundation migration | 1/2 |
| OCR/Migrate | Existing | ocr-api/worker and migration reconciliation tooling | later integration |
| Notifications/events | Existing | notification-api/worker and event-dispatcher | 1/3 |
| Outreach | Existing | outreach-api and campaign migrations | existing, integrate when needed |
| Product/pricing catalog | Existing | identity admin pricing service and migration 0043 | 4/6 |
| Platform roles/session/admin controls | Existing | identity admin, platform migrations and admin app | 4 |
| Platform Admin creation lifecycle | Partial / gap | bootstrap tooling exists; complete self-service lifecycle must be verified/implemented | 4 |
| Administrative directory enrichment | Gap | no complete rich aggregation contract identified | 4 |
| Administrative exports | Gap | no complete audited export workflow identified | 4 |
| Platform analytics | Partial | telemetry exists; complete product/security/growth analytics dashboards are not complete | 5 |
| AI administration | Partial / gap | AI-related admin UI/docs exist; provider/model/routing/budget governance is not a complete backend workflow | 5 |
| Patient account deletion | Gap / incomplete | patient self-service foundation exists, but complete verified permanent deletion lifecycle is not complete | 3 |
| Emergency-contact break-glass notification | Partial | emergency notification migration and notification infrastructure exist; complete contact notification lifecycle must be verified | 3 |
| Subscription billing | Gap | authoritative pricing/catalog exists; subscription/invoice/payment lifecycle is not complete | 6 |
| Appointments | Gap | no complete appointment domain identified | 7 |
| Triage | Gap | no complete triage domain identified | 7 |
| Inpatient/admission | Gap | no complete admission domain identified | 7 |
| Wards/beds | Gap | no complete ward/bed domain identified | 7 |
| Emergency Department workflow | Gap | break-glass/emergency access exists, but ED operational workflow is not a complete domain | 7 |
| Referrals | Gap | no complete referral domain identified | 7 |
| Maternity | Gap | no complete maternity domain identified | 8 |
| Surgery/theatre | Gap | no complete theatre domain identified | 8 |
| Radiology/imaging | Gap | no complete imaging domain identified | 8 |
| Telemedicine | Gap | no complete telemedicine domain identified | 8 |
| Hospital billing/invoicing/payments | Gap | pricing/catalog is not clinical billing | 9 |
| HMO/insurance/claims | Gap | no complete insurance claims domain identified | 9 |
| Inventory/procurement | Gap | no complete hospital operations domain identified | 9 |
| Ambulance/transport | Gap | no complete domain identified | 9 |
| Blood bank | Gap | no complete domain identified | 9 |
| HR/staff scheduling/rosters | Gap | no complete hospital operations domain identified | 9 |
| Quality/safety | Gap | audit/security controls are not a complete quality/safety domain | 9 |

## Do-not-recreate list

Do not recreate legacy Supabase functions or monolithic endpoints for:
- identity
- authentication
- consent/access
- clinical records
- laboratory
- pharmacy
- files/documents
- notifications
- audit
- provider/facility authorization

The authoritative implementation already has stronger service boundaries for these capabilities.

## Phase 0 conclusion

The supplied plan is directionally correct. The major work is integration for the existing identity/EHR/lab/pharmacy/access stack, followed by the genuinely missing lifecycle, analytics, AI governance, billing and hospital-domain workflows.

This document is an audit baseline only. It does not authorize production deployment, database changes against staging/production, or merging.
