# HID Migrate threat model

Status: implementation baseline; must be reviewed before real-data staging.

## Protected assets

- Original and derived patient documents, OCR text, extracted clinical fields, identifiers, canonical HID records, audit evidence, provider credentials, and encryption keys.

## Trust boundaries

- Browser/PWA to authenticated Edge Functions.
- Edge Functions to PostgreSQL and private Storage.
- Worker lease boundary to OCR/AI providers.
- Migrate staging data to canonical Patient and Medical Record entities.

## Principal threats and controls

| Threat | Required controls implemented in the baseline |
|---|---|
| Cross-tenant IDOR | Project access/capability checks, RLS, and database tenant-consistency triggers |
| Over-privileged staff | Project-scoped roles, expiring review leases, separation-of-duty policy |
| Wrong-patient attachment | Identifier-qualified candidates, masked comparisons, manual final decision, one-decision constraint |
| Duplicate import | Folder-version and idempotency uniqueness, row lock, idempotent return |
| Malicious upload | Private bucket, signed uploads, quarantine, checksum, security-scan job before acceptance |
| Source tampering | Immutable original asset hashes and append-only OCR/extraction/decision evidence |
| PHI leakage | No public bucket, short signed access, protected-route analytics controls, no PHI in operational logs |
| Provider outage or abandonment | Durable jobs, leases, heartbeat, bounded retries, dead-letter state |
| Shared-device loss | No service-worker document cache; short sessions and encrypted offline queue remain deployment requirements |
| Destructive correction | Correction cases and compensating/versioned remediation; no hard merge/delete |

## Residual launch risks

- OCR/AI vendor region, retention, training prohibition, and contractual terms require governance approval.
- Offline encrypted-queue threat modelling requires device/platform validation.
- Unclaimed patient/account claiming remains unresolved; new-identity imports stay blocked.
- Penetration testing and backup/restore drills require a production-equivalent staging environment.
