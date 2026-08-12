# HID Migrate module boundary

This directory is the production boundary for HID Migrate.

## Allowed dependencies

Migrate may import:

- canonical HID types from `src/types/hid.ts`;
- shared components from `src/components`;
- shared API, auth, observability and route utilities from `src/lib`;
- its own public domain contracts from `src/features/migrate/domain`.

Other HID modules may import only from `src/features/migrate/index.ts`. They must
not import Migrate screens, fixtures or internal workflow state.

## Domain ownership

HID Migrate owns migration workflow concepts such as Migration Case, project,
batch, source folder, scan session, processing result, validation, QA, matching
decision and import job.

It does not own Patient, HID Identity, Medical Record, Facility, Staff or Audit
Event. Those remain canonical HID entities. A `MigrationCase` references and
eventually feeds those entities; it never replaces them.

## Naming rules

- TypeScript domain/read models use the existing repository's snake_case fields.
- UI-only adapters may expose camelCase locally but must not redefine wire names.
- `hid_code` is the HID Number.
- Legacy identifiers are typed and tenant/facility qualified.
- Project, migration batch, scan batch, source document and import job IDs remain
  distinct.
- Case state, validation status, QA status, match status and import status are
  separate types.

## Design-system integration

- Use Inter for interface text and the globally bundled JetBrains Mono for IDs.
- Reuse shared `Button`, `Input`, `Select`, `Textarea`, `Card`, `Badge`,
  `PageLoader`, `EmptyState`, `Modal` and `BottomSheet` components.
- Consume semantic variables from `src/index.css`; do not establish a Migrate color
  palette or component family.
- Use `MigrationStatusBadge` to format prototype status labels through the shared
  HID `Badge`.
- Preserve the responsive capture workflow, but use the HID shell, spacing,
  focus, error and accessibility conventions.

## Current phase boundary

Phases 1-12 are implemented locally across persistent project operations, private
capture, durable processing, OCR/intelligence, validation, QA, patient matching,
idempotent canonical imports, patient-record integration, audit, observability and
hardening. Phase-specific change summaries identify the exact boundary and
environment-dependent verification still required.

Phases 13-14 are deployment preparation only. Their staging/UAT and controlled
production-launch artifacts intentionally leave external evidence and approvals
pending; this repository state does not claim a staging or production deployment.
