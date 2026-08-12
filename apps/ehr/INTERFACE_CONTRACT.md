# HID EHR Interface Contract

## Status

This contract describes the maintained React/Vite EHR client and NestJS API in
this directory. It replaces the obsolete static-demo and direct-retired hosted identity backend EHR
contract. The local demo adapter implements the same browser-facing shapes in
memory, but production authorization and persistence always belong to the API.

## Browser boundary

The browser may call only the typed interfaces under `src/api/`:

- `authApi` for staff login, session restoration, facility context, and logout.
- Identity lookup and authorization interfaces for exact-HID patient access.
- Encounter, note, vital, diagnosis, medication-request, laboratory-request,
  document, and timeline interfaces.

The browser must not:

- connect directly to PostgreSQL, retired hosted identity backend tables, or object storage;
- issue or generate a patient HID;
- select an authoritative role, facility, or permission;
- treat department configuration as an authorization grant;
- reveal a patient record from an unverified identifier; or
- convert a missing backend into a simulated successful operation.

Canonical client types are defined in `src/api/contracts.ts`. API problem
documents are normalized by `src/api/client.ts` and `src/api/errors.ts`.

## Authentication contract

A successful staff session supplies:

```text
actor: id, displayName, roles, roleLabel, permissions
facility: id, name, code, type, departments
session: expiry and transport security fields when applicable
```

The browser projects this into presentation policy using
`src/auth/session.ts`. The NestJS guard remains authoritative. Ambiguous roles,
missing permission scope, invalid facility context, and expired sessions fail
closed.

Production deployments should use HttpOnly session cookies. State-changing
requests require the configured CSRF and idempotency controls. Error messages
shown to users must remain sanitized and must not expose credentials, tokens,
queries, or internal infrastructure.

## Identity and patient access

HID Identity owns the canonical patient identity. The EHR can:

1. submit an exact HID for governed lookup;
2. receive a patient summary only after authorization allows disclosure;
3. link an existing Identity patient to an authorized facility workflow; and
4. open a patient-scoped encounter workspace.

The EHR cannot create an independent patient identity. Registration UI is an
Identity-boundary workflow, not a local patient insert.

## Clinical resources

The maintained API contract covers:

- encounters;
- clinical notes;
- manual vitals and observations;
- diagnoses;
- medication-request intent;
- laboratory-request intent;
- governed clinical document metadata and upload intent; and
- patient and encounter timeline reads.

Each create operation is patient-, encounter-, actor-, and facility-scoped. The
server applies authorization, validation, idempotency, audit, and persistence.
Medication requests do not mean dispensing. Laboratory requests do not mean
laboratory execution or result ownership.

## Facility onboarding

The nine-stage onboarding screen is part of the continuous local EHR flow:

`Facility → Type → Departments → Branches → Staff → Roles → Billing → Review → Launch`

In demo mode, its result is local presentation configuration saved in browser
storage. It may preview department-driven modules and roles, but it does not
create a production organization, invite staff, assign permissions, configure
payment processing, or enable a backend module.

A production facility-provisioning API is unresolved and must be introduced as
a separately reviewed contract before the UI can persist production setup.

## Retained module directory

The application exposes appointments, triage, inpatient, emergency, maternity,
surgery, laboratory, radiology, pharmacy, billing, insurance, inventory,
reports, staff, HR, shifts, quality, ambulance, blood bank, telemedicine, and
referrals from one directory.

Only the core EHR interfaces listed above are active. A retained module remains
gated until it has all of the following:

- typed browser contract;
- authenticated API route;
- server-derived permission policy;
- active-facility isolation;
- semantic audit;
- idempotency and concurrency behavior where applicable;
- durable persistence and migration ownership; and
- focused authorization and failure tests.

Gated modules may explain intended functionality. They must not load fixture
patient data, mutate local arrays as if they were production records, or report
a successful production operation.

## Local demo adapter

The local demo is enabled only during development when
`VITE_HID_DEMO_MODE=true`. It provides an isolated staff session and in-memory
patient/clinical workflow for browser verification. Demo records are explicitly
non-authoritative, browser-local, and disposable.

Production builds must not expose demo credentials, demo session restoration,
or fixture-backed success paths.

## Errors and degraded dependencies

- Unauthorized or expired sessions return to staff sign-in.
- Denied patient authorization reveals no patient record.
- Unavailable API, database, Identity, or storage dependencies fail visibly.
- The local demo login does not display a production-service outage warning when
  the demo adapter is intentionally active.
- Gated modules explain their missing contract and perform no action.

## Change process

When adding a capability:

1. Confirm domain ownership in `../docs/PRODUCT.md`.
2. Add or change types in `src/api/contracts.ts`.
3. Implement the matching NestJS module and database migration when required.
4. Add server authorization, facility isolation, audit, and idempotency.
5. Add the client workflow and loading, empty, denied, error, and responsive
   states.
6. Add focused client and server verification.
7. Update this contract and `ARCHITECTURE.md` in the same change.
