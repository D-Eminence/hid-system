# Terraform foundation

This is an undeployed infrastructure scaffold. The first target is `dev`; the AWS region is deliberately required rather than defaulted. Each environment must use its own state, CIDR ranges, and approval path.

The root composes six local modules. `network` owns VPC routing; `data` owns storage, keys, secrets placeholders, and PostgreSQL; `application` owns ECR, ECS, HTTPS ingress, WAF, and service discovery; `integration` owns the provider API; `ai` owns private OpenSearch and model permissions; `operations` owns backups, alarms, and the optional account trail. The root passes outputs between modules and selects each environment's inputs. The state bucket is created separately by `../bootstrap`.

## Included

- Two-AZ VPC with public, private application, and isolated data subnets.
- Internet gateway and optional NAT for application egress (one in dev/staging, one per AZ in production).
- KMS key, private versioned document bucket, ECR repository, ECS cluster, Cloud Map private namespace, and CloudWatch application log group.
- Application and PostgreSQL security groups, database subnet group, and optional RDS PostgreSQL instance with an RDS-managed master password.
- AWS Backup vault and daily plan, with the optional RDS instance selected when enabled.
- Optional HTTPS load balancer, AWS WAF, Fargate service, Cloud Map registration, and CPU autoscaling.
- Optional JWT-protected provider API with a VPC link to the application listener.
- Optional private OpenSearch domain and allowlisted Bedrock model permissions for the application role.
- Optional account-wide CloudTrail trail, alarms, alert topic, and Secrets Manager placeholders.

## Before a plan or apply

1. Confirm the AWS account ID and choose a region after reviewing the SOW's residency and transfer requirements with the client. The provider checks the account ID before managing resources.
2. Choose CIDRs that do not overlap other environments or connected networks. Confirm two available AZs.
3. Create the state bucket with `../bootstrap`, then initialize this root with that bucket, its environment-specific key, and `use_lockfile=true`. The backend block is empty until `terraform init -backend-config=...` supplies the approved values.
4. Copy `environments/dev.tfvars.example` to `environments/dev.tfvars` and fill in approved values. Equivalent staging and production templates have non-overlapping CIDRs. Do not commit `.tfvars` files.
5. Confirm egress, RDS and OpenSearch sizing, backup retention, recovery targets, and expected cost. `enable_nat`, `enable_database`, `enable_application`, `enable_provider_api`, `enable_opensearch`, and `enable_account_trail` default to false.
6. Run `terraform init`, `terraform fmt -check`, `terraform validate`, and `terraform plan -var-file=environments/dev.tfvars`. Review the plan before applying.

The optional task and service cannot run until a real container image, origin certificate, Cloudflare CIDRs, secrets, and health-check contract are supplied. Enabling the application requires NAT in this template. The provider API still relies on application-level consent and patient authorization; its JWT authorizer only validates partner tokens. Terraform creates Secrets Manager placeholders without secret values. Cloudflare DNS is a separate cutover template under `infra/cloudflare/`.

Terraform AWS provider v6.66.0 is locked and `terraform validate` passes. No AWS credentials or approved region are available here, so no live plan or apply has run.
