# Staging broker request submission

The four reusable staging workflows and `release/scripts/submit-staging-signing-request.mjs` prepare the existing broker integration without creating keys, installing resources, invoking AWS or publishing a release during local validation. Production and deferred MetaMap work are unchanged. Missing configuration fails closed. These files are locally prepared; they are not installed or executed remote workflows.

| Workflow | Protected environment | Existing paired broker function |
| --- | --- | --- |
| `tuf-snapshot-signer-one.yml` | `staging-snapshot-signer-one` | `hid-staging-tuf-broker-snapshot-one` |
| `tuf-snapshot-signer-two.yml` | `staging-snapshot-signer-two` | `hid-staging-tuf-broker-snapshot-two` |
| `tuf-timestamp-signer-one.yml` | `staging-timestamp-signer-one` | `hid-staging-tuf-broker-timestamp-one` |
| `tuf-timestamp-signer-two.yml` | `staging-timestamp-signer-two` | `hid-staging-tuf-broker-timestamp-two` |

Each online role has a **one-of-two** signature policy. The two candidates are alternatives, not two signatures to schedule for every publication. Choose one approved snapshot candidate and one approved timestamp candidate. The existing broker rejects an unrelated competing request while a publication is pending; do not invoke the alternate candidate as an automatic retry or workaround.

The adapter first checks the protected caller source, a separately pinned reusable workflow/tooling commit, actual repository/owner IDs, owner-only environment policy, and successful same-source producer run and immutable artifact identity/digest. The artifact contains exactly a versioned public root and a signed input: `N.root.json` plus `M.targets.json` for snapshot, or `N.root.json` plus `M.snapshot.json` for timestamp. Each file must match its independently approved byte digest; extra files, symbolic links, private root fields, invalid timestamps and invalid signature thresholds are rejected before AWS credentials. The root uses the existing public-root validator. Root provenance/custody and the retained root rotation chain remain independently required.

After owner approval, the adapter constructs a fresh request using the existing Go `signingbroker.Request` schema `1.0.0`, preserving exact root/input bytes as base64. It uses the actual Go field order and existing whole-second clock rules. The approved request lifetime is bounded by the broker's role policy; preparation reserves at least an hour above the publication minimum. A practical proposed configuration is 96 hours for snapshot and 12 hours for timestamp; these are preparation values, not a provider assumption or automatic release approval.

Submission is limited to account `659225405023`, `eu-west-1`, the actual paired submitter role, and one numbered Lambda version ARN. It performs one STS identity read, one single-object conditional S3 upload and one synchronous qualified Lambda invocation. The request key is exactly:

```text
tuf-signing-broker/requests/hid-staging-broker-v1/ROLE-CANDIDATE/REQUEST_SHA256.json
```

The upload sends `If-None-Match: *`, the expected bucket owner, full-object SHA-256 checksum, `application/json`, the exact storage KMS ARN, disabled S3 Bucket Keys and the existing five metadata fields (`hid-schema`, `hid-state-id`, `hid-role`, `hid-candidate`, `hid-sha256`). It does not use a multipart upload, an ACL, retention override or direct KMS request. AWS documents the [conditional upload and checksum contract](https://docs.aws.amazon.com/cli/latest/reference/s3api/put-object.html) and the [single-object SSE-KMS permission requirement](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html).

The current submitter IAM grants `s3:PutObject` in its candidate namespace and encryption through S3, with no object read or `PutObjectRetention` grant. The existing bucket's 90-day COMPLIANCE default supplies retention. The broker independently reads the exact returned object version and validates retention, owner, media type, encryption, checksum, metadata and bytes before signing. No permission is broadened to let the client set or inspect retention. [AWS requires an additional permission for an explicit retention configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html).

The client rejects an absent/mismatched S3 version, checksum or encryption response and never invokes an unqualified Lambda or alias. It checks the Lambda response status and executed version, every release/request/input binding, output byte hash, the exact output metadata reference and the paired P-256 signature against the approved candidate SPKI in the public root. The broker remains authoritative for retained state, transition policy and request replay. These client checks do not replace independent materialization, admission, journal authorization or publication verification. [Lambda's invocation response contract](https://docs.aws.amazon.com/cli/latest/reference/lambda/invoke.html) distinguishes invocation success from function failure.

Before a cloud operation the adapter exclusively creates `staging-signing-attempt.json`. Reusing that runner attempt fails. The AWS CLI uses one attempt; neither upload nor Lambda failure is automatically retried. The workflow retains the attempt marker even when no successful result exists. After a timeout, transport error or malformed response, an authorized read-only operator must reconcile the exact request object, qualified broker and durable pending/completed state before a separately approved action. Do not turn a failed request into a fresh request with a new timestamp to bypass that review.

Copy `release/config/staging-signer.template.json` into a private staging review location. All `null` values deliberately fail. Resource ARNs, SPKI fingerprints, source/workflow SHA, release ID, metadata versions/digests and producer run/artifact IDs are derived from real reviewed resources, source and signed public artifacts. They are not values the user must invent. The owner supplies only the established public custody/provenance inputs and approval of the eventual concrete protected action. Private keys, PINs and provider credentials never enter the configuration.

Configure these public values separately on the selected candidate's protected staging environment after review:

| Variable | Required value |
| --- | --- |
| `TUF_SIGNER_SOURCE_SHA` | Actual approved caller/source commit on the protected branch |
| `TUF_SIGNER_WORKFLOW_SHA` | Actual approved reusable workflow/tooling commit, independently pinned by the caller and AWS role trust |
| `TUF_SIGNER_CONFIG_JSON` | Exact approved JSON bytes from the completed public configuration |
| `TUF_SIGNER_CONFIG_SHA256` | SHA-256 of those exact bytes |
| `TUF_SIGNER_ROLE_ARN` | Actual paired submitter role output, matching the configuration |

No static AWS key or GitHub secret is needed. The OIDC payload precheck is not a signature verifier; AWS STS independently verifies the action's token and immutable role trust. The workflow has no dispatch trigger or publisher call. A reviewed staging caller must use the actual immutable reusable workflow SHA; current source cannot be assigned a fabricated self-reference.

Validation command:

```sh
node --test --test-isolation=none release/test/staging-signing-submission.test.mjs
```

The nine local tests use temporary synthetic public metadata and injected transports. They cover all four capability bindings, real Go schema order, signed input closure, timestamps, canonical request bytes, exact upload/Lambda envelopes, output signature and hash substitution, wrong owner/account/role/candidate/source, ambiguous failures without retries, and exclusive attempt reservation. They do not establish AWS signing permission, real custody, a completed protected run or staging acceptance.
