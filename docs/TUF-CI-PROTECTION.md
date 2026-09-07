# TUF protected CI configuration and evidence

Status on 2026-09-06: source prepared; **live protection is BLOCKED**. This file
does not authorize a commit, push, workflow dispatch, cloud change, or publication.
The canonical decision is in [TUF-PRODUCTION-IMPLEMENTATION.md](TUF-PRODUCTION-IMPLEMENTATION.md).

## Verified GitHub facts

Fresh read-only `gh api` requests at **2026-09-06 21:45 UTC** verified
`D-Eminence/hid-system`, repository ID `1317340803`, owner ID `182018869`,
**public** visibility, personal user ownership, and default branch `main`.
The environment and workflow lists are empty. `main` protection returns 404
“Branch not protected”; the release branch returns 404 “Branch not found”.
Rulesets returns 200 with an empty list. Actions allows all actions and does not
require SHA pinning; default workflow permission is read and Actions cannot
approve PRs. All six full action SHA pins resolve to their named upstream repos.
Sanitized API responses are retained under `docs/evidence/tuf-phase-c/github/`.

The earlier inspection reported private visibility and plan-restricted protection
reads. The new read supersedes that state; this agent made no GitHub mutation.
The current blocker is owner installation and verification of the required
protections, rather than a demonstrated plan restriction. Do not infer approval
from public visibility. A future ownership/visibility change requires fresh
identity/availability checks. [GitHub environment availability](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

## Owner configuration checklist

Labels: **REPO** = implemented in repo; **GITHUB** = requires GitHub
configuration; **OWNER** = requires owner approval; **ID** = requires exact
external identifier. A label is a responsibility, not proof the setting exists.

| Control | Required configuration | Classification / observed state |
| --- | --- | --- |
| Default and release branches | Protect `main` and the exact owner-selected release caller branch; no wildcard caller authorization | GITHUB, OWNER, ID; main unprotected, release branch absent |
| Pull requests | Required independent review; dismiss stale approvals; require approval of latest push; code-owner review; resolved conversations | GITHUB, OWNER; unverified |
| Required checks | Require all seven local-gate jobs listed below on exact head; bind check source to GitHub Actions; no skipped/neutral replacement | REPO, GITHUB; source only |
| Force push and deletion | Deny force pushes and branch deletion; no bypass actors/admin exemption | GITHUB, OWNER; unverified |
| Release tags | Protect `v*`/chosen release tags from replacement/deletion; tags cannot call the publisher (branch-only code policy) | GITHUB, OWNER; unverified |
| Staging publisher | Create `staging-publisher`, named reviewers, prevent self-review, disable administrator bypass | REPO, GITHUB, OWNER, ID; absent |
| Production publisher | Independently configure `production-publisher`; never copy staging approval/credentials | REPO, GITHUB, OWNER, ID; absent and production remains locked |
| Environment branches | Protected branches only, custom branch policy false; code/IAM further require the one exact caller ref | REPO, GITHUB; absent |
| OIDC | Only publisher job requests `id-token: write`; bind IAM subject, audience, numeric identities, exact ref and immutable reusable workflow | REPO, GITHUB, OWNER, ID; IAM not deployed |
| Build/test authority | Read-only token, no environment, no cloud credentials or signing bindings; hosted ephemeral runner | REPO; live run absent |
| Default token | Read-only, PR approval disabled | GITHUB; verified |
| Actions policy | Allow only reviewed full action SHAs and immutable reusable callers; require SHA pinning where supported | REPO, GITHUB, OWNER; service currently allows all |
| CODEOWNERS | Install actual owners from `.github/CODEOWNERS.template`, including workflow, tooling, signing, publication, infrastructure, migration and lockfiles | REPO template, GITHUB, OWNER, ID; not enforced |
| Variables | Protected environment only; exact independently reviewed workflow/tooling/config hashes, account/region/role and repository pins | REPO, GITHUB, OWNER, ID; unavailable |
| Credentials | Existing staging Cloudflare token in Secrets Manager; exact ARN/version reference only; no private signing keys in GitHub | REPO, OWNER, ID; unavailable |
| Other capabilities | Separate build, evidence-writer, auditor and four signer environments/roles/workflow pins | REPO IaC, GITHUB, OWNER, ID; capability execution workflows are not supplied |

Required check names (use the actual check-run names returned by the first
successful run, and then verify the installed required-check rules):

1. `Release contracts and admission`
2. `Pinned TUF client and reproducibility`
3. `AWS release-trust source policy`
4. `Cloudflare TUF Workers`
5. `EHR release-bound offline cache`
6. `Complete workspace verification`
7. `Historical upstream reference oracle`

The owner must provide actual reviewer IDs and coverage. Listing two reviewers
does not enforce two approvals: GitHub needs only one member of the environment
reviewer list. Offline TUF root/targets thresholds remain independently 2-of-3.
[GitHub environment review rules](https://docs.github.com/en/rest/deployments/environments).

Protected publisher variables: `TUF_PUBLISHER_WORKFLOW_SHA`,
`TUF_TOOLING_ARCHIVE_SHA256`, `TUF_PUBLISHER_CONFIG_JSON`,
`TUF_PUBLISHER_CONFIG_SHA256`, `TUF_REPOSITORY_ID`, `TUF_REPOSITORY_OWNER_ID`,
`TUF_PROTECTED_REF`, `TUF_CANDIDATE_WORKFLOW_PATH`, `TUF_PUBLISHER_ROLE_ARN`,
`TUF_AWS_REGION`, `TUF_AWS_ACCOUNT_ID`. Configuration JSON contains non-secret
references and public pins only. Protect its changes as carefully as workflow
changes. Candidate artifacts cannot supply these variables.

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

There is no actual candidate run/artifact, signed staging root/targets,
approved tooling archive, or committed reusable-workflow SHA. The eight
capability IAM workflow names include build, evidence and signer/auditor
workflows whose execution implementation is not provided by the publisher.
An independently approved candidate generation/signing/canary execution
arrangement must be concretely reviewed before staging can execute; an ordinary
developer branch or local fixture cannot fill that role. No active caller is
installed because a literal immutable workflow SHA does not exist yet.
