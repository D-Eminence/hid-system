# HID EHR AI Instructions

These module instructions supplement, and never override, [`../CODEX.md`](../CODEX.md)
or the authoritative platform documentation under [`../docs/`](../docs/README.md).
When instructions conflict, follow the root authority.

## Tech Stack
- React
- Vite
- TypeScript

## Rules
- Never use `any`.
- Follow [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) first, then use
  [`ARCHITECTURE.md`](ARCHITECTURE.md) for EHR-specific runtime details.
- Read [`../docs/PRODUCT.md`](../docs/PRODUCT.md) before implementing features.
- Don't change the database schema without a migration.
- Ask before deleting or renaming files.
- Keep components modular.
- Use strict TypeScript.
- Don't hardcode production information or patient data.
