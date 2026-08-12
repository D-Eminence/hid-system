# HID Migrate controlled production launch runbook

Status: launch preparation only. Production deployment is not authorized.

## Mandatory approvals

- Canonical unclaimed-patient/account-claim architecture.
- Branch/department model and controlled clinical schemas.
- Provider, region, retention, legal hold, and deletion policy.
- Matching and QA thresholds with separation-of-duty policy.
- Pilot organization, volume, support model, SLOs, RTO/RPO, and success metrics.
- Staging UAT, penetration test, restore drill, privacy review, and clinical governance sign-off.

## Pre-launch checkpoint

1. Freeze release commit and record frontend, functions, workers, migrations, and schema versions.
2. Confirm encrypted database/storage backups and successful restore evidence.
3. Dry-run forward migrations against a production-sized sanitized copy.
4. Confirm feature control is disabled globally and enabled for no organizations.
5. Validate secrets, provider quotas, queue capacity, alert routing, on-call roster, and support desk.
6. Re-run build, dependency audit, Migrate contract/schema tests, smoke tests, and PHI-log scan.
7. Record go/no-go approvals in the release evidence register.

## Pilot sequence

1. Deploy backward-compatible database expansion.
2. Deploy functions and workers with job-schema compatibility.
3. Deploy frontend artifact.
4. Run synthetic production smoke checks while Migrate remains disabled.
5. Enable one approved organization and one project.
6. Import a deliberately small first batch.
7. Reconcile every folder, patient decision, record, version, file, checksum, and audit event.
8. Hold capacity until daily clinical/security/operations review approves expansion.

## Stop conditions

- Any cross-tenant access, wrong-patient attachment, public/long-lived document access, missing audit evidence, unreconciled import, persistent PHI logging, or restore failure.
- Queue age, provider failure, cost, import error, or storage growth exceeds approved threshold.

## Rollback and containment

- Disable Migrate/project job creation through the platform control.
- Allow safe active leases/transactions to finish, then stop workers.
- Roll back frontend and workers to prior immutable artifacts.
- Prefer corrective forward database migration; do not destroy imported evidence.
- Open correction cases for wrong matches/attachments and use compensating record versions.
- Rotate exposed credentials and revoke sessions/URLs when security containment is required.

## First-week review

- Daily reconciliation, queue/dead-letter, accuracy, false-match, cost, access, and incident review.
- Daily staff access and assignment review.
- No volume increase without signed operational and clinical approval.
