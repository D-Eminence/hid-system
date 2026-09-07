# HID Release Artifact Gate

Status: the container critical/high remediation passes locally; no deployment is
approved and the rejected predecessor remains permanently blocked.

## 1. Purpose

No tag, successful build, local test, or mutable registry reference identifies a HID release. A release is the exact Git commit plus the exact digest of each independently deployable image and its review evidence. ECS receives only `repository@sha256:<64 hex>` values through required CloudFormation parameters; `latest` is rejected by IaC assertions.

The twelve governed image identities are Identity API, EHR API, Lab API,
Pharmacy API, OCR API, OCR Worker, Outreach API, Notification API, Notification
Worker, Event Dispatcher, the API-only Gateway, and the EHR Dockerfile's
separate `migration` target. The seven frontends are independent Cloudflare
Workers Static Assets releases; they are not embedded in Gateway or counted as
ECR images.

The legacy container-only machine contract is
[release-manifest.schema.json](../infra/aws/release-manifest.schema.json).
The TUF release bundle being implemented under ADR-035 becomes the authoritative
promotion contract because it binds those twelve records to the seven frontend
artifacts, migration ledger, artifact-set hash, and promotion evidence. TUF is
the detached signed envelope; the JSON manifest does not invent an embedded
signature field.

## 2. Required evidence per component

Every component record must bind:

1. release identifier and exact 40-character Git SHA;
2. component and ECR repository URI;
3. registry-reported image digest and full digest-qualified image URI;
4. build timestamp;
5. CycloneDX JSON or SPDX JSON SBOM URI plus its SHA-256;
6. scanner name/version, immutable report URI, completion time, critical count, high count, and decision; and
7. an approved exception ID whenever the decision is `approved_exception`.

The registry digest is captured after push and compared with the locally built content digest. ECS parameters are rendered from this manifest, never from tags. AWS documents the accepted `repository-url/image@digest` task-definition form in its [ECS task-definition guidance](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/create-task-definition.html).

## 3. Gate order

```text
locked source checkout
  -> root tests / verify / build
  -> locked multi-stage image builds
  -> final UID, health tool, signal, layer, secret and size inspection
  -> CycloneDX or SPDX SBOM generation
  -> dependency + OS/image vulnerability scans
  -> complete container topology acceptance
  -> immutable ECR push
  -> registry digest re-read and comparison
  -> strict release bundle plus deterministic frontend targets
  -> TUF targets threshold and retained repository generation
  -> CDK lint / typecheck / assertions / offline synth
  -> pinned-root verification and sealed deployment plan
  -> staging approval
```

ECR repositories enable scan-on-push and immutable tags in IaC. A future authorized account should enable ECR enhanced scanning with Amazon Inspector for continuous findings; AWS describes enhanced scanning as the ECR/Inspector integration in [ECR image scanning](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning.html). CI's pre-push scanner remains required because registry scanning cannot protect a digest that has not yet been admitted.

## 4. Severity policy

- Any unreviewed critical or high finding blocks publication and deployment.
- `pass` is valid only when critical and high counts are both zero; the JSON schema enforces this.
- A high finding may proceed only under a time-bounded, named security exception with issue, reachable impact, compensating controls, approver, owner, expiry, and upgrade/remediation date. The manifest records its exception ID.
- Moderate/low findings require triage and ownership but are not automatically blocking. A severity increase invalidates the prior disposition.
- A scanner failure, incomplete database, missing SBOM, mutable tag-only identity, digest mismatch, missing final-layer inspection, or missing component record fails closed.

The dependency dispositions that precede this gate are in `RELEASE_FINDINGS.md`. SheetJS and lock attribution are resolved; the remaining React Router findings are moderate and explicitly tracked.

## 5. SBOM and scan custody

Use a current pinned generator capable of CycloneDX JSON or SPDX JSON. Store reports in a versioned, encrypted release-evidence location separate from application PHI. Evidence keys contain release/component identifiers only. Do not place repository credentials, environment secrets, source maps containing secrets, patient data, OCR content, or runtime configuration in SBOM metadata.

The evidence object's SHA-256 is recorded in the manifest. Retention, access logging, and write permissions belong to the release/security roles; ECS tasks do not need access.

## 6. ECR admission policy

The repositories synthesized by CDK use:

- AES-256 server-side encryption;
- immutable tags;
- scan on push;
- seven-day cleanup for untagged residue; and
- bounded retained-image counts by environment.

An immutable tag is a human release label; the digest is execution identity. Rollback selects a previously accepted manifest digest and registers a new task-definition revision. It never retags an image.

## 7. CI/CD design

The future authorized pipeline stages are:

1. source checkout at protected commit;
2. root tests, verification, and build;
3. all Docker targets built on a Docker-capable runner;
4. SBOM, dependency, OS/image, layer, secret, UID, health and signal gates;
5. topology acceptance and browser/offline acceptance;
6. deterministic frontend archives, content manifests, complete release bundle,
   artifact-set calculation, and schema/cross-field validation;
7. authenticated ECR push, digest comparison, and target finalization;
8. TUF targets signing, snapshot/timestamp signing, archive, publication preview,
   pinned-root verification, and atomic repository promotion;
9. sealed-plan CDK synth and policy assertions using only verified digest inputs;
10. staging approval;
11. foundation deploy with desired counts zero;
12. migration plan, snapshot/PITR check, dry run, apply and zero-pending verification;
13. token delivery/issuer, secret, TLS and provider preflight;
14. staging service/frontend rollout, attack tests, restore, rollback, monitoring,
   and acceptance;
15. exact-artifact production promotion, offline threshold, explicit production
   approval, migration, progressive rollout and acceptance.

GitHub OIDC is the intended future CI credential mechanism. No trust provider, repository subject, AWS role, or account policy is created here because the account/repository governance inputs are not authorized. Static AWS keys are forbidden.

Private TUF signing keys are also forbidden in GitHub secrets. Builder,
offline targets/root custody, online freshness signing, publication, workload
deployment, and independent verification are separate capabilities. A scoped
Cloudflare publisher token is not a signing key, but staging and production
must still use independent protected credentials.

## 8. Rollback and database rule

Application rollback selects a previous accepted digest/task-definition
revision and restores desired counts progressively. Database migrations are
forward-only after application: never rewrite migrations `0001`–`0028`, never
run uncontrolled down migrations, and never treat an image rollback as a
database rollback. `0001`–`0027` remain the immutable pre-convergence ledger;
`0028` is the additive identity/notification migration-state checkpoint. Use
point-in-time restore only under the incident/data-recovery decision path;
normal correction is an additive migration/forward fix.

## 9. Current evidence status

| Evidence | Status |
|---|---|
| Manifest schema/template | Implemented and locally parsed |
| CDK digest-only image parameters | Implemented and asserted |
| ECR immutable/scanning/lifecycle policy | Synthesized, not deployed |
| Web high dependency finding | Resolved locally |
| Lab/Outreach attribution | Resolved locally |
| Failed source candidate `df4f41328375c9a2235c2e6d48dd482ff6f432af` | Blocked: Docker Scout 1.24.0 found 3 critical and 9 high final-image findings in both representative Node Bookworm-slim images; see RF-004 |
| Remediated Identity/EHR representative images | Built locally from pinned Distroless Node 22 Debian 13 final stages; native modules, ready health, UID 65532, and SIGTERM passed; Docker Scout SARIF reports have 0 critical and 0 high findings |
| Full Docker builds/final-filesystem secret scans/SBOM/image scans | Passed locally for all twelve governed targets. The ten Node services and EHR `migration` report zero vulnerabilities; Gateway reports zero critical/high findings. Twelve SPDX SBOMs and their checksums were generated, all final filesystems produced zero high-confidence secret findings, and all images run non-root. Evidence must be regenerated from the clean committed release-source SHA before promotion. |
| Gateway independent remediation | Pinned `nginxinc/nginx-unprivileged` digest `sha256:334d92979f15aaecd5dd50af5105e1230e2bb70765d45b1e2f964e7c5eda81c3`; UID 101, API-only routes, health, upstream proxy, and SIGQUIT passed. Scout reports 0 critical, 0 high, 3 low, and 1 unspecified finding. |
| Runtime topology | Seven APIs reached live/ready, six database-backed APIs and two dispatchers failed readiness closed and recovered, two OCR workers polled under one non-owner role without claim errors, disabled Notification Worker returned live 200/ready 503 and handled SIGTERM, two dispatchers handled SIGTERM, and the migration image reported zero pending for plan and dry-run. No external provider was called. |
| ECR push/registry digest/Inspector | Externally pending; no AWS account configured |

The preceding candidate remains blocked and may not be promoted. A clean
remediation commit plus a complete rebuild from that exact SHA is required
before the local image set can become release evidence; ECR/Inspector and all
deployment evidence remain external.
