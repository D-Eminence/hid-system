# Backend Layout Convergence

Date: 2026-08-11  
Status: implemented and verified locally; external environment verification pending

## 2026-08-12 convergence addendum

The active backend inventory now also contains `services/notification-api` and
`services/notification-worker`. The duplicated inactive human Auth/Identity
implementation formerly retained under EHR has been removed; EHR keeps only
its workload/remote-security boundaries. Human actors are `local` or `oidc`
only, and Identity is always PostgreSQL-backed. Direct legacy HTTP and Supabase
runtime providers are absent. Migration `0028` extends the immutable
`0001`–`0027` ledger with OTP, KYC/mapping, encrypted-device, and delivery
reconciliation state. Statements below describing retained compatibility Auth,
the old directory count, earlier service totals, or earlier migration tips are
historical extraction evidence.

## Outcome

All active backend runtimes now have one physical home under `services/`:

```text
services/
  identity-api/
  ehr-api/
  lab-api/
  pharmacy-api/
  ocr-api/
  ocr-worker/
  outreach-api/
  notification-api/
  notification-worker/
  event-dispatcher/
```

The EHR frontend remains at `ehr/`. The former `ehr/server` directory is absent
and is rejected by the platform graph verifier. Ports, public paths, domain
semantics, database roles, migration versions, gateway behavior, and browser
URLs did not change.

## Pre-cutover classification

The pre-cutover `ehr/server` inventory contained 183 non-generated files.

| Classification | Content | Disposition |
| --- | --- | --- |
| EHR runtime-owned | Active composition, EHR clinical/document routes, EHR audit writes, remote security, typed service adapters, configuration, health, storage, tests | Moved unchanged to `services/ehr-api` and independently rebuilt |
| OCR worker-owned | 11 configuration, repository, exact-object reader, provider, lifecycle, entrypoint, and test files | Moved to `services/ocr-worker/src` with an independent manifest, lockfile, tests, build, environment example, README, and Dockerfile |
| Platform database-owned | One `0001`-`0025` migration ledger, runtime grants, schema/RLS tests, migrator, role bootstrap, and legacy transition scripts | Moved intact with the package to `services/ehr-api/database` and `scripts`; explicitly not classified as EHR domain ownership |
| Inactive compatibility source | Old local Auth/Identity/Consent implementations and empty transitional module shells excluded from active `AppModule` | Retained without application wiring to preserve historical transition tests; composition and live negative-route checks prove it is not executable ownership |
| Dead infrastructure | Empty `SecurityGuard` marker and duplicate EHR/Lab OCR-worker package commands | Removed |

The inactive compatibility source is deliberate bounded debt, not a second
backend. Deleting or separately archiving it should be its own evidence-backed
cleanup because it participates in historical identity-transition tests even
though no active module imports it.

## Migration-ledger decision

No applied migration was edited, renamed, reordered, split, or added. The
checksum-governed ledger remains exactly `0001` through `0025`.

Moving the ledger into a new neutral package was considered and deferred.
Its runner, local env precedence, PostgreSQL dependency, administrator-only
role bootstrap, and schema-test paths were already proven together. Changing
that packaging and credential boundary during runtime relocation would add
unnecessary migration risk. The closest safe supported state is therefore:

- one platform ledger at `services/ehr-api/database/migrations`;
- one runner at `services/ehr-api/scripts/apply-migrations.mjs`;
- one idempotent runtime-grant and role-verification surface; and
- explicit documentation that physical co-location does not confer EHR
  ownership over Identity, Lab, Pharmacy, OCR, or Outreach schema history.

A later neutral tooling extraction must move the ledger as one unit and retain
checksum identity. It must never create per-service histories.

## Package and orchestration changes

- `@hid/ehr-api` owns only the EHR API production entrypoint. Worker scripts
  and the Textract dependency were removed; a clean locked install confirms
  Textract is absent from its dependency tree.
- `@hid/ocr-worker` owns the only worker production entrypoint. It depends only
  on PostgreSQL, Zod, S3, and Textract packages and imports no API
  implementation or `@hid/api-client`.
- `@hid/api-client` now has its own TypeScript development dependency and
  lockfile rather than borrowing a binary through the retired EHR path.
- Root build/test/dev scripts use the new package paths and include the worker.
- Root development starts backend APIs in compile-once local mode so a runtime
  child failure reaches the parent and drains siblings. Standalone `dev:*`
  commands retain watch mode.
- Root local configuration passes each service only its required values. The
  existing EHR-local database URL remains the final shared-development database
  fallback for compatibility; other EHR auth/storage settings do not leak to
  sibling services. Worker local overrides are loaded only for the worker.
- Static Docker contracts now cover Identity, EHR, Lab, Pharmacy, OCR API, OCR
  worker, and Outreach: Node 22, locked install, non-root runtime, and exact
  production command. Docker execution remains external because Docker is not
  available locally.

## Boundary and duplicate-owner evidence

`npm run verify:platform-graph` now asserts:

- the former `ehr/server` path is absent;
- all seven backend directories exist;
- EHR active composition excludes extracted Auth, Identity, Consent, Lab,
  Pharmacy, Outreach, and OCR modules;
- every owning service mutates only its allowed schema set;
- worker SQL references only `ocr`;
- service packages have no owning-service runtime dependencies other than the
  shared transport package;
- EHR and Lab expose no duplicate worker command;
- worker source imports neither HTTP API implementation nor shared HTTP
  transport; and
- every backend Dockerfile satisfies the static production contract.

The live process/listener inspection found one owner on each port 3000-3006
and 3101. EHR executed only from `services/ehr-api/dist/main`; no retired EHR
or duplicate worker process existed. Direct EHR requests to the retired OCR and
Identity paths returned 404. Gateway OCR returned the standalone OCR-owned 401
Problem Details response and preserved `layout-convergence-20260811`.

## Remaining transitional layout

No active backend runtime remains outside `services/`. Two deliberate layout
debts remain: inactive Identity/Auth/Consent compatibility source stays inside
`services/ehr-api` for historical transition tests, and the one platform
migration ledger is temporarily co-located there. Neither is registered as a
second runtime or changes domain ownership.

The EHR frontend remains at `ehr/`; moving it to the architecture's future
`apps/ehr` target is a separate frontend-convergence task. No frontend was
moved or redesigned during this backend cutover.

## Verification results

| Surface | Result |
| --- | --- |
| Identity API | 13 suites / 39 tests; lint and root build pass |
| EHR API | 23 suites / 70 tests; clean locked install, lint, build pass |
| OCR worker | 3 suites / 8 tests; clean locked install, lint, build pass |
| OCR API | 8 suites / 27 tests; lint and root build pass |
| Lab API | 11 suites / 31 tests; lint and root build pass |
| Pharmacy API | 7 suites / 17 tests; lint and root build pass |
| Outreach API | 7 suites / 15 tests; lint and root build pass |
| Combined backend total | 72 suites / 207 tests |
| Shared API client | Independent locked install, typecheck, and build pass |
| Frontend contracts | Identity and Outreach verifiers pass from new paths |
| Full root production build | Passes for both frontends, shared client, six APIs, and worker |
| Platform graph / import / Docker static scan | Passes |
| Migration plan and dry run | Zero pending; rollback-only dry run passes |
| Runtime roles | Idempotent local provisioning and separate assertion-only verification pass |
| Schema/RLS | Full integration SQL completes through intentional `ROLLBACK` |
| Live graph | All six APIs return 200 for live and ready; gateway root/EHR return 200 |
| Root shutdown/error behavior | SIGINT drains all listeners; injected invalid child config exits root 1 and leaves no orphan listeners |
| Worker-only process | Reaches database/test-provider readiness with APIs stopped, claims fail closed with PostgreSQL `42501`, then drains cleanly |
| Whitespace/stale path audit | `git diff --check` passes; remaining old-path text is historical or a negative verifier assertion |

The worker-only `42501` is expected in this checkout: no registered
`ocr_worker` principal or environment-specific worker LOGIN exists. No job was
claimable or changed. Provisioning that deployment identity remains external.

## External verification pending

- build, scan, and execute the EHR and worker container images;
- provision environment-specific non-owner EHR and worker LOGINs;
- exercise production issuer/JWKS/audience/subject and rotating token mounts;
- verify PostgreSQL TLS with the approved CA;
- collect AWS private-network, IAM, S3 versioning, KMS, and Textract evidence;
- verify deployed gateway/observability behavior and authenticated publication;
- retain the already outstanding real NIN-provider and representative-device
  Outreach evidence.

## Exact next repository stage

The codebase already persists transactional outbox records but has no shared
delivery dispatcher or active consumer inbox foundation. The next repository
stage is therefore:

1. implement the bounded transactional outbox dispatcher; then
2. implement durable consumer inbox/dedup handling for at-least-once,
   idempotent processing.

That stage must preserve domain ownership, keep event payloads minimum-
necessary and PHI-safe, and avoid a distributed transaction. It is not part of
this layout convergence.
