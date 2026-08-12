# HID Migrate operations runbook

## Queue incident

1. Pause new project jobs using the Migrate feature/project control.
2. Inspect queue age, leased jobs, retries, and dead letters by project and provider.
3. Reclaim only expired leases. Never run the same non-idempotent provider callback manually.
4. Retry classified transient failures in bounded batches.
5. Leave corrupt, malicious, or quality-failed sources for rescan/review.
6. Record incident, correlation IDs, provider status, affected projects, and reconciliation result.

## Import incident

1. Stop new import items while allowing the current transaction to finish.
2. Verify each item independently against `target_record_ids`, current versions, and provenance.
3. Retry only `failed` or `verification_failed` items.
4. For a wrong patient or attachment, open a correction case and mark the item `correction_required`.
5. Preserve source assets, record versions, match decisions, and audit history.

## Security incident

1. Revoke affected sessions, project memberships, signed URLs, and provider credentials.
2. Disable Migrate by feature control if scope is uncertain.
3. Preserve append-only audit evidence and correlation IDs.
4. Assess patient/organization scope without copying PHI into tickets or chat.
5. Follow HID breach, legal, and hospital notification procedures.

## Recovery

- Restore database and storage into an isolated environment.
- Reconcile assets by SHA-256 and imported records by provenance/idempotency key.
- Requeue only jobs whose canonical outputs are absent.
- Record restore point, reconciliation counts, discrepancies, and approval.
