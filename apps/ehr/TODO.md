# HID EHR Delivery Backlog

## Completed Locally

- [x] Consolidated repository with root `npm run dev`.
- [x] One browser origin at `http://localhost:3000`.
- [x] EHR available at `/ehr/` through the Identity gateway.
- [x] Canonical `ehr.html` served directly as the localhost EHR experience.
- [x] `HID EHR - Standalone.html` kept byte-identical to `ehr.html`.
- [x] All decoded reference code and UI terminology standardized on EHR.
- [x] Reference dashboards, clinical areas, operational modules, responsive
  navigation, and facility setup retained exactly.
- [x] Facility signup connected continuously to the nine-stage onboarding and
  administrator workspace launch.
- [x] Typed React client, NestJS API, and PostgreSQL migration assets retained.
- [x] Strict EHR TypeScript/Vite production build.

## Production Gates

- [ ] Reproduce the approved reference workflows in the typed client without
  changing the accepted visual behavior.
- [ ] Replace every fixture and simulated reference action with an authenticated,
  facility-isolated, audited API contract before production use.
- [ ] Configure and deploy the NestJS EHR API and PostgreSQL migrations.
- [ ] Complete production staff provisioning and session integration with HID
  Identity.
- [ ] Approve patient authorization, consent, purpose-of-use, and break-glass
  operating procedures.
- [ ] Configure private document storage, malware scanning, retention, and legal
  hold controls.
- [ ] Add end-to-end tests against disposable real database and storage services.
- [ ] Complete keyboard, screen-reader, zoom, and mobile-device testing.

No backlog item authorizes a second patient identity, client-selected production
roles, direct browser database access, or simulated production success.
