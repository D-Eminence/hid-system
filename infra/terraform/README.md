# AWS Terraform root

This root converts the application team's regional CDK design to Terraform. Environment profiles preserve the original network ranges, service sizing, database connection budgets, retention, and scaling limits.

## Safety gates

`enable_database`, `enable_runtime`, `enable_ingress`, `enable_backup_plan`, and `enable_cost_governance` default to `false`. This allows the shared foundation and ECR repositories to be reviewed before stateful or running services are created.

The provider rejects the wrong AWS account and any region other than `eu-west-1`. Runtime images must use immutable SHA-256 digests. Ingress requires both ACM certificates and a separate Cloudflare origin secret. Terraform checks subnet shape and the database connection budget before planning.

## Environment profiles

| Profile | VPC | AZs | NAT | RDS | Runtime |
| --- | --- | ---: | ---: | --- | --- |
| development | `10.20.0.0/16` | 2 | 1 | `db.t4g.small`, single AZ | API tasks start at one; workers can start at zero |
| staging sleep | `10.30.0.0/16` | 2 | 0 | retained, single AZ | desired count zero |
| staging economy | `10.30.0.0/16` | 2 | 1 | `db.t4g.small`, single AZ | low-cost live profile |
| staging fidelity | `10.30.0.0/16` | 2 | 2 | `db.t4g.medium`, Multi-AZ | production-like profile |
| production | `10.40.0.0/16` | 3 | 2 | `db.r6g.large`, Multi-AZ | at least two tasks per service |

## Local checks

```powershell
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
terraform test
```

The test suite uses a mocked AWS provider. It plans both the development foundation and the full staging economy runtime without accessing AWS.

## Remote state initialization

After applying `../bootstrap`, initialize each environment with its own state key:

```powershell
terraform init -reconfigure `
  -backend-config="bucket=<state-bucket>" `
  -backend-config="key=health-identity/development/terraform.tfstate" `
  -backend-config="region=eu-west-1" `
  -backend-config="encrypt=true" `
  -backend-config="use_lockfile=true"
```

Copy `environments/development.tfvars.example` to the ignored `environments/development.tfvars` file and replace approved values. Terraform creates secret containers but never writes secret values.

## Runtime activation

Before setting `enable_runtime = true`:

1. Push all eleven images to the ECR URLs returned by `ecr_repository_urls`.
2. Set every entry in `image_uris` to a repository digest URI.
3. Set the migration image and RDS CA bundle.
4. Populate the runtime and workload database secrets.
5. For development or production, provide the workload issuer, JWKS URL, and six service subjects.
6. Run the migration task and verify its result before starting application services.

Before setting `enable_ingress = true`, provide the public and internal ACM certificate ARNs and a random Cloudflare origin secret of at least 32 characters. The resulting `public_api_origin` is the value handed to the Cloudflare frontend owner.

The separate release trust and TUF signing design found in the application branch is outside the regional runtime stack. It should be converted as a dedicated state and approval boundary after the application release process is agreed.
