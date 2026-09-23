# Infrastructure workflow

## Current state

The AWS application platform is represented in Terraform and has not been deployed. The agreed home region is Ireland (`eu-west-1`). Existing AWS Budgets must be inventoried before the optional cost-governance module is enabled.

## Deployment sequence

1. Apply `bootstrap/` locally to create the S3 state bucket.
2. Move the bootstrap state into that bucket and configure the GitHub environment variables used by the plan workflow.
3. Review a development foundation plan with the database and runtime gates disabled.
4. Confirm ACM certificate validation records with the Cloudflare owner.
5. Build and push all eleven application images, then record immutable image digests.
6. Populate the application and per-workload database secrets through an approved bootstrap process.
7. Enable RDS, run the migration task, then enable ECS and ingress in development.
8. Complete health, security, backup, restore, and cost checks before staging or production.

The GitHub workflow validates and plans only. An apply job should be added after the AWS role, GitHub environments, review rules, and first plan have been approved.

## Inputs still needed

- Confirmation that AWS account `659225405023` is the intended account.
- ACM certificate ARNs after DNS validation for the public API and internal service domain.
- Eleven digest-qualified container image URIs and the migration image URI.
- The AWS RDS CA bundle used by the application containers.
- Application secret values and the database bootstrap or migration procedure.
- Development and production workload identity issuer, JWKS URL, and service subjects. Staging creates its own issuer.
- An operations email address and confirmation of the existing AWS Budgets configuration.
- Confirmation that the selected availability zones have sufficient Fargate, NAT, RDS, and elastic IP quota.

No patient data or plaintext secret value belongs in Git, Terraform variables, plans, or state.
