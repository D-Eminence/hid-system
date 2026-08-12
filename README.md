# HID Platform

This repository contains seven independently deployable HID browser
applications, an API-only regional gateway, independently runnable
Identity/EHR/Lab/Pharmacy/OCR/Outreach services, OCR Worker, Notification
API/Worker, Event Dispatcher, PostgreSQL migration assets, Cloudflare frontend
definitions, AWS infrastructure, and governing platform documentation.

## Start here

- [`CODEX.md`](CODEX.md) defines permanent repository and implementation rules.
- [`docs/README.md`](docs/README.md) is the documentation index.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) defines the target platform architecture.
- [`docs/TASK.md`](docs/TASK.md) defines the current implementation scope.

Module documentation under `apps/ehr/` and `apps/web/` describes local setup and
implementation details. It does not override the platform documentation above.

## Production deployment foundation

The backend infrastructure is the AWS CDK v2 TypeScript application in
[`infra/aws`](infra/aws). It defines typed development, staging, and production
profiles and synthesizes one regional runtime/data stack without AWS lookups.
Cloudflare definitions in [`infra/cloudflare`](infra/cloudflare) own DNS/TLS,
the apex redirect, seven Workers Static Assets frontends, and the fixed
same-origin `/api/v1/*` proxy. AWS contains no CloudFront or static frontend
publication.

```bash
npm --prefix infra/aws ci
npm run test:infra
npm run verify:infra
```

Start with [`docs/AWS_DEPLOYMENT_ARCHITECTURE.md`](docs/AWS_DEPLOYMENT_ARCHITECTURE.md)
and [`docs/AWS_DEPLOYMENT_RUNBOOK.md`](docs/AWS_DEPLOYMENT_RUNBOOK.md). The
foundation defaults every ECS service to zero desired tasks. A release host
must produce twelve immutable image records, SBOMs, scan reports, and the
governed manifest. Authorized AWS/Cloudflare accounts, DNS/certificates,
secrets, provider credentials, database roles, migration, and workload-token
delivery remain external prerequisites.

## Local development

From the repository root:

```bash
npm run dev
```

The local launcher retains a one-origin developer convenience surface. Use
`http://localhost:3000/` for the Web and patient portal entry,
`http://localhost:3000/ehr/` for EHR, `http://localhost:3000/lab/` for
Laboratory, `http://localhost:3000/pharmacy/` for Pharmacy,
`http://localhost:3000/ocr/` for OCR Operations,
`http://localhost:3000/outreach/` for field registration, and
`http://localhost:3000/admin/` for governed platform administration. See
[`docs/FRONTEND_LAYOUT_CONVERGENCE.md`](docs/FRONTEND_LAYOUT_CONVERGENCE.md)
and the module READMEs for focused
build, test, migration, and environment guidance.

Useful frontend-only commands:

```bash
npm run dev:frontends
npm run dev:clinical
npm run preview:frontends
npm run test:pharmacy
npm run test:ocr
npm run verify:frontends
npm run verify:offline
npm run verify:telemetry
```

Direct loopback UI ports are Web 3100, EHR 3101, Lab 3102, Pharmacy 3103,
Outreach 3104, OCR 3105, and Admin 3106. In production each app has its own
Cloudflare hostname and makes same-origin calls that its Worker proxies to the
fixed AWS API origin.

For local API startup, root `.env.local` supplies shared local platform
configuration and `services/ehr-api/.env.local` is an EHR-only override.
`services/ocr-worker/.env.local` is loaded only by the worker, and
`services/event-dispatcher/.env.local` is loaded only by the dispatcher;
Notification API/Worker overrides remain isolated to their service files.
Already-exported environment variables have highest precedence, and server values are not
passed to either browser application process.

For compatibility with the current local checkout, the database URL from the
EHR override is also the final shared-development database fallback. Only that
one actual dependency is propagated; EHR auth/storage configuration is not
inherited by other services. Service-specific database URLs still take
precedence.
# Local extracted clinical services

`npm run dev` starts the authoritative Identity API on 3001, EHR API on 3002,
extracted Lab API on 3003, Pharmacy API on 3004, OCR API on 3005, and Outreach
API on 3006 behind the one-origin
gateway. Standalone Identity commands are `npm run dev:identity-api`,
`npm run build:identity-api`, and `npm run test:identity-api`. Standalone Outreach commands are `npm run dev:outreach-api`,
`npm run build:outreach-api`, and `npm run test:outreach-api`.
Standalone OCR API commands are `npm run dev:ocr-api`, `npm run build:ocr-api`,
and `npm run test:ocr-api`. The independent worker commands are
`npm run dev:ocr-worker`, `npm run build:ocr-worker`, and
`npm run test:ocr-worker`.
The neutral event dispatcher commands are `npm run dev:event-dispatcher`,
`npm run build:event-dispatcher`, and `npm run test:event-dispatcher`; its
status listener defaults to 3010.
Notification OTP and ordinary-notification commands are
`npm run dev:notification-api`, `npm run test:notification-api`,
`npm run dev:notification-worker`, and `npm run test:notification-worker`.
Authentication codes use the direct Notification API boundary; ordinary
events use EventBridge/SQS and Notification Worker. The paths are deliberately
separate.
The dedicated Admin frontend commands are `npm run dev:admin`,
`npm run test:admin`, and `npm run build:admin`; its loopback direct port is
3106 and its same-origin API is Identity-owned `/api/v1/admin/*`. It has no
direct database access, clinical authority, or break-glass authority. See
`docs/SUPER_ADMIN_FOUNDATION.md`.

Pharmacy (`npm run dev:pharmacy`, `npm run test:pharmacy`) and OCR Operations
(`npm run dev:ocr`, `npm run test:ocr`) are real authenticated API clients, not
placeholder dashboards. Their app READMEs record exact product and offline
limits. Contextual clinical OCR review remains in EHR.

The root launcher starts the worker only when `OCR_WORKER_DATABASE_URL` and a
non-`disabled` `OCR_PROVIDER` are explicitly configured. Otherwise it reports
the intentional disabled state while still starting the OCR API, preventing a
normal UI/API launch from unexpectedly claiming durable OCR work.

The root launcher likewise starts the event dispatcher only when
`EVENT_DISPATCHER_ENABLED=true`; an explicit non-disabled transport and
dispatcher database URL are still required. Normal UI/API startup therefore
does not silently publish transactional events.

Set `PHARMACY_DATABASE_URL` and `OCR_DATABASE_URL` to their local service
logins when available; the
development launcher otherwise uses the existing local database URL. It
generates independent ephemeral EHR, Lab, Pharmacy, OCR, and Outreach caller secrets for that one
run. Production requires separate non-owner logins and asymmetric workload
identity and never uses these local fallbacks.
