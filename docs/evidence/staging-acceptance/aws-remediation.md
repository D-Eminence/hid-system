# Staging AWS remediation candidate

**UNAPPROVED REMEDIATION CANDIDATE** based on `a709e643a731b444f7cb775b2b16fe28164146a7`. No commit, push, cloud mutation or deployment. **STAGING DEPLOYMENT AUTHORIZATION: BLOCKED**.

The three confirmed source blockers are corrected for staging only. Economy adds ECR API/DKR and Logs endpoints in one AZ; Gateway/OCR Worker/Event Dispatcher retain no public HTTPS egress. Migration gains HTTPS only to the AWS endpoint security group and regional S3 prefix list in live staging. Sleep keeps migration HTTPS closed. EHR/OCR use `s3:ListBucket` on the exact document bucket for HeadBucket. Staging RDS root input is capped at4096 characters with actual-region/CA selection guidance; a full global bundle is not embedded.

Four focused tests cover required bootstrap endpoints, restricted migration destinations, sleep closure, exact-bucket IAM grants and parameter/template quotas. Final62/62 infrastructure tests pass; typecheck, cost inventory, default+sleep/economy/fidelity synthesis and synth/policy verification, and diff whitespace all pass. The first new test attempt failed on an optional-field test helper; that log remains retained and the corrected rerun is separately logged.

Production and development generated templates are byte-for-byte identical before and after:

| Profile | SHA-256 before and after | Bytes |
| --- | --- | ---: |
| production | `f05320072901de1b34d0004a3d9b95f6b16a88b31bff0c6682bf2d7cb1d6b2b6` | 464453 |
| development | `42cadadc0cda9ef7f13c86f27937b066662f417e5e5925fc2a46a1bb708db73c` | 517254 |

## Candidate template counts

| Profile | Bytes | Resources | Parameters | Outputs |
| --- | ---: | ---: | ---: | ---: |
| default | 517254 | 412 | 62 | 21 |
| sleep | 276270 | 207 | 37 | 20 |
| economy | 512641 | 413 | 62 | 21 |
| fidelity | 516287 | 416 | 62 | 21 |

All native templates remain under the1MB S3 template limit. Use an S3 template URL for these templates, which exceed the51200-byte inline request limit. Actual account-bound synthesis remains unavailable until real AWS/AZ context is verified; fixture assemblies are not deployable evidence.

## Changed files

- `docs/AWS_COST_MODEL.md`
- `docs/AWS_DEPLOYMENT_ARCHITECTURE.md`
- `docs/AWS_DEPLOYMENT_RUNBOOK.md`
- `docs/AWS_IAM_MATRIX.md`
- `infra/aws/cost-inventory.json`
- `infra/aws/scripts/verify-synth.mjs`
- `infra/aws/src/config.ts`
- `infra/aws/src/hid-regional-stack.ts`
- `infra/aws/test/infrastructure.test.ts`

Patch SHA-256: `9560d59f42b924edab6a635a245b98b4ec2d1a4f30edfa948afaa9beaa009094`. Full file hashes, exact command logs and templates are recorded in `aws-remediation.json`, `aws-candidate-command-results.json`, and `aws-candidate-template-equivalence.json`.

## Remaining gates

- Approve immutable candidate source through repository governance; original approved SHA unchanged
- Refresh approved staging AWS session and verify actual account/region/AZ/resource identifiers
- Verify real RDS CA/root,TLS,certificates,secret CMK grants and role isolation
- Prove rotating workload JWT delivery and provider prerequisites
- Bind admitted ARM64 images/provenance and actual release-trust state
- Review account-specific quotas,cost,diff,retention/custody and rollback inputs
- Deploy and validate actual staging health/security/migrations/backup/restore/forward rollback

Known limits: production/development retain their existing unrelated source defects because their configuration is locked. Three added economy endpoint/AZ attachments increase fixed cost; current quantities are recorded without invented pricing. Live IAM, credentials, monitoring delivery, TLS, migrations, restore and rollback are NOT VERIFIED. No local result changes the final staging acceptance decision.

Independent review found no must-fix concern and recomputed template equality from the actual files. See `aws-independent-review.md` and `aws-independent-review-checks.json`.
