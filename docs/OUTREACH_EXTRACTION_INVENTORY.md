# Outreach extraction inventory

Repository inventory date: 2026-08-10. This records active code first;
`upstream_snapshot` is historical evidence only.

## Product reality before extraction

1. **Users/patients:** active Outreach pages attempted public worker signup and
   campaign joins through missing edge-function names. They did not create a
   patient in the active backend. Historical Supabase code created auth/workforce
   records and is not authoritative.
2. **HID issuance:** no active Outreach code issued an HID.
3. **Identity calls:** login used the shared Identity client. Operational data
   called a nonexistent `outreach-data` function rather than a governed Identity
   registration command.
4. **Direct Identity writes:** none in active code. Historical Supabase policies
   were broad and are not restored.
5. **Offline mode:** the UI displayed offline/sync states, but did not implement
   durable offline behavior.
6. **Offline data:** none was durably stored. In-memory encounter and queue rows
   disappeared on reload.
7. **IndexedDB:** not used by Outreach before this extraction.
8. **PHI in localStorage:** none found in the active Outreach path. `localStorage`
   contained only an opaque authentication-session hint. An opaque OTP handle was
   previously in `sessionStorage`; the public OTP flow is now fail-closed.
9. **Temporary IDs:** historical/reference code had a `provisional_patient_id`,
   but the active UI did not generate a safe durable temporary ID.
10. **Outbox/sync queue:** types and missing-function calls existed. “Sync” slept
    for 1.2 seconds and marked all rows synced; it was fake, non-durable success.
11. **Documents:** active Outreach did not upload documents.
12. **OCR:** active Outreach did not invoke OCR.
13. **NIN collection:** none in the active Outreach UI.
14. **NIN verification:** none; Identity remains the only owner.
15. **Demographics:** the active form collected name, sex, age, phone, notes,
    service type, and a consent label.
16. **Screenings:** service-type choices named vitals, vaccination, lab sample,
    and referral, but no active server authority implemented them.
17. **Clinical records:** no active backend clinical write existed. The UI called
    its form an encounter, which overstated the evidence.
18. **Worker/facility authorization:** Identity authenticated the worker, but the
    old missing data function supplied no verifiable active facility authorization
    contract. Campaign role claims were browser-facing historical concepts.
19. **Hosted APIs:** EHR contained only an empty `OutreachModule`; Identity hosted
    authentication, workforce/facility context, consent, patient authorization,
    and governed canonical registration. No active Outreach API existed.
20. **UI:** `/outreach`, login, signup, join, and verify routes existed in the
    Identity Vite application. Signup/join/OTP routes described infrastructure
    that was not active.
21. **Fail-closed:** public onboarding/OTP, campaigns, visits, screenings,
    vaccinations, specimens, referrals, document/OCR work, NIN, canonical-patient
    creation, ambiguous matching, EHR publication, and any unavailable dependency.

## Ownership and cutover classification

| Component | Classification | Disposition |
|---|---|---|
| Canonical patient UUID, HID, identifiers, NIN, merge and new-person approval | IDENTITY OWNED / KEEP IN CURRENT OWNER | Never written by Outreach. |
| Workforce authentication, facility membership and permissions | IDENTITY OWNED / KEEP IN CURRENT OWNER | Outreach asks Identity on every protected request. |
| Patient consent/access authorization | IDENTITY OWNED / KEEP IN CURRENT OWNER | Existing-patient linking requires exact non-break-glass authorization. |
| Temporary field registration case and `tmp_<uuid-v4>` | OUTREACH OWNED / MOVE TO OUTREACH SERVICE | Implemented in `services/outreach-api` and schema `outreach`. |
| Temporary-to-existing-canonical mapping | OUTREACH OWNED with Identity authorization | Append-only provenance; it does not create Identity. |
| Browser encrypted command queue and safe receipt metadata | OUTREACH OWNED | IndexedDB/Web Crypto; acknowledged command PHI is deleted. |
| HTTP/problem/correlation primitives | SHARED INFRASTRUCTURE / MOVE TO SHARED CONTRACT | Typed `OutreachApiClient` in `packages/api-client`. |
| Clinical encounter, observation and screening truth | EHR OWNED / KEEP IN CURRENT OWNER | Not implemented in this slice. No Outreach-to-EHR writer exists. |
| OCR jobs, extraction and validation | OCR OWNED / KEEP IN CURRENT OWNER | Not implemented; future use must call OCR API. |
| Documents, quarantine and secure objects | EHR/storage boundary / KEEP IN CURRENT OWNER | Not implemented; no second upload path. |
| EHR `OutreachModule` structure-only stub | OBSOLETE AFTER CUTOVER | Unregistered; EHR hosts no Outreach route or writer. |
| `outreach-data` and fake queue APIs | OBSOLETE AFTER CUTOVER | Replaced with the typed standalone client and real outbox. |
| Public Outreach signup/invite/OTP UI | TRANSITIONAL then fail-closed | Routes explain facility-managed provisioning; no mutation occurs. |
| Historical Supabase campaigns/workers/encounters/sync tables and permissive RLS | Historical only / DO NOT RESTORE | Not active architecture. |
| Vite one-origin route | SHARED INFRASTRUCTURE | `/api/v1/outreach/*` proxies to port 3006. |

## Implemented minimum boundary

The repository supports one narrow operational workflow: an authorized member
of one facility saves a temporary demographic/contact registration command. A
stable local command ID, temporary ID, and idempotency key are generated before
network submission. The server records an unresolved case, immutable event,
semantic audit, command idempotency, and minimum outbox event atomically.

A separate optimistic-concurrency command may link that case to an **existing**
canonical patient after the Identity API authorizes the exact patient, worker,
facility, purpose, and `write_records` scope. The original temporary reference
is preserved. No endpoint asks Identity to create a patient, and ambiguity has
no success path; it remains `identity_resolution_pending`.

Direct cross-domain database access after cutover is zero: Outreach has no
Identity/EHR/Lab/Pharmacy/OCR mutation grant. Its only cross-domain calls are
typed HTTP authorization calls to Identity with both user context and an
independent `outreach-api` workload identity.

## Explicitly deferred

Campaigns, assignments beyond Identity facility membership, field visits,
screenings, vaccinations, referrals, specimens, documents, uploads, OCR, NIN,
new-person Identity registration, and EHR clinical ingestion lack enough active
product evidence for this extraction. Each requires a separate governed
contract; no placeholder success or permissive table was created.
