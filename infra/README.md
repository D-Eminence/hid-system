# Health Identity infrastructure

Terraform for the Health Identity AWS foundation described in the SOW. The implementation starts with development and keeps region selection configurable until the client approves data residency and service availability.

## Structure

| Directory | Purpose |
| --- | --- |
| `bootstrap/` | Creates the versioned, encrypted S3 remote-state bucket and its access policy. |
| `terraform/` | Composes the environment modules for dev, staging, and production. |
| `terraform/modules/network/` | VPC, two-AZ subnet layout, routing, internet gateway, and NAT. |
| `terraform/modules/data/` | KMS, S3 documents, secret placeholders, security groups, and optional RDS PostgreSQL. |
| `terraform/modules/application/` | ECR, ECS Fargate, ALB, WAF, Cloud Map, logging, and autoscaling. |
| `terraform/modules/integration/` | Optional JWT-protected provider API and VPC link. |
| `terraform/modules/ai/` | Optional private OpenSearch and allowlisted Bedrock permissions. |
| `terraform/modules/operations/` | Backups, alarms, SNS alerts, and optional account CloudTrail. |
| `cloudflare/` | Separate proxied DNS cutover after the AWS origin is validated. |

## Deployment order

1. Approve the AWS account, region, and non-overlapping network ranges.
2. Apply `bootstrap/` locally, then migrate its state into the created S3 bucket.
3. Copy `terraform/environments/dev.tfvars.example` to the ignored `dev.tfvars` file and fill in approved values.
4. Initialize the development root with the remote backend and S3 lockfile enabled.
5. Review the foundation plan before enabling RDS or cost-bearing application and AI services.
6. Add the application image, certificate, Cloudflare CIDRs, secret ARNs, and health contract before enabling ECS.
7. Validate staging before production and apply the Cloudflare DNS change only during the approved cutover.

## Current status

- No AWS or Cloudflare resources have been deployed.
- No credentials, patient data, secret values, state files, or real `.tfvars` files belong in this repository.
- The bootstrap, AWS environment, and Cloudflare roots pass provider-backed `terraform validate`.
- The application repository and Supabase dependency inventory are still required before migration and runtime integration can be completed.

See the README inside each Terraform root for its setup steps and required inputs.
