# CDK to Terraform reconciliation

Reviewed on 2026-09-23 against `origin/review/staging-prerequisites-20260915` at commit `7b47728`.

## Converted regional platform

| CDK capability | Terraform location |
| --- | --- |
| Environment profiles and workload catalogue | `terraform/locals.tf` |
| VPC, subnet tiers, NAT and AWS endpoints | `terraform/modules/network/` |
| PostgreSQL 16, KMS, documents and secret containers | `terraform/modules/data/` |
| EventBridge and notification queues | `terraform/modules/messaging/` |
| Eleven ECR repositories and Fargate services | `terraform/modules/application/` |
| Cloud Map and internal TLS routing | `terraform/modules/application/platform.tf` and `ingress.tf` |
| Public gateway ALB and WAF origin control | `terraform/modules/application/ingress.tf` |
| Staging workload issuer and token sidecars | `terraform/modules/application/workload_identity.tf` and `runtime/` |
| Database migration task | `terraform/modules/application/workloads.tf` |
| Alarms, alerting and backups | `terraform/modules/application/autoscaling.tf` and `terraform/modules/operations/` |
| Budgets and anomaly detection | `terraform/modules/cost-governance/` |

## Terraform improvements

- Environment-specific remote state with S3 lock files.
- AWS account and Ireland region guards.
- Explicit resource activation gates for a staged first deployment.
- Immutable container digest validation.
- Least-access security group rules expressed as standalone resources.
- RDS enhanced monitoring role and explicit log retention.
- KMS permissions for encrypted EventBridge to SQS delivery.
- Mocked development and staging runtime plans in `terraform test`.
- CI performs format, validation, tests, and plans; it cannot apply yet.

## Separate follow-on scope

The application branch also contains a release trust and TUF signing system with Object Lock archives, CloudTrail, GitHub OIDC capability roles, asymmetric signing candidates, and an optional signing broker. It is a separate security boundary and is not instantiated by the regional application entry point. Its Terraform conversion should use a separate backend and approval workflow after the release process, immutable GitHub workflow references, retention mode, and signing custody are approved.

Cloudflare Workers and frontend routing remain with the frontend owner. This repository supplies the AWS origin, certificate requirements, and origin-secret contract needed for that integration.
