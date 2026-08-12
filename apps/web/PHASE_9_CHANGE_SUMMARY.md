# Phase 9 change summary - Bulk import and HID/EHR integration

Status: implemented locally; no remote database or function deployment has been performed.

## Delivered

- Versioned mapping-template contract for later source-specific mappings.
- Idempotent import jobs and independently retryable per-folder import items.
- One import item per source-folder version, protected by database uniqueness.
- Atomic canonical creation of medical records, first versions, structured data, provenance, and immutable source-file references.
- Import restricted to final `link_existing` match decisions.
- Corrected validation fields take precedence without modifying provider extraction history.
- Canonical category and `info_type` mapping for documents, laboratory results, and medication records.
- Post-import verification of canonical record IDs, current versions, and source lineage.
- Live import queue with execute, retry, and verify actions.

## Safety boundaries

- Pending-new-identity decisions remain `blocked_identity`; Phase 9 does not fabricate Auth users or unapproved Patient rows.
- Items are transactionally isolated, so one failed folder does not roll back successful folders.
- Retrying an imported item returns the existing targets instead of creating duplicates.
- Source scans remain in the private migration bucket and are referenced immutably. Lifecycle copying is deferred until the approved retention architecture is available.

## Verification

- Frontend production build: required before Phase 10 handoff.
- Atomicity, idempotency, RLS, and concurrent retry tests require an isolated retired hosted identity backend test database.
