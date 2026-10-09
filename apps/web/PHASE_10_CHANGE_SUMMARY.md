# Phase 10 change summary - Patient Folder integration

Status: implemented locally; no remote deployment has been performed.

## Delivered

- Completed Migrate items resolve to the existing `/hospital/patient-records/:hidCode` experience.
- No parallel Migrate-owned patient folder or clinical record store was introduced.
- Canonical medical records retain migration project, source folder, source document, import item, and schema-version provenance.
- Shared record cards display a `Validated archive import` source badge.
- Original accepted scans appear through the existing signed record-file flow while retaining their migration bucket and immutable asset link.
- Completed-records workspace lists canonical patient identity and verified import status.

## Security behavior

- Opening a completed patient record continues through existing HID patient-access/grant enforcement.
- Record file downloads continue through the existing authenticated signed-download function.
- The completion list exposes only the project-scoped patient identity returned by the protected Migrate import API.

## Verification

- Frontend production build: required before the Phase 11 handoff.
- Runtime access and signed-download tests require a migrated isolated retired hosted identity backend environment.
