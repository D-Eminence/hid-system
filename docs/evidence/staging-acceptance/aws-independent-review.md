# Independent review of staging AWS remediation

Reviewer scope: read-only diff/context review after the AWS audit agent authored the staging patch. No duplicate tests, source edits, cloud API calls, synthesis or deployments were performed by this review.

Current result: **PASS for staging-only source isolation and least-privilege review; no must-fix concern identified.** This is review of a proposed successor patch based on `a709e643a731b444f7cb775b2b16fe28164146a7`, not a claim that the approved SHA already contains these fixes.

- Migration egress is additive only when `configuration.name === 'staging'` and `runtimeIngressEnabled` is true. The two added rules are TCP 443 to the existing AWS endpoint security group and TCP 443 to the externally verified regional Amazon S3 managed prefix list. Existing TCP 5432 is restricted to the database security group. No public IPv4/IPv6 CIDR or all-traffic egress is introduced. `allowAllOutbound: false` stays intact. Staging sleep gets no migration HTTPS egress.
- The endpoint SG is shared by the selected AWS interface endpoints, so the network rule permits reaching that endpoint group rather than only three individual service endpoints. AWS IAM remains an independent boundary: the migration task retains no business AWS policy and execution permissions/secrets are unchanged. The S3 prefix-list rule is a network destination range, not an object-key prefix or grant of S3 IAM authority.
- Only staging economy adds ECR API, ECR Docker, and CloudWatch Logs endpoints. This restores private task bootstrap paths; production/development profiles retain their existing lists. NAT count, task/public-IP boundaries, and database ingress remain unchanged.
- Staging EHR/OCR task policies replace invalid `s3:HeadBucket` with `s3:ListBucket` on the exact document-bucket ARN. No wildcard resource, object-write grant, KMS grant, or additional role is added. Actual health implementations call HeadBucket in `services/ehr-api/src/storage/s3-storage.provider.ts:41` and `services/ocr-worker/src/s3-document-reader.ts:18`. The AWS API documents ListBucket as the required HeadBucket permission. The production historical invalid action remains a separately recorded future production gate under this staging-only mandate.
- Staging alone gets the 4096-character CA parameter maximum and explicit matching-region/CA-root instructions. This does not disable hostname/certificate validation or add a CA default. Selecting the live database's matching public root and demonstrating its TLS chain remain external prerequisites.
- Regression checks explicitly cover live staging's endpoint/S3/RDS egress, no public migration egress, sleep closure, exact two-role bucket health grants, and parameter/template quotas. Existing acceptance controls were strengthened rather than bypassed.
- Diff includes staging economy cost attachments 4 to 7 and matching architecture/runbook/IAM documentation. The added private endpoints carry ongoing staging cost; no fabricated estimate or cloud creation is claimed.

Official references checked on 2026-09-08: [AWS HeadBucket permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadBucket.html) and [ECR VPC endpoints](https://docs.aws.amazon.com/AmazonECR/latest/userguide/vpc-endpoints.html).

Independent verification completed using the author's retained synthesis outputs, without rerunning synthesis/tests:

| Profile | Before/after result | Template SHA-256 | Bytes |
| --- | --- | --- | --- |
| Production | Independently recomputed byte-identical | `f05320072901de1b34d0004a3d9b95f6b16a88b31bff0c6682bf2d7cb1d6b2b6` | 464453 |
| Development | Independently recomputed byte-identical | `42cadadc0cda9ef7f13c86f27937b066662f417e5e5925fc2a46a1bb708db73c` | 517254 |

The evidence is `aws-candidate-template-equivalence.json`; this review recomputed each hash and byte comparison from the actual before/after files and saved results in `aws-independent-review-checks.json`. That file also records actual synthesized migration SG rules, including inspection for inline egress. Economy/fidelity have exactly three rules: RDS SG TCP5432, AWS endpoint SG TCP443, and `S3PrefixListId` TCP443. Neither has inline egress or any IPv4/IPv6 CIDR. Sleep has only the RDS SG TCP5432 rule.

The initial new regression test failed because optional destination fields were stringified to undefined; the author's test-only correction safely uses an empty string fallback. The final retained `aws-candidate-tests-final.log` contains 62 tests passed, zero failed/skipped. No production behavior or security guard was changed to make that test pass.

No dependent deployment may treat this review as cloud acceptance, approval to merge, or approval to change the release source pin. Missing staging identifiers, credentials, admitted artifacts and irreversible trust approvals continue to block deployment.

Reviewed source hashes:

- `infra/aws/src/config.ts`: `961f07911428048fc89dc34b81c834d27bd9bf5abc9d84ec6eebb9ee90e5752c`
- `infra/aws/src/hid-regional-stack.ts`: `4d01507501548a287fd13d162f07e1f23c28784747f260cbeb8fc94e8d6edbf6`
- `infra/aws/scripts/verify-synth.mjs`: `92e5f78a6697b12c43215dcebe79fc8f0c7bc361ff0d0f73dd6dd8d09493c3b8`
- `infra/aws/test/infrastructure.test.ts`: `cbb56672c2e3fea73f36a3f79c83d5c76eda425568af105c773375c3322ef8a2`
- `infra/aws/cost-inventory.json`: `b0d3949d80098f426651a0a6282eaf245260845de20f5f334e4bd8bdab9fe231`

Recorded: 2026-09-09T08:28:28.264659+00:00.
