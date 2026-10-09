# HID OCR Worker

Independent non-HTTP worker for lease-bound OCR extraction. It has no EHR API
or OCR API application imports and can run while both HTTP services are
stopped. It claims work only through the exact `ocr` security-definer command
surface using a login that inherits `hid_ocr_worker`; that role has no table
privileges.

The worker preserves `SKIP LOCKED` claims, expiring and renewable leases,
per-attempt tokens, bounded retry, exact S3 object-version/size/SHA-256
verification, provider isolation, and immutable completion/failure commands.
It never publishes clinical truth and exposes no network port.

Use Node.js 22 or newer and configure from `.env.example` through injected
process environment. The executable does not load env files itself.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm start
```

`OCR_PROVIDER=disabled` fails closed without claiming work. The deterministic
`test` provider is accepted only with `NODE_ENV=test`; production requires
Textract, PostgreSQL TLS with a trusted CA, private versioned S3, least-
privilege IAM, and the approved KMS policy. The root development launcher runs
this worker only when `OCR_WORKER_DATABASE_URL` and a non-disabled provider are
explicitly configured.
