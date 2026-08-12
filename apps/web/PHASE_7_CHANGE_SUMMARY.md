codenpm# Phase 7 change summary - Human validation and QA

Status: implemented locally; database migration and Edge Function deployment are not applied to a remote environment.

## Delivered

- Persistent validation and QA task queues tied to a specific source document and extraction version.
- Exclusive, expiring task leases with server-side claim and release operations.
- Append-only validation and QA decision tables with monotonically increasing versions.
- Validation decisions: approve, approve with corrected fields, reject, and send back.
- QA decisions: approve, return, and escalate.
- Project-configurable QA sample rate, self-validation prevention, and independent-QA enforcement.
- Automatic validation task creation after successful extraction.
- Automatic QA sampling for low-confidence and randomly sampled approved validation results.
- Capability checks through the existing Migrate project-role boundary.
- Live validation and QA workspaces using the shared HID design-system controls.
- Source-span and field-confidence display preserved in every review.

## Deliberate boundaries

- Corrected values are retained as an append-only decision payload; they do not overwrite provider extraction output.
- Phase 7 does not link or create patients and does not import clinical records.
- Audit decision tables provide immutable review history; Phase 11 will add normalized `hid_audit_events` taxonomy and correlation coverage.
- Remote retired hosted identity backend migrations and function deployment remain unperformed.

## Verification

- Frontend production build: required before Phase 8 handoff.
- Database/RLS execution: pending an environment with the retired hosted identity backend CLI and isolated test database.
