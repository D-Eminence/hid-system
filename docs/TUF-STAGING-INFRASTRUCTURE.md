# Staging infrastructure plan and irreversible-action gate

Status: **OBJECT LOCK: UNAPPROVED / NOT CREATED; NO LIVE PLAN OR INFRASTRUCTURE ACCEPTANCE**.
Only local source synthesis is permitted. Production is excluded from this
package. The expected topology remains AWS private services/database plus
Cloudflare Workers Static Assets; there is no TUF R2 bucket or CloudFront
distribution to provision.

## Identifier inventory and validation

Copy `release/config/staging-identifiers.template.json` into the ignored
`release/local/` directory and fill only independently verified, non-secret
identifiers. `<...>` values mean unavailable, not defaults. The known GitHub
numeric IDs came from read-only API evidence. Hostnames and names such as
`hid-tuf-staging` identify the source design, not observed cloud resources.

The inventory covers all eight capability environments/workflow refs/IAM roles,
AWS account/region/OIDC provider, three release buckets plus the clinical
document bucket, storage and four distinct signing KMS keys, broker state key,
broker image/public-key pins/bootstrap root object version, DynamoDB/journal,
Cloudflare credential ARN/version/encryption-key reference, SNS/CloudTrail/logs,
ECS/RDS/restore/snapshot/TLS/ALB identifiers, twelve exact ECR image URIs,
workload/provider/network evidence references, Cloudflare account/zone/seven
frontend services, release SHA/target/digests/versions, and migration evidence.
`cloudfront_distribution_id` and `r2_bucket` are explicitly null because this
architecture does not use them.

```sh
node release/scripts/validate-staging-identifiers.mjs --check-template release/config/staging-identifiers.template.json
node release/scripts/validate-staging-identifiers.mjs release/local/staging-identifiers.json
```

The template check succeeds structurally and enumerates missing inputs; normal
validation fails if any are missing. Unknown fields, malformed identifiers,
wrong account/region, production resource names/hosts, non-staging ECR paths,
reused role/key pins, invalid Git refs and attempted authorization flags fail.
The validator does not prove ownership of opaque KMS/account IDs. A successful
validation still states `NOT_AUTHORIZED` and `live_ownership_verified=false`.
It is never a deployment gate substitute.
The corrected source-model plans in `docs/evidence/tuf-phase-c/offline-plans.json`
were regenerated using clearly synthetic identifiers. Their policy now fixes
730-day object retention; a 729–730-day IAM remaining-duration interval accounts
for request-transit rounding while code independently verifies the original
730-day lifetime. Upper bounds reject unintended longer retention.
No live plan, resource or approval was created.

Before use, independently read AWS caller identity, resource ARNs/tags, bucket
owner/encryption/retention, KMS public-key/SPKI/usage/state, role trust and
effective permissions, exact secret metadata/version ID (never value), RDS
snapshot/CA/network state and immutable registry digests. Verify Cloudflare
account membership, zone ID/name, token account/zone scope, Worker name/route
and certificate state. Export only sanitized identifiers and evidence hashes.

## Proposed resource changes

`HidReleaseTrustStack` exists in source but is deliberately absent from the
normal CDK deployment entry point. The proposed isolated stack name is
`Hid-staging-ReleaseTrust`; the exact account, region, allocated physical
bucket names and immutable workflow pins remain missing.

| Resource | Proposed change | Dependencies and retained boundary |
| --- | --- | --- |
| `ReleaseRepository`, `EvidenceArchive`, `AuditLogArchive` S3 buckets | Create private, versioned, KMS-encrypted, Object-Locked buckets | Separate from patient documents; block public access, TLS-only; retain on deletion/replacement |
| Storage and broker-image KMS keys | Create distinct retained rotating encryption keys | Key access must survive recovery and archive retention |
| Snapshot/timestamp candidates | Create four non-exportable P-256 SIGN_VERIFY KMS keys | Two independent keys per online role; public pins require a separate custody/ceremony approval |
| Broker ECR repository | Create `hid-staging-tuf-signing-broker` | KMS encryption, immutable tags, scan on push, retained image bytes |
| OIDC capability roles | Create eight exact-subject, repository/owner/ref/workflow-bound roles | Existing provider only; no ordinary build signing permission |
| CloudTrail | Create `hid-staging-release-trust-audit` with release object data events | Dedicated audit bucket; no clinical log payloads |
| Broker phase | Add DynamoDB state, state KMS key, five fixed Lambda functions, alarms/log groups, publisher journal grants | Requires broker image digest, ceremony root/SPKI pins, alert destination and existing credential ARN/version |
| Cloudflare TUF Worker | Protected bootstrap/upload/preview/100% deploy/custom-domain activation | Separate later publication authorization; no runtime signing or write endpoint |
| Application foundation | Existing `Hid-staging-Regional` source plan | Separate readiness/approval; private RDS, ECS, task roles, secrets, queues/logs and ALB/TLS |

The source supports a two-step trust-stack bootstrap: first retained storage and
candidate keys; then the broker after root/SPKI/image pins exist. Neither step
can be authorized with missing resource identities. Do not deploy an empty
broker configuration and call signing/publication ready.

Offline plan generation, after the required literal plan identifiers exist:

```sh
npm --prefix infra/aws run typecheck
npm --prefix infra/aws test
cd infra/aws
node --import tsx scripts/plan-tuf-staging.mjs --foundation ../../release/local/staging-identifiers.json /tmp/NEW_FOUNDATION_PLAN
node --import tsx scripts/plan-tuf-staging.mjs --broker ../../release/local/staging-identifiers.json /tmp/NEW_BROKER_PLAN
```

This script validates staging context and creates only a local CloudFormation
assembly plus `review.json` containing logical resource actions and the exact
template hash. It does not initialize a cloud client, invoke deployment, resolve credentials
or look up resources. The construct's required acknowledgment literals model source
only; `review.json` records `NOT_AUTHORIZED`. A missing identifier fails before
synthesis. The normal application CDK entry point is unchanged.

Before requesting mutation approval, retain the concrete template, template
hash, immutable source SHA and real read-only existing-stack comparison. Review
every create/modify/replace/delete, IAM trust diff and quota/cost impact. A
CloudFormation change-set creation is itself an external mutation and is not
performed by local planning. Do not present the source inventory as a real
account-specific diff.

The authoritative journal/evidence duration is **2 years (730 days)**. This
local correction grants no infrastructure authority. Staging/production bucket
defaults remain their separate 90/180-day policies; journal, state and evidence
objects explicitly request 730 days. Expiry of the lock does not authorize
deletion or bypass append-only journal/recovery checks.

## Object Lock approval record to complete

| Decision | Proposed staging setting / implication |
| --- | --- |
| Why | An overwritten/deleted journal must not erase publication intent or allow replay; retained exact object versions preserve release and recovery evidence |
| Exact resources | The three named logical buckets in `Hid-staging-ReleaseTrust`; account/region and final physical IDs remain `<REQUIRED>` |
| Environment | Staging only; no production bucket/key/credential substitution |
| Mode | Proposed COMPLIANCE; 90-day bucket default. Owner must explicitly approve this choice before creation |
| Journal/evidence retention | Adapter explicitly requests **730 days (2 years)** for publication journal slots, evidence and archived generation objects; state policy enforces the corrected floor. This is materially longer than the 90-day default |
| Legal holds | No hold is configured. Ordinary operators receive no hold/bypass/delete capability. Any future legal-hold change is independently governed |
| Lifecycle | No automatic purge is approved. Roots remain permanent; retain at least five accepted staging releases and 90 days, whichever is greater, and every referenced rollback artifact |
| Deletion | Compliance-locked versions cannot be deleted or have retention shortened before expiry, even by the account root. Stack deletion/replacement retains resources |
| Cost | Ongoing S3 version/object growth, requests/checksums, KMS keys/requests, CloudTrail data events, DynamoDB PITR, ECR bytes, Lambda and CloudWatch retention/alarms; immutable 730-day evidence cannot be purged to recover costs |
| Cost estimate | Requires region, release/file/byte counts, publication/renewal frequency, log volume and retention. No price or numeric total has been invented. Use approved current pricing and include renewal-driven journal growth |
| DR | Preserve KMS decrypt ability, exact object version IDs/hashes, all root history, full journal and current CAS/high-water. Test archive readback and DynamoDB reconstruction without trusting an older head |
| Rollback | No undo for Object Lock enablement. Before creation, abandon the plan; afterward, stop writers and retain locked resources. Correct configuration through a reviewed forward change/new isolated stack, never erase history |
| Can it change later? | Object Lock cannot be disabled and versioning cannot be suspended. Bucket defaults may affect future objects; existing compliance deadlines cannot be shortened. Longer retention increases irreversible obligations |
| Blast radius | Wrong account/key/retention can lock inaccessible or unintended bytes for 2 years, accumulate costs, or destroy decryption recovery. Never upload PHI or secrets to the release archive |
| Authorization | **NOT REQUESTED / NOT GRANTED**: exact account-specific plan and custody inputs must exist before a concrete approval request |

AWS documents the irreversible bucket/versioning behavior, encryption-key loss,
replication and lifecycle limitations in [Object Lock considerations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-managing.html),
and compliance retention semantics in [Locking objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html).
Object Lock protects versions; unversioned delete markers and key deletion are
separate threats addressed by the source policy and required recovery drills.

## Post-creation verification, only after authorization

Use literal identifiers from the approved manifest; capture metadata only:

```sh
aws sts get-caller-identity
aws s3api get-bucket-versioning --bucket EXACT_BUCKET --expected-bucket-owner EXACT_ACCOUNT
aws s3api get-object-lock-configuration --bucket EXACT_BUCKET --expected-bucket-owner EXACT_ACCOUNT
aws s3api get-bucket-encryption --bucket EXACT_BUCKET --expected-bucket-owner EXACT_ACCOUNT
aws s3api get-public-access-block --bucket EXACT_BUCKET --expected-bucket-owner EXACT_ACCOUNT
aws s3api get-bucket-policy --bucket EXACT_BUCKET --expected-bucket-owner EXACT_ACCOUNT
aws dynamodb describe-table --table-name hid-staging-tuf-broker-state --region EXACT_REGION
aws dynamodb describe-continuous-backups --table-name hid-staging-tuf-broker-state --region EXACT_REGION
aws secretsmanager describe-secret --secret-id EXACT_SECRET_ARN --region EXACT_REGION
aws secretsmanager list-secret-version-ids --secret-id EXACT_SECRET_ARN --region EXACT_REGION
aws kms describe-key --key-id EXACT_KEY_ARN --region EXACT_REGION
aws kms get-public-key --key-id EXACT_SIGNING_KEY_ARN --region EXACT_REGION
aws cloudtrail get-trail-status --name hid-staging-release-trust-audit --region EXACT_REGION
```

Recompute the public SPKI hashes, compare to ceremony pins, inspect effective
role permissions and CloudTrail event selectors/alarms, and prove denied
cross-environment, signing, deletion, retention-bypass and checkpoint writes
with authorized negative tests. Read an exact test object's retention/checksum/
KMS/version after the separately authorized test write. Object Lock tests create
retained data and need inclusion in the approval. Verify Cloudflare Worker
versions/deployments/routes through the pinned wrapper/provider read APIs;
[Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/)
distinguish version upload from deployment. Do not run `wrangler rollback` on a
TUF repository.
