# Lab service extraction inventory

This records the completed physical-boundary classification; authoritative architecture remains in the platform documents.

| Classification | Active artifacts |
|---|---|
| Move to Lab service | Former `ehr/server/src/lab/**`: imports, work items, accessions/specimens, executions/results, DTOs, controllers, services, and tests. Now under `services/lab-api/src/lab/**`. |
| Keep in EHR | `services/ehr-api/src/ehr/lab-requests/**`: EHR-owned laboratory-order intent and exact source version. The transitional Lab UI remains in `ehr/src/ehr-ops.jsx`. |
| Move to shared contract/client | Bounded HTTP transport and Lab client in `packages/api-client/src/{index,lab}.ts`. |
| Replace with Lab client | EHR order acceptance and OCR Lab publication now inject `LabApiService`; neither imports Lab implementation classes. |
| Transitional | Identity authentication/session and authorization decisions are obtained over the EHR-hosted Identity API until Identity is physically extracted. Historical migrations remain in the central runner. |
| Obsolete after extraction | `ehr/server/src/lab/**`, EHR `LabModule` registration, and `hid_api_runtime` inheritance of `hid_lab_runtime`; removed. |

Dependencies: Lab owns its PostgreSQL connection, semantic audit inserts, transactional outbox, and authorization enforcement. It calls Identity over HTTP for authenticated actor and patient-access decisions. The browser retains `/api/v1/lab/*`; the local gateway routes that namespace to port 3003. EHR and OCR use bounded calls with correlation, facility, purpose, bearer actor context, idempotency, Problem Details, and service identity. Local identity is ephemeral; production uses separately subject-bound, audience-bound asymmetric workload JWTs from rotating mounted token files.
