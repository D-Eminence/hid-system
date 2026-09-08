# GitHub protection preparation evidence

This bundle is the immutable-preparation milestone's historical snapshot. Its
independent-reviewer requirement and owner self-review denial were superseded
by the user's sole-owner governance instruction. See the
[current correction evidence](../tuf-solo-governance/README.md); retained JSON
snapshots and original commit manifests are not rewritten as new observations.

The 2026-09-08 correction is now locally committed as
`11b52d1ea59e572ad649d8f71fd84997d10749aa`, with separate synchronized records.
The complete relevant local suite passed. Original PR head `5ee3118` has 14/14
ordinary checks passing; the corrected local history has not been pushed.
The owner reports the existing bypass UI is exposed and unused. No merge or
protected execution is authorized. Current correction evidence is authoritative
for these facts; the historical denial below is not current owner policy.

Historical milestone status: **PROTECTED CI READINESS BLOCKED**. The remote reviewed SHA is
`ba2cd3290e7c1fe72817c3bdfb806dd306b2c633`. The new local preparation is separate from that immutable remote source; no
additional push or protected workflow run occurred.

- [Actual GitHub state](state.json): initial facts and independently read-back
  branch/Actions/four-environment protections; reviewer coverage gap in that historical policy.
- [Ordinary run](ordinary-ci.json): run `34103460898`, exact source, seven jobs,
  four passes/three failures and bounded failure evidence. Not protected CI.
- [CI fix validation](ci-fix-validation.json): isolated EHR and fixture
  reproductions plus local full test/verify; hosted Node22 rerun remains pending.
- [Readiness and binding validation](validation.json): 29 release tests,
  signature/approval negative cases and targeted race-enabled journal/broker
  tests. Synthetic checks cannot establish a successful protected run.
- [Live-snapshot readiness denial](readiness-denial.json): actual owner-only
  environment coverage is rejected locally before any token request.
- [Prerequisites](../../../release/config/protected-ci-prerequisites.json):
  exact known GitHub identities, unset reviewed-SHA pin and all 96 unresolved
  external template references; no cloud identifiers invented.

Raw API readbacks, request bodies, the initial rejected legacy-contexts request,
verification logs and remote refs are retained privately at
`/home/l2e/.local/state/hid-phase-c/github-protection-20260907T135222Z/`.
Ordinary CI logs and isolated reproduction evidence are retained at
`/home/l2e/.local/state/hid-phase-c/github-protection-ci-audit/`.

At that historical milestone, GitHub PR/check/admin/Actions rules and four
distinct environment gates were active. CODEOWNERS was absent remotely and the historical policy prevented owner
self-approval. That self-review policy is now superseded. A verified owner-only CODEOWNERS file
and staging-only readiness workflow are local preparation, not effective remote
controls. No bypass or additional reviewer identity was invented.

Historical next step (superseded): owner designates independent reviewer membership and production approval
coverage, followed by separately authorized publication through a review branch
and protected PR, successful ordinary CI and a staging-approved immutable SHA.
Do not dispatch a protected probe, configure credentials, deploy or migrate
under this evidence. Object Lock is **UNAPPROVED / NOT CREATED**, retention is
**2 years / 730 days**, staging is **NOT ACCEPTED**, data migration is **NOT
AUTHORIZED**, and production is **LOCKED**.
