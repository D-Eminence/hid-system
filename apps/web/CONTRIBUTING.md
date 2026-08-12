# Contributing to HID Web

Use a reviewed branch and run the repository gates before proposing a change:

```bash
npm test
npm run verify
npm run build
git diff --check
```

Authentication, authorization, migration, notification, offline, and telemetry
changes require focused negative tests. Never commit credentials, patient data,
OTP values, NIN, provider payloads, or local deployment metadata.

`apps/web` remains an independent Vite application. Production static delivery
is defined by `infra/cloudflare/workers/hid-web/wrangler.json`; browser API calls
remain relative `/api/v1/*` requests. Deployments, provider activation, DNS
changes, and production data work require separate authorization and are not
triggered merely by merging source.
