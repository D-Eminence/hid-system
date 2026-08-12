# Phase 11 change summary - Audit, security, and observability

Status: implemented locally; dashboards and alerts require deployed infrastructure.

## Delivered

- Cross-phase database trigger enforcing organization/facility/project consistency.
- Append-only protection for OCR, classification, extraction, validation, and QA evidence.
- Correction-case model for wrong-patient, wrong-attachment, clinical-data, and duplicate-identity remediation.
- Provider/service cost events with project attribution.
- Project operations view covering folders, pages, queue depth, dead letters, validation, QA, imports, and cost.
- Shared PHI-safe migration audit writer with actor, project, resource, reason, request/correlation ID, and metadata.
- RLS for correction and cost resources.
- Static migration-contract verification for required tables, RLS, exceptional states, and unsafe patterns.

## Operational boundaries

- No correction case performs a destructive delete or hard merge.
- Production alert routing, provider-cost tables, SLO thresholds, and retention jobs remain environment-specific launch configuration.
- OCR text, extracted patient fields, names, phone numbers, and NIN values are prohibited from operational logs.
