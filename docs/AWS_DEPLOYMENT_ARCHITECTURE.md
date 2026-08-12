# HID AWS Deployment Architecture

Status: locally implemented and synthesized; live AWS, Cloudflare, DNS, TLS,
provider, migration, and production behavior remain external acceptance.

## Production boundary

The production model has one regional AWS stack. It deliberately contains no
CloudFront distribution and no AWS-hosted frontend artifacts.

```text
browser
  -> Cloudflare DNS/TLS/WAF
  -> one of seven Workers Static Assets applications
  -> same-origin /api/v1/* Worker proxy
  -> api.healthidentitydirectory.com
  -> regional AWS WAF (origin-secret allow rule + managed/rate rules)
  -> public HTTPS ALB
  -> API-only Gateway
  -> owner API

owner outbox -> Event Dispatcher -> EventBridge
  -> ordinary-notification rule -> encrypted SQS + DLQ
  -> Notification Worker -> Novu / FCM boundary

Identity -> workload-authenticated Notification API
  -> SES / Termii / Meta, with bounded Infobip fallback
```

Authentication OTP never enters EventBridge, SQS, Novu, or ordinary delivery
history. The Cloudflare-to-AWS request carries an independent
`x-hid-origin-authorization` secret. The regional WAF rejects a missing or
incorrect value before the ALB target path. This is defense in depth and does
not replace browser authentication, CSRF, authorization, or owner-service
checks.

## Frontend ownership

Cloudflare publishes seven independent static applications:

| Host | Application | Root |
|---|---|---|
| `www.healthidentitydirectory.com` | Web/patient | `/` |
| `ehr.healthidentitydirectory.com` | EHR | `/` |
| `lab.healthidentitydirectory.com` | Lab | `/` |
| `pharmacy.healthidentitydirectory.com` | Pharmacy | `/` |
| `ocr.healthidentitydirectory.com` | OCR Operations | `/` |
| `outreach.healthidentitydirectory.com` | Outreach | `/` |
| `admin.healthidentitydirectory.com` | Admin | `/` |

The apex host performs an originless redirect to `www`. Each Worker serves only
its own build, applies its own service-worker scope and permissions policy, and
proxies only `/api/v1/*` to the fixed AWS API hostname. HTML, service workers,
and API responses are not cached as durable PHI. Gateway contains no static
frontend output and returns `API_ONLY_ORIGIN` for non-API paths.

## Regional AWS resources

The CDK v2 application under `infra/aws` synthesizes:

- a VPC with public edge, private-with-egress application, and isolated
  database subnets;
- one public HTTPS ALB, one internal HTTPS ALB, regional WAF, private service
  discovery, and private DNS;
- eleven independent ECS/Fargate services and one migration task definition;
- eleven immutable, scan-on-push ECR repositories and twelve digest-qualified
  image parameters;
- private encrypted PostgreSQL 16 with TLS enforcement, backups, logs, and
  environment-specific deletion policy;
- a private versioned KMS-encrypted document bucket and the implemented
  Textract boundary;
- one EventBridge bus, one allowlisted ordinary-notification rule, and one
  KMS-encrypted SQS queue with KMS-encrypted DLQ;
- CloudWatch logs, focused runtime/data alarms, and bounded metrics; and
- S3 gateway plus ECR, Logs, Secrets Manager, KMS, EventBridge, SQS, and
  Textract interface endpoints.

There is no API Gateway, Lambda, SNS, Redis, search cluster, Bedrock resource,
CloudFront distribution, or duplicate frontend host in the current design.

## Runtime inventory

| Runtime | Port/route | Database | Business AWS authority |
|---|---|---|---|
| Identity API | 3001; auth/identity/audit/admin | Identity LOGIN | none; calls Notification API over workload identity |
| EHR API | 3002; EHR | EHR LOGIN | exact document S3/KMS read/write |
| Lab API | 3003; Lab | Lab LOGIN | none |
| Pharmacy API | 3004; Pharmacy | Pharmacy LOGIN | none |
| OCR API | 3005; OCR | OCR API LOGIN | none |
| OCR Worker | no browser route | OCR Worker LOGIN | exact document read/decrypt and three Textract calls |
| Outreach API | 3006; Outreach | Outreach LOGIN | none |
| Notification API | 3007; internal only | none | regional `ses:SendEmail`; other providers through HTTPS |
| Notification Worker | 3008; internal health only | Notification Worker LOGIN | consume the exact notification queue; providers through HTTPS |
| Event Dispatcher | 3010; internal health only | Dispatcher LOGIN | `PutEvents` to the exact HID bus |
| Gateway | 3000; `/api/v1/*` only | none | none |
| Database migration | one-shot task | migration administrator | no steady-state service or business authority |

The migration target shares EHR's repository but has its own required image
digest, giving twelve governed image identities for eleven repositories.

## Identity, data, and secrets

Identity is the only human authentication and canonical patient/HID authority.
The supported runtime modes are local imported credentials with atomic
bcrypt-to-Argon2id upgrade, or approved OIDC. Supabase and legacy HTTP identity
proxies are migration sources/history only, never production runtime paths.

Nine non-owner PostgreSQL LOGIN secrets are isolated by service. The migration
administrator is separate. Only Identity receives auth signing/login-pepper,
NIN, OTP-HMAC, and Turnstile material. Notification provider configuration is
injected only into Notification API/Worker as required. Gateway receives no
application secrets.

Workload JWT issuer, JWKS, exact subjects, audiences, and rotating file delivery
are externally governed inputs. Empty task-local volumes describe the mount
contract; they do not prove credential delivery. Desired counts default to zero
until migration, certificates, secrets, workload identity, providers, and live
negative tests pass.

## Migration and release

Migrations `0001`–`0027` are immutable. Additive migration `0028` introduces
the identity/notification migration state needed for OTP, progressive KYC,
legacy mapping, encrypted device registration, and delivery reconciliation.
Migration is a controlled ECS RunTask operation: snapshot/PITR gate, plan,
fixture/source dry run, apply once, reconciliation, runtime-role verification,
then progressive service rollout.

Every ECS image parameter must be `repository@sha256:<digest>`. The release
gate requires all twelve component records, SBOMs, vulnerability decisions,
registry digest comparison, and an exact Git SHA. Frontend releases have their
own Cloudflare build/asset/host evidence and are not fabricated as ECR images.

## Local evidence and external gates

Local CDK assertions and offline synthesis prove the declared template shape;
they do not prove AWS IAM behavior, DNS, certificates, WAF propagation,
provider delivery, queue consumption, migrations against HID 1.0, or production
availability. Those remain explicitly external and require authorized staging
evidence before production.
