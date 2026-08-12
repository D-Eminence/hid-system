# Phase 1 change summary

Scope: Foundation and Architecture Alignment only.

## Delivered

- Established `src/features/migrate` as the Migrate module boundary.
- Added one public import surface at `src/features/migrate/index.ts`.
- Moved the existing Migrate UI beneath the feature boundary.
- Defined canonical, immutable value lists for:
  - project roles;
  - Migration Case states;
  - project statuses;
  - document categories;
  - legacy identifier types;
  - validation, QA, match and import statuses;
  - matching bands and field-mapping statuses.
- Added the `MigrationCase` aggregate root for one physical patient folder moving
  through Migrate.
- Added source lineage, patient candidate, quality, decision and transition types.
- Added an exhaustive state-transition map with runtime guard/assertion helpers.
- Replaced the previous overloaded `MigrationStatus` with separate status families.
- Expanded the executable and human-readable data dictionaries.
- Aligned prototype project fixtures with canonical project fields.
- Reused the shared HID `Badge` for migration status presentation.
- Documented dependency, naming, ownership and design-system rules.
- Kept `src/types/migrate.ts` as a compatibility re-export.

## Explicitly not included

- Authentication or session changes.
- Project RBAC, membership enforcement or tenant isolation.
- retired hosted identity backend migrations, RLS policies or database tables.
- Edge Functions, APIs, storage or signed upload changes.
- OCR, AI, queues, validation persistence, matching or imports.
- Phase 2 or later implementation.

## Verification

- TypeScript compilation passed.
- Vite production and legacy builds passed.
- No whitespace errors were found.
- Scope guard found no changes to retired hosted identity backend, canonical HID/database types, auth,
  `hidApi` or retired hosted identity backend client code.
