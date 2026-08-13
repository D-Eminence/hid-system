# HID AWS IAM Matrix

Status: least-privilege policies are synthesized and locally asserted; live
allow/deny behavior remains external staging acceptance.

Every ECS task definition has a distinct execution role and task role. The
execution role pulls its image, writes its log stream, and resolves only the
secrets referenced by that task. The application task role contains only its
business AWS API authority.

## Runtime matrix

| Runtime | Execution-role secret scope | Task-role allows | Explicit non-authority |
|---|---|---|---|
| Identity API | its DB; auth; NIN/OTP/Turnstile | none | no SES, provider secret API, S3, Textract, queue, EventBridge, or other DB secret |
| EHR API | its DB/scanner URL | exact document bucket metadata/read/write and exact document KMS use via S3 | no auth signing/pepper, Textract, queue, EventBridge, delete, or bucket administration |
| Lab API | its DB | none | no document/provider/event/queue authority |
| Pharmacy API | its DB | none | no document/provider/event/queue authority |
| OCR API | its DB | none | no S3/KMS/Textract/EventBridge/queue authority |
| OCR Worker | its DB | exact document read/decrypt and three regional Textract calls | no write/delete, KMS encrypt, EventBridge, queue, or clinical API IAM authority |
| Outreach API | its DB | none | no provider/document/event/queue authority |
| Notification API | notification provider fields only | regional `ses:SendEmail` | no DB, Novu worker, queue consumption, EventBridge, document, or auth-signing secret |
| Notification Worker | its DB and Novu key | consume/delete/change visibility on the exact encrypted notification queue | no OTP providers, EventBridge management, document, or auth authority |
| Event Dispatcher | its DB | `events:PutEvents` on the exact HID bus | no rule/target management, queue consumption, archive/replay, or provider authority |
| Gateway | none beyond ECS execution/logging | none | no frontend secrets, DB, application secret, S3/KMS, provider, or administrative credential |
| Migration task | deployment-only migration DB | none | no service, runtime DB secret, master-secret read, or business AWS API |
| Staging RDS re-stop scheduler | none | `rds:StopDBInstance` on the exact staging DB ARN, sleep profile only | no production ARN, start/modify/delete/snapshot authority, wildcard resource, or retry loop |
| Cost governance stack | notification destinations only | none | no Budget Action, IAM execution role, ECS/RDS mutation, or shutdown authority |

Only Identity receives `AUTH_SIGNING_SECRET` and `AUTH_LOGIN_PEPPER`. This
negative boundary is asserted so EHR and every other task cannot receive them.
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
| S3/KMS | EHR and OCR Worker only | exact bucket/key resources and KMS via-S3 conditions |

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

Workload JWTs are not IAM credentials or static environment secrets. Exact
issuer, JWKS, subjects, audiences, expiry, and rotation are externally supplied.
Read-only token-file mounts define the service contract; a real delivery
mechanism must be proven before desired counts rise from zero.

## Required live negative tests

Staging must record that:

1. every task fails to resolve another task's secret;
2. only Identity can receive auth/NIN/OTP/Turnstile material;
3. Notification API can send SES mail but cannot consume the queue;
4. Notification Worker can consume only the exact queue and cannot call SES by IAM;
5. OCR Worker succeeds on exact S3/KMS/Textract actions and fails unrelated actions;
6. Dispatcher succeeds only on exact-bus `PutEvents`;
7. Gateway has no business AWS authority;
8. each database LOGIN passes its intended SQL and fails cross-domain mutation; and
9. migration authority is absent from every steady-state service.

No live IAM claim is made by local synthesis.
