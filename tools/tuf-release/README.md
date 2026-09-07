# HID TUF release tooling

This module contains the repository-owned, noninteractive release verifier and
deterministic frontend artifact tooling. It is pinned to `go-tuf/v2` v2.4.2.
Release builds use Go 1.26.8 with distribution, binary and container hashes in
`toolchain/production-build.json`. Run `node scripts/verify-production-toolchain.mjs`
with that Go on PATH (or set `HID_TUF_BUILD_GO`), then run
`node ../../release/scripts/go-vulnerability-gate.mjs` before building.
The historical Go 1.25.0/reference-client manifest remains an isolated
interoperability oracle. It is not an approved release toolchain: the Phase C
audit found reachable standard-library vulnerabilities in that old build.

The production client has no signing command and never bootstraps a root from a
remote repository. A caller must supply an out-of-band trusted `root.json`, its
SHA-256, an explicit environment/release ID, exact repository origins, and a
durable environment-specific state directory.

`hid-tuf get-batch` accepts a bounded strict-JSON request with this shape:

```json
{
  "schema_version": "1.0.0",
  "targets": [
    {
      "target": "environments/staging/releases/r0000000001-g0123456789abcdef0123456789abcdef01234567/release-bundle.json",
      "output": "/absolute/new/workspace/release-bundle.json"
    }
  ]
}
```

The request must be a no-follow regular file of at most 1 MiB. Its schema is
exact (unknown or duplicate JSON members and trailing values are rejected) and
contains 1 through 512 entries. Targets are bounded to 512 bytes and to the
selected environment/release namespace. Outputs are bounded to 4096 bytes and
must be canonical absolute paths that are absent, mutually distinct and
non-overlapping, outside client state, and below symlink-free ancestors.

The command validates the whole set before writing, uses one authenticated
refresh and state lock, and commits every verified output without replacement.
Use a new disposable workspace for each batch because a later repository or
filesystem failure can leave earlier verified outputs present.

Repository-generation code under `internal/testrepo` is test-only. Its keys are
created inside test temporary directories and are not production key material.
Production root/targets provisioning remains an offline ceremony and approval
gate described in `docs/TUF-PRODUCTION-IMPLEMENTATION.md`.

Generated archives, client state, roots, metadata, and signing material are not
source files and must remain outside Git.

## Repository operator boundary

`hid-tuf-repo` is separate from the production verifier and has only these
role-specific operations:

```text
prepare-targets
prepare-targets-attestation
complete-targets-evidence
assemble-targets
sign-snapshot
sign-timestamp
materialize-generation
```

It does not create/import keys or expose a raw-message signing command. All
inputs are strict, bounded JSON or metadata files at canonical absolute paths;
reads resolve every path component without following symlinks, and outputs are
create-only. Metadata versions are positive JavaScript-safe integers.

The targets ceremony produces canonical `targets.signed.json` and
`targets-signing-request.json`. Each of the two detached custodian records must
contain the ordinary TUF signature plus a second same-key, domain-separated
attestation over the complete request, key ID, TUF signature, and signing time.
Assembly rejects context changes, evidence reuse, and mixed custodians.

For each custodian, use a separate empty `0700` output directory because the
two ceremony outputs have fixed basenames. First sign the exact raw bytes of
`targets.signed.json` once with the custodian's authorized P-256 targets key,
ECDSA/SHA-256, and encode the resulting ASN.1 DER signature as lowercase hex.
Then run:

```text
hid-tuf-repo prepare-targets-attestation \
  /absolute/targets-plan.json /absolute/1.root.json /absolute/prepared \
  KEY_ID TUF_SIGNATURE_DER_HEX 2026-09-02T12:00:00Z \
  /absolute/custodian-1/targets-evidence-attestation-statement.json
```

Sign the exact raw bytes of the generated statement once using the same key and
ECDSA/SHA-256, again returning lowercase ASN.1 DER hex. Do not reserialize the
JSON, sign the stdout receipt, sign its displayed SHA-256, or hash either input
before passing it to a signing API that already applies SHA-256. Complete the
record with:

```text
hid-tuf-repo complete-targets-evidence \
  /absolute/targets-plan.json /absolute/1.root.json /absolute/prepared \
  KEY_ID TUF_SIGNATURE_DER_HEX 2026-09-02T12:00:00Z ATTESTATION_DER_HEX \
  /absolute/custodian-1/targets-signature-evidence.json
```

Repeat in `custodian-2`, then pass the two completed evidence files to
`assemble-targets`. These commands accept public signatures only. Never pass a
private-key path, hardware-token PIN, provider credential, or signing session
to this CLI; private-key interaction remains entirely inside the independently
controlled offline ceremony.

Online plans are role-specific and bind the exact input, current root, previous
same-role metadata, and previous root. Genesis starts at version 1. A successor
may keep selected input bytes identical or advance them once, must advance its
own role once, and may use only the identical root or an authenticated next
root. The CLI rejects plans older than five minutes or more than one minute in
the future before loading AWS configuration. This ordinary CLI contract never
accepts a caller-selected high-water or skipped version.

Direct GitHub-to-KMS signing is forbidden. The AWS source grants no
GitHub-assumable role `kms:Sign`; `sign-snapshot` and `sign-timestamp` are local
construction/preflight boundaries, not an authorized production CI entrypoint.
The fixed AWS broker is source-implemented but uninstantiated. It obtains root,
key, clock, current publication state, pending decisions, and separate
snapshot/timestamp version high-water marks from its protected checkpoint. Only
that broker advances one from a durable high-water after an exposed pending
version becomes stale; exact old requests replay archived bytes without KMS.
New signing reserves 30 minutes above the hard publication floors and rechecks
the complete output immediately before CAS. A caller-supplied predecessor hash
is not that trust anchor.

`materialize-generation` permits no predecessor only for an all-version-1
genesis. Every successor pins the exact previous repository SHA-256. Before an
exclusive atomic commit, the materializer validates retained root rotation,
role signatures, metadata references, sequential root/targets continuity,
strict ordinary snapshot/timestamp successor transitions, target immutability,
and physical target closure. A TUF-valid broker recovery may burn an unpublished
online version, but `materialize-generation` deliberately cannot authorize that
gap. Use the separately state-authenticated operator below for pending recovery.
Run the independent validator before any upload:

```text
npm --prefix infra/cloudflare run tuf:validate -- staging /absolute/repository
```

## Read-only publication operator

`hid-tuf-publication` reads the strongly consistent checkpoint head and
authenticates its immutable state journal. It has no signing or state-write
operation. Authorization compares the exact current and pending role bytes,
reserves 30 minutes above the publication floors, and reloads state before
issuing a five-minute decision. It is evidence, not a bearer token or lock.

```text
hid-tuf-publication /absolute/publication-config.json \
  /absolute/previous-repository EXPECTED_PREVIOUS_REPOSITORY_SHA256 \
  /absolute/candidate-repository EXPECTED_CANDIDATE_REPOSITORY_SHA256

hid-tuf-publication materialize /absolute/publication-config.json \
  /absolute/generation-plan.json /absolute/absent-destination

hid-tuf-publication confirm /absolute/publication-config.json \
  /absolute/candidate-repository EXPECTED_CANDIDATE_REPOSITORY_SHA256 \
  EXPECTED_PRIOR_STATE_REVISION
```

The protected predecessor hash must come from the retained evidence of the
previously published complete generation, not be recomputed from an unchecked
local predecessor or supplied by the candidate. Durable role hashes alone
cannot prove the entire retained file closure. Only initial all-version-one
bootstrap permits `- -` instead of the predecessor path and hash; both state
reads must prove absence and the root must equal the fixed bootstrap pin.

The `materialize` variant accepts the same strict generation plan, requires a
predecessor, and authorizes the pending tuple before construction and immediately
before atomic directory commit. It can consume broker-burned online gaps while
preserving published immutable files and sequential offline root/targets
lineage. A failed final authorization leaves no destination. Its output is not
permission to publish: the wrapper must independently reauthorize it and check
the protected predecessor hash.

`confirm` is a separate read-only post-canary observation, not another pending
authorization. It requires the exact candidate to be the durable published
tuple at a revision greater than the attempt's recorded prior revision. It
reads state twice, rejects drift/cancellation/clock rollback, and rechecks the
actual-time freshness floors after the final read. Prior revision zero is only
for the all-version-one bootstrap. The result schema is
`hid.tuf.publication-confirmation/v1`; the publisher must not invoke the
checkpoint canary or write its state to make this check pass. This observation
does not replace public endpoint verification or serialize other publishers.

The configuration is strict bounded JSON with schema
`hid.tuf.publication-reader/v1` and exactly these fields: `schema_version`,
`environment`, `repository_id`, `state_id`, `bootstrap_root_sha256`, `table_name`,
`bucket_name`, `state_object_prefix`, `expected_aws_account_id`,
`expected_aws_region`, `encryption_key_arn`, and `object_lock_mode`.
The uninstantiated AWS stack exposes the public configuration as
`PublicationReaderConfiguration`. Review and hash the resolved configuration
before placing it on an isolated protected runner. Its credentials need only
the exact state-row read, versioned state-object/retention reads, and S3-context
decryption grants provided by the publisher role; no direct KMS signing.

Actual Cloudflare upload, deployment and initial-route activation require these
separately protected runner values:

```text
HID_TUF_PUBLICATION_EXECUTABLE
HID_TUF_PUBLICATION_EXECUTABLE_SHA256
HID_TUF_PUBLICATION_CONFIG
HID_TUF_PUBLICATION_CONFIG_SHA256
HID_TUF_PREVIOUS_REPOSITORY
HID_TUF_PREVIOUS_REPOSITORY_SHA256
```

Executable/configuration paths must be canonical absolute non-symlink regular
files, not group/other writable. The wrapper accepts only fresh process output,
never an authorization file supplied alongside the candidate. Upload uses a
private hash-rechecked copy; upload/deployment receipts are schema `2.0.0` and
bind the state revision, all metadata hashes, repository hashes and operator
pins. Old schema `1.0.0` upload/deployment receipts are rejected. Receipt outputs
must be absent, canonical, outside the repository and below symlink-free
ancestors; these checks precede external operations.

Per-environment serialization covers upload, preview admission, deployment,
initial route activation when needed, and read-only public confirmation. The
reusable `.github/workflows/tuf-publish.yml` definition keeps build/test work
credential-free, then enters a distinct protected staging or production
publisher environment. Its first step binds the protected branch, immutable
workflow SHA, numeric repository/owner IDs, actor/run identity, GitHub-hosted
runner, required non-self reviewers, disabled administrator bypass, and the
environment returned by GitHub before loading downloaded code or credentials.
AWS independently enforces the same immutable OIDC identity.

`hid-tuf-journal` is the durable coordination adapter. It accepts exactly one
strict request and a separately pinned `hid.tuf.publication-journal-operator/v1`
configuration:

```text
hid-tuf-journal /absolute/journal-config.json EXPECTED_CONFIG_SHA256 \
  /absolute/request.json
```

Supported actions are `begin`, `advance`, `confirm`, `fail`, `read`, `evidence`,
and `archive`. There is deliberately no reset, deletion, takeover, retry, steal,
or resume operation. The store uses the existing environment broker DynamoDB
table for a strongly consistent conditional head and the existing Object-Locked
evidence bucket for fixed create-only revision slots. Each slot records and
authenticates its exact predecessor object version/hash; every read replays the
whole transition chain, compares the head twice, checks for an occupied next
slot, and revalidates checksum, KMS envelope, exact metadata, and the original
2-year (730-day) retention deadline.

Before publication, `archive` preserves every repository file as immutable
content-addressed data and seals a complete manifest after a second whole-tree
inspection. `evidence` accepts only the bounded structured publication envelope,
uses a digest-derived key, and reads back its bytes and 2-year (730-day) retention.
This local configuration does not authorize infrastructure creation: Object Lock
remains **UNAPPROVED / NOT CREATED**.

The live protected driver records an intent with a new five-minute state
authorization immediately before each Cloudflare side effect and records only
validated structured receipts afterward. Hashes in journal records reference
these authenticated immutable envelopes; raw errors, provider responses, tokens,
and secrets are never journal fields.

A failed or ambiguous attempt is not safe to resume. Lost S3 or DynamoDB commit
responses, orphan slots, failed external calls, expired attempts, and unknown
outcomes freeze the environment for independent reconciliation. Recovery means
reading the retained immutable chain and provider state, producing governed
reconciliation evidence, and starting a new forward-version attempt only after
an approved future recovery mechanism has established the outcome. Never retry
an external effect automatically, reset the journal/checkpoint, reuse a consumed
version, or activate an old Worker as rollback. Source and local tests do not
authorize a live workflow run or staging deployment.

Checkpoint schema `2.0.0` is stored in AWS state-manifest `v3`. There is no
backward-compatible `v2` reader because this stack has never been instantiated:
initial staging must assert empty state and bootstrap directly at `v3`. A future
populated-state migration must preserve the immutable journal ancestry and both
online-role high-water marks; resetting state would permit version reuse and is
forbidden.

The supply-chain evidence verifier always checks the project module graph and
the downloaded upstream module's sum, origin commit, `go.mod`, and `go.sum`.
`--require-installed` additionally checks the pinned Go/reference binaries and
their embedded Go build metadata. For independent evidence revalidation, pass
`--source-dir` with a clean v2.4.2 checkout, `--go-distribution` with the pinned
Go tarball, or both `--build-a` and `--build-b` with retained build artifacts.
