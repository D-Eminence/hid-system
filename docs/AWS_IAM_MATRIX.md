# HID AWS IAM Matrix

Status: least-privilege policies are synthesized and locally asserted; live
allow/deny behavior remains external staging acceptance.

Every ECS task definition has a distinct execution role and task role. The
execution role pulls its image, writes its log stream, and resolves only the
secrets referenced by that task. The application task role contains only its
business AWS API authority plus, for the six workload callers in staging and
production (ADR-047), an exact-resource permission to request their own
workload tokens from their own environment's issuer.

## Runtime matrix

| Runtime | Execution-role secret scope | Task-role allows | Explicit non-authority |
|---|---|---|---|
| Identity API | its DB; auth; NIN/OTP/Turnstile/platform MFA key | workload issuer `POST /token` only | no SES, provider secret API, S3, Textract, queue, EventBridge, or other DB secret |
| EHR API | its DB/scanner URL | exact document bucket metadata/read/write and exact document KMS use via S3; workload issuer `POST /token` | no auth signing/pepper, Textract, queue, EventBridge, delete, or bucket administration |
| Lab API | its DB | workload issuer `POST /token` only | no document/provider/event/queue authority |
| Pharmacy API | its DB | workload issuer `POST /token` only | no document/provider/event/queue authority |
| OCR API | its DB | workload issuer `POST /token` only | no S3/KMS/Textract/EventBridge/queue authority |
| OCR Worker | its DB | exact document read/decrypt and three regional Textract calls | no write/delete, KMS encrypt, EventBridge, queue, or clinical API IAM authority |
| Outreach API | its DB | workload issuer `POST /token` only | no provider/document/event/queue authority |
| Notification API | notification provider fields only | regional `ses:SendEmail` | no DB, Novu worker, queue consumption, EventBridge, document, or auth-signing secret |
| Notification Worker | its DB and Novu key | consume/delete/change visibility on the exact encrypted notification queue | no OTP providers, EventBridge management, document, or auth authority |
| Event Dispatcher | its DB | `events:PutEvents` on the exact HID bus | no rule/target management, queue consumption, archive/replay, or provider authority |
| Gateway | none beyond ECS execution/logging | none | no frontend secrets, DB, application secret, S3/KMS, provider, or administrative credential |
| Migration task | deployment-only migration DB | none | no service, runtime DB secret, master-secret read, or business AWS API |
| Workload issuer Lambda (staging and production, ADR-047) | no application secrets | `kms:GetPublicKey` and `kms:Sign` on its exact retained P-256 key; signing restricted to `ECDSA_SHA_256`; own logs; the key policy denies `kms:Sign` to every other principal | no database, provider, document, queue, or arbitrary-key authority |
| Staging RDS re-stop scheduler | none | `rds:StopDBInstance` on the exact staging DB ARN, sleep profile only | no production ARN, start/modify/delete/snapshot authority, wildcard resource, or retry loop |
| Cost governance stack | notification destinations only | none | no Budget Action, IAM execution role, ECS/RDS mutation, or shutdown authority |

The workload issuer exists in staging and production (ADR-047); each caller
may invoke only its own environment's `/<environment>/POST/token`. Development has no issuer, so its task roles have
no `execute-api:Invoke`.

Only Identity receives `AUTH_SIGNING_SECRET` and `AUTH_LOGIN_PEPPER`. This
negative boundary is asserted so EHR and every other task cannot receive them.
Likewise only the `identity-api` container receives `MFA_SECRET_KEY_B64`, from
the `mfaSecretKeyB64` field of the Identity sensitive secret, and
`MFA_KEY_VERSION`; this is asserted for every profile. The Identity execution
role already resolves that secret, so the key adds no IAM statement.
Provider fields are injected only into Notification API/Worker as required.

## Resource-wildcard exceptions

No inline policy grants `Action: "*"` or a service-wide action wildcard. Two
implemented APIs require `Resource: "*"` because those calls do not provide a
deployable message/document resource ARN:

- OCR Worker: exactly `AnalyzeDocument`, `StartDocumentTextDetection`, and
  `GetDocumentTextDetection`, constrained by `aws:RequestedRegion`;
- Notification API: exactly `ses:SendEmail`, constrained by
  `aws:RequestedRegion`.

All S3, KMS, EventBridge, and SQS business permissions remain resource-bound.
The offline synth verifier rejects any unreviewed wildcard-resource statement.
AWS-managed task-execution policy behavior is separate from application task
authority.

## Network/service principals

| Boundary | Permission | Enforcement |
|---|---|---|
| Cloudflare -> public ALB | HTTPS API requests only | regional WAF exact origin-secret rule plus managed/rate rules; secret stored outside task configs |
| Gateway -> browser-routed owner APIs | exact task ports | paired security-group rules; no notification/dispatcher/worker browser route |
| Service -> internal ALB | HTTPS owner-service calls | private DNS/certificate and paired security groups |
| ECS -> AWS endpoints | TLS to required endpoints | endpoint security group plus IAM API authorization |
| RDS | PostgreSQL from each DB runtime and migration SG | isolated subnets, TLS, distinct LOGIN grants |
| Document S3/KMS | EHR and OCR Worker only | exact bucket/key resources and KMS via-S3 conditions |
| Six staging caller tasks -> issuer | IAM-authenticated `POST /token` | exact API/stage/method/resource `execute-api:Invoke`; server maps IAM role to subject and audience allowlist |
| Staging API Gateway -> issuer Lambda | token POST and public JWKS GET only | exact API route source ARNs; no test-invoke permission; issuer validates request context |

The public ALB is not CloudFront-restricted: CloudFront is absent. Direct-origin
suppression is the Cloudflare-held header secret enforced by regional WAF.

## Database LOGIN mapping

Nine runtime secret interfaces map to nine non-owner LOGINs:

| Secret | Required group role |
|---|---|
| `IdentityApiDatabaseSecretArn` | `hid_identity_api_runtime` |
| `EhrApiDatabaseSecretArn` | `hid_ehr_api_runtime` |
| `LabApiDatabaseSecretArn` | `hid_lab_api_runtime` |
| `PharmacyApiDatabaseSecretArn` | `hid_pharmacy_api_runtime` |
| `OcrApiDatabaseSecretArn` | `hid_ocr_api_runtime` |
| `OcrWorkerDatabaseSecretArn` | `hid_ocr_worker` |
| `OutreachApiDatabaseSecretArn` | `hid_outreach_api_runtime` |
| `NotificationWorkerDatabaseSecretArn` | `hid_notification_worker` |
| `EventDispatcherDatabaseSecretArn` | `hid_event_dispatcher` |

Notification API is deliberately stateless and has no database secret.
`MigrationDatabaseSecretArn` is a separate deployment administrator. The RDS
bootstrap secret is never injected into a steady-state application.

## Workload identity

Workload JWTs are not IAM credentials or static environment secrets. Staging
uses an implemented IAM-authenticated issuer with the following exact bindings:

| Caller task role | JWT subject | Allowed audiences |
|---|---|---|
| Identity API | `hid:staging:identity-api` | `hid-notification-api` |
| EHR API | `hid:staging:ehr-api` | `hid-identity-api`, `hid-lab-api`, `hid-pharmacy-api` |
| Lab API | `hid:staging:lab-api` | `hid-identity-api` |
| Pharmacy API | `hid:staging:pharmacy-api` | `hid-identity-api` |
| OCR API | `hid:staging:ocr-api` | `hid-identity-api`, `hid-ehr-api`, `hid-lab-api`, `hid-pharmacy-api` |
| Outreach API | `hid:staging:outreach-api` | `hid-identity-api` |

These are six subjects and eleven caller/audience bindings. Only API Gateway's
IAM request context identifies the caller; the token request contains an
audience and cannot select a subject or role. The issuer rejects unmapped IAM
roles, foreign account/API/stage context, and unauthorized audiences. Its
Lambda role alone is granted signing with the dedicated P-256 key. The key
policy enforces that independently of IAM (DEP-4-KEY):

| Key policy statement | Effect |
|---|---|
| Account root, `kms:*` | Allow; key administration stays with the account, so the key cannot be locked out |
| `DenySigningFromEveryOtherPrincipal` | Deny `kms:Sign` to any principal whose `aws:PrincipalArn` is not the issuer Lambda role |
| `DenyEveryOtherSigningAlgorithm` | Deny `kms:Sign` with any `kms:SigningAlgorithm` other than `ECDSA_SHA_256` |
| `DenyEveryOtherMessageType` | Deny `kms:Sign` with any `kms:MessageType` other than `RAW` |

An explicit Deny overrides any IAM grant, so an administrator who grants
`kms:Sign` to another role still cannot sign; doing so would first need a key
policy change, which CloudTrail records. An account administrator can still
change the key policy or the issuer function: ADR-047 accepts that
same-account custody risk until a separate custody account or an SCP is
decided. No ECS task role has `kms:Sign` authority.

At the network edge, the issuer stage of every profile with NAT gateways
(staging economy and fidelity, production) has a REGIONAL web ACL that blocks
by default and allows only the VPC's NAT gateway Elastic IPs (D3). IAM
authentication of `POST /token` is unchanged; the web ACL also keeps the
public JWKS out of reach of every other source.

The issuer returns ES256 JWTs with a 300-second lifetime and `token_use:
workload`; receivers accept only that (ES256, `exp` and `iat` required, at
most 300 seconds old). Each caller's sidecar uses the same admitted Identity
API image, runs as UID/GID 65532 with a read-only root filesystem, verifies the
token, and atomically writes mode-0600 files into its owned mode-0700 task
volume. The application mounts that volume read-only and starts only once the
sidecar is healthy; the sidecar is not essential and ECS restarts it if it
exits (D2). Renewal runs about every 90 seconds, failures
retry after 10 seconds, and expiring files are removed. Token renewal does not
rotate the retained signing key.

All staging modes retain the same issuer, public JWKS endpoint, and key; sleep
has no running ECS tasks or token agents. There are no external staging issuer,
JWKS, or subject parameters.

Production (ADR-047, accepted; not deployed) has its own issuer with the same
six roles and eleven bindings: its own retained key
(`alias/hid-production-workload-signing`), API (`hid-production-workload-identity`),
stage `/production`, function `hid-production-workload-issuer`, and subjects
`hid:production:identity-api`, `hid:production:ehr-api`,
`hid:production:lab-api`, `hid:production:pharmacy-api`,
`hid:production:ocr-api` and `hid:production:outreach-api`, with the audiences
above. It has no external issuer, JWKS, or subject parameters. The issuer and
the agent bind the environment to the issuer path, the subject prefix and the
API Gateway stage, so a staging token or caller is refused in production and
the reverse. Development retains its external issuer and token-delivery
contract and has no token writer. Deployed minting, renewal, expiration, and
receiver rejection still require staging evidence before raising task counts.

## Required live negative tests

Staging must record that:

1. every task fails to resolve another task's secret;
2. only Identity can receive auth/NIN/OTP/Turnstile/platform MFA key material;
3. Notification API can send SES mail but cannot consume the queue;
4. Notification Worker can consume only the exact queue and cannot call SES by IAM;
5. OCR Worker succeeds on exact S3/KMS/Textract actions and fails unrelated actions;
6. Dispatcher succeeds only on exact-bus `PutEvents`;
7. Gateway has no business AWS authority;
8. each database LOGIN passes its intended SQL and fails cross-domain mutation;
9. migration authority is absent from every steady-state service;
10. each staging caller can mint only its mapped audiences, while unmapped roles,
    wrong context, and subject/role overrides fail;
11. no task can call `kms:Sign`, an administrator role granted `kms:Sign` by IAM is
    still refused by the key policy, and the issuer cannot sign with an unrelated
    key, another algorithm or a `DIGEST` message;
12. application containers cannot write token files, renewal preserves valid
    service calls, and expired, malformed, or unavailable credentials fail closed;
    and
13. the issuer stage refuses (`403` from WAF) a JWKS or token request from any
    source other than the NAT gateway addresses.

No live IAM claim is made by local synthesis.

The staging EHR and OCR Worker bucket-health grants use `s3:ListBucket` on
the exact document bucket ARN, which is the IAM permission required for the
S3 `HeadBucket` API. Object reads/writes and KMS permissions keep their
existing resource bounds. The approved production template is unchanged;
its historical `s3:HeadBucket` action requires a separately authorized fix
before any production readiness claim.
