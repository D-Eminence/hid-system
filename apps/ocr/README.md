# HID OCR operations workspace

`apps/ocr` is the authenticated digitization-operations frontend. It uses the
shared Identity cookie/CSRF session, requires an active facility assignment
with OCR permissions, calls only same-origin `/api/v1/ocr/*`, and has no direct
database, object-storage, provider, or worker credential.

Gateway route: `/ocr/`. Direct development port: `3105`.

The existing API supports exact document/job lookup, secured job creation,
eligible failed-job retry, extraction metadata, validation state, and
publication state. It does not expose a global queue or worker/provider status,
so the UI does not invent either. Raw OCR text and clinical corrections remain
in EHR's patient/encounter review workspace.

The installable app shell is offline-aware. Job creation/retry/publication are
not queued or simulated offline. No OCR text, document content, patient value,
or API payload is sent to telemetry. Sentry/PostHog replay is disabled.

```bash
npm --prefix apps/ocr test
npm --prefix apps/ocr run build
```
