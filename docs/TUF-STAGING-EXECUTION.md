# Protected staging execution and acceptance package

Date: 2026-09-08. Decision: **STAGING NOT ACCEPTED**.
Readiness: **BLOCKED; NOT READY FOR PROTECTED STAGING EXECUTION**.
Production remains locked. This package authorizes no commit, push, workflow
dispatch, cloud mutation, secret/key creation, migration, or deployment.

The authoritative state and verification ledger are
[TUF-PRODUCTION-IMPLEMENTATION.md](TUF-PRODUCTION-IMPLEMENTATION.md) and
[TASK.md](TASK.md). Operational prerequisites are detailed in
[CI protection](TUF-CI-PROTECTION.md),
[staging infrastructure](TUF-STAGING-INFRASTRUCTURE.md), and
[migration, restore and rollback](TUF-STAGING-MIGRATION.md).

## Exact identity and present evidence limits

The local branch is `tuf-production-release`; unchanged original preparation is
`5ee3118688e04c364b6d351d1b3ef3385c71abb4`, parent and verified remote release SHA
`ba2cd3290e7c1fe72817c3bdfb806dd306b2c633`. The original implementation and
730-day retention correction are committed and pushed. Preparation `5ee3118` is
verified on `review/tuf-preparation-5ee3118` in open
[PR #1](https://github.com/D-Eminence/hid-system/pull/1), not merged. Local source
correction `11b52d1ea59e572ad649d8f71fd84997d10749aa` is its child; synchronized
documentation/evidence is a separate local commit. Both scopes passed local
verification and remain excluded from the remote PR until a separately
authorized exact-SHA push. Old-head push CI `34167766797` and PR CI `34168206030`
passed all seven jobs each; corrected-head remote CI is unverified.
No protected run, signed staging candidate or deployment receipt exists.
Object Lock remains **UNAPPROVED / NOT CREATED**, journal/evidence retention
exactly **730 days / 2 years**.

The user confirmed the PR exposes “Merge without waiting for requirements to
be met (bypass rules)”; this is user-provided evidence and the option is unused.
Normal author PR self-approval is impossible. Existing owner-only PR exception
use and merge require separate authorization after corrected-head CI passes.
No independent developer is required, and no staging/production authorization
is inferred from owner environment self-approval being permitted.

Use [the non-secret identifier template](../release/config/staging-identifiers.template.json)
as the single inventory. Known GitHub identity is `D-Eminence/hid-system`,
repository ID `1317340803`, owner ID `182018869`. Reverify these after any
ownership change. Planned resource names and hostnames below identify the
design; they do not prove resources or DNS exist.

GitHub GET/GraphQL readback at `2026-09-08T09:47:40Z` verifies both protected branches,
review ruleset `22459937`, and four distinct environments. The sole owner may
merge their own PR through the narrow owner review exception; CI and branch
safety remain enforced. Contributors require owner review once CODEOWNERS is
installed on the base branches. Each environment requires the owner, allows
owner self-review, denies admin bypass and permits protected branches only.
Production approval is separate; no secrets or variables are configured.
See [current protection evidence](evidence/tuf-solo-governance/README.md).

| Execution binding | Required value and current state |
| --- | --- |
| Source and tooling | Two explicit immutable Git SHAs, with the publisher/tooling workflow pin reviewed independently; final execution pins remain unassigned |
| Protected ref | Preparation ref is `refs/heads/tuf-production-release`; exact execution pin requires owner review; no wildcard, tag or PR caller |
| Candidate provenance | Successful approved candidate workflow path, run ID/attempt and immutable artifact ID, name, size and GitHub digest; unavailable |
| Release identity | `r<10-digit-sequence>-g<40-character-source-SHA>` allocated under release state policy; unavailable |
| TUF target | `environments/staging/releases/<release_id>/release-bundle.json`; its exact identity and SHA-256 remain unavailable |
| Application artifacts | Twelve digest-qualified OCI images and seven deterministic frontend artifacts admitted by the signed bundle; unavailable |
| Aggregate hashes | Release-bundle, artifact-set, whole-repository, bootstrap-root, tooling-archive and publisher-config SHA-256 values; unavailable |
| Metadata | Exact root/targets/snapshot/timestamp versions, hashes, expiry and retained object versions; unavailable; never substitute fixture metadata |
| Workflow | Immutable `.github/workflows/tuf-publish.yml@<tooling_sha>`, called through reviewed committed orchestration; the literal caller pin does not yet exist |
| Approval | Actual `staging-publisher` environment deployment approval for the execution, retained owner/run evidence, self-review allowed and admin bypass false; environment configured, actual run approval absent |
| Infrastructure | Manifest account/region, role/key/bucket/state/credential-version/application/Cloudflare identifiers and readback evidence; missing |
| Journal | Planned ID `hid-staging-publication-v1`, prefix `tuf-publication-journal/hid-staging-publication-v1/`; actual bucket, chain head/object versions and checkpoint evidence unavailable |

Local tests, hashes and the synthetic PostgreSQL rehearsal are preparation
evidence only. Rebuild and verify the final committed source in protected CI.
Historical Go 1.25.0 reference hashes cannot authorize production-tooling builds;
the separately pinned Go 1.26.8 production profile and vulnerability gate apply.
The canonical ledger identifies retained evidence and any earlier temporary
records that are no longer available. Do not reconstruct missing logs as if
they were original evidence.

## Expected staging destinations

All destinations derive from the identifier template; ownership, TLS, routing,
deployed generation and health remain unverified.

| Surface | Expected URL |
| --- | --- |
| TUF repository | `https://updates.staging.healthidentitydirectory.com` |
| Application API | `https://api.staging.healthidentitydirectory.com` |
| Web | `https://staging.healthidentitydirectory.com` |
| EHR | `https://ehr.staging.healthidentitydirectory.com` |
| Lab | `https://lab.staging.healthidentitydirectory.com` |
| Pharmacy | `https://pharmacy.staging.healthidentitydirectory.com` |
| OCR | `https://ocr.staging.healthidentitydirectory.com` |
| Outreach | `https://outreach.staging.healthidentitydirectory.com` |
| Admin | `https://admin.staging.healthidentitydirectory.com` |

The TUF Worker is `hid-tuf-staging`; frontend Worker names are the template's
seven `hid-<application>-staging` names. AWS uses the proposed isolated
`Hid-staging-ReleaseTrust` and application `Hid-staging-Regional` stacks.
This topology has no TUF R2 bucket or CloudFront distribution. Do not fill
staging gaps with production resource identities or credentials.

## Mandatory execution sequence

Each row requires retained evidence before its successor may be accepted.
Local preparation can happen earlier; it does not complete a live step.
Protected branch policy must already permit and enforce the credential-free
CI run in step 2; step 4 installs/verifies the separate deployment environments.

| Step | Required execution | Completion evidence / current gate |
| --- | --- | --- |
| 1. Immutable source commit | Review final diff, secret/artifact exclusions and required verification; obtain commit authorization, then record exact SHA. Obtain separate push authorization and verify remote SHA before CI | Original implementation/retention commits pushed; preparation remains local, solo-owner corrections uncommitted; separate push/PR/merge authorization required |
| 2. Protected CI execution | Run all committed local security jobs on the exact protected source and isolated publisher-tooling checks without cloud credentials | No protected run; blocked |
| 3. CI evidence verification | Independently verify run/jobs/logs, provenance, dependency audits, paired build digests and complete artifact inventory against source | No run evidence; blocked |
| 4. Protected GitHub environment configuration | Verify owner-installed environments, exact owner reviewer, self-review allowance/admin bypass denial, branch restrictions, permissions and immutable workflow/config pins | All four environments, branch protections and owner review ruleset configured; source publication, remote CI and immutable execution pins pending |
| 5. Exact AWS/Cloudflare identifier binding | Validate the filled non-secret manifest and independently read actual ownership, scopes, versions, TLS, roles and keys | Exact identifiers unavailable; blocked |
| 6. Irreversible infrastructure authorization | Review account-specific source plan/read-only diff and request explicit approval of exact Object Lock resources/retention and signing-key custody actions | Not requested or granted; no concrete live plan |
| 7. Staging infrastructure readiness | Execute only approved changes; verify resource policies, state, retention, archives, alarms, private database/runtime and denied cross-environment access | No live infrastructure acceptance |
| 8. Protected staging publication | Approve the exact signed candidate; execute journal-owned archive, upload, preview, 100% deployment, route, public confirmation and durable completion | Candidate, orchestration and approval unavailable |
| 9. Staging application deployment | Deploy only the twelve OCI/seven frontend artifacts admitted from that TUF target and source identity | No admitted deployment or receipts |
| 10. Staging smoke/integration/security tests | Exercise health, authorized synthetic workflows, denial paths, cache generations, dependencies and release tampering | No live staging test evidence |
| 11. Staging data-migration rehearsal | Use approved synthetic/sanitized source, bound schema/inventory, immutable migration image, pre-change backup and rehearsed commands | Local synthetic rehearsal passed; actual staging remains unexecuted |
| 12. Migration integrity verification | Independently reconcile identity/clinical/object/audit relationships, counts/checksums, constraints, held/conflicting rows, timestamps and rerun behavior | Local fixture evidence only; source inventory and staging verification missing |
| 13. Backup/restore verification | Restore the identified pre-migration backup to a separate staging destination; verify database/object integrity and application behavior | Local PostgreSQL restore passed; staging snapshot/PITR and restored application unverified |
| 14. Rollback rehearsal | Execute approved forward recovery release C selecting compatible retained A artifacts after B; preserve TUF high-water and reconcile database writes | Local attack tests/design only; actual application/TUF/database recovery unexecuted |
| 15. Full staging acceptance | Independently review every criterion below and retain an explicit binary decision | STAGING NOT ACCEPTED |
| 16. Production migration preparation | Only after step 15, prepare source inventory, mappings, rehearsal-derived estimates and production-specific recovery gates | Locked; not prepared by this package |
| 17. Production cutover plan | Prepare exact artifact/resource identities, write freeze, routing, checkpoints, owners and abort/recovery criteria | Locked pending staging acceptance |
| 18. Explicit production authorization | Obtain new explicit approval covering infrastructure, publication, migration, application deployment and cutover | Not requested or granted |
| 19. Production deployment | Deploy only separately approved, verified production artifacts after staging acceptance | Forbidden in Phase C |
| 20. Production migration | Execute only the approved production plan with hard integrity and restore gates after production deployment | Forbidden in Phase C |
| 21. Post-cutover verification | Verify production data, application, TUF, journal, access and routing evidence | Locked |
| 22. Monitoring/hypercare | Execute approved observation, alert ownership, recovery and incident coverage | Locked |
| 23. Final production acceptance | Independent explicit acceptance after all production evidence exists | Locked; no production readiness claim |

## Staging test and journal procedure

Before step 8, freeze the reviewed source, candidate IDs, metadata, complete
artifact closure and manifest hashes in the execution record. Independently
verify the actual GitHub run/attempt and environment approval. Candidate code
must not execute in a credential-bearing publication job. Ordinary build/test
jobs receive neither signing credentials nor publisher authority.

The approved tooling must recompute the candidate repository hash, verify
TUF signatures/expiry/thresholds and the full target closure, admit the release
bundle and produce deployment inputs. Retain each artifact's bytes identity,
size, SHA-256, source/provenance and scan/SBOM evidence. Immutable artifact IDs
do not replace independent content verification.

Use the pinned `hid-tuf-journal` with the separately hashed journal config and
a strict read request as documented in [the operator guide](../tools/tuf-release/README.md).
Independently verify the entire retained immutable chain and evidence/object
versions, predecessor references, exact SHA/target/artifact-set/repository/
metadata/environment tuple, run owner/attempt and current CAS/high-water.
Require a committed intent before every external effect and a matching receipt
afterward. Public confirmation must re-read the served generation through the
verifier and match the full admitted artifact set. A successful Wrangler
command or CI job alone is insufficient.

At steps 9–10, retain task/Worker version identities, DNS/TLS and routing
readback, per-service health/readiness, and seven frontend build identities.
Exercise synthetic sign-in, patient/account/HID lookup, authorized EHR
encounter/note reads and supported domain workflows through their actual
routes. Verify relevant queues/provider integrations with approved staging
fixtures. Record release-bound EHR cache behavior for update, reload, offline
and reconnect, including stale-generation rejection.

Security tests must cover unauthenticated and wrong-role requests,
cross-facility/cross-patient denial, runtime role/RLS boundaries, private
database access, and absence of credentials/PHI in public artifacts and logs.
TUF attack fixtures must reject tampered target/metadata bytes, incorrect
thresholds, expiry/freeze, rollback, mixed generations, environment substitution,
untrusted refs, replay and stale journal recovery. Run destructive or retained
test writes only inside their explicitly approved staging scope; never corrupt
the live accepted repository to demonstrate an attack.

## Failure, recovery and rollback

Failure before a journal claim must retain bounded rejection/run evidence and
must not claim publication success. Once a claim or external effect exists,
an unknown outcome freezes the environment. Stop concurrent publication and
automatic retries, preserve journal/object versions and receipts, and perform
independent read-only reconciliation of the immutable archive, broker state,
Worker versions/deployments/routes and public metadata. Missing evidence is
unresolved state, not permission to replay an effect.

Use only the journal's verified recovery protocol; record the operator,
evidence references, exact observed state and authorized disposition. Never
reset a checkpoint, take over a stale claim, delete a journal slot, reuse a
burned version or trust a stale head. A network timeout does not establish
that the remote operation failed. When the prior outcome is reconciled, any
required repair proceeds through a newly approved forward publication.

Application rollback uses a new signed recovery release with higher sequence
and metadata versions, retaining compatible prior application bytes under
the release admission contract. TUF clients must continue rejecting old
metadata. Do not restore an old TUF Worker version, serve an old timestamp or
clear a client's high-water state. Verify retained artifacts, journal ancestry,
DNS/CDN/cache behavior, monitoring and user-visible application behavior.

Database recovery uses the verified pre-migration restore only when its write
boundary is safe. After target writes, freeze and reconcile those writes under
the approved single-writer recovery plan before switching; blind snapshot
replacement could lose clinical records. Independently recheck the restored
application and all identity/clinical/audit/object relationships. The exact
rehearsal and evidence requirements are in
[TUF-STAGING-MIGRATION.md](TUF-STAGING-MIGRATION.md).

## Binary staging acceptance record

Every criterion below is required. **FAIL** includes missing, unavailable or
unexecuted evidence. A local pass does not make a live criterion pass.

| Criterion | Decision | Evidence present and missing |
| --- | --- | --- |
| Immutable source and protected CI | FAIL | Local verification/source exists; authorized commit, protected remote run and independently exported CI evidence absent |
| Exact SHA/digest/provenance binding | FAIL | Source assertions and adversarial tests exist; actual candidate/build/signing/publication identities absent |
| TUF verification | FAIL | Local verifier/attack coverage exists; ceremony root pin and signed staging generation/public readback absent |
| Publication journal validation | FAIL | Local durable journal/recovery tests exist; immutable staging chain, object versions, current state and confirmed receipt absent |
| Staging infrastructure | FAIL | Source policy and offline planning exist; exact account/resource bindings, approvals and live deny/readback evidence absent |
| Staging application health | FAIL | Local builds/tests exist; deployed task/Worker identities and live readiness absent |
| Functional smoke/integration tests | FAIL | Planned supported synthetic workflows exist; end-to-end staging results absent |
| Security tests | FAIL | Local admission/schema/RLS tests exist; live identity/network/credential-boundary evidence absent |
| Tamper tests | FAIL | Local attack coverage exists; independently witnessed deployed-client staging results absent |
| Migration rehearsal | FAIL | Synthetic local PostgreSQL rehearsal passed; authorized source schema/domain/object inventory and actual staging rehearsal absent |
| Migration integrity | FAIL | Local counts/checksums, 328 foreign keys, typed retry and reconciliation passed; representative staging source/target reconciliation absent |
| Backup/restore | FAIL | Real local synthetic dump/restore equality passed; staging snapshot/restore identity and restored-application validation absent |
| Rollback rehearsal | FAIL | Forward-recovery procedure exists; accepted A/B/C application/TUF/database/DNS recovery receipts absent |
| Monitoring/logging | FAIL | Source alarms/logging design exists; canary execution, expiry/freshness alerts, operational destinations and witnessed alerts absent |
| Recovery documentation | FAIL | Local procedures exist; exact operators, environment bindings, tested run evidence and approved recovery disposition absent |

Decision: **STAGING NOT ACCEPTED**. No criterion may be waived by copying a
local fixture result, substituting production credentials or treating a
missing result as success. Production preparation remains blocked at step 16.

## Remaining source work and smallest external inputs

The reusable publisher is not a complete release orchestrator. Source execution
for the other IAM-pinned build, evidence-writer, auditor and signer workflows,
the candidate builder/attestation/signing orchestration, an immutable caller,
and a witnessed publication/expiry canary is not supplied by this package.
Root/targets custody and the owner-authorized isolated capability arrangement must also be
settled. These materially affect security; filling identifiers alone cannot
make staging executable. Implement and review the selected orchestration,
including deterministic artifacts, SBOM/scans/provenance and isolated signer
roles, before requesting staging execution authorization.

The current next gate is separate authorization to push the final local
correction/documentation SHA to the existing review branch and update PR #1.
Verify the new remote SHA and ordinary CI before separate owner-exception/merge
authorization. No merge, protected dispatch or cloud action is authorized.
The pre-PR plan below is retained as historical ordering; do not replay its
preparation-only push or create another PR.

The smallest immediate owner inputs were:

1. The exact preparation push is ready for separate authorization:
   `5ee3118688e04c364b6d351d1b3ef3385c71abb4` → `review/tuf-preparation-5ee3118`.
   The branch is currently absent. Independently verify that remote SHA before
   a separately authorized PR into `tuf-production-release`. Ordinary CI and
   owner review follow; merge requires explicit authorization. No second
   developer is required and no protected workflow is dispatched.
2. Review the eight-file solo-owner source correction and cohesive nine-file
   documentation scope as two separate logical commits, only after explicit
   authorization. They are uncommitted and excluded from the exact5ee push.
   Corrected protected checks and CODEOWNERS must land through review before
   relying on owner-specific base-branch enforcement or running readiness.
   Owner-pinned final staging SHA and explicit dispatch approval remain required.
3. Supply only non-secret staging AWS account/region, Cloudflare account/zone,
   existing provider/credential metadata references, allocated resource names
   and approved schema/dataset inventory. Complete the remaining manifest
   from independently verified resources and build/ceremony evidence as it
   becomes available. Never send token values, database passwords or keys.

After those inputs and missing source orchestration are resolved, generate the
concrete account-specific infrastructure plan and custody package. Only then
request explicit Object Lock/key actions, followed by explicit staging
publication/application/migration/test scope approval. The proposed 90-day
Object Lock default and 730-day journal/evidence retention require review
of their exact cost, deletion, key-recovery and rollback implications; no
approval has been requested or granted. Staging approval cannot authorize any
of the production steps.

The next safe local executable check is:

```sh
node release/scripts/validate-staging-identifiers.mjs --check-template release/config/staging-identifiers.template.json
```

Its successful structural check must still report unavailable identifiers and
`NOT_AUTHORIZED`. Once real values are provided, normal validation of the
ignored local manifest must pass before any dependent plan is synthesized.
The canonical ledger records the current commit proposal and final local
verification; neither this command nor that proposal dispatches a workflow.
