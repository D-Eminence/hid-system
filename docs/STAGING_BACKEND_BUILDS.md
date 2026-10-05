# Automated staging backend builds

`Staging backend images` checks PRs and builds affected backend components.
Pushes to `staging-novu-ci-20261005` or `staging` also publish passing images to
existing staging ECR repositories using short-lived GitHub OIDC credentials.
Frontend-only changes do not run this pipeline. The current frontend release is
retained while the developer finishes its changes.

The pipeline installs service lockfiles, runs tests/type checks, builds ARM64,
generates an SPDX SBOM and rejects High/Critical Grype findings. Image transfer
between jobs is checked against hashes, source SHA and Docker configuration.
Immutable ECR tags contain source SHA, Actions run ID/attempt and Docker target.
Each `staging-digest-*` artifact includes `publication.json`, SBOM and scan result.
Terraform deployment uses the recorded `image_uri` digest as a separate step.
Other images and frontend archives keep their own original source provenance.

No runtime API keys, database passwords or production permissions are used by CI.
The AWS role trusts exact immutable repository/owner IDs and staging branches.
The owner should protect the staging branch against unreviewed changes. Existing
TUF production workflows are unchanged; CDK is not a gate for this pipeline.

To retry one component after the workflow is on the default branch, use Actions
→ Staging backend images → Run workflow, select the staging branch and component.
Until then, a push to the dedicated staging branch starts the workflow.

## Novu update

Developer fix `879ed55` provisions/updates the patient's Novu subscriber from
their current verified account email before triggering generic notification text.
The restricted worker uses `integration.notification_recipient_for_claim` rather
than reading identity/auth tables directly. Apply additive migration 0063 and
the reviewed runtime grants before deploying this worker. Existing migration
checksums remain unchanged. `test-notification-recipient.mjs` exercises real
restricted PostgreSQL logins using synthetic data in a disposable container.
