mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:root"
      user_id    = "123456789012"
    }
  }

  mock_data "aws_region" {
    defaults = {
      region = "eu-west-1"
    }
  }

  mock_data "aws_ec2_managed_prefix_list" {
    defaults = {
      id   = "pl-12345678"
      name = "com.amazonaws.eu-west-1.s3"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      id   = "mock-policy"
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  # Known key ARNs at plan time, so the execution roles' decrypt lists can be checked.
  mock_resource "aws_kms_key" {
    override_during = plan
    defaults = {
      arn = "arn:aws:kms:eu-west-1:123456789012:key/00000000-0000-0000-0000-000000000000"
    }
  }

  mock_resource "aws_api_gateway_rest_api" {
    override_during = plan
    defaults = {
      id            = "abc123"
      execution_arn = "arn:aws:execute-api:eu-west-1:123456789012:abc123"
    }
  }
}

mock_provider "awscc" {}

# ocr-worker reads paper records with the Claude API: it gets the Claude key
# through its execution role, and HTTPS out through NAT. Nothing else changes.
variables {
  expected_account_id      = "123456789012"
  environment              = "production"
  availability_zones       = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
  public_subnet_cidrs      = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
  application_subnet_cidrs = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
  database_subnet_cidrs    = ["10.40.20.0/24", "10.40.21.0/24", "10.40.22.0/24"]
  enable_database          = true
  enable_runtime           = true
  enable_ingress           = true
  rds_ca_bundle_base64     = "dGVzdC1jYS1idW5kbGU="
  regional_certificate_arn = "arn:aws:acm:eu-west-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
  internal_certificate_arn = "arn:aws:acm:eu-west-1:123456789012:certificate/22222222-2222-2222-2222-222222222222"
  cloudflare_origin_secret = "0123456789abcdef0123456789abcdef"
  migration_image_uri      = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/ehr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  image_uris = {
    identity-api        = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/identity-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ehr-api             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/ehr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    lab-api             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/lab-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    pharmacy-api        = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/pharmacy-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ocr-api             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/ocr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ocr-worker          = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/ocr-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    outreach-api        = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/outreach-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    notification-api    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/notification-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    notification-worker = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/notification-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    event-dispatcher    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/event-dispatcher@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    gateway             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  enable_ai                        = true
  ai_generation_provider           = "anthropic"
  ai_allow_anthropic_us_processing = true
  anthropic_secret_arn             = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:/hid/production/anthropic-ABCDEF"
  anthropic_secret_kms_key_arn     = "arn:aws:kms:eu-west-1:123456789012:key/33333333-3333-3333-3333-333333333333"
  ocr_ai_us_processing_approved    = true
}

run "ocr_worker_can_reach_and_unlock_the_claude_key" {
  command = plan

  assert {
    condition = (
      module.application.ai_generation_configuration.ehr_secret_fields == ["ANTHROPIC_API_KEY"] &&
      module.application.ai_generation_configuration.ocr_secret_fields == ["ANTHROPIC_API_KEY"] &&
      !contains(module.application.ai_generation_configuration.other_secret_fields, "ANTHROPIC_API_KEY")
    )
    error_message = "Only ehr-api and ocr-worker may receive the Claude key."
  }

  assert {
    condition = alltrue([for name in ["ehr-api", "ocr-worker"] :
      contains(module.application.anthropic_runtime_access.execution_kms_keys[name], var.anthropic_secret_kms_key_arn)
    ])
    error_message = "Both execution roles that receive the Claude key must be able to decrypt it, or their tasks fail to start."
  }

  assert {
    condition = (
      jsonencode(module.application.anthropic_runtime_access.https_egress_workloads) == jsonencode(["ocr-worker"]) &&
      contains(module.application.anthropic_runtime_access.general_https_workloads, "ehr-api") &&
      !contains(module.application.anthropic_runtime_access.general_https_workloads, "ocr-worker")
    )
    error_message = "ocr-worker needs its own HTTPS rule to reach the Claude API; ehr-api keeps its existing one."
  }
}

run "ocr_worker_is_told_to_use_claude_on_text_only" {
  command = plan

  assert {
    condition = jsonencode(module.application.anthropic_runtime_access.ocr_worker_ai_environment) == jsonencode({
      OCR_AI_US_PROCESSING_APPROVED = "true"
      OCR_AI_MODE                   = "claude"
      OCR_TEXTRACT_FEATURES         = "text"
    })
    error_message = "ocr-worker must run the Claude step, with the US processing approval, on Textract text detection only."
  }
}

run "without_ocr_approval_only_ehr_keeps_the_key" {
  command = plan

  variables {
    ocr_ai_us_processing_approved = false
  }

  assert {
    condition = (
      module.application.ai_generation_configuration.ehr_secret_fields == ["ANTHROPIC_API_KEY"] &&
      length(module.application.ai_generation_configuration.ocr_secret_fields) == 0 &&
      length(module.application.anthropic_runtime_access.https_egress_workloads) == 0 &&
      !contains(module.application.anthropic_runtime_access.execution_kms_keys["ocr-worker"], var.anthropic_secret_kms_key_arn) &&
      contains(module.application.anthropic_runtime_access.execution_kms_keys["ehr-api"], var.anthropic_secret_kms_key_arn) &&
      module.application.anthropic_runtime_access.ocr_worker_ai_environment.OCR_AI_MODE == "off" &&
      module.application.anthropic_runtime_access.ocr_worker_ai_environment.OCR_AI_US_PROCESSING_APPROVED == "false"
    )
    error_message = "Without the OCR approval, ocr-worker gets no Claude key, no internet rule and AI mode off; ehr-api is unchanged."
  }
}

run "bedrock_keeps_ocr_worker_closed" {
  command = plan

  variables {
    ai_generation_provider       = "bedrock"
    ai_allow_eu_processing       = true
    anthropic_secret_arn         = ""
    anthropic_secret_kms_key_arn = ""
  }

  assert {
    condition = (
      length(module.application.ai_generation_configuration.ocr_secret_fields) == 0 &&
      length(module.application.anthropic_runtime_access.https_egress_workloads) == 0
    )
    error_message = "Without the direct Claude API, ocr-worker gets no key and no HTTPS rule to the internet."
  }
}
