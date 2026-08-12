# HID Release Artifact Gate

Status: implemented schema and local policy; Docker/ECR/Inspector execution is externally pending.

## 1. Purpose

No tag, successful build, local test, or mutable registry reference identifies a HID release. A release is the exact Git commit plus the exact digest of each independently deployable image and its review evidence. ECS receives only `repository@sha256:<64 hex>` values through required CloudFormation parameters; `latest` is rejected by IaC assertions.

The twelve governed image identities are Identity API, EHR API, Lab API,
Pharmacy API, OCR API, OCR Worker, Outreach API, Notification API, Notification
Worker, Event Dispatcher, the API-only Gateway, and the EHR Dockerfile's
separate `migration` target. The seven frontends are independent Cloudflare
Workers Static Assets releases; they are not embedded in Gateway or counted as
ECR images.

The machine contract is [release-manifest.schema.json](../infra/aws/release-manifest.schema.json). [release-manifest.template.json](../infra/aws/release-manifest.template.json) contains substitution tokens, deliberately not fabricated digests.

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
  -> signed/retained release manifest
  -> CDK lint / typecheck / assertions / offline synth
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
6. manifest creation and schema validation;
7. authenticated ECR push, digest comparison, manifest finalization;
8. CDK synth and policy assertions using the finalized digest inputs;
9. staging approval;
10. foundation deploy with desired counts zero;
11. migration plan, snapshot/PITR check, dry run, apply and zero-pending verification;
12. token delivery/issuer, secret, TLS and provider preflight;
13. staging service rollout and acceptance;
14. production approval, migration, progressive rollout and acceptance.

GitHub OIDC is the intended future CI credential mechanism. No trust provider, repository subject, AWS role, or account policy is created here because the account/repository governance inputs are not authorized. Static AWS keys are forbidden.

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
| Docker builds/digests/layers/SBOM/image scans | Externally pending; Docker is available locally, but no release image/evidence run is authorized in this stage |
| ECR push/registry digest/Inspector | Externally pending; no AWS account configured |

No release manifest has been fabricated for this stage.
