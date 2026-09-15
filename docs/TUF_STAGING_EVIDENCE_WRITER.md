# Prepared staging evidence archive writer

The reusable `.github/workflows/tuf-evidence.yml` and `release/scripts/append-staging-release-evidence.mjs` preserve independently approved staging evidence using the existing release trust `EvidenceWriterRole`. They are local preparation. No workflow run, AWS upload, deployment or production change has been performed by this work. Deployment remains paused while the quota request is pending. MetaMap remains deferred and disabled.

The adapter consumes an actual completed, successful, first-attempt producer run on the same approved source. Its artifact must contain exactly one regular file named `evidence.json`. The input must satisfy the existing promotion evidence contract and its mandatory checks, bind the exact staging release and artifact set, and have completed before archival. Supported evidence types are `staging-acceptance`, `migration-dry-run`, `staging-copy-migration`, `backup-restore` and `rollback-drill`. The adapter never creates passed checks or converts local preparation receipts into acceptance evidence. Production approval evidence is rejected.

The owner-approved configuration binds the protected caller source SHA separately from the immutable reusable workflow SHA, the exact caller path, repository and owner, fixed staging account `659225405023` and region `eu-west-1`, discovered writer role and evidence archive/key, release/artifact set, expiry, producer run/artifact IDs, artifact name/digest and exact evidence payload SHA-256/size. The GitHub API verifies the artifact archive digest metadata; the independently approved payload hash verifies the downloaded `evidence.json` bytes. Archive transport warnings cannot substitute different evidence bytes. Additional files, symlinks, duplicate JSON keys, reruns, forked producers, stale approvals and mismatched resources or source fail closed.

Before assuming AWS authority, the job checks the `staging-evidence-writer` environment's sole-owner review policy with no administrator bypass, the protected branch and actual reusable workflow OIDC claims, completed producer provenance, exact downloaded bytes and existing release contract. The OIDC claim comparison is a precheck; AWS STS verifies the independently obtained token's signature and the role's immutable workflow trust. The job checks source, owner policy and producer provenance again before upload. GitHub's environment runtime gate supplies the approval; this adapter does not independently retrieve approval-history records. [GitHub reusable workflow OIDC claims](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows).

The only AWS operations are caller identity, evidence archive versioning and Object Lock configuration reads, and one `PutObject`. Every S3 call pins the expected bucket owner. The destination is computed internally as:

```text
release-evidence/staging/<release-id>/<evidence-type>/<artifact-id>-<evidence-sha256>.json
```

No configurable prefix or broker namespace is accepted. The write supplies `If-None-Match: *`, SHA-256 checksum, exact content length and SSE-KMS key ARN, with S3 Bucket Keys disabled. The existing object-scoped KMS encryption context requires the object ARN. A single `PutObject` uses the existing `kms:GenerateDataKey` permission; multipart upload and decryption are not used. Conditional writing is enforced by this adapter, while existing IAM limits the object prefix and denies broker writes; this change does not add an IAM condition or widen any permissions. [AWS conditional PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html), [AWS SSE-KMS permissions and encryption context](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html).

The adapter requires enabled versioning and the reviewed `COMPLIANCE`/90-day bucket default immediately before writing. It inherits that default and does not send per-object retention headers: the existing writer has neither `s3:PutObjectRetention` nor `s3:GetObjectRetention`. S3 applies the bucket default when an upload does not supply individual retention. The receipt records the observed default, exact returned object version, encryption and checksum, and explicitly sets `per_object_retention_verified: false`. Subsequent version-specific retention readback belongs to the existing auditor capability. A concurrent administrator changing the default cannot be excluded by this writer's read-before-write check. [AWS Object Lock retention](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html), [Object Lock permissions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-managing.html).

An existing key, failed upload, timeout, missing version/checksum or encryption mismatch fails without retry, overwrite or success receipt. If an upload might have completed, reconcile the fixed key and exact version through the auditor before any new run. The successful local receipt reports only `approved-evidence-bytes-appended`; independent evidence truth, per-object retention, release admission and live staging acceptance remain unverified. Archival never authorizes deployment.

Copy `release/config/staging-evidence-writer.template.json` into ignored `release/local/` and fill it from approved source, discovered trust outputs and actual producer artifacts. The template intentionally contains `null` for values that do not yet exist and fails validation. No provider credential, private signing key or static AWS credential is required. Keep the evidence itself free of patient details and secrets: it is a bounded release control record.

| Protected staging environment variable | Value source |
| --- | --- |
| `TUF_EVIDENCE_SOURCE_SHA` | Actual approved protected caller commit |
| `TUF_EVIDENCE_WORKFLOW_SHA` | Actual approved reusable workflow/tooling commit |
| `TUF_EVIDENCE_CONFIG_JSON` | Exact reviewed configuration bytes, including producer payload pins and expiry |
| `TUF_EVIDENCE_CONFIG_SHA256` | SHA-256 of those exact bytes, including any retained newline |
| `TUF_EVIDENCE_WRITER_ROLE_ARN` | Discovered `EvidenceWriterRole` output, identical to configuration |

The agent derives those values when actual source, resources and evidence exist. They are not additional owner credentials to invent. Remaining external authorization is the normal owner environment approval for a concrete archival run and the separately reviewed release trust/custody and irreversible retention resource decisions. Before any run, approved reusable source must be installed, a subsequent staging caller must pin that immutable SHA, scoped trust resources must exist, and a real evidence producer must have completed. This preparation does not install a passing placeholder caller or produce synthetic acceptance evidence.

Focused local validation:

```bash
node --test --test-isolation=none release/test/staging-evidence-writer.test.mjs
```

The injected transports exercise conditional upload contents, provenance and environment/claim rejection, production and incomplete/future evidence rejection, bounded regular-file reads, wrong AWS roles, retention drift, ambiguous writes and response mismatches. No test contacts AWS or writes an archive object. Synthetic identifiers and evidence in unit tests are not staging evidence or trust material.
