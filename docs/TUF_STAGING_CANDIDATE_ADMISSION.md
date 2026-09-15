# Staging candidate admission

`.github/workflows/tuf-staging-candidate.yml` admits already signed staging TUF repository data and creates an immutable GitHub artifact containing `repository/`, `admission.json`, and `source-provenance.json`. It does not sign metadata, obtain cloud authority, publish, or establish live acceptance. The existing protected publisher independently verifies candidate run provenance, artifact identity, repository digest, approval, custody, and journal capabilities before deployment.

The workflow is dispatch-only, bound to `D-Eminence/hid-system` (repository ID `1317340803`, owner ID `182018869`). It requires its own workflow SHA and source checkout to equal the approved source SHA on the fixed protected branch `refs/heads/tuf-production-release`; other branches are rejected even if protected. The workflow file identity is fixed to `.github/workflows/tuf-staging-candidate.yml` on that branch. Only `contents: read` and `actions: read` are granted. Downloaded candidate data is never executed.

Configure a `staging-candidate` GitHub environment with exactly the sole owner `D-Eminence` as required reviewer, self-review permitted for the sole owner, administrator bypass disabled, and protected branches only. The job checks this policy through GitHub after the runtime approval gate. Its required environment variables are:

| Variable | Meaning |
| --- | --- |
| `TUF_STAGING_CANDIDATE_SOURCE_SHA` | Independently approved exact 40-character source and workflow SHA |
| `TUF_PROTECTED_REF` | `refs/heads/tuf-production-release` (the fixed approved release branch; the candidate environment remains staging only) |
| `TUF_STAGING_CANDIDATE_APPROVAL_JSON` | Exact approval-plan bytes described below |
| `TUF_STAGING_CANDIDATE_APPROVAL_SHA256` | Independently approved SHA-256 of those exact bytes; no implicit trailing newline |

The approval plan has exactly these fields. Values must come from actual approved source, trust ceremony, release artifacts, AWS staging identity, and successful artifact-producing workflow evidence; this document supplies no runnable placeholder approval.

| Field | Required value |
| --- | --- |
| `schema_version` | `hid.staging-candidate-approval/v1` |
| `environment` | `staging` |
| `git_sha`, `release_id` | Exact approved source SHA and immutable matching `rNNNNNNNNNN-gSHA` release ID |
| `repository_sha256` | Digest produced by the existing canonical TUF directory validator |
| `trusted_root_version`, `trusted_root_sha256` | Independently trusted retained staging root version and exact signed root bytes SHA-256 |
| `artifact_set_sha256` | Exact approved release artifact set digest |
| `aws_account_id`, `aws_region` | Actual approved staging account and region |
| `expires_at` | Unexpired UTC whole-second approval expiry |
| `source_run_id`, `source_artifact_id` | Immutable successful producer run and artifact IDs, decimal strings |
| `source_artifact_digest` | GitHub artifact archive digest, `sha256:` followed by 64 lowercase hexadecimal characters |
| `source_workflow_path` | Exact approved independent signed-data producer workflow path |

The producer must have succeeded through `push` or `workflow_dispatch` in this repository, on the same source SHA and protected branch. The artifact must be unexpired, belong to that run and repository, and match the independently approved GitHub archive digest. Missing configuration or unreadable GitHub policy/provenance fails closed. The producer workflow must be distinct from the candidate admission workflow.

Install the locked `release` and `infra/cloudflare` dependencies with lifecycle scripts disabled. Local data-only admission uses:

```text
node release/scripts/admit-staging-candidate.mjs admit ABSOLUTE_APPROVAL_JSON APPROVED_PLAN_SHA256 ABSOLUTE_SIGNED_REPOSITORY ABSENT_OUTPUT_DIRECTORY
```

Local output is `candidate-data-admitted` with `deployment_authorized: false`; it does not provide GitHub source provenance or owner approval on its own. The GitHub workflow verifies provenance separately and retains it alongside admitted data. The input repository remains unchanged; outputs are created exclusively and every copied file is rehashed against validated signed metadata.

Before publication, the approved publisher configuration must select `.github/workflows/tuf-staging-candidate.yml` as its candidate workflow and bind the resulting candidate run/artifact IDs and repository digest. The workflow does not call the publisher itself. Remaining prerequisites include real OCI/frontend artifacts with provenance and scan evidence, the independently signed staging repository and trusted root, signer/custodian and workload capability workflows, approved publisher caller/configuration, journal/Object Lock infrastructure, and staging deployment and acceptance evidence. Synthetic test repositories demonstrate code behavior only.

Validation: `node --test release/test/staging-candidate.test.mjs`. The tests exercise exact source and owner identity, artifact digest and producer failures, expired/production/unknown plans, fully signed synthetic repository admission, root/repository/artifact-set mismatch, signature tampering, exclusive output creation, and the workflow's absence of cloud permissions.
