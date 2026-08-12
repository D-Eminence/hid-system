# HID EHR

HID EHR is the facility staff workspace in the consolidated HID repository.
The canonical browser experience is the self-contained `ehr.html` bundle. Vite
serves that exact bundle at `/ehr/`, so the localhost UI matches the reference
without a second approximation layer.

Vite also attaches `src/canonical-platform-runtime.ts` as a separate production
entry. It does not replace or reinterpret the reference UI; it provides the
shared PHI-redacted telemetry policy, safe browser-error capture, visible
connectivity status, and `/ehr/`-scoped static-shell service worker. The worker
never caches `/api/` responses.

The equivalent reference entries are:

- `ehr.html` - canonical runtime and visual source of truth.
- `HID EHR - Standalone.html` - byte-identical standalone copy.
- `HID EHR.html` - forwards to the canonical bundle.

All decoded text, identifiers, CSS namespaces, comments, and visible labels in
the canonical bundles use EHR terminology. Base64 integrity strings are not
treated as product terminology.

## Run From The Repository Root

```bash
npm run dev
```

Use one browser origin:

- `http://localhost:3000/` - HID Identity and portal entry.
- `http://localhost:3000/ehr/` - canonical HID EHR reference flow.
- `http://localhost:3000/api/v1/` - EHR API when configured.
- `http://localhost:3000/api/v1/ocr/` - standalone OCR API through the same origin.

The EHR UI listens directly on loopback port `3101` and the configured EHR API
listens on `3002`; both are proxied through the Identity Vite gateway. Users
should open port `3000` only.

## Local Reference Flow

The canonical EHR bundle is a local interactive reference, not production
authentication. Login fields start blank. Entering a staff email and password
and selecting **Sign in** opens the local reference workspace.

For a new facility, select **Register facility** on the sign-in screen. The
continuous local flow is:

1. Create the facility administrator profile.
2. Enter the facility name and verified contact details.
3. Complete Facility, Type, Departments, Branches, Staff, Roles, Billing,
   Review, and Launch.
4. Open the generated workspace as the facility administrator.

Signup, onboarding, staff, patient, incident, and operational records start
empty and contain only information entered in the current browser. They do not
create a production Identity account or provision a live facility.

The bundle includes dashboards, patients, appointments, triage, consultation,
inpatient care, emergency, maternity, surgery, laboratory, radiology, pharmacy,
billing, insurance, inventory, reports, audit, staff, HR, shifts, quality,
ambulance, blood bank, telemedicine, referrals, responsive navigation, and the
facility setup flow represented by the reference.

Do not connect the reference bundle to production patient data. Local actions
are browser-scoped reference behavior and do not represent durable server
operations.

## Maintained Integration Code

`src/` contains the typed React client and `server/` contains the NestJS API,
authorization, Identity bridge, audit, clinical modules, and PostgreSQL
migrations. The TypeScript client remains build-checked as the production
integration target, but exact-reference mode serves `ehr.html` at `/ehr/`.

Production work must preserve these boundaries:

- HID Identity is the only patient identity issuer.
- Browser code must not connect directly to PostgreSQL, database data APIs, or storage
  credentials.
- Server sessions, facility membership, permissions, consent, and audit are
  authoritative.
- Reference fixtures and simulated success must never become a production data
  path.

## Verification

From the repository root:

```bash
npm run build:ehr
npm run test:ehr-api
```

Run `npm run build` for the complete repository build.
# Extracted Lab integration

The EHR frontend continues using `/api/v1/lab/*`, but the gateway now routes those calls to the standalone Lab API on port 3003. The EHR backend owns laboratory-order intent only and uses the shared typed client for exact-version Lab acceptance. Lab backend implementation is not registered or stored in `services/ehr-api`.

# Extracted Pharmacy integration

The gateway routes `/api/v1/pharmacy/*` to the standalone Pharmacy API on port
3004. EHR retains prescription intent and sends only an exact active
prescription version through the shared typed client. OCR sends governed
historical medication evidence through the same service boundary. No Pharmacy
backend module or direct Pharmacy-table writer remains in EHR. The current
Pharmacy UI placeholder remains unavailable until a dedicated operational UI
is intentionally designed.

# Extracted OCR integration

The governed OCR review workspace remains in the typed EHR frontend, but its
shared client now reaches `/api/v1/ocr/*` through the gateway on standalone
port 3005. EHR port 3002 no longer registers OCR controllers. EHR exposes only
narrow internal, `ocr-api` workload-authenticated source-document and imported
clinical-note commands. The provider worker runs independently from
`services/ocr-worker` and is not an OCR API or EHR API readiness dependency.
