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
- [`docs/QOREID_VERIFICATION_CONTRACT.md`](docs/QOREID_VERIFICATION_CONTRACT.md) defines the disabled-by-default server-only QoreID verification boundary.

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

## Before you push: the full database check

CI runs a full database rehearsal on every push. You can now run the same
check on your own machine with one command, so you find problems before CI
does.

**Ways of working**

- Start every backend branch from `staging-novu-ci-20261005`, which is what
  production runs: `git fetch origin && git switch -c <your-branch> origin/staging-novu-ci-20261005`.
- Before you add a migration file (`services/ehr-api/database/migrations/NNNN_*.sql`),
  book its number on issue #258 first, so two branches never pick the
  same number.
- Run `npm run check:db` before you push any change that touches a
  migration, a database test, a runtime verifier or a backend service.

**Running it**

```bash
npm run check:db                 # check prerequisites, then run the rehearsal (about 3 minutes)
npm run check:db -- --prepare    # first install and build anything missing, then run
npm run check:db:all             # also identity-api and ehr-api jest and the release tests (about 4 minutes)
npm run check:db -- --check-only # only check prerequisites; installs and runs nothing
```

It first checks what the rehearsal needs and, for anything missing, prints
what is wrong and the command that fixes it:

- **PostgreSQL 16 with pgvector.** The check finds it on your PATH or in the
  usual install folders. If it picks the wrong one, set
  `PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config` (Ubuntu) or
  `PG_CONFIG="$(brew --prefix postgresql@16)/bin/pg_config"` (macOS).
- **A normal user account.** PostgreSQL will not start as root, so do not use
  `sudo`.
- **Dependencies for every service** (`services/*`) and for `release/` (the
  rehearsal loads release modules too). Every installed package must match
  that folder's `package-lock.json`; if not, the check says "dependencies out
  of date, run with --prepare". It also checks that every npm package the
  rehearsal itself imports can be found, so it never starts a rehearsal that
  cannot load.
- **Built packages** that the services use (`packages/api-client`,
  `packages/server-telemetry`).
- **git can read the checkout.** Use a clone your own account created. The
  rehearsal runs git without your home folder, so a `--global safe.directory`
  setting does not help.

`--prepare` fixes only the npm items. It runs `npm ci` in each folder of this
checkout that needs it and builds missing packages. It never replaces a
`node_modules` folder that is a link and never changes your git or npm
settings. Like any `npm ci`, it downloads packages from your configured
registry, reads your npm settings (`~/.npmrc`) and writes to your npm cache
and npm log folder (usually `~/.npm`). `--prepare` cannot be combined with
`--check-only`.

The rehearsal migrates a fresh database and runs every database suite:
`services/ehr-api/database/tests/*.integration.sql` on the migrated database
itself, and `services/ehr-api/test/database/*.integration.sql` on a copy of it
whose schemas, tables, functions and owner policies belong to a role that is
neither a superuser nor allowed to bypass row-level security, as production's
migration login. A superuser owner skips forced row-level security, so a
suite could pass under it and still fail in production. Each suite is one
transaction that ends in `ROLLBACK`, judged by psql's exit status; a failure
names every failed suite and its first error. CI's "Synthetic migration
rehearsal" job runs the same rehearsal, so the suites run in CI too.

The rehearsal makes its own throwaway PostgreSQL in `/tmp`, reachable only
through a private socket, fills it with fictional data and deletes it at the
end. It never connects to any other database. At the end you get a short
pass/fail summary. On a failure it names the failing step (for the rehearsal,
the rehearsal step inside it), the first error line, the file it points to
and the full log of that step. Logs go to a new `hid-db-check-*` folder in
your system temp folder (the summary prints the path), or to the folder you
give with `--log-dir DIR`. Delete it when you are done.

## Local development

From the repository root:

```bash
npm run dev
```

The local launcher retains a one-origin developer convenience surface. Use
`http://localhost:3000/` for the Web and patient portal entry,
`http://localhost:3000/ehr/` for EHR, `http://localhost:3000/lab/` for
Laboratory, `http://localhost:3000/pharmacy/` for Pharmacy,
`http://localhost:3000/migrate/` for HID Migrate,
`http://localhost:3000/outreach/` for field registration, and
`http://localhost:3000/admin/` for governed platform administration. See
[`docs/FRONTEND_LAYOUT_CONVERGENCE.md`](docs/FRONTEND_LAYOUT_CONVERGENCE.md)
and the module READMEs for focused
build, test, migration, and environment guidance.

The `/migrate/` path above is a local developer-gateway convenience. The
public Migrate application is served directly from
`https://migrate.healthidentitydirectory.com/`.

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

Pharmacy (`npm run dev:pharmacy`, `npm run test:pharmacy`) and HID Migrate
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
