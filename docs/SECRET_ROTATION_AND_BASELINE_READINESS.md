# HID Secret Rotation and Git Baseline Readiness

**Status:** local pre-release audit complete; external secret administration and
release approval remain pending.  
**Audit date:** 2026-08-12  
**Authority:** this document is the single rotation and Git-baseline record for
the HID 1.0 convergence baseline.

## Scope and method

The audit scans the canonical source roots `apps`, `services`, `packages`,
`gateway`, `infra`, `scripts`, and `docs`, plus root policy/configuration
files. It excludes generated output, dependencies, local environment files,
editor state, and the explicitly historical `identity/` and
`upstream_snapshot/` directories. The scanner detects high-confidence private
keys, cloud access/session keys, GitHub tokens, Cloudflare and hosting tokens,
Supabase service roles, database password URLs, presigned URLs, service-account
private keys, SMTP/provider credentials, OAuth secrets, signing keys,
access/session cookies, and raw NIN values in non-test context. It prints only
finding locations and rule names, never values.

The local result is zero high-confidence secret findings in canonical text and
built frontend artifacts. Frontends are checked to use the public `VITE_`
environment prefix only; server-only secrets and database contracts are rejected
from source and output. A Turnstile **site key** or other public client
identifier is not treated as a secret and is never accepted as a substitute for
its server-side counterpart.

The current audit run passed all required local gates. A fresh authorized
disposable PostgreSQL 16.14 acceptance run applied `0001` through `0028`, left
zero pending, passed schema/RLS/ownership, non-owner denial, verified-TLS,
API outage/recovery/SIGTERM, OCR Worker and Event Dispatcher concurrency
checks, and removed its temporary cluster. No external database was contacted.

The scan intentionally does not treat an environment-variable name, a secret
reference, an identifier, or a placeholder as evidence that a credential was
committed or exposed. A focused, value-free scan of all locally reachable Git
objects found no high-confidence private key, AWS access key, GitHub token,
Supabase service-role key, database-password URL, or presigned AWS URL.

## Rotation inventory and required external action

No credential values are reproduced in this record. “Referenced” below means a
configuration name or public identifier was observed; it does **not** mean the
associated credential value was found.

| Item | Evidence and environment | Rotation / revocation action | Configuration update needed |
| --- | --- | --- | --- |
| Retired Vercel deployment token | The prior local workflow source referenced a GitHub Actions secret name only; no token value was found. The workflows have been removed from the canonical baseline. | Delete/revoke the GitHub Actions secret and the corresponding Vercel token in the retired Vercel team/project before final release. This is retirement hygiene, not a finding of exposure. | None in HID source; Vercel is not a target. |
| Vercel organisation/project identifiers | Historical workflow identifiers were configuration metadata, not credentials. The workflows are removed. | No secret rotation required. Retire the old Vercel project linkage if it still exists. | None. |
| Supabase URL and anonymous client key | Present only in ignored local Web configuration as public client identifiers; Supabase has no canonical runtime role. No service-role value was found. | No credential rotation is required solely for an anonymous public key. Review Supabase RLS and disable/archive the historical project according to its retirement plan. | Remove or replace the ignored local values only if local development is moved to another source. |
| Sentry DSN and PostHog client key | Present only in ignored local Web configuration as public browser telemetry identifiers. | No secret rotation required. Disable or replace the historical ingestion/project configuration when it is retired. | Update ignored local browser configuration only when a replacement project is approved. |
| Local database URL, authentication signing secret, and login pepper | Found only in ignored local development files; database endpoints classify as local. No canonical or Git-history value was found. | If any value was copied outside isolated local development or might be reused in a shared environment, generate a new independent value before use. | Place the replacement in the approved secret store/runtime environment, never in source or an `.env.example` file. |
| Cloudflare, AWS, GitHub, database-release, Turnstile-secret, NIN, FCM, Novu, SES/Termii/Meta/Infobip and similar provider credentials | Interfaces, placeholders, and secret-store references exist where required by the target design, but no credential value was found in canonical source or the focused history scan. | Do not invent or rotate a non-evidenced value. Mint, scope, and record each real production credential through the provider/secret-management change process before deployment. | Configure only through Cloudflare/AWS/provider secret mechanisms and ECS/runtime references; no frontend or Git source update may contain values. |

Before an approved deployment, the release owner must confirm that retired
Vercel and historical Supabase resources are no longer able to serve HID,
revoke any still-live retired-provider tokens, and record the new target
credentials by provider, owning environment, secret reference, rotation owner,
and last-rotated date in the approved external secret inventory. This repository
must retain only names and references, never values.

## Git baseline safety

`main` is an orphan-style clean baseline: it has one initial commit containing
only `README.md`. The index is empty. Legacy local refs exist separately, but
they are not ancestors of `main` and are not part of the baseline history. They
must not be pushed with the new baseline without explicit maintainer review.

The intended review/staging set is canonical source and documentation only:
root policy files, `CODEX.md`, `package.json`, `apps/`, `services/`,
`packages/`, `gateway/`, `infra/`, `scripts/`, and `docs/` (plus
legitimate package lock files where they already belong). No staging, commit,
push, tag, or deletion of historical artifacts is performed by this audit.

Root `.gitignore` excludes local `.env` forms, build output, dependencies,
coverage, editor/agent state, `identity/`, and `upstream_snapshot/`, while
preserving `.env.example` templates. `.dockerignore` applies the equivalent
build-context exclusions. The historical directories remain on disk and are
ignored rather than deleted.

## Migration and data-boundary assurance

`scripts/verify-migration-ledger.mjs` pins the accepted SHA-256 checksums for
migrations `0001` through `0028`. It fails if an accepted migration is edited,
missing, reordered, or if an unreviewed extra migration is introduced. Migration
`0028_identity_notification_migration_state.sql` is the accepted additive
migration: it adds HMAC-only OTP/rate-limit state, progressive assurance,
restricted legacy identity-link evidence, encrypted revocable device
registrations, and PHI-free notification delivery reconciliation. It creates no
plaintext OTP, device token, notification body, raw contact value, or raw NIN
store.

Existing runtime roles are explicitly `NOBYPASSRLS`; public access to the new
tables and notification schema is revoked. The disposable PostgreSQL acceptance
suite verifies the applied migration ledger has zero pending entries together
with schema, grants, RLS, non-owner denial, and TLS boundaries. RLS remains a
defence in depth for protected data; table ownership and explicit least-
privilege grants remain the primary service boundary for internal state.

## Required final gates

Before staging, rerun:

```text
npm test
npm run verify
npm run build
npm run build:cloudflare
npm run acceptance:container:database
git diff --check
npm run verify:prebaseline-git
```

Passing local checks does not authorize a deployment. DNS, Cloudflare, AWS,
Vercel, Supabase, email/SMS/push, NIN, and other external provider actions
remain separate, change-controlled approvals.
