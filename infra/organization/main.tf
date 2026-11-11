# AI services opt-out (owner condition before the first real patient): no content that AWS AI services process
# for HID (Amazon Textract reading uploaded paper records, and every other AI service on the opt-out list) may be
# stored or used by AWS to develop or improve its services. Attached to the organization root, so it applies to
# every account in the organization, the management account and accounts added later included.
#
# Only the policy and its attachment are managed here. The organization itself (its policy types and trusted
# services) is deliberately not imported: a plan would remove any setting made outside this root. Enabling the
# AISERVICES_OPT_OUT_POLICY policy type on the root is one command run once by the owner (README.md); the
# precondition below stops the apply, naming that command, until it has been run.

data "aws_organizations_organization" "current" {}

locals {
  root = data.aws_organizations_organization.current.roots[0]
  ai_opt_out_enabled = anytrue([
    for policy_type in local.root.policy_types :
    policy_type.type == "AISERVICES_OPT_OUT_POLICY" && policy_type.status == "ENABLED"
  ])

  # Every AI service, opted out, and child policies may not change it ("@@none").
  ai_opt_out_content = {
    services = {
      default = {
        opt_out_policy = {
          "@@operators_allowed_for_child_policies" = ["@@none"]
          "@@assign"                               = "optOut"
        }
      }
    }
  }
}

resource "aws_organizations_policy" "ai_services_opt_out" {
  name        = "hid-ai-services-opt-out"
  description = "HID: AWS AI services may not store or use HID content to develop or improve their services."
  type        = "AISERVICES_OPT_OUT_POLICY"
  content     = jsonencode(local.ai_opt_out_content)

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_organizations_policy_attachment" "ai_services_opt_out_root" {
  policy_id = aws_organizations_policy.ai_services_opt_out.id
  target_id = local.root.id

  lifecycle {
    precondition {
      condition     = data.aws_organizations_organization.current.master_account_id == var.management_account_id
      error_message = "Run this root with credentials for the organization's management account."
    }
    precondition {
      condition     = local.ai_opt_out_enabled
      error_message = "Enable the policy type once first: aws organizations enable-policy-type --root-id <root id> --policy-type AISERVICES_OPT_OUT_POLICY (see infra/organization/README.md)."
    }
  }
}
