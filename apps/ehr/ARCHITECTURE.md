# HID EHR Architecture

Read `README.md` and `../docs/PRODUCT.md` before changing the EHR.

## Active Local Runtime

```text
http://localhost:3000/ehr/
  -> Identity Vite gateway proxy
  -> EHR Vite server on loopback port 3101
  -> vite.config.ts transformIndexHtml
  -> ehr.html canonical self-contained bundle
  -> src/canonical-platform-runtime.ts (connectivity, scoped PWA, safe telemetry)
```

`ehr.html` is the active visual and interaction source of truth. The file
`HID EHR - Standalone.html` is byte-identical, and `HID EHR.html` forwards to
the canonical bundle. This guarantees that the localhost EHR renders the
reference itself instead of a visually similar reconstruction.

The canonical platform runtime is independently bundled and survives the
reference document replacement through window-level listeners. It does not
mount a competing clinical application or turn local reference actions into
server truth. It initializes the shared replay-disabled telemetry layer,
registers the `/ehr/` worker, reports sanitized runtime failures, and maintains
the standard offline indicator.

The bundle owns its local demonstration state. It must not be connected to
production patient data, production authentication, or privileged credentials.

## Production Integration Target

The typed application and API remain in the repository as the production
integration path:

```text
src/main.tsx
  -> src/ehr-app.jsx
  -> src/components/auth/
  -> src/components/layout/
  -> src/components/dashboards/
  -> src/components/clinical/
  -> src/components/modules/
  -> src/api/

server/src/
  -> auth and authorization
  -> identity interoperability
  -> EHR clinical modules
  -> document controls
  -> audit and storage boundaries
```

The TypeScript client is build-checked but is not the `/ehr/` browser entry
while exact-reference mode is enabled. Production integration should move
reference workflows behind typed, authenticated, facility-isolated, audited
API contracts before replacing the canonical local bundle.

The gateway proxies `/api/v1/ocr/*` to the OCR API on loopback port `3005` and
the remaining EHR `/api` fallback to port `3002`. The complete
development allocation is centralized in `../scripts/ports.mjs`; environment
overrides are validated and duplicate port assignments fail before startup.

## Product Boundaries

- HID Identity alone issues and governs patient identity.
- EHR owns encounters and clinician-authored clinical records and intent.
- Laboratory owns test execution and authoritative results.
- Pharmacy dispensing, inventory, billing, HR, and other operational contexts
  require their own approved contracts and controls.
- Browser code never receives direct database or general storage credentials.
- Roles, permissions, facility scope, consent, and purpose are enforced by the
  server in production.
- Local reference fixtures and simulated actions cannot substitute for durable
  production operations.

## Naming Contract

Product terminology, filenames, source identifiers, CSS namespaces, routes,
documentation, and decoded reference assets use `EHR`, `Ehr`, or `ehr`.
Package-lock integrity hashes are immutable dependency checksums and are not
product terminology.

## Build

`npm run build` in this directory performs strict TypeScript validation and
builds the canonical HTML entry. From the repository root, `npm run dev` keeps
Identity and EHR on the continuous `localhost:3000` origin.
