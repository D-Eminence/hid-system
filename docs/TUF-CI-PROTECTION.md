# TUF protected CI configuration and evidence

Status on 2026-09-07: **BRANCH/ACTIONS/ENVIRONMENT PROTECTIONS APPLIED;
PROTECTED CI READINESS BLOCKED BY OWNER REVIEWER COVERAGE AND UNPUBLISHED SOURCE**.
Protected CI has not run. No cloud credentials, Object Lock, release publication
or staging deployment is authorized by this preparation.

## Actual GitHub state and applied controls

Live API inspection verified public repository `D-Eminence/hid-system`, ID
`1317340803`, owner `D-Eminence` ID `182018869`, default branch `main`, and
administrator permissions. Remote `tuf-production-release` remains at
`ba2cd3290e7c1fe72817c3bdfb806dd306b2c633`. Before this phase, eight branches
were unprotected and rulesets, environments and CODEOWNERS were absent.
[Sanitized state and API readback](evidence/tuf-github-protection/state.json)
separate the initial snapshot from applied settings.

| Control | Actual state |
| --- | --- |
| `main` and `tuf-production-release` | Protected: PR required, one approval, stale-review dismissal, latest-push approval, code-owner review required, resolved conversations |
| Checks | All seven observed check names below, strict up-to-date requirement, each pinned to GitHub Actions app ID `15368` |
| Force push/deletion/admin bypass | Force push and deletion denied; restrictions enforced for admins; no bypass allowance installed |
| CODEOWNERS | Local file names verified owner `@D-Eminence`; absent from both remote base branches until separately authorized publication and reviewed merge |
| Actions policy | Six exact reviewed action SHAs allowed; GitHub-owned/Marketplace blanket allowances disabled; SHA pinning required |
| PR workflow approval | All external contributors require approval; workflow execution remains untrusted read-only code |
| Default token | Read-only; Actions cannot approve PRs |
| Environments | Four distinct protected environments listed below; no secrets/variables configured |
| Runners | No self-hosted runners; workflows select ephemeral GitHub-hosted runners |
| OIDC | Default subject mode unchanged; no AWS trust or credential configuration performed |
| Release tags | No tag-dependent release workflow exists; tags are rejected by publisher identity policy; no invented tag pattern configured |

The temporary release-preparation branch is protected while it carries security
code. The production execution ref remains unassigned. A future tag-based
protocol needs a reviewed exact tag pattern and protection before use.
Classic branch protections supply the controls; no ruleset was needed.
The first API request mixed deprecated `contexts` with `checks` and returned
422 without mutation. Removing only `contexts` retained the exact app-bound
checks; the corrected request and independent readback passed.

The check names are:

1. `Release contracts and admission`
2. `Pinned TUF client and reproducibility`
3. `AWS release-trust source policy`
4. `Cloudflare TUF Workers`
5. `EHR release-bound offline cache`
6. `Complete workspace verification`
7. `Historical upstream reference oracle`

GitHub required checks alone can accept skipped/neutral conclusions. Release
admission still requires an independently verified successful candidate run,
source/artifact identity, signed TUF targets and fresh durable authorization;
no skipped check is release evidence. Changes to workflow logic require review.
[Branch protection API](https://docs.github.com/en/rest/branches/branch-protection)
and [Actions policy API](https://docs.github.com/en/rest/actions/permissions)
document the applied settings.

## Distinct environment gates and remaining owner action

| Environment | GitHub ID | Purpose |
| --- | --- | --- |
| `staging` | `21412878104` | Staging application/approval readiness gate; local probe only |
| `production` | `21412879562` | Separate explicit production approval; no production workflow/credentials prepared |
| `staging-publisher` | `21412881394` | Existing reusable publisher capability identity |
| `production-publisher` | `21412883002` | Separate production publisher capability; production remains locked |

Each requires `D-Eminence` (`182018869`), prevents self-review, disables admin
bypass and permits protected branches only. Publisher code and IAM preparation
further pin one exact caller ref; protected-branch membership alone is not
publication authorization. Named staging/production environments do not replace
or rename the capability-specific subjects already reviewed in AWS source.

Only the owner is currently a collaborator. An owner-initiated run cannot
self-approve. The owner must designate independent reviewers, provide accepted
membership/access and a production-specific approval decision, then verify the
installed IDs and CODEOWNERS coverage. No identities were guessed or invitations
sent. One approval is the GitHub environment minimum; multiple listed reviewers
do not enforce multiple approvals. Offline TUF thresholds remain separate.
See [GitHub environment approvals](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

The repository owner can still edit repository protections. Administrative,
reviewer and signing-custodian separation remains an explicit governance gate;
setting `enforce_admins` is not evidence of independent custody.

## Workflow-by-workflow authority audit

| Workflow/job | Trigger and untrusted code | Authority and release boundary |
| --- | --- | --- |
| `tuf-local-gates.yml`, seven jobs | Push, pull request, manual dispatch; PR source is untrusted; no privileged trigger or reusable workflow call | `contents: read`, no environment/OIDC/secrets; SHA-pinned actions and no persisted checkout credentials; builds/tests/local synth and bounded CI evidence upload only; cannot publish TUF or releases |
| `tuf-publish.yml`, tooling | Reusable-only; caller selects data inputs and tooling SHA; tooling remains unprivileged | `contents: read`, no environment/OIDC/secrets; produces immutable-ID tooling artifact; privileged consumer separately requires approved source/archive digest |
| `tuf-publish.yml`, publish | Reusable-only, no installed caller; rejects PR/tag events, wrong ref/SHA/repository/owner/hosted-runner/workflow claims | Approval-gated `${environment}-publisher`; `contents: read`, `actions: read`, `id-token: write`; IAM preparation binds exact subject/audience/ref/immutable reusable workflow; only after identity/tooling/provenance gates may assume publisher role and run durable TUF publication; no private signing key or direct KMS signing capability |
| `tuf-protected-readiness.yml`, local preparation | Manual-only; fixed staging environment/ref/repository; independently approved source SHA before checkout; no reusable publisher call | Only GitHub metadata/approval reads and signature-verified OIDC with `hid-protected-ci-readiness` audience; no AWS STS action, SDK, secrets, credentials, deployment or release output; bounded public evidence only |

PR source cannot reach privileged jobs in these reviewed workflows. A fork or
arbitrary branch cannot substitute publisher checkout code: protected variables
pin the immutable reusable workflow SHA and tooling archive hash, while candidate
source is downloaded only as data. GitHub settings, review coverage and future
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
`npm run verify` pass locally. Local Node is 24.13.1; remote Node 22.23.2 has not
rerun. [Run/job evidence](evidence/tuf-github-protection/ordinary-ci.json) and
[fix validation](evidence/tuf-github-protection/ci-fix-validation.json) record
precise scope and limits. This run is ordinary credential-free CI, not protected CI.

## Staging-only protected readiness probe

The locally prepared probe requires a fresh manual dispatch (attempt 1), exact
repository IDs, `refs/heads/tuf-production-release`, protected ref, requested
SHA equal to caller/workflow/checkout SHA, and independently set staging
`TUF_READINESS_APPROVED_SHA`. It checks all four live environment identities,
review rules, non-initiator User reviewer coverage, staging approval history and
GitHub-signed short-lived OIDC claims. It requests audience
`hid-protected-ci-readiness`, never `sts.amazonaws.com`, and saves no token bytes.
Negative tests exercise the real inline gate and verifier with synthetic data.
A synthetic pass is not an executed protected run.

Do not dispatch yet. The workflow must first be separately published through
review and made dispatchable from the default branch, reviewer coverage must be
resolved, ordinary CI must pass on updated source, and the owner must pin the
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
protection rules and trusted IAM policy. Review/administration/custodian
separation, key custody, and live deny tests are required. No evidence here
claims those controls have been deployed.

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
and retains its bounded summary, excluding backups and raw SQL logs. The
isolated historical upstream job retains reference-client evidence only; it
has no release output or cloud authority. Production tooling and the broker
use the independently pinned Go 1.26.8 profile and a symbol-level vulnerability
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

[Non-secret prerequisite manifest](../release/config/protected-ci-prerequisites.json)
records the exact known GitHub identities and all 96 unresolved template fields.
AWS account/region/IAM roles/KMS/Secrets Manager/S3 references, Cloudflare account/
zone/resource identifiers, candidate/signing/canary execution, approved tooling
and configuration hashes, signed metadata and custody review remain pending.
No placeholders may be treated as deployed resources or authorized credentials.

Stop for owner-supplied independent reviewer coverage and separate authorization
to publish the new local preparation via a review branch/protected PR. No direct
push bypass, protected workflow dispatch, cloud mutation or production operation
is authorized. Object Lock remains **UNAPPROVED / NOT CREATED**, with immutable
journal/evidence retention **2 years (730 days)**. Staging is not accepted;
data migration is not authorized; production remains locked.
