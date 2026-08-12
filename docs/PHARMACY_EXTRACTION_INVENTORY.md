# Pharmacy Extraction Inventory

## Repository evidence

The pre-extraction active repository contained a real EHR-owned
prescription-intent workflow, but no active Pharmacy operational implementation
to move unchanged. These findings governed the implementation; they describe
the state before migration `0023`.

| Evidence | Current meaning | Disposition |
|---|---|---|
| `services/ehr-api/src/ehr/prescriptions/` and `ehr.prescriptions` | Versioned EHR clinical prescribing intent with canonical patient, encounter, facility, actor, medication, dose, route, frequency, instructions, status, and immutable `ehr.record_versions` history | **EHR OWNED / KEEP IN EHR** |
| Former `ehr/server/src/pharmacy/` | Empty structure-only NestJS module and README; no controller, service, DTO, repository, route, or persistence | **OBSOLETE AFTER CUTOVER / REMOVED** |
| `ehr/src/components/clinical/ClinicalForms.tsx` and typed EHR API contracts | Active prescription creation and clinical timeline presentation | **EHR OWNED / KEEP IN EHR** |
| `ehr/src/ehr-ops.jsx`, `moduleAvailability.ts`, `Pharmacy POS.html` | Unavailable placeholder/wrapper rather than an operational Pharmacy client | **TRANSITIONAL PRESENTATION EVIDENCE** |
| `ehr/src/data/hospital.data.ts` and legacy JSX fixtures | Empty medication/drug arrays and presentation-only `dispensed` flags | **DO NOT TREAT AS CLINICAL OR DISPENSING TRUTH** |
| OCR `PHARMACY` / `historical_medication_evidence` classification | Governed validation vocabulary exists, but publication intentionally has no owning target | **MOVE TO PHARMACY IMPORT CONTRACT; REMAIN SEPARATE FROM DISPENSING** |
| `upstream_snapshot` medication records and Pharmacy marketing/UI material | General historical medication evidence and product aspirations; no authoritative dispensing lifecycle or Pharmacy persistence | **HISTORICAL REFERENCE ONLY** |
| Current roles, RLS, outbox, gateway, and shared clients | No Pharmacy database role, schema, outbox, route, or typed client exists | **CREATE MINIMUM PHARMACY BOUNDARY** |

## Direct answers from current evidence

1. **Prescription intent exists:** yes, in EHR. It is not Pharmacy-owned.
2. **Pharmacy persistence exists:** no.
3. **Dispensing exists:** no authoritative dispensing command or record exists.
4. **Medication history exists:** only empty/reference UI shapes and historical
   general-record concepts; no active Pharmacy medication-history authority.
5. **Pharmacy UI exists:** only an unavailable active placeholder, an HTML
   wrapper, historical screenshots, and marketing/reference presentation.
6. **Stock/inventory exists:** no active stock, lot, expiry, movement, or
   reconciliation implementation.
7. **Imported medication evidence exists:** OCR can classify a governed
   candidate, but no owning Pharmacy persistence or publication API exists.
8. **OCR Pharmacy publication fails closed:** yes.
9. **Pharmacy APIs are hosted by EHR:** no; EHR hosts prescription APIs and an
   empty Pharmacy module only.
10. **Pharmacy database roles exist:** no.
11. **Direct cross-domain Pharmacy SQL exists:** no Pharmacy schema exists.
12. **Safe functionality to preserve:** EHR prescription intent and exact
    versions, typed EHR UI/API behavior, canonical Identity patient UUIDs,
    governed OCR review/provenance, shared service transport, and the current
    same-facility authorization model.

## Implemented disposition

Migration `0023_pharmacy_domain_foundation.sql` and
`services/pharmacy-api/` now implement the smallest boundary supported by the
inventory:

* **PHARMACY OWNED:** exact-version accepted work items, acceptance events,
  explicit dispensings, append-only reversals, imported medication evidence,
  Pharmacy outbox records, controllers/services/DTOs/tests, and readiness.
* **EHR OWNED / KEEP IN EHR:** `ehr.prescriptions`, prescribing transitions,
  immutable EHR prescription history, and the public exact-version handoff.
* **MOVE TO SHARED CONTRACT / REPLACE WITH PHARMACY CLIENT:** the typed
  `packages/api-client` Pharmacy transport used by EHR and OCR.
* **TRANSITIONAL:** the unavailable EHR Pharmacy presentation; it is not an
  operational writer and no dedicated Pharmacy UI was invented.
* **REMOVED AFTER CUTOVER:** the empty EHR Pharmacy backend registration.

OCR `PHARMACY` publication is enabled only after governed validation and
canonical patient confirmation. It calls the Pharmacy import API and creates
activity-unknown historical evidence with exact provenance. It has no command,
SQL privilege, or service credential capable of creating dispensing.

## Minimum extraction boundary

```text
EHR exact active prescription version
        -> typed Pharmacy client
        -> Pharmacy acceptance snapshot
        -> explicit dispensing event
        -> optional governed reversal
```

Separately:

```text
validated OCR historical medication candidate
        -> Pharmacy imported medication evidence
        != prescription
        != dispensing
```

This stage intentionally does not implement partial dispensing, refills,
inventory/stock, purchasing, suppliers, POS/payment, claims, medication
administration, a national drug catalogue, or a dedicated Pharmacy frontend.
