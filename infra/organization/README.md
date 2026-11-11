# AWS AI services opt-out (organization)

The owner's condition before the first real patient: no content that AWS AI services process for HID may be
stored or used by AWS to develop or improve its services. This root creates an AWS Organizations
**AI services opt-out policy** (`AISERVICES_OPT_OUT_POLICY`) that opts **every** AI service out, forbids child
policies from changing that, and attaches it to the **organization root**, so it covers every account in the
organization (the management account and accounts added later included).

What it covers, and what it does not:

| Service HID uses | Covered by | Notes |
| --- | --- | --- |
| Amazon Textract (OCR of uploaded paper records) | this policy | Textract is on the AI services opt-out list. |
| Amazon Bedrock (Titan embeddings, EHR chat) | Bedrock's own terms | Bedrock is not on the opt-out list; AWS states Bedrock does not use prompts or outputs to train models. Nothing to set. |
| Claude reading (Anthropic API, `api.anthropic.com`, US processing) | Anthropic's commercial terms | Not an AWS service; this policy does not apply. The owner should keep Anthropic's commercial terms and data-retention settings on file. |

Only the policy and its attachment are managed here. The organization itself is **not** imported: its enabled
policy types and trusted services may have been set outside Terraform, and a plan from this root must never
remove them.

## Steps for the owner (management account credentials)

1. **If the account is not yet in an organization** (`aws organizations describe-organization` returns
   `AWSOrganizationsNotInUseException`), create one with all features; the current account becomes its
   management account:

   ```bash
   aws organizations create-organization --feature-set ALL
   ```

2. **Enable the policy type once** on the root (Terraform stops with this command until it has been run):

   ```bash
   ROOT_ID=$(aws organizations list-roots --query 'Roots[0].Id' --output text)
   aws organizations enable-policy-type --root-id "$ROOT_ID" --policy-type AISERVICES_OPT_OUT_POLICY
   ```

3. **Plan and apply** with the same S3 backend as the other roots (`infra/bootstrap`), a state key of its own
   (for example `organization/terraform.tfstate`), and the management account's ID:

   ```bash
   terraform init -backend-config=... -backend-config="key=organization/terraform.tfstate"
   terraform plan -var aws_region=eu-west-1 -var management_account_id=<12-digit id> -out organization.plan
   terraform apply organization.plan
   ```

   The plan must show two resources to add (the policy and its attachment) and nothing else.

4. **Check** that it is in effect for the application account:

   ```bash
   aws organizations describe-effective-policy --policy-type AISERVICES_OPT_OUT_POLICY \
     --target-id <application account id>
   ```

   The effective policy must show `"opt_out_policy": {"@@assign": "optOut"}` under `default`.

## Tests

```bash
terraform init -backend=false && terraform test
```

The plan-only tests (mock provider, no AWS calls) check that every AI service is opted out at the root, that a
child policy cannot opt back in, and that the apply refuses until the policy type is enabled or when run outside
the management account.
