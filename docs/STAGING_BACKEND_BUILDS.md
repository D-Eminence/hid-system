# Automated staging backend builds

`Staging backend images` checks PRs and builds affected backend components.
Pushes to `staging-novu-ci-20261005` or `staging` also publish passing images to
existing staging ECR repositories using short-lived GitHub OIDC credentials.
Frontend-only changes do not run this pipeline. The current frontend release is
retained while the developer finishes its changes.

The pipeline installs service lockfiles, runs tests/type checks, builds ARM64,
generates an SPDX SBOM and rejects High/Critical Grype findings. Image transfer
between jobs is checked against hashes, source SHA and Docker configuration.
Immutable ECR tags contain source SHA, Actions run ID/attempt and Docker target.
Each `staging-digest-*` artifact includes `publication.json`, SBOM and scan result.
Terraform deployment uses the recorded `image_uri` digest as a separate step.
Other images and frontend archives keep their own original source provenance.

No runtime API keys, database passwords or production permissions are used by CI.
The AWS role trusts exact immutable repository/owner IDs and staging branches.
The owner should protect the staging branch against unreviewed changes. Existing
TUF production workflows are unchanged; CDK is not a gate for this pipeline.

To retry one component after the workflow is on the default branch, use Actions
→ Staging backend images → Run workflow, select the staging branch and component.
Until then, a push to the dedicated staging branch starts the workflow.

## Novu update

Developer fix `879ed55` provisions/updates the patient's Novu subscriber from
their current verified account email before triggering generic notification text.
The restricted worker uses `integration.notification_recipient_for_claim` rather
than reading identity/auth tables directly. Apply additive migration 0063 and
the reviewed runtime grants before deploying this worker. Existing migration
checksums remain unchanged. `test-notification-recipient.mjs` exercises real
restricted PostgreSQL logins using synthetic data in a disposable container.

## First live build and scan results (2026-10-05)

The workflow runs on the dedicated staging branch. All thirteen component test,
typecheck and ARM64 build jobs passed those steps in run `37294730067`; final
OS-inclusive Syft/Grype scans blocked publication. The repository's action
allowlist rejected Anchore actions, so official scanner binaries are installed
using pinned release SHA-256 values. Failed scan artifacts retain the exact SPDX
SBOM and full Grype report; package findings also appear in the job log.

The original Node 22 distroless base had outdated OpenSSL and glibc libraries.
The pinned base was then updated within the same Node 22/Debian 13 image family to
`sha256:55e7cd155c86d8956af63fec0a9d0790dd6d0ba98c7d38e63c0866557ee7aff8`.
Scanning that exact ARM64 base removed all Critical findings and the High findings
with available Debian fixes. Six unique High advisory IDs remain (twelve package
matches), with no packaged fix reported:

| Advisory | Package(s) | Current scan result |
|---|---|---|
| CVE-2026-85091 | zlib1g | not-fixed; upstream affected-version range needs assessment |
| CVE-2026-5435 | libc6 | wont-fix; Debian calls this a minor deprecated-function issue |
| CVE-2026-19499 | libc6 | wont-fix; Debian calls this a minor formatting-function issue |
| CVE-2026-95619 | GCC runtime packages including libstdc++6 | not-fixed |
| CVE-2026-102010 | GCC runtime packages including libstdc++6 | not-fixed |
| CVE-2026-84243 | libc6 | not-fixed; gettext accepts LANGUAGE paths (added 2026-10-31) |

Sources: [zlib](https://security-tracker.debian.org/tracker/CVE-2026-85091),
[glibc deprecated functions](https://security-tracker.debian.org/tracker/CVE-2026-5435),
[glibc formatting](https://security-tracker.debian.org/tracker/CVE-2026-19499),
[GCC allocation](https://security-tracker.debian.org/tracker/CVE-2026-95619),
[GCC queue](https://security-tracker.debian.org/tracker/CVE-2026-102010),
[glibc gettext](https://security-tracker.debian.org/tracker/CVE-2026-84243).
These are scanner findings, not a claim that each is exploitable through HID.
No blanket ignore, severity downgrade or security exception is applied.

By late October 2026 Grype reported CVE-2026-111497 (Critical), CVE-2026-105482
and CVE-2026-106069 (High) against that base's Node 22.23.3 (for example run
`40910587476`); all are fixed in the Node 22.23.4 security release. The base is now pinned to
`sha256:f643bc05bdcf5a8d98442e8a2a5c7a3a4c3a0e3bc4cdc5f10557d47f1ddd5812`, the
same image variant carrying Node 22.23.4. Its only changed ELF is
`/nodejs/bin/node`, byte-identical to the signed nodejs.org linux-arm64 release
binary; the Debian library layers are unchanged. The only other changes are data
packages: tzdata and tzdata-legacy 2026c-0+deb13u1 to 2026e-0+deb13u1, and
ca-certificates 20250419 to 20250419+deb13u1, which removes the AAA Certificate
Services (Comodo) and emSign ECC Root CA - G3 roots from
`/etc/ssl/certs/ca-certificates.crt`. Node uses its bundled root store by default,
and no HID service reads the system bundle or switches Node to it. These checks
are recorded in `security/node-22.23.4-runtime-evidence.json`. Scanning that ARM64
base reports no Node finding and the same eleven High matches listed above.

Every staging image with High scan findings (all but the gateway, whose scan is
clean) is admitted against the same exact-image not-affected assessment as
production, `security/production-runtime-assessment.json`, which covers all
twelve assessed components. Editing it rebuilds every staging image.
The earlier per-component staging assessments (first for the Novu update, see
`security/STAGING_NOVU_RUNTIME_ASSESSMENT.md`) are kept only as the native
evidence that assessment cites. The expiring OpenVEX is generated only after
native-binary/package checks, and is rechecked before publication.
Both raw and assessed findings are retained. `component=novu-update` builds and
publishes only the worker and migration images; no frontend is rebuilt.
Publication remains blocked until supported patches or evidence-backed affectedness
decisions resolve the actual findings. Gateway findings remain in its separate
scan artifact; its Nginx/base image is unchanged by this scoped Novu update.

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

The owner (D-Eminence) approved an exception in chat on 2026-11-01. It is
recorded in `security/npm-audit-exceptions.json`, approved 2026-11-01 and
expiring 2026-12-01 at 00:00 UTC. The basis:

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
  only `actions/checkout` and `actions/setup-node` come before the audit step:
  no `npm ci`, install script, build or test, and no cache restore. `npm audit`
  reads only the lockfile, and the exception gate uses only Node built-ins.
  setup-node must say `package-manager-cache: false` (it takes a missing or
  empty value as true), and setup-go comes after the audit, because a cache
  restored before it could bring back whatever an earlier run's dependency code
  saved, a replaced `npm` in the tool cache included. The publisher tooling
  job's setup-go must also say `cache: false`. Each audit job has exactly one
  checkout step, before its audit: the local gates at the event's own commit
  (no `ref`), the publisher at `inputs.tooling_sha`, so no checkout step can
  point the audit at another commit. A later `run` step that rewrites the tree
  or a lockfile is not checked: like any step after the audit, it is left to
  owner review. The step runs in
  `shell: /usr/bin/bash -p -e {0}`: an absolute path, so no `bash` found on PATH
  runs it, and privileged mode, so bash reads no `BASH_ENV` or `ENV` file and
  imports no shell function from the environment, even one written to
  `GITHUB_ENV` at run time. A release test runs both shells to show the
  difference.
- **The environment, by allowlist.** The workflow env, every audit job's env
  and the env of every step in an audit job may set only the variables these
  workflows use today
  (`AUDIT_ENV_ALLOWLIST`: `CI`, `NODE_VERSION`, `GO_VERSION`, the two broker
  images, `GOTOOLCHAIN`, `TOOLING_SHA`, `PLAN_JSON`, `WRANGLER_SEND_METRICS`,
  `HID_REQUIRE_CLOUDFLARE_VALIDATOR`, `HID_PUBLIC_BASE` and `GATE_STEPS_JSON`;
  `NODE_VERSION` only in the workflow env). `BASH_ENV`, `ENV`, `NODE_OPTIONS`,
  `npm_config_*`, `PATH`, a proxy, an extra CA and anything else are refused
  there. In every other job, the publish job included, `npm_config_*`,
  `NODE_OPTIONS`, `PATH`, `BASH_ENV` and `ENV` (matched in any case) are refused
  in any env: the job's and its steps'. Every env anywhere in the workflow
  must be a plain map, not an expression whose keys a reviewer cannot see. No
  job may run in a container or with services. A job container's env, image,
  Docker options, ports and volumes can each set an environment variable for
  every step, in more spellings than a static check can list; a service
  container runs beside the steps and, through its image, options or volumes,
  can change what they reach. None of these workflows uses one.
- **The actions and the runner, by allowlist.** An audit job may use only
  `actions/checkout`, `actions/setup-node`, `actions/setup-go` and
  `actions/upload-artifact`, each at its reviewed commit and with only the inputs
  it takes today (`AUDIT_JOB_ACTIONS`); any other action, a local action or a
  container action is refused. setup-node must install the reviewed Node
  (22.23.2), and every audit job runs on `ubuntu-24.04`.
- **One reading of the YAML.** The verifier's YAML parser ends a line only at
  LF. YAML 1.2 also ends one at a lone CR, and libyaml-family parsers (the
  family of GitHub's) also at NEL, LS and PS. Such a character in a comment
  would hide every key and step after it from the verifier while GitHub runs
  them. So every workflow read through the verifier's parser (these two, and
  the protected readiness workflow) must be printable ASCII with LF line breaks
  (tab allowed), end with a line break, and carry no `%YAML` directive. Release tests hide a checkout `ref`, a step before
  the audit, `continue-on-error` and an npm cache behind each of the four. Those
  workflows must also keep to a block-style subset that a differential test
  against libyaml (about 150,000 generated documents) found both parsers read
  the same way: no flow collection except an empty one (in `{?ref: …}` the key is "?ref"
  to the verifier and "ref" to libyaml), no anchor (libyaml ends its name at
  `:` or `?`), no explicit tag, no `<<` merge key, no quoted or plain value over
  several lines (an escaped line break folds differently, and after a bare `-`
  and a comment the verifier joins the following items into one value), no
  block scalar indentation indicator (trailing whitespace lines differ), and no
  block scalar header on a line of its own (after a comment line, it swallows
  the keys below it in the verifier's parser, `continue-on-error` included).
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
image scans or `security/production-runtime-assessment.json`. It is also the
first npm audit exception: RF-005 in `docs/RELEASE_FINDINGS.md` declined one
for a High in the same bundled tree. This one is a moderate, approved by the
owner, limited to one installed path and expiring.

Before 1 December, either move infra/aws to an aws-cdk-lib release that bundles
minimatch 11.0.1 or later and delete the entry (left in place it fails as stale),
or have the owner review the basis again and set new `approved_at` and
`expires_at` dates. With no entries the gate behaves like the plain audit, so the
workflows can keep it.
