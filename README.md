# hid-system infrastructure

Terraform implementation of the Health Identity AWS platform in `eu-west-1`. It translates the regional AWS CDK design from `review/staging-prerequisites-20260915` into reviewable Terraform without deploying resources.

## What is defined

- Three tier VPC networking across two availability zones in development and staging and three in production.
- PostgreSQL 16 on RDS, three KMS keys, an encrypted document bucket, and Secrets Manager containers.
- Eleven ECR repositories and eleven ECS Fargate services, plus a one-shot database migration task.
- Cloud Map, private Route 53 service names, an internal HTTPS load balancer, and a public API load balancer.
- AWS WAF origin authentication for the Cloudflare API proxy.
- EventBridge, an encrypted notification queue and dead-letter queue, service IAM roles, autoscaling, alarms, backups, budgets, and cost anomaly monitoring.
- A staging-only KMS backed workload identity issuer and token-agent sidecars.

The Cloudflare frontend remains owned by the application team. Terraform outputs the AWS API origin needed for that handoff.

## Layout

| Path | Purpose |
| --- | --- |
| `infra/bootstrap/` | Creates the protected S3 remote-state bucket and state access policy. |
| `infra/terraform/` | Environment root, safety gates, tests, and required outputs. |
| `infra/terraform/modules/network/` | VPC, subnets, routing, NAT gateways, and VPC endpoints. |
| `infra/terraform/modules/data/` | RDS, KMS, S3, secret containers, and database monitoring. |
| `infra/terraform/modules/messaging/` | EventBridge, SQS, DLQ, encryption, and queue policies. |
| `infra/terraform/modules/application/` | ECR, ECS, Cloud Map, load balancers, WAF, workload identity, IAM, and scaling. |
| `infra/terraform/modules/operations/` | SNS alerts, RDS alarms, and AWS Backup. |
| `infra/terraform/modules/cost-governance/` | Optional budgets and Cost Explorer anomaly detection. |

No resource has been applied to AWS from this repository. See [infra/README.md](infra/README.md) for the deployment sequence and remaining inputs.
