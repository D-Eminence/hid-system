# Exact-SHA AWS staging audit

Source: `a709e643a731b444f7cb775b2b16fe28164146a7`. Phase1/2 decision: **NOT READY**. **STAGING DEPLOYMENT AUTHORIZATION: BLOCKED**.

No source edits, authenticated AWS calls, deployment, diff/change set or cloud mutations were performed by this auditor. Dependency installation and generated evidence are local only. Root audit separately reports an expired AWS session and no actual staging account binding.

| ID | Classification | Finding |
| --- | --- | --- |
| AWS-01 | PASS | Exact-source dependency installation, static checks and 58 infrastructure tests |
| AWS-02 | PASS | Default and all three staging offline synth and declared-template verifiers pass |
| AWS-03 | PASS | Submitted templates are within S3 template, parameter, resource and output quotas |
| AWS-04 | WARNING | Full RDS bundles exceed parameter quota; a verified matching root certificate can fit |
| AWS-05 | BLOCKER | Economy lacks ECR/Logs network path for Gateway, OCR Worker and Event Dispatcher |
| AWS-06 | BLOCKER | Migration task cannot bootstrap because its security group allows only RDS egress |
| AWS-07 | BLOCKER | EHR and OCR Worker HeadBucket permission is ineffective |
| AWS-08 | PASS | Declared private data and environment separation boundaries |
| AWS-09 | NOT VERIFIED | Actual staging account/region, AZ context, cloud state and deployment permission unavailable |
| AWS-10 | NOT VERIFIED | Live credentials, CA/certificates, workload token delivery, providers and admitted image digests absent |
| AWS-11 | WARNING | Eight API/provider tasks permit public HTTPS egress without endpoint destination restriction |
| AWS-12 | WARNING | Runtime observability exists but active alert delivery and network access-log configuration are not declared |
| AWS-13 | NOT VERIFIED | Operational rollback and backup restoration remain unexecuted |
| AWS-14 | WARNING | Staging-operation wrapper is not a read-only audit command or first-foundation provisioner |
| AWS-15 | NOT VERIFIED | Release trust infrastructure and immutable retention/custody are separate gated dependencies |

## Native template quotas

| Profile | File bytes | Compact bytes | Resources | Parameters | Outputs |
| --- | ---: | ---: | ---: | ---: | ---: |
| aws-default-assembly | 517254 | 352233 | 412 | 62 | 21 |
| aws-economy-assembly | 507484 | 344515 | 408 | 62 | 21 |
| aws-economy-bound-fixture-assembly | 501679 | 342158 | 408 | 62 | 21 |
| aws-fidelity-assembly | 514974 | 349330 | 414 | 62 | 21 |
| aws-sleep-assembly | 276200 | 182291 | 207 | 37 | 20 |

The account-bound fixture output is from a failed synthesis and is measurement evidence only. It must not be used as a deployable assembly. Actual staging account-bound validation is NOT VERIFIED.

All native templates fit the 1MB S3 object quota and exceed the51200-byte inline request quota. None of the passing source verifiers check parameter value length or full template byte size. The global bundle inline-expansion experiment exceeds1MB; the actual source uses a parameter and encounters the4096-byte parameter-value limit first. Selected root certificates can fit that limit when matched to the actual RDS CA. See downloaded public-certificate hashes and byte measurements in the JSON evidence.

## AWS-01 — PASS: Exact-source dependency installation, static checks and 58 infrastructure tests

- npm ci --ignore-scripts exit0; ordinary worktree-local node_modules, not symlink
- npm run typecheck exit0; npm test exit0, 58/58; npm run cost:inventory:check exit0
- aws-command-results.json records commands, configurations, durations and log paths

## AWS-02 — PASS: Default and all three staging offline synth and declared-template verifiers pass

- Default development, staging sleep/economy/fidelity: synth --no-lookups, verify:synth and verify:policy all exit0
- infra/aws/scripts/synth.mjs:15-24; infra/aws/scripts/verify-synth.mjs; aws-template-measurements.json
- No authenticated AWS, deployment, diff or change-set command performed by AWS auditor

## AWS-03 — PASS: Submitted templates are within S3 template, parameter, resource and output quotas

- Default:517254 bytes/412 resources/62 parameters/21 outputs; sleep:276200/207/37/20; economy:507484/408/62/21; fidelity:514974/414/62/21
- All exceed 51200-byte inline request limit, so S3 template URL/CDK asset path is required
- AWS limits:200 parameters,500 resources,200 outputs,4096-byte parameter values,51200-byte inline templates,1MB S3 templates
- https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-limits.html

## AWS-04 — WARNING: Full RDS bundles exceed parameter quota; a verified matching root certificate can fit

- infra/aws/src/hid-regional-stack.ts:411,675,745,751,756,942 declares one String parameter used in ten task environments
- Downloaded public global bundle:165408 PEM bytes/220544 base64 bytes/108 certs; illustrative us-east-1 regional:4576/6104/3
- Illustrative individual us-east-1 roots:RSA2048 1932 base64 bytes; RSA4096 2852; ECC3841320. Each fits 4096 bytes
- Global-inline hypothetical expansion of economy template:2549705 compact bytes; native template remains507484 bytes. This is diagnostic, not actual CloudFormation submitted-template size
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html says register root CA only; actual staging region and selected RDS CA remain unavailable

Required disposition: Bind actual staging region and DB CA identifier; provide matching public root only and verified TLS evidence. Add staging-only MaxLength4096/input documentation; do not inline a global bundle or weaken TLS. A full-bundle deployment input is blocked, but delivery redesign is not inherently required.

## AWS-05 — BLOCKER: Economy lacks ECR/Logs network path for Gateway, OCR Worker and Event Dispatcher

- infra/aws/src/config.ts:104-107 selects only secrets-manager,eventbridge,sqs,textract endpoints
- infra/aws/src/hid-regional-stack.ts:654-662 excludes gateway,ocr-worker,event-dispatcher from public443 egress
- Synthesized economy security groups confirm only endpointSG443/S3prefix443 (+ owner ports or RDS); no ecr-api/ecr-docker/logs endpoints
- https://docs.aws.amazon.com/AmazonECR/latest/userguide/vpc-endpoints.html documents Fargate ECR API+DKR+S3 and required Logs connectivity

Required disposition: Add ecr-api,ecr-docker,logs to economy profile endpoints in one AZ; keep restrictive security groups. Update staging economy cost inventory/docs/assertions. Production/fidelity/development settings remain unchanged.

## AWS-06 — BLOCKER: Migration task cannot bootstrap because its security group allows only RDS egress

- infra/aws/src/hid-regional-stack.ts:367-372 adds RDS outbound plus endpoint inbound only
- infra/aws/src/hid-regional-stack.ts:947-951 sets allowAllOutbound:false; no matching migration443 outbound exists
- Economy synthesized MigrationSecurityGroupBCB362A0 has one outbound rule to DatabaseSecurityGroup7319C0F6 tcp5432; no endpoint or S3 path

Required disposition: For staging live profiles only, add migration-to-endpointSG tcp443 and migration-to-S3 managed prefix list tcp443. Keep no public egress; sleep remains closed. Verify full image/secret/log boot chain and actual task startup after approved deployment.

## AWS-07 — BLOCKER: EHR and OCR Worker HeadBucket permission is ineffective

- infra/aws/src/hid-regional-stack.ts:807 and822 grant s3:HeadBucket instead of s3:ListBucket
- services/ehr-api/src/storage/s3-storage.provider.ts:41 and services/ocr-worker/src/s3-document-reader.ts:18 issue real HeadBucket API calls
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadBucket.html requires s3:ListBucket for general-purpose buckets

Required disposition: In staging only replace the unsupported s3:HeadBucket action with s3:ListBucket on the exact document bucket ARN. Retain every object/KMS bound and cross-bucket denial; cover action contract with source assertions. Preserve production template byte-for-byte as user requires.

## AWS-08 — PASS: Declared private data and environment separation boundaries

- infra/aws/src/config.ts:146-166 assigns staging API/browser namespace,independent origin-secret parameter and10.30.0.0/16 CIDR
- infra/aws/src/hid-regional-stack.ts:110-115 separates edge/application/isolated database subnets;153-164 private encrypted RDS/TLS enforcement at139; 637-642 no public task IPs and circuit-breaker rollback
- Nine runtime LOGIN secrets plus separate migration secret;12 separate task/execution roles;private versioned KMS document bucket;origin WAF;no CloudFront;passed assertions

## AWS-09 — NOT VERIFIED: Actual staging account/region, AZ context, cloud state and deployment permission unavailable

- Parent read-only AWS audit reported hid-admin session expired, sts get-caller-identity exit255; no non-secret staging manifest is present
- Actual account/region synthesis not performed or claimed
- Illustrative account111111111111/us-east-1 synth --no-lookups exit1:missing availability-zones context. Its emitted assembly is incomplete diagnostic output, not successful synthesis
- infra/aws/bin/hid-infrastructure.ts:8-13; infra/aws/src/config.ts:196-201; aws-economy-bound-fixture-synth.log

Required disposition: Owner refreshes approved AWS staging login locally; independently verify actual STS/account/region and existing resources, supply validated non-secret staging manifest and approved observed AZ context. Then rerun exact-source account-bound no-lookup synthesis, API validation and read-only diff; do not use fixture identifiers.

## AWS-10 — NOT VERIFIED: Live credentials, CA/certificates, workload token delivery, providers and admitted image digests absent

- infra/aws/src/hid-regional-stack.ts:399-444 declares required certificates/prefix/root/workload/secret/digest interfaces
- Six task-local read-only workload volumes are empty contracts:627-628; no delivery sidecar/provider is present
- docs/AWS_DEPLOYMENT_RUNBOOK.md:14-32 and179-194 require independently bound inputs and provider/rotation/deny proof
- Imported external Secrets Manager CMK decrypt authority must be checked against actual key metadata:secret import at556-560 supplies no encryptionKey

Required disposition: Bind12 actual ARM64 image identities plus secrets metadata/version/CMK grants,9 runtime DB logins and migration operator,public/internal ACM,origin secret,CA/prefix list,issuer/JWKS/rotating tokens and staging providers; prove negative and positive runtime paths. Never substitute production secrets or fixture pins.

## AWS-11 — WARNING: Eight API/provider tasks permit public HTTPS egress without endpoint destination restriction

- infra/aws/src/hid-regional-stack.ts:659-662 allows anyIPv4:443 through NAT for request APIs and notification API/worker
- CODEX.md section41 requires approved PHI egress needs; source description says approved issuer/provider but security group itself is destination-broad

Required disposition: Record specific approved issuer/provider egress need and account network controls; validate real paths and least privilege. Do not broaden Gateway/OCR Worker/Dispatcher/migration egress to repair bootstrap.

## AWS-12 — WARNING: Runtime observability exists but active alert delivery and network access-log configuration are not declared

- Economy template has47 CloudWatch alarms and13 log metric filters; zero AlarmActions
- No ALB access logging,VPC FlowLogs,WAF LoggingConfiguration found in HidRegionalStack; CloudWatch resource declaration is not witnessed alert delivery
- infra/aws/src/hid-regional-stack.ts:1150 onward defines alarms; application logs are configured per task at599-613

Required disposition: Before acceptance identify approved operational alert destination/account-level log integration and prove failure detection, sanitized logs and witnessed alert receipt. If absent, add separate staging-scoped reviewed observability controls; no hypothetical claim of existing monitoring.

## AWS-13 — NOT VERIFIED: Operational rollback and backup restoration remain unexecuted

- RDS14-day backups/deletion protection and Snapshot delete/replace policies,retained keys/docs/ECR and ECS deployment rollback exist in source
- docs/AWS_DEPLOYMENT_RUNBOOK.md:248-254 gives generic previous-artifact rollback; later docs/TUF-STAGING-MIGRATION.md requires forward release C,higher metadata/high-water and safe single-writer recovery
- No accepted A/B/C retained artifact/DB/Cloudflare receipts available

Required disposition: Use canonical TUF forward recovery procedure, not stale timestamp or old Worker generation. Prove exact backup/restore/application integrity and staging A/B/C release recovery before acceptance; no stack destroy or destructive DB rollback.

## AWS-14 — WARNING: Staging-operation wrapper is not a read-only audit command or first-foundation provisioner

- infra/aws/scripts/staging-operation.mjs:38-43 requires existing RDS;54 invokes CDK diff without --no-change-set;57 can start database;66 deploys with require-approval never after acknowledgments;71 destroys on teardown
- Current auditor did not run wrapper or diff. Source acknowledgments are not substitute for actual evidence/authorization

Required disposition: Do not run this wrapper for Phase1/4 read-only validation. Establish existing-vs-new staging stack first; use explicitly read-only diff flags after credential binding; forbid teardown per user task. Review concrete command/parameters before any authorized deployment.

## AWS-15 — NOT VERIFIED: Release trust infrastructure and immutable retention/custody are separate gated dependencies

- infra/aws/bin/hid-infrastructure.ts normal app includes regional and optional cost stack only; release trust stack is deliberately absent
- docs/TUF-STAGING-INFRASTRUCTURE.md requires concrete account-bound plan and explicit Object Lock/key custody approval; no such identity/approval is available
- 58 tests include source release-trust policy tests but prove no live signing/journal/publication

Required disposition: Bind staging release-trust identifiers and reviewed current source; obtain exact irreversible Object Lock/key custody approval only after concrete reviewable plan. Do not invent keys/signatures or treat local fixtures as deployment evidence.

## Minimal candidate patch scope after Phase2

1. Stage-only economy ECR API/DKR/Logs endpoints; retain restrictive security groups and update cost inventory/assertions/docs.
2. Stage-only live-profile migration outbound443 to exact endpoint SG and S3 managed prefix list; sleep stays closed.
3. Stage-only exact document-bucket `s3:ListBucket` grants replacing ineffective `s3:HeadBucket`.
4. Stage-only RDS public-root parameter length guard (4096) and exact region/DB-CA selection guidance, plus byte/resource/parameter quota assertions. No bulk-inline CA workaround.
5. Verify default/development and production synthesized templates are byte-identical before/after the patch; no production configuration change is authorized. Re-run all58+ relevant tests, typecheck, cost inventory and all staged synth verifiers. Keep original exact-SHA evidence separate from modified unapproved candidate evidence.

Actual AWS binding, token/secret/provider/resource ownership, cloud IAM deny tests, admitted release artifacts, irreversibility approvals, deployed health, migrations, restore and forward rollback remain manual/external gates. They cannot be repaired by invented local configuration.
