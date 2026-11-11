mock_provider "aws" {
  mock_data "aws_organizations_organization" {
    defaults = {
      master_account_id = "123456789012"
      roots = [{
        id           = "r-test"
        arn          = "arn:aws:organizations::123456789012:root/o-test/r-test"
        name         = "Root"
        policy_types = [{ type = "AISERVICES_OPT_OUT_POLICY", status = "ENABLED" }]
      }]
    }
  }
}

variables {
  aws_region            = "eu-west-1"
  management_account_id = "123456789012"
}

run "opts_every_ai_service_out_at_the_root" {
  command = plan

  assert {
    condition     = aws_organizations_policy.ai_services_opt_out.type == "AISERVICES_OPT_OUT_POLICY"
    error_message = "The policy must be an AI services opt-out policy."
  }

  assert {
    condition     = jsondecode(aws_organizations_policy.ai_services_opt_out.content).services.default.opt_out_policy["@@assign"] == "optOut"
    error_message = "Every AI service (default) must be opted out."
  }

  assert {
    condition     = jsondecode(aws_organizations_policy.ai_services_opt_out.content).services.default.opt_out_policy["@@operators_allowed_for_child_policies"] == ["@@none"]
    error_message = "No child policy may opt an account back in."
  }

  assert {
    condition     = aws_organizations_policy_attachment.ai_services_opt_out_root.target_id == "r-test"
    error_message = "The policy must be attached to the organization root, so it covers every account."
  }
}

run "refuses_until_the_policy_type_is_enabled" {
  command = plan

  override_data {
    target = data.aws_organizations_organization.current
    values = {
      master_account_id = "123456789012"
      roots = [{
        id           = "r-test"
        arn          = "arn:aws:organizations::123456789012:root/o-test/r-test"
        name         = "Root"
        policy_types = []
      }]
    }
  }

  expect_failures = [aws_organizations_policy_attachment.ai_services_opt_out_root]
}

run "refuses_outside_the_management_account" {
  command = plan

  override_data {
    target = data.aws_organizations_organization.current
    values = {
      master_account_id = "210987654321"
      roots = [{
        id           = "r-test"
        arn          = "arn:aws:organizations::210987654321:root/o-test/r-test"
        name         = "Root"
        policy_types = [{ type = "AISERVICES_OPT_OUT_POLICY", status = "ENABLED" }]
      }]
    }
  }

  expect_failures = [aws_organizations_policy_attachment.ai_services_opt_out_root]
}
