# GitHub protection preparation evidence

Status: **PROTECTED CI READINESS BLOCKED**. The remote reviewed SHA is
`ba2cd3290e7c1fe72817c3bdfb806dd306b2c633`. The new local preparation is separate from that immutable remote source; no
additional push or protected workflow run occurred.

- [Actual GitHub state](state.json): initial facts and independently read-back
  branch/Actions/four-environment protections; current reviewer coverage gap.
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

GitHub PR/check/admin/Actions rules and four distinct environment gates are
active. Remote CODEOWNERS is absent and only the owner can review environments,
so owner-initiated runs cannot self-approve. A verified owner-only CODEOWNERS file
and staging-only readiness workflow are local preparation, not effective remote
controls. No bypass or additional reviewer identity was invented.

Next: owner designates independent reviewer membership and production approval
coverage, followed by separately authorized publication through a review branch
and protected PR, successful ordinary CI and a staging-approved immutable SHA.
Do not dispatch a protected probe, configure credentials, deploy or migrate
under this evidence. Object Lock is **UNAPPROVED / NOT CREATED**, retention is
**2 years / 730 days**, staging is **NOT ACCEPTED**, data migration is **NOT
AUTHORIZED**, and production is **LOCKED**.
