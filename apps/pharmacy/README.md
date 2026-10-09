# HID Pharmacy workspace

`apps/pharmacy` is the authenticated Pharmacy operational frontend. It uses the
shared Identity cookie/CSRF session, requires an active facility assignment
with Pharmacy capabilities, calls only same-origin `/api/v1/pharmacy/*`, and
has no database or internal-service credential.

Gateway route: `/pharmacy/`. Direct development port: `3103`.

Implemented UI follows the existing API: accepted prescription work queue,
server-confirmed full dispensing, append-only dispensing reversal, and exact-ID
read of imported historical medication evidence. It does not claim inventory,
partial fills, refills, substitution, payment, controlled-drug processing, or
medication administration.

The app shell is offline-capable and visibly reports connectivity. Pharmacy
mutations are intentionally online-only in this version; an offline click does
not queue or display a false dispensing success. API authorization is always
re-evaluated by Pharmacy.

Sentry and PostHog use `@hid/telemetry`; replay is disabled and only allowlisted
non-PHI properties may be emitted.

```bash
npm --prefix apps/pharmacy test
npm --prefix apps/pharmacy run build
```
