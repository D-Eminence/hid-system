# TUF protected CI configuration and evidence

Status on 2026-09-08: **SOLO-OWNER CORRECTION LOCALLY VERIFIED AND COMMITTED;
PR #1 UPDATE PENDING — NOT MERGED**.
[PR #1](https://github.com/D-Eminence/hid-system/pull/1) introduces exact
`5ee3118688e04c364b6d351d1b3ef3385c71abb4` from `review/tuf-preparation-5ee3118`
into `tuf-production-release`. Ordinary push run `34167766797` and PR run
`34168206030` passed all seven jobs each: 14/14 checks on that old head.
Source correction `11b52d1ea59e572ad649d8f71fd84997d10749aa` is committed locally
as its child, with synchronized records in a separate documentation commit.
The corrected history requires a separately authorized exact-SHA push to the
existing review branch and fresh ordinary CI before any separately authorized
merge. No protected workflow ran; no cloud or environment setting was changed.
Current [evidence](evidence/tuf-solo-governance/README.md) and canonical records
supersede historical preparation statements below.

The user confirmed GitHub displays “Merge without waiting for requirements to
be met (bypass rules)”. This user-provided UI evidence is not an agent browser
observation. The option remains unused. Normal PR author approval is impossible;
owner PR exception use and owner environment self-approval are distinct.

## Actual GitHub state and owner/contributor controls

Repository `D-Eminence/hid-system` is public, ID `1317340803`, owner `D-Eminence`
ID `182018869`, default branch `main`. Remote `tuf-production-release` remains
`ba2cd3290e7c1fe72817c3bdfb806dd306b2c633`; immutable preparation commit
`5ee3118688e04c364b6d351d1b3ef3385c71abb4` remains the remote PR head.
Fresh GitHub GET/GraphQL readback at `2026-09-08T09:47:40Z` confirms the controls
below. New local correction commits have not been pushed or checked remotely.

The owner may develop/review/merge their own work through a PR without a second
reviewer. Contributors use PRs, CI and owner review. On both `main` and
`tuf-production-release`, the controls are layered:

| Control | Verified configuration |
| --- | --- |
| Classic branch protection | PR required, seven strict app-bound checks, conversations resolved, administrator enforcement, no force pushes or deletion |
| Classic duplicate review fields | Approval count 0, code-owner review false, latest-push approval false; review requirements live in the ruleset below |
| Active review ruleset `22459937` | Exact two refs only; one approval, code-owner review, stale-review dismissal, conversations; latest-push approval false |
| Review exception | Only User `182018869`, mode `pull_request`; no CI/deletion/force-push exception |
| CODEOWNERS | Local default owner for all changes plus explicit existing sensitive paths; not yet installed in either remote base branch |
| Actions | Six exact allowed action SHAs; SHA pinning; no blanket GitHub-owned/Marketplace allowance; all external contributors require approval |
| Default token | Read-only; Actions cannot approve PRs |
| Environments | Four distinct owner-approved gates; no configured secrets/variables |
| Runners/OIDC | No self-hosted runners; default OIDC subject mode unchanged; no AWS trust configuration |
| Release tags | No tag-dependent release workflow; publisher rejects tags; no new tags or tag rules |

The review ruleset was created and its exact User/PR exception verified before
changing duplicate classic review requirements. All other classic fields match
the previous readback exactly. The owner still needs a PR and passing technical
checks. Owner use of the review exception is an explicit, auditable merge
decision, rather than an approving review submitted by a PR author; other contributors have no bypass. CODEOWNERS must be installed on
both bases before its ownership policy is effective. No collaborator was added.
No actual PR merge was performed to test these settings.

The narrow ruleset avoids the organization-only classic bypass feature on this
personal repository. GitHub layers rulesets with classic protections; review
exceptions do not remove the separate technical requirements.
[Branch protections](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
[ruleset API](https://docs.github.com/en/rest/repos/rules) and
[rule layering](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets).

Required check names, each bound to GitHub Actions app ID `15368`:

1. `Release contracts and admission`
2. `Pinned TUF client and reproducibility`
3. `AWS release-trust source policy`
4. `Cloudflare TUF Workers`
5. `EHR release-bound offline cache`
6. `Complete workspace verification`
7. `Historical upstream reference oracle`

GitHub required checks alone can accept skipped/neutral conclusions. Release
admission still requires verified successful candidate provenance, source/
artifact identity, signed targets and fresh durable authorization.

## Separate owner-approved environments

| Environment | GitHub ID | Required reviewer | Prevent self-review | Admin bypass | Deployment restriction | Secrets / variables |
| --- | --- | --- | --- | --- | --- | --- |
| `staging` | `21412878104` | `D-Eminence` / `182018869` | false | false | Protected branches only | 0 / 0 |
| `production` | `21412879562` | `D-Eminence` / `182018869` | false | false | Protected branches only | 0 / 0 |
| `staging-publisher` | `21412881394` | `D-Eminence` / `182018869` | false | false | Protected branches only | 0 / 0 |
| `production-publisher` | `21412883002` | `D-Eminence` / `182018869` | false | false | Protected branches only | 0 / 0 |

Only self-review prevention changed on these environments; owner approval,
identities, branch policy and administrator bypass restrictions remain.
Production changes were announced before application. There are no additional
wait timers or custom deployment protection rules in the inspected metadata.
Production approval remains a separate explicit action; merging source or
approving staging grants no production authority. Future credentials remain
isolated by environment/capability, with OIDC and exact workflow/source pins.
Live rollback remains a mandatory unverified gate. Production is locked.
[GitHub environment controls](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

The required reviewer list remains restricted to `D-Eminence`. Allowing self-
review permits that owner to approve an owner-initiated run; it does not permit
other contributors to approve any protected deployment. Contributor access
cannot replace the named required reviewer. A production environment approval
is a separate action from a PR merge or staging approval.

Technical capability and signing-key separation remain required. Human approval
is centralized with the owner; no independent second developer is required.
The owner may still edit repository settings, so configuration evidence is not
proof against a malicious or compromised owner. Signing custody remains a
separate unapproved design/ceremony gate; this phase creates no keys.

## Workflow-by-workflow authority audit

| Workflow/job | Trigger and untrusted code | Authority and release boundary |
| --- | --- | --- |
| `tuf-local-gates.yml`, seven jobs | Push, pull request, manual dispatch; PR source is untrusted; no privileged trigger or reusable workflow call | `contents: read`, no environment/OIDC/secrets; SHA-pinned actions and no persisted checkout credentials; builds/tests/local synth and bounded CI evidence upload only; cannot publish TUF or releases |
| `tuf-publish.yml`, tooling | Reusable-only; caller selects data inputs and tooling SHA; tooling remains unprivileged | `contents: read`, no environment/OIDC/secrets; produces immutable-ID tooling artifact; privileged consumer separately requires approved source/archive digest |
| `tuf-publish.yml`, publish | Reusable-only, no installed caller; rejects PR/tag events, wrong ref/SHA/repository/owner/hosted-runner/workflow claims | Approval-gated `${environment}-publisher`; `contents: read`, `actions: read`, `id-token: write`; IAM preparation binds exact subject/audience/ref/immutable reusable workflow; only after identity/tooling/provenance gates may assume publisher role and run durable TUF publication; no private signing key or direct KMS signing capability |
| `tuf-protected-readiness.yml`, local preparation | Manual-only; fixed staging environment/ref/repository; owner-approved source SHA before checkout; no reusable publisher call | Only GitHub metadata/approval reads and signature-verified OIDC with `hid-protected-ci-readiness` audience; no AWS STS action, SDK, secrets, credentials, deployment or release output; bounded public evidence only |

PR source cannot reach privileged jobs in these reviewed workflows. A fork or
arbitrary branch cannot substitute publisher checkout code: protected variables
pin the immutable reusable workflow SHA and tooling archive hash, while candidate
source is downloaded only as data. GitHub settings, owner approval and future
IAM enforcement are all required; repository defaults alone are not a token
permission ceiling. No repository or environment secret currently exists.

The OIDC publisher gate verifies exact issuer/audience, caller SHA/ref, numeric
repository/owner IDs, environment, run/attempt/actor, hosted runner and immutable
`job_workflow_ref`/SHA before AWS credentials. AWS trust source separately requires
an exact protected environment subject and `sts.amazonaws.com` audience. No
live cloud token or assume-role test was performed. The current AWS reference
lists the GitHub claim condition keys used by the preparation:
[AWS OIDC condition keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html).

Tooling/candidate downloads use immutable artifact IDs; the consumer verifies an
independently approved tooling digest and complete candidate repository hash.
Run provenance binds successful workflow path/event/repository/branch/SHA,
unexpired artifact metadata and GitHub archive digest. Signed targets bind the
exact environment/release/Git SHA/artifact digest and full artifact set. A fresh
state-authorized decision then binds that tuple to the immutable journal slot,
predecessor, workflow/config/executable hashes, owner run/attempt and exact
metadata versions/digests. The durable journal prevents replay/concurrent
repetition and freezes ambiguous attempts. GitHub artifact/review history alone
is not sufficient freshness or authorization evidence.

## Ordinary CI and local fixes

Ordinary [run `34103460898`](https://github.com/D-Eminence/hid-system/actions/runs/34103460898)
on `ba2cd3290e7c1fe72817c3bdfb806dd306b2c633` completed failure: four successful
jobs, three failed. EHR missed shared source dependencies; Cloudflare and
workspace tests shared a runtime-executable fixture assumption. The hosted
mode was not logged; a group-writable local runtime reproduces the rejection.
The two-file fix installs/audits shared lockfiles and uses a private mode-0500
fixture executable, retaining rejection of writable executables. No production
validator or dependency lockfile changed.

Isolated EHR build/5 tests, Cloudflare 52 tests, actionlint, full `npm test` and
`npm run verify` pass locally. Both ordinary runs on original `5ee3118` now pass
remotely. The newer solo-owner correction passed the full local build/test/verify,
release/readiness/publication, Go/race/vet/module and reproducibility checks;
remote CI on its updated PR head remains pending a separately authorized push.
[Historical run/job evidence](evidence/tuf-github-protection/ordinary-ci.json) and
[fix validation](evidence/tuf-github-protection/ci-fix-validation.json) record
precise scope and limits. This run is ordinary credential-free CI, not protected CI.

## Staging-only protected readiness probe

The locally prepared probe requires a fresh manual dispatch (attempt 1), exact
repository IDs, `refs/heads/tuf-production-release`, protected ref, requested
SHA equal to caller/workflow/checkout SHA, and owner-set staging
`TUF_READINESS_APPROVED_SHA`. It checks all four live environment identities,
review rules requiring only User `D-Eminence` / `182018869`, explicit self-review
allowance, staging owner approval history and GitHub-signed short-lived OIDC
claims. The owner can approve their own dispatch. A contributor-initiated run
still requires the owner approval; contributor approval cannot substitute. It requests audience
`hid-protected-ci-readiness`, never `sts.amazonaws.com`, and saves no token bytes.
Negative tests exercise the real inline gate and verifier with synthetic data.
A synthetic pass is not an executed protected run.

Do not dispatch yet. The workflow must first be separately published through
owner review and made dispatchable from the default branch, ordinary CI must
pass on updated source, and the owner must pin the
reviewed SHA in the staging environment. That variable is unset. A successful
future probe would prove only staging approval/OIDC; it cannot approve
publication, Object Lock, staging acceptance, production or migration.

## Attacker review and implemented assertions

| Attempt | Source boundary / evidence |
| --- | --- |
| PR or untrusted-ref publication | Reusable-only publisher; exact protected branch; OIDC event limited to push/dispatch; repository/owner IDs and hosted runner checked |
| Workflow-file replacement | Full action pins, independently approved reusable workflow SHA and tooling archive hash; IAM immutable workflow claim pin. Branch protection remains essential |
| Spoofed release SHA | Inline `plan.git_sha == GITHUB_SHA`, OIDC `sha == GITHUB_SHA`, candidate-run head SHA and live driver equality; negative executable tests |
| Reused CI evidence | Successful exact approved candidate workflow/run, matching source repository/branch/SHA, immutable unexpired artifact ID/digest; fork/PR/stale failures tested |
| Cross-environment publication | Distinct environment approval, reader/root/repository/account identity, target namespace, metadata/journal tuple and credential ARN |
| Artifact replacement | Download by immutable artifact ID; independently recompute complete repository and target closure hashes; TUF metadata and release admission; private validated upload copy |
| Signing credential theft by build | No build OIDC/environment; no offline private keys; only fixed AWS broker has KMS signing capability |
| Publication before approval | Environment gates the entire publisher job; inline checks verify installed reviewer/self-review/bypass rules before cloud authority |
| Caller overrides security-critical inputs | Protected environment pins override request values; untrusted inputs remain data; no candidate source checkout/execution |
| Replay/concurrent retry/stale recovery | Environment concurrency never cancels publication; durable journal claims/intents/CAS, immutable chain and high-water dominate CI retry; unknown outcomes freeze |
| Direct unapproved Wrangler publication | Protected wrapper requires exact fresh authorization and committed intent callback; IAM and scoped credential custody remain live verification gates |

Code checks cannot protect against an owner deliberately replacing both
protection rules and trusted IAM policy. The accepted model centralizes human
authority while retaining technical capability isolation, exact identity pins,
key-custody review, audit evidence and live denial tests. No evidence here claims
cloud trust or custody has been deployed, or requires a second developer.

## Exact first-run evidence contract

The first credential-free run of `tuf-local-gates.yml` must run from a committed
pristine checkout. PR evidence is useful for review but cannot authorize a
release. A protected branch run must independently establish all seven jobs passed.

Each of the five focused jobs uploads
`tuf-local-<job>-<run_id>-<attempt>` containing `local-gate-evidence.json`:
repository/owner IDs, exact SHA/ref/workflow SHA, event, protection indication,
run/attempt/job, timestamp, gate outcomes, toolchain/reference/ledger hashes,
and available paired command sizes/digests. The workspace job uploads
`tuf-workspace-<run_id>-<attempt>` with exact build/test/verify commands,
timestamps, exit codes and SHA-256-bound logs, including partial failure.
It also runs the socket-only synthetic PostgreSQL migration/restore rehearsal
and retains its bounded summary, excluding backups and raw SQL logs, and the
gateway runtime check (`gateway-runtime`), which pulls the digest-pinned
`nginxinc/nginx-unprivileged` image of `gateway/Dockerfile` and runs its nginx
against loopback stubs with no credential. The
isolated historical upstream job retains reference-client evidence only; it
has no release output or cloud authority. Production tooling and the broker
use the independently pinned Go 1.26.10 profile and a symbol-level vulnerability
gate; Go 1.25.0 remains only in that historical job.

The publisher's credential-free tooling job uploads
`tuf-verified-tooling-<run_id>-<attempt>` with deterministic `tooling.tar.gz`
and `tooling-evidence.json`: five paired binaries, sizes/digests,
reproducibility outcomes, tool versions/flags, dependency lock hashes and
test/audit gates. The tooling archive digest must be independently approved
before publisher authority is usable. A self-authored JSON file is not signed
build provenance or live acceptance; export and verify GitHub run/job/log data.

The publication job retains `tuf-publication-<run_id>-<attempt>`:

- `hid-publication-identity.json`: public identity claims, environment ID,
  reviewer IDs and installed approval rules; never the OIDC token;
- `hid-publication-inputs.json`: exact source SHA, successful candidate run and
  artifact ID/name/size/GitHub digest, independently hashed repository file
  inventory, TUF versions/digests, environment, review identities and timestamp;
- tooling verification evidence, bounded immutable journal result references,
  and `summary.json` with result/failure state when execution reached the driver.

Approval history identifies the reviewer/environment. The API does not prove
which run attempt a historical review authorized; retain GitHub deployment and
audit records for the actual attempt. The job's live environment gate remains
the authorization boundary. Early failure may have no journal because no claim
occurred; absent evidence is a failure, never success.

The durable S3 journal/evidence archive binds exact source SHA, artifact target
and digest, artifact-set hash, whole repository hash, root/targets/snapshot/
timestamp versions and digests, environment, run/attempt/actor, immutable object
versions, predecessor references, timestamp and bounded recovery disposition.
No raw credential responses, process environments, private journal requests,
keys, patient data or arbitrary directory globs belong in CI artifacts.

Independent verification commands after an authorized run:

```sh
gh api repos/D-Eminence/hid-system/actions/runs/EXACT_RUN_ID
gh api repos/D-Eminence/hid-system/actions/runs/EXACT_RUN_ID/jobs --paginate
gh api repos/D-Eminence/hid-system/actions/runs/EXACT_RUN_ID/artifacts --paginate
gh api repos/D-Eminence/hid-system/actions/runs/EXACT_RUN_ID/approvals
gh run download EXACT_RUN_ID --repo D-Eminence/hid-system --dir NEW_PRIVATE_EVIDENCE_DIRECTORY
```

Compare every reported SHA, workflow path, ref, ID, size and digest to the
reviewed source/run and signed candidate. Export completed job logs and hash
them; retain the exported bundle under approved private immutable evidence
retention. GitHub's artifact expiry window is not the long-term archive.

## Remaining execution inputs

Current Git/PR state: PR #1 exists and is not merged. Its correction is locally
verified and committed; an exact-SHA push/update remains separately authorized.


[Non-secret prerequisite manifest](../release/config/protected-ci-prerequisites.json)
records the exact known GitHub identities and all 96 unresolved template fields.
AWS account/region/IAM roles/KMS/Secrets Manager/S3 references, Cloudflare account/
zone/resource identifiers, candidate/signing/canary execution, approved tooling
and configuration hashes, signed metadata and custody review remain pending.
No placeholders may be treated as deployed resources or authorized credentials.

The next push, only after authorization, targets existing
`review/tuf-preparation-5ee3118` and updates PR #1 into `tuf-production-release`.
Use the final immutable documentation-commit SHA and its parent correction;
do not replay an old preparation-only push or create another PR. Independently
verify remote equality and ordinary CI on that new head before separate merge
authorization. The eight source files and nine documentation/evidence files
are separate local commits. No amend, rebase, squash, cherry-pick, force push,
direct protected-branch push or history rewrite is permitted. The original
`5ee3118` still has superseded protected checks; the committed correction must
land before any readiness execution. No protected dispatch or cloud action is
authorized here.
Object Lock remains **UNAPPROVED / NOT CREATED**, with immutable journal/evidence
retention **2 years (730 days)**. Staging is not accepted; data migration is not
authorized; production remains locked.

## Expected OIDC identity — prepared, not live acceptance

Live OIDC configuration is `use_default: true`, `use_immutable_subject: false`.
The API also returns an immutable prefix; it is inactive in this configuration.
Do not silently adopt it or broaden a subject. The complete machine-readable
expectations are in the [prerequisite manifest](../release/config/protected-ci-prerequisites.json).

| Claim | Readiness | Future publisher trust |
| --- | --- | --- |
| Repository / owner | `D-Eminence/hid-system` / `D-Eminence`, numeric IDs `1317340803` / `182018869` | Same exact repository and owner |
| Ref | `refs/heads/tuf-production-release` | Exact approved protected caller ref; production ref not assigned |
| SHA | Requested = approved = checkout = workflow = `GITHUB_SHA` | Caller = plan = candidate source SHA; reusable tooling SHA separately pinned |
| Workflow | `Protected staging readiness probe`; exact readiness path/ref and SHA | Exact caller workflow remains to be selected; reusable workflow separately pinned |
| Job workflow ref | Absent: direct job | `D-Eminence/hid-system/.github/workflows/tuf-publish.yml@<exact-approved-SHA>`; no branch/tag alias |
| Environment | `staging` | Exact `staging-publisher` or `production-publisher` for that role |
| Actor | Exact runtime login and ID; owner approval separately verified | Exact runtime actor ID; caller/login arrangement remains to be reviewed |
| Audience | `hid-protected-ci-readiness` | `sts.amazonaws.com` |
| Subject | `repo:D-Eminence/hid-system:environment:staging` | Exact environment subject ending `:staging-publisher` or `:production-publisher` |

The probe verifies RS256 signatures using fixed GitHub JWKS and bounded time
claims, rejects wrong repository/owner/workflow/actor claims, and never requests
AWS audience or calls AWS. The publisher's inline claim checks precede cloud
authority; AWS STS must enforce its own cryptographic trust policy. Current
publisher code uses the GitHub environment runtime gate for approval; it does
not separately fetch approval history. No signed live token or AWS assumption
was performed in this phase. Expected caller claims are pending inputs rather
than implemented cloud controls.
[GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc),
[reusable workflow identity](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows),
[AWS condition keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html).

## npm audit exception: minimatch in aws-cdk-lib (2026-11-01)

Since 31 October every backend run has failed the infra/aws dependency audit
(`npm --prefix infra/aws audit --audit-level=moderate`, in the AWS release-trust
job of `tuf-local-gates.yml` and the tooling audit of `tuf-publish.yml`). It
reports one moderate advisory,
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249):
minimatch below 11.0.1 can be made to do excessive work by a crafted glob pattern
(globparts amplification, CWE-405). The affected copy is minimatch 10.2.5,
bundled inside aws-cdk-lib 2.273.0, which infra/aws pins; npm also lists
aws-cdk-lib itself because of it. There is no fix to take: aws-cdk-lib 2.273.0,
2.274.0 and 2.275.0 (the latest on 1 November) all bundle minimatch ^10.2.x, and
npm overrides cannot replace a bundled dependency.

The owner (D-Eminence) approved an exception in chat on 2026-11-01, first on
`staging-novu-ci-20261005`, then the same day on main
(D-Eminence/hid-system#143, which ports it unchanged with its three follow-up
fixes). It is recorded in `security/npm-audit-exceptions.json`, approved
2026-11-01 and expiring 2026-12-01 at 00:00 UTC. The basis:

- minimatch runs only while CDK synthesizes infra/aws: asset exclude patterns,
  the bundling-stacks context patterns and construct-id selectors. The patterns
  come from this repository's source and CDK context, and the strings matched are
  its own construct paths and asset file paths. No outside input reaches it.
- infra/aws is not part of any runtime image. No Dockerfile copies it, its
  `node_modules` are not in the TUF tooling archive, and its one Lambda asset
  (`runtime/workload-issuer`) contains no CDK code.
- The worst case is a slow synth on a developer or CI machine.

Both infra/aws audit steps now run
`node release/scripts/npm-audit-with-exceptions.mjs infra/aws` (Node built-ins
only). It runs `npm --prefix infra/aws audit --json` and passes only if every
advisory at moderate or above matches an entry for that directory with the same
GHSA id, package, npm vulnerable range, severity and installed path. It fails when:

- an advisory, or a new installed path of one, has no entry;
- any entry in the file has expired;
- an entry is stale: one of its paths no longer matches the audit. Stale entries
  fail rather than warn, so the file cannot keep approvals for things that are gone;
- the exceptions file is malformed: unknown or missing fields, a window longer
  than 92 days, an approval date in the future, two entries for one advisory, or
  text that is not canonical 2-space JSON (which also rules out duplicate keys);
- npm cannot run, exits other than 0 or 1, prints anything but a version 2 audit
  report, or reports an error.

Advisories below moderate pass without an entry, as they did with
`--audit-level=moderate`. Every other audit is unchanged: release,
infra/cloudflare and the EHR and shared-package audits still run plain
`npm audit --audit-level=moderate`. `release/scripts/verify-publication-workflow.mjs`
now pins every npm audit command in both workflows. It rejects these changes, and
the release tests try each one: dropping an audit, sending another directory
through the exception gate, a different exceptions file, `|| true`, a condition or
`continue-on-error` on an audit step or its job, a `needs` on an audit job (it
would be skipped whenever the job it waits on is), a container, service or
matrix on an audit job, a workflow or job default shell, a step in an audit job
that writes `GITHUB_ENV` or `GITHUB_PATH`, a registry override, or another step
touching `security/`.

Since the audit pin hardening (2 November 2026, owner's request) it also checks:

- **The audit runs first, in a shell that reads no BASH_ENV.** In every audit job
  the audit step comes straight after the reviewed setup actions, before any
  `npm ci`, install script, build or test: `npm audit` reads only the lockfile,
  and the exception gate uses only Node built-ins. The step runs in
  `shell: /usr/bin/bash -p -e {0}`: an absolute path, so no `bash` found on PATH
  runs it, and privileged mode, so bash reads no `BASH_ENV` or `ENV` file and
  imports no shell function from the environment, even one written to
  `GITHUB_ENV` at run time. A release test runs both shells to show the
  difference.
- **The environment, by allowlist.** The workflow env and every audit job's and
  audit step's env may set only the variables these workflows use today
  (`AUDIT_ENV_ALLOWLIST`: `CI`, `NODE_VERSION`, `GO_VERSION`, the two broker
  images, `GOTOOLCHAIN`, `TOOLING_SHA`, `PLAN_JSON`, `WRANGLER_SEND_METRICS`,
  `HID_REQUIRE_CLOUDFLARE_VALIDATOR`, `HID_PUBLIC_BASE` and `GATE_STEPS_JSON`;
  `NODE_VERSION` only in the workflow env). `BASH_ENV`, `ENV`, `NODE_OPTIONS`,
  `npm_config_*`, `PATH`, a proxy, an extra CA and anything else are refused,
  and every env anywhere in the workflow must be a plain map, not an expression
  whose keys a reviewer cannot see.
- **The actions and the runner, by allowlist.** An audit job may use only
  `actions/checkout`, `actions/setup-node`, `actions/setup-go` and
  `actions/upload-artifact`, each at its reviewed commit and with only the inputs
  it takes today (`AUDIT_JOB_ACTIONS`); any other action, a local action or a
  container action is refused. setup-node must install the reviewed Node
  (22.23.2), and every audit job runs on `ubuntu-24.04`.
- **PATH, pinned in the audit step.** Every audit command starts with
  `export PATH="$RUNNER_TOOL_CACHE/node/22.23.2/x64/bin:/usr/bin:/bin"` and
  `test "$(node --version)" = v22.23.2`, where setup-node installs that Node.
  Whatever a reviewed action added to PATH does not reach npm or the gate, and a
  workflow cannot redirect `RUNNER_TOOL_CACHE`: the runner sets `RUNNER_*`
  itself after `GITHUB_ENV` and env maps.

These are still static checks on the workflow text, not a sandbox, and the list
is not complete. One of the four reviewed actions itself turned hostile (it runs
as the runner user and could replace files in the tool cache or write
`~/.npmrc`), or a self-hosted runner set up to answer `ubuntu-24.04`, can still
get past them. The owner's review of every workflow change (CODEOWNERS) is still
the real control. The local gate evidence records
the exceptions file's SHA-256. The gate compares real paths when it decides
whether it was run directly, so running it through a symlink still runs the
audit instead of exiting 0 without output.

This exception covers the infra/aws npm audit only. It changes nothing in the
image scans. It is also the
first npm audit exception: RF-005 in `docs/RELEASE_FINDINGS.md` declined one
for a High in the same bundled tree. This one is a moderate, approved by the
owner, limited to one installed path and expiring.

Before 1 December, either move infra/aws to an aws-cdk-lib release that bundles
minimatch 11.0.1 or later and delete the entry (left in place it fails as stale),
or have the owner review the basis again and set new `approved_at` and
`expires_at` dates. With no entries the gate behaves like the plain audit, so the
workflows can keep it.
