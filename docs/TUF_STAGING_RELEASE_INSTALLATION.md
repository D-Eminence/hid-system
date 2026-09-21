# Staging release workflow installation

The current staging application changes and the eight new candidate/capability workflows are prepared in [draft PR #2](https://github.com/D-Eminence/hid-system/pull/2). Ordinary CI runs on that review branch. They have no approved successor commit or protected execution receipt. The protected source branch remains `refs/heads/tuf-production-release`; its name grants no production authority. No workflow is dispatched while the Fargate quota request is pending.

The read-only GitHub observation at `2026-09-14T14:45:38Z` recorded remote source `a709e643a731b444f7cb775b2b16fe28164146a7` with seven successful required checks. Only `tuf-local-gates.yml`, `tuf-protected-readiness.yml` and reusable `tuf-publish.yml` existed on that source. It preceded the separately recorded installation of eight staging environments; use the later environment installation receipt for current policy state.

| Workflow | Local preparation and remaining implementation |
| --- | --- |
| `tuf-staging-candidate.yml` | Prepared and tested. Admits already signed staging data from an independently approved producer run/artifact. It cannot sign or deploy. |
| `tuf-audit.yml` | Prepared and tested. Reusable, staging only, with the existing auditor IAM role. Reads archive retention and public signing key pins; see the exact scope below. |
| `tuf-publish.yml` | Existing reusable protected publisher. Requires an immutable caller, approved configuration/tooling and admitted signed data. A callable publisher is not a completed release arrangement. |
| `tuf-build.yml` | Prepared and tested. Builds the 12 ARM64 application/migration outputs across 11 staging repositories, or the separate AMD64 signing broker. Uses native, mode-bound runners and narrowly scoped staging ECR permissions. Production trust templates are unchanged. See [image build preparation](STAGING_IMAGE_BUILD.md). |
| `tuf-evidence.yml` | Prepared and tested. Archives exact independently approved same-source evidence with conditional SSE-KMS writes and existing `release-evidence/*` permissions. Rejects production/incomplete evidence and cannot enter the broker namespace. See [evidence writer](TUF_STAGING_EVIDENCE_WRITER.md). |
| Four snapshot/timestamp submitter workflows | Prepared and tested with the existing immutable broker request contract, exact candidate S3 scope and numbered Lambda version. The client verifies signed public input and paired output signatures, reserves an exclusive attempt and never retries an ambiguous operation. See [signing submission](TUF_STAGING_SIGNING_SUBMISSION.md). No live signing or remote installation occurred. |
| Staging callers | Must reference the actual reusable workflow commit SHA and pin the reviewed caller source. No fabricated SHAs or passing placeholder callers are installed. |

The private machine-readable installation plan is `release/local/20260915-staging-preparation/release-installation-plan.json`. Workflow files, roles, source/build digests, artifact/run IDs and provider/resource identifiers are values the agent derives. They do not belong in `USER INPUT REQUIRED` merely because they are currently absent.

The auditor uses only existing scoped permissions: STS caller identity; each of three archives' location, versioning and Object Lock configuration; descriptions of their three storage keys; and descriptions/public keys for four online signing keys. It compares the exact staging account, region and assumed role, requires versioning, `COMPLIANCE` with the configured 90-day bucket default, enabled customer-managed keys and four independently pinned P-256 SPKI digests. Bucket owner checks accompany every S3 read. It performs 21 read operations and no writes, signing or deployment. These checks follow the [AWS Object Lock API](https://docs.aws.amazon.com/cli/latest/reference/s3api/get-object-lock-configuration.html) and [KMS public key API](https://docs.aws.amazon.com/cli/latest/reference/kms/get-public-key.html).

This limited result does not verify bucket encryption configuration/policies, every object's retention, root/targets custody, journal/checkpoint state, release admission or application acceptance. The existing auditor role cannot read every bucket configuration API; the workflow does not silently broaden it. A successful receipt explicitly retains those limitations and `deployment_authorized: false`.

Populate a private copy of `release/config/staging-auditor.template.json` only from actual approved source, discovered trust resources and reviewed public key pins. `null` values fail validation. Configure these public values on the existing `staging-auditor` environment after review:

| Variable | Exact value source |
| --- | --- |
| `TUF_AUDITOR_SOURCE_SHA` | Approved caller source commit on the protected branch |
| `TUF_AUDITOR_WORKFLOW_SHA` | Actual approved reusable workflow/tooling commit |
| `TUF_AUDITOR_CONFIG_JSON` | Exact approved JSON bytes; include source/workflow SHA, caller path, discovered role/archive/key ARNs and public SPKI pins |
| `TUF_AUDITOR_CONFIG_SHA256` | SHA-256 of those exact bytes, including any deliberately retained newline |
| `TUF_AUDITOR_ROLE_ARN` | Actual `AuditorRole` stack output; must match the approved configuration |

The workflow commit and caller source are deliberately separate. Installing a caller that contains an immutable reference to an earlier approved reusable workflow commit avoids a self-referencing commit hash. The workflow verifies protected source, exact caller path, owner-only environment policy and immutable reusable identity before assuming AWS credentials. The local OIDC claim precheck is not signature verification; AWS STS verifies the token and exact role trust. [GitHub documents the separate reusable workflow claims](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows). No GitHub secret or static AWS key is required by this adapter.

Installation sequence remains: review the completed local bounded adapters; create the successor review branch/PR with its actual source SHA and ordinary CI; install the approved reusable workflows through normal source controls; derive immutable caller references in a subsequent source change; fill machine-generated public configuration from reviewed staging resource outputs; obtain the actual owner environment approval when a concrete run is ready. Default-branch workflow dispatch discoverability must also be checked before scheduling a dispatch. None of these steps permits bypassing branch requirements or production protection.

The owner still supplies the actual public custody assignments and authenticated public root/provenance from the established ceremony. Creation of irreversible retention resources requires a concrete account-specific plan and the owner's separate decision. Private keys, PINs, recovery material and provider secrets remain outside chat and Git. MetaMap remains deferred and disabled; its work is unchanged.

Validation: `node --test --test-isolation=none release/test/staging-release-audit.test.mjs` exercises the real adapter with an injected read-only transport, context/config/owner/immutable-claim rejection, role substitution, wrong region, missing versioning, changed retention, disabled keys, public-key mismatch and read failures. Synthetic keys in these tests are not staging trust material.

## Concrete offline approval preparation

The last green review source was `fe472b818caf6488d57ffb88875eec2300a4b7e9` in
[draft PR #2](https://github.com/D-Eminence/hid-system/pull/2). It is not an approved
protected source; any follow-up source still requires ordinary CI. The review branch
preserves the original workspace HEAD/index and the existing user edit to
`docs/SECURITY.md`.

Two ignored, mode-0600 review artifacts are ready:

- `release/local/20260915-staging-preparation/staging-trust-foundation.review.json`
  and its adjacent `.review-template.json`: account `659225405023`, `eu-west-1`,
  stack `Hid-staging-ReleaseTrust`, 32 resources, three retained encrypted/versioned
  archives with 90-day COMPLIANCE default retention, and eight retained KMS keys
  (four storage and four online candidates). The broker and publisher token binding
  are absent. Template SHA-256:
  `c57e66cb92bef7b2a1b8928152458bc562f724e21b4da6b48a7dd49d0b4bc6f6`.
  Object Lock cannot be disabled after creation; protected versions cannot be
  removed or their retention shortened during the retention period. Retained
  resources continue to exist after stack deletion. Creating them incurs AWS
  storage/key charges. The local synthesis acknowledgement records understanding
  for planning; `owner_retention_approved` and `deployment_authorized` remain false.
- `release/local/20260915-staging-preparation/tuf-staging-capabilities.proposed.yml`
  and `staging-capability-caller.review.json`: seven mutually selected capability
  jobs using actual immutable workflow source above. It has no installed caller
  commit, no dispatch, and no guessed source/resource/artifact identifiers.
  Build mode is bound to its native runner and approved configuration. The caller
  must be reviewed separately and registered on the current default branch before
  manual dispatch discovery can work; every capability still rejects execution
  outside the fixed protected staging source ref.

The exact owner decisions, once ordinary CI and source review are complete, are
approval of PR #2's final source and acceptance of this staging resource/retention
plan. Those decisions do not override the quota hold or later public-custody,
broker, provider, artifact, environment-approval or live acceptance checks.
The OIDC provider ARN in the preview is a deterministic proposed identifier;
its last inventory was absent. All AWS resource existence and key fingerprints
must be discovered after authorized creation, never inferred from the template.
