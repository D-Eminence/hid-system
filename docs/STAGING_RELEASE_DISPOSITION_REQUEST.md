# Staging release decisions still required

Prepared 2026-10-04. This is a request for recorded decisions, not an approval.
Local candidate builds and tests do not close these findings.

## RF-005: official CDK dependency patch

The latest official `aws-cdk-lib` release is still 2.272.0 and bundles the
affected `brace-expansion` version. The current dependency audit reports one
high vulnerable package. The existing release policy requires a patched
official bundle and forbids overrides or suppression. Recheck the upstream
release, then update the lock and pass audit, AWS tests and offline synthesis.
Until that happens, this publication gate stays blocked. Deployment uses
Terraform, but that does not remove the repository's existing release gate.

## RF-006: former sandbox fixture values in pushed Git history

The security owner needs to record a disposition for the earlier exposure.
The current source has been remediated; a new commit cannot remove values from
earlier pushed commits. The baseline already includes the earlier PR merge.
No affected values are reproduced in this request.

Please record in the finding or a linked private security decision:

- Accountable owner and approver, decision date and affected repository scope.
- The access/exposure assessment and required remediation, with a ticket,
  responsible owner and completion date.
- Whether the staging release may proceed, and any conditions or expiry.
- If history remediation is required, the separately authorized procedure and
  coordination for existing clones, branches and retained artifacts.

This workstream preserves Git history. It does not grant that authorization or
create a security exception. `assert-publishing-source.ps1` requires a documented
closed/approved finding before publication; do not change only the status text
without its supporting decision.

## Other application gaps

Legacy billing settings, editable staff policy flags and dynamic AI routes
still have no complete native runtime counterpart. The exact values remain
preserved. Their operational implementation or explicit release deferral is
tracked in `DATABASE_CONFIGURATION_MAPPING_REQUIRED.md`. These are not reasons
to discard source rows or enable unsupported browser controls.
