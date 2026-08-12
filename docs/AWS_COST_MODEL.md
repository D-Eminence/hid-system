# HID AWS and Cloudflare Cost Model

Status: architecture-level variables only. No current account pricing, region,
traffic, provider contract, tax, or production load evidence exists, so this
document intentionally provides no monthly total.

## Estimation method

Create separate development, staging, and production estimates after region and
provider approval:

```text
monthly cost = runtime hours and scale-out
             + protected data/storage/backup
             + requests, events, messages and OCR pages
             + transfer/NAT/endpoints/load balancing
             + logs, metrics, scans and evidence retention
             + Cloudflare plans/Workers delivery
             + external notification providers
             + recovery and capacity headroom
```

## Main variables

| Driver | Variables and current topology |
|---|---|
| ECS/Fargate | Eleven independent long-running services; vCPU/memory, desired count, runtime hours, scale-out, and ephemeral storage. Migration is a twelfth one-shot image/task, not a service. |
| RDS PostgreSQL | Instance class, Multi-AZ, gp3 allocation/growth, backups/PITR, snapshots, log export, and connection/query load. |
| NAT | One development or two staging/production gateways plus processed GiB for non-endpoint provider/issuer traffic. |
| VPC endpoints | Eight interface services across selected AZs: ECR API/Docker, Logs, Secrets Manager, KMS, EventBridge, SQS, Textract. S3 uses a gateway endpoint. |
| Load balancers | One public API ALB and one internal HTTPS ALB; hours and LCUs. There is no CloudFront cost. |
| AWS WAF | One regional web ACL, managed groups, rate rule, and inspected API requests. |
| Cloudflare | Seven Workers Static Assets deployments, DNS/TLS/WAF/request/egress allowances, logs, and any paid plan features. The apex redirect is originless. |
| S3/KMS | Current/non-current document versions, requests, multipart residue, KMS keys/operations, and legally required retention. |
| Textract | Pages/images by operation and bounded retries. No Bedrock resource exists. |
| EventBridge/SQS | Custom ordinary-notification events, rule matches, queue requests/storage, redrive, and DLQ retention. Authentication OTP bypasses this path. |
| Notifications | SES email; Termii SMS; Meta/Infobip WhatsApp or fallback; Novu ordinary workflows; FCM server push. Estimate per approved contract and country/channel mix. |
| CloudWatch | Eleven runtime log groups plus migration/RDS logs, Container Insights, alarms, metric filters, retention, and query volume. |
| ECR/scanning | Eleven repositories, twelve release image identities, retained GiB, CI scans, and future Inspector enhanced scanning. |
| Secrets Manager | Nine runtime DB secrets, migration, auth, Identity-sensitive, notification-provider, and bootstrap interfaces plus rotation/API calls. |
| Route 53/ACM | Private DNS queries and regional certificates. Public DNS/TLS is Cloudflare-owned. |

## Environment profile

| Variable | Development | Staging | Production |
|---|---:|---:|---:|
| Availability zones | 2 | 2 | 3 |
| NAT gateways | 1 | 2 | 2 |
| Recommended Gateway/API count after gates | 1 | 2 | 2 |
| Recommended Worker/Dispatcher count after gates | 1 | 1 | 2 |
| API scale ceiling | 2 | 4 | 8 |
| RDS class | `db.t4g.small` | `db.t4g.medium` | `db.r6g.large` |
| RDS Multi-AZ | no | yes | yes |
| RDS allocated/max GiB | 50/100 | 100/300 | 200/1000 |
| Backup retention | 7 days | 14 days | 35 days |
| Log retention | 30 days | 90 days | 365 days |
| ECR retained images/repository | 25 | 50 | 100 |

Desired-count recommendations are not capacity findings. The CloudFormation
parameters default to zero until prerequisites pass.

## Encoded controls

- ARM64 Fargate and bounded autoscaling avoid an unbounded shared service.
- Eleven immutable ECR repositories have scan-on-push and bounded retention.
- Frontends are independently cached by Cloudflare and do not consume Fargate
  or CloudFront capacity.
- Private AWS endpoints reduce NAT dependence for implemented AWS services;
  measure endpoint-hour cost against actual processed traffic.
- S3 uses bucket keys, version lifecycle, and seven-day multipart cleanup.
- SQS has bounded retention/redrive; its DLQ is not an archive.
- Logs have environment-specific retention and no PHI/high-cardinality metric
  dimensions.
- No API Gateway, Lambda, SNS, Redis, search cluster, Bedrock, private CA, or
  duplicate frontend hosting is provisioned.

Do not optimize away production Multi-AZ, backups/PITR, encryption, versioning,
audit evidence, private database placement, least privilege, minimum healthy
replicas, OTP separation, or release evidence solely to meet a cost target.

Before staging, attach dated AWS and Cloudflare calculator exports plus provider
quotes. After load testing and the first 30 days, compare actual Fargate/RDS,
NAT/endpoints, ALB/WAF, S3/KMS/Textract, EventBridge/SQS, notification, logs,
ECR/scans, and Cloudflare usage against the estimate.
