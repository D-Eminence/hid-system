# Automated staging backend builds

`Staging backend images` runs only on pushes to `staging` and on manual runs
against `staging`. It builds affected backend components and publishes passing
images to existing staging ECR repositories using short-lived GitHub OIDC
credentials. Pull requests no longer start it: `Production backend candidates`
(`production-backend-images.yml`) builds and scans PR images under the stricter
production policy, and its PR check also runs the staging selection and scan
guard tests (`scripts/staging-backend-build.test.mjs`,
`scripts/assess_staging_runtime_test.py`).
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
with available Debian fixes. Seven unique High advisory IDs were then left
(thirteen package matches) with no packaged fix reported. Each had a runtime
assessment in `security/production-runtime-assessment.json`; CVE-2026-76844 was
added on 2026-11-06 after owner approval. The two zlib advisories were fixed by
DSA-6613-1 and removed on 2026-11-12 (see below). Four OpenSSL advisories in
libssl3t64 3.5.7-1~deb13u3 were added on 2026-11-17 and two more on 2026-11-18,
so eleven High advisory IDs remain (seventeen package matches):

| Advisory | Package(s) | Current scan result |
|---|---|---|
| CVE-2026-85091 | zlib1g | fixed in 1:1.3.dfsg+really1.3.1-1+deb13u1 (DSA-6613-1); base repinned and assessment removed 2026-11-12 |
| CVE-2026-5435 | libc6 | wont-fix; Debian calls this a minor deprecated-function issue |
| CVE-2026-19499 | libc6 | wont-fix; Debian calls this a minor formatting-function issue |
| CVE-2026-95619 | GCC runtime packages including libstdc++6 | not-fixed |
| CVE-2026-102010 | GCC runtime packages including libstdc++6 | not-fixed |
| CVE-2026-84243 | libc6 | not-fixed; gettext accepts LANGUAGE paths (added 2026-10-31) |
| CVE-2026-76844 | zlib1g | fixed in 1:1.3.dfsg+really1.3.1-1+deb13u1 (DSA-6613-1); base repinned and assessment removed 2026-11-12 (the gate still rejects any gz* write import) |
| CVE-2026-95692 | libssl3t64 | not-fixed; AES-GCM-SIV IV length (added 2026-11-17) |
| CVE-2026-95691 | libssl3t64 | not-fixed; QUIC client CRYPTO frame use-after-free (added 2026-11-17) |
| CVE-2026-88823 | libssl3t64 | not-fixed; AES-GCM-SIV empty AAD update (added 2026-11-17) |
| CVE-2026-107496 | libssl3t64 | not-fixed; CMS_encrypt with EC group order 1 (added 2026-11-17) |
| CVE-2026-107493 | libssl3t64 | not-fixed; PEM_X509_INFO_read_bio_ex with a caller-supplied stack (added 2026-11-18) |
| CVE-2026-124709 | libssl3t64 | not-fixed; QUIC server keeps rejected streams (added 2026-11-18) |

Sources: [zlib](https://security-tracker.debian.org/tracker/CVE-2026-85091),
[glibc deprecated functions](https://security-tracker.debian.org/tracker/CVE-2026-5435),
[glibc formatting](https://security-tracker.debian.org/tracker/CVE-2026-19499),
[GCC allocation](https://security-tracker.debian.org/tracker/CVE-2026-95619),
[GCC queue](https://security-tracker.debian.org/tracker/CVE-2026-102010),
[glibc gettext](https://security-tracker.debian.org/tracker/CVE-2026-84243),
[zlib gz_write](https://security-tracker.debian.org/tracker/CVE-2026-76844),
[OpenSSL GCM-SIV IV](https://security-tracker.debian.org/tracker/CVE-2026-95692),
[OpenSSL QUIC client](https://security-tracker.debian.org/tracker/CVE-2026-95691),
[OpenSSL GCM-SIV AAD](https://security-tracker.debian.org/tracker/CVE-2026-88823),
[OpenSSL CMS_encrypt](https://security-tracker.debian.org/tracker/CVE-2026-107496),
[OpenSSL advisory 20261110](https://openssl-library.org/news/secadv/20261110.txt),
[OpenSSL PEM_X509_INFO](https://security-tracker.debian.org/tracker/CVE-2026-107493),
[OpenSSL QUIC server](https://security-tracker.debian.org/tracker/CVE-2026-124709),
[OpenSSL advisory 20261117](https://openssl-library.org/news/secadv/20261117.txt).
These are scanner findings, not a claim that each is exploitable through HID.
No blanket ignore, severity downgrade or security exception is applied.

By late October 2026 Grype reported CVE-2026-111497 (Critical), CVE-2026-105482
and CVE-2026-106069 (High) against that base's Node 22.23.3 (for example run
`40910587476`); all are fixed in the Node 22.23.4 security release. The base was then pinned to
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
base reported no Node finding and the zlib, glibc and GCC High matches listed
above.

On 2026-11-12 the base was repinned to
`sha256:74224b87e0ca49c53adcc9b475d13f4080a10eea5ab2fdd4684e5094accd4041`
(pushed 2026-11-08), the same image variant with zlib1g
1:1.3.dfsg+really1.3.1-1+deb13u1 from DSA-6613-1, which Debian lists as fixing
CVE-2026-85091 and CVE-2026-76844. Its only changed ELF is
`/usr/lib/aarch64-linux-gnu/libz.so.1.3.1`, byte-identical to Debian's arm64
package, with the same exported symbols and imports; the only other change is
tzdata and tzdata-legacy 2026e to 2026f. libc6, the GCC runtime and the Node
22.23.4 layer are unchanged. Both zlib findings were removed from the assessment
as fixed, and these checks are recorded in
`security/zlib-deb13u1-runtime-evidence.json`. The expected scan of this base is
the eleven glibc and GCC High matches above and no zlib finding.

On 2026-11-17 Grype began reporting four High OpenSSL advisories (OpenSSL
severity Low, advisory 20261110, fixed upstream in 3.5.10 due 2026-12-01) in
libssl3t64 3.5.7-1~deb13u3, which Debian marks vulnerable for trixie with no
fixed version. The base and its native bytes are unchanged. No process in these
images loads the system `libssl.so.3` or `libcrypto.so.3`: node links its own
OpenSSL statically, the Argon2 addon imports no OpenSSL symbol, and the only
ELFs that need `libcrypto.so.3` are `libssl.so.3` and the two `engines-3`
modules of the same package. The four entries are assessed as vulnerable code
not in execute path. They cover only the Debian copy: node 22.23.4's statically
linked OpenSSL 3.5.9 is also in the affected range, Grype does not report it,
and it stays open until a Node 22 release ships OpenSSL 3.5.10. HID services
use only `aes-256-gcm` and no CMS or QUIC API. The expected scan is now fifteen
High matches: the eleven glibc and GCC matches and the four libssl3t64 matches.

On 2026-11-18 Grype (database built 2026-11-18T06:21Z) added two more High
libssl3t64 3.5.7-1~deb13u3 findings from OpenSSL advisory 20261117 (OpenSSL
severity Low, High in Grype only from the CISA-ADP CVSS score, fixed in 3.5.10 due
2026-12-01, Debian vulnerable with no fixed version): CVE-2026-107493, a
use-after-free in `PEM_X509_INFO_read_bio_ex()` that needs a caller-supplied
non-NULL stack, and CVE-2026-124709, unbounded memory retention in the OpenSSL
QUIC server. Staging run `44300202434` confirmed that all twelve native
inventories are unchanged and that these two were the only unassessed rows. Both
are assessed on the same basis as the four above (no process loads the system
`libssl.so.3` or `libcrypto.so.3`). Node's static OpenSSL 3.5.9 is also in their
range; the Node 22.23.4 source has no `PEM_X509_INFO_read*`, `OSSL_QUIC_*` or
`SSL_new_listener` call outside `deps/openssl`. The expected scan is now
seventeen High matches. The policy `expires_at` stays 2026-12-12, but these two
entries carry a per-finding `expires_at` of 2026-12-01T00:00:00+00:00: the
assessor (`scripts/assess-staging-runtime.py`, also used by production) and
`assertScan` in both build scripts refuse a match against them from that instant,
and production refuses a per-finding expiry later than the policy's. Findings
without one are unchanged. All six libssl3t64 entries should be removed once a
Debian 3.5.10 package is in the base rather than renewed past 2026-12-01.

On 2026-11-19 Grype began reporting CVE-2026-123864, CVE-2026-123865,
CVE-2026-123866 and CVE-2026-123872 (High) against node 22.23.4 in every Node
image (for example the ehr-api job of PR #280), all fixed in the Node 22.23.5
security release (2026-11-11). The base was repinned to
`sha256:af2e7dd3017037b3ba73238b818c7273f3b4349c005f8bd1454b78d580fe7e37`
(`latest`, pushed 2026-11-12), the same image variant carrying Node 22.23.5. Its
only changed ELF is `/nodejs/bin/node`, byte-identical to the signed nodejs.org
linux-arm64 release binary, with the same imports; the only other change is the
file mode of `/usr/lib/os-release`. libc6, the GCC runtime, zlib1g and libssl3t64
are byte-identical, so the findings above are unchanged and no finding is added.
Node 22.23.5 still bundles OpenSSL 3.5.9. These checks are recorded in
`security/node-22.23.5-runtime-evidence.json`.

The gateway (nginx-unprivileged on Alpine 3.24.2) has no ELF inventory
assessment. Earlier gateway findings were fixed by pinning a fixed package from the
signed Alpine 3.24 repository (see `gateway/Dockerfile`). On 2026-11-18 Grype
began reporting CVE-2026-88823, CVE-2026-95691, CVE-2026-95692 and
CVE-2026-107496 against libssl3 and libcrypto3 3.5.9-r0 (eight High matches,
through NVD CPE data), and later CVE-2026-84786, CVE-2026-107493,
CVE-2026-124709, CVE-2026-107494 and CVE-2026-121482. Alpine 3.24 then served no
newer package, so those nine were covered by an OpenVEX (Q99 A, Q136 A). As of
2026-11-25 Alpine v3.24/main serves libssl3 and libcrypto3 3.5.9-r1 (built
2026-11-18, aports 0f4c7e8d0f5f), which patches CVE-2026-88822, CVE-2026-88823,
CVE-2026-95691, CVE-2026-95692 and CVE-2026-107496, and `gateway/Dockerfile` pins
it (Q292 A). The other five are not fixed in 3.5.9-r1. The gateway serves plain
HTTP on port 3000 and proxies only to `http://` upstreams, so it never creates a
TLS or QUIC session; nginx, its modules, njs, libapk and ssl_client import no
QUIC method, `SSL_new_listener`, DANE, `PEM_X509_INFO_*`, `CMS_*` or
`PKCS7_verify` function, and no module is loaded. Both workflows therefore apply
the committed `security/gateway-runtime.vex.json` to the gateway scan only. It
names those five CVEs for the exact libssl3 and libcrypto3 3.5.9-r1 aarch64
Alpine 3.24.2 purls, and `assertGatewayVex` in
`scripts/production-backend-build.mjs` refuses it after `hid_expires_at`
(2026-12-01), for any other package, version, CVE or Critical finding, or when the
sha256 of `gateway/Dockerfile`, `gateway/nginx.conf.template` or
`gateway/proxy-headers.conf` differs from its `hid_bound_files`, so any gateway
change needs the VEX re-reviewed. The build scripts read the VEX only for a gateway
scan with ignored High/Critical rows (a clean gateway scan needs no file), and
`pack` copies it into the gateway build evidence as `gateway-runtime.vex.json`.
Replace it with a pinned fixed Alpine 3.24 package when one is served (OpenSSL
3.5.10 is due 2026-12-01), and do not renew it.

On 2026-11-19 Grype began reporting CVE-2026-113425, CVE-2026-121810,
CVE-2026-123007, CVE-2026-123633, CVE-2026-123634 (Critical) and CVE-2026-118899
(High) against the base's nginx 1.30.6-r1, fixed from 1.30.7-r0. No
nginx-unprivileged image with 1.30.7 is published yet, so `gateway/Dockerfile`
pins nginx and its four installed modules at 1.30.7-r1 (njs 1.30.7.1.0.2-r1) from
the nginx.org Alpine 3.24 repository the base installed nginx from, verified by
the `nginx_signing.rsa.pub` key already in the base. apk keeps the base's
unprivileged `nginx.conf` and `default.conf`. Because `gateway/Dockerfile`
changed, `security/gateway-runtime.vex.json` was re-reviewed: nginx, its modules
and njs at 1.30.7-r1 have the same OpenSSL imports as 1.30.6-r1, so only its
`gateway/Dockerfile` hash and the nginx version in its statements changed; its
CVEs, purls and 2026-12-01 expiry are unchanged.

Every staging image with High scan findings except the gateway (see above) is admitted against the same exact-image not-affected assessment as
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
infra/cloudflare and the shared-package audits still run plain
`npm audit --audit-level=moderate` (apps/ehr has used the gate since
17 November; see the next section). `release/scripts/verify-publication-workflow.mjs`
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

## npm audit exception: picomatch in apps/ehr build tooling (2026-11-17)

The EHR release-bound offline cache job of `tuf-local-gates.yml` now
fails its apps/ehr audit with five high findings from one advisory,
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf):
picomatch up to 4.0.7 is open to regular expression denial of service through
single-branch repeated extglobs. npm reports picomatch 4.0.7 and, through it,
vite 8.2.4, tinyglobby 0.2.17, fdir 6.5.0 and @vitejs/plugin-react 6.1.1, all
devDependencies. There is no fix to take: 4.0.7 is picomatch's latest release.

The owner (D-Eminence) approved a narrow exception in chat on 17 November 2026
("Q95 A"): wherever picomatch is build or test tooling only and in nothing
shipped, until 2026-12-01, and only while no fixed version is published. The
evidence, from `origin/staging-novu-ci-20261005` at 73eae090:

- `npm --prefix apps/ehr test` passed, `HID_PUBLIC_BASE=/ npm --prefix apps/ehr
  run build` completed, and the job's release-binding check passed on the
  output. None of the 10 files in `apps/ehr/dist` contains picomatch's source
  strings (`picomatch`, `POSIX_REGEX_SOURCE`, `REGEX_NON_SPECIAL_CHARS`,
  `Expected pattern to be a non-empty string`); the same search finds them in
  `apps/ehr/node_modules/picomatch/lib`.
- `npm ls picomatch --omit=dev --all` is empty for apps/ehr, and
  `npm ls picomatch --package-lock-only --omit=dev --all` is empty for all 27
  `package-lock.json` directories, the 11 services included (their images
  install with `npm ci --omit=dev`). Every picomatch in a lockfile is marked dev.

The audit step of that job now runs the shared-package audits as before and
`node release/scripts/npm-audit-with-exceptions.mjs apps/ehr`, and the entry in
`security/npm-audit-exceptions.json` covers `node_modules/picomatch` in
apps/ehr only. It expires at 00:00 UTC on 2026-12-01, like the minimatch entry.
It uses two optional fields the gate gained for it:

- `dependent_paths` lists the four package paths npm reports as vulnerable
  through picomatch. The gate fails if the advisory reaches any other package
  path (for example a runtime dependency that starts using tinyglobby), and
  fails as stale if a listed one is no longer reached.
- `ends_when_fix_published: true` makes the gate run `npm view picomatch
  versions --json` and read the installed version from
  `apps/ehr/package-lock.json`. Any release outside `<=4.0.7` newer than the
  installed copy fails the gate, as does a registry or lockfile it cannot read.
  When that happens, upgrade vite (or override picomatch) and delete the entry.

`release/scripts/verify-publication-workflow.mjs` pins the new audit command
(`EHR_AUDIT_GATE`) and the directories an exception may name
(`EXCEPTION_GATE_DIRECTORIES`: infra/aws and apps/ehr); the release tests try
dropping, weakening or redirecting it.

**18 November 2026: entry removed.** npm audit stopped reporting
GHSA-fc5q-39xc-vjpf while picomatch was still 4.0.7, its latest release, so the
advisory was withdrawn or changed upstream rather than fixed:
`npm --prefix apps/ehr audit --json` now reports 0 vulnerabilities. The gate then
failed the entry as stale on every branch (`stale exception: GHSA-fc5q-39xc-vjpf
picomatch <=4.0.7 (high) in apps/ehr no longer matches npm audit at
node_modules/picomatch; correct or remove it`), so the entry was deleted, as
the stale rule above requires; the infra/aws minimatch entry is the only one
left. The apps/ehr audit stays on the gate (`EHR_AUDIT_GATE`, with apps/ehr
still in `EXCEPTION_GATE_DIRECTORIES`), so a future exception needs no workflow
change.
With no apps/ehr entry it behaves like the plain audit at moderate: if npm
reports the advisory again, the job fails until it is reviewed again. The
release tests keep the removed entry as a fixture, to go on covering
`dependent_paths`, `ends_when_fix_published` and the registry lookup.
