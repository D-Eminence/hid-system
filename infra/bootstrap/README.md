# Remote state bootstrap

This root creates the S3 bucket used by the AWS, Cloudflare, and bootstrap Terraform states. It enables versioning, default encryption, public-access blocking, TLS-only access, bucket-owner enforcement, and deletion protection. It also creates a state-access IAM policy that can be attached to the approved deployment role. The S3 backend uses lockfiles, so no DynamoDB table is needed.

The bucket must exist before it can hold its own state. Start locally with an approved AWS account and region:

1. Copy `terraform.tfvars.example` to `bootstrap.tfvars` and fill in the approved values.
2. Run `terraform init -backend=false` in this directory.
3. Run `terraform plan -var-file=bootstrap.tfvars` and review the bucket policy, region, and account.
4. Run `terraform apply -var-file=bootstrap.tfvars`. Record the `state_bucket_name` output.
5. Back up the local state securely, then migrate it to `health-identity/bootstrap/terraform.tfstate` in the new bucket with `terraform init -migrate-state` and `-backend-config` values for `bucket`, `key`, `region`, `encrypt=true`, and `use_lockfile=true`. Verify `terraform state list` after migration and remove the local copy only when the remote state is confirmed.

Use distinct keys such as `health-identity/dev/terraform.tfstate`, `health-identity/staging/terraform.tfstate`, `health-identity/prod/terraform.tfstate`, and `health-identity/cloudflare/terraform.tfstate` for other roots. The output `state_access_policy_arn` grants access across this project's state prefix; attach it only to trusted deployment roles, and narrow it per environment if roles should be isolated. Keep this bucket and the bootstrap state under restricted administrative ownership.

No AWS credentials or approved region are available here, so this stack is validated locally but has not been planned or applied.
