mock_provider "aws" {
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_region" { defaults = { region = "eu-west-1" } }
  mock_data "aws_iam_policy_document" { defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" } }
}
mock_provider "awscc" {}
variables {
  expected_account_id      = "123456789012"
  environment              = "staging"
  availability_zones       = ["eu-west-1a", "eu-west-1b"]
  public_subnet_cidrs      = ["10.30.0.0/24", "10.30.1.0/24"]
  application_subnet_cidrs = ["10.30.10.0/24", "10.30.11.0/24"]
  database_subnet_cidrs    = ["10.30.20.0/24", "10.30.21.0/24"]
  enable_database          = true
  enable_ai                = true
  ai_generation_provider   = "anthropic"
}
run "reject_missing_key_reference" {
  command = plan
  variables { ai_allow_anthropic_us_processing = true }
  expect_failures = [terraform_data.deployment_guard]
}
run "reject_unapproved_us_processing" {
  command = plan
  variables { anthropic_secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:/hid/staging/anthropic-ABCDEF" }
  expect_failures = [terraform_data.deployment_guard]
}
run "reject_foreign_secret" {
  command = plan
  variables {
    anthropic_secret_arn             = "arn:aws:secretsmanager:eu-west-1:999999999999:secret:/hid/staging/anthropic-ABCDEF"
    ai_allow_anthropic_us_processing = true
  }
  expect_failures = [terraform_data.deployment_guard]
}
run "reject_foreign_kms_key" {
  command = plan
  variables {
    anthropic_secret_arn             = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:/hid/staging/anthropic-ABCDEF"
    anthropic_secret_kms_key_arn     = "arn:aws:kms:eu-west-1:999999999999:key/11111111-1111-1111-1111-111111111111"
    ai_allow_anthropic_us_processing = true
  }
  expect_failures = [terraform_data.deployment_guard]
}
run "reject_bedrock_model_on_direct_api" {
  command = plan
  variables { anthropic_model_id = "eu.anthropic.claude-sonnet-4-6" }
  expect_failures = [var.anthropic_model_id, terraform_data.deployment_guard]
}
run "reject_secret_selector_injection" {
  command = plan
  variables { anthropic_secret_json_key = "apiKey:version" }
  expect_failures = [var.anthropic_secret_json_key, terraform_data.deployment_guard]
}
run "accept_direct_generation_keep_titan_only" {
  command = plan
  variables {
    anthropic_secret_arn             = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:/hid/staging/anthropic-ABCDEF"
    ai_allow_anthropic_us_processing = true
  }
  assert {
    condition = (module.application.ai_generation_configuration.provider == "anthropic" &&
      module.application.ai_generation_configuration.model_id == "claude-sonnet-4-6" &&
      module.application.ai_generation_configuration.ehr_secret_fields == ["ANTHROPIC_API_KEY"] &&
    !contains(module.application.ai_generation_configuration.other_secret_fields, "ANTHROPIC_API_KEY"))
    error_message = "Only EHR may receive the direct Claude key, with the selected first-party model."
  }
  assert {
    condition = (length(module.ai[0].bedrock_inference_policy.Statement) == 1 &&
      module.ai[0].bedrock_inference_policy.Statement[0].Resource == ["arn:aws:bedrock:eu-west-1::foundation-model/amazon.titan-embed-text-v2:0"] &&
    module.ai[0].bedrock_inference_policy.Statement[0].Action == ["bedrock:InvokeModel"])
    error_message = "Direct generation must remove Claude/streaming Bedrock permissions while preserving Titan embeddings."
  }
  assert {
    condition     = !var.enable_runtime && !var.ai_allow_eu_processing
    error_message = "Configuration acceptance must not start runtime or require the obsolete EU Claude approval."
  }
}
run "preserve_existing_bedrock_until_cutover" {
  command = plan
  variables {
    ai_generation_provider = "bedrock"
    ai_allow_eu_processing = true
  }
  assert {
    condition = (length(module.ai[0].bedrock_inference_policy.Statement) == 3 &&
      module.application.ai_generation_configuration.model_id == "eu.anthropic.claude-sonnet-4-6" &&
    length(module.application.ai_generation_configuration.ehr_secret_fields) == 0)
    error_message = "Existing live Bedrock configuration must stay usable until the explicit provider/image cutover."
  }
}
