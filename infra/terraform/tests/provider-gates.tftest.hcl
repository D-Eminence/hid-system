mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { region = "eu-west-1" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}
mock_provider "awscc" {}

variables {
  expected_account_id      = "123456789012"
  environment              = "staging"
  availability_zones       = ["eu-west-1a", "eu-west-1b"]
  public_subnet_cidrs      = ["10.30.0.0/24", "10.30.1.0/24"]
  application_subnet_cidrs = ["10.30.10.0/24", "10.30.11.0/24"]
  database_subnet_cidrs    = ["10.30.20.0/24", "10.30.21.0/24"]
}

run "reject_qoreid_without_credentials" {
  command = plan
  variables { qoreid_enabled = true }
  expect_failures = [terraform_data.deployment_guard]
}

run "reject_nin_only_without_qoreid" {
  command = plan
  variables { qoreid_nin_only_enrollment_enabled = true }
  expect_failures = [terraform_data.deployment_guard]
}

run "reject_foreign_qoreid_secret" {
  command = plan
  variables {
    qoreid_enabled    = true
    qoreid_secret_arn = "arn:aws:secretsmanager:eu-west-1:999999999999:secret:qoreid-test-ABCDEF"
  }
  expect_failures = [terraform_data.deployment_guard]
}

run "reject_orphaned_qoreid_key" {
  command = plan
  variables { qoreid_secret_kms_key_arn = "arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111" }
  expect_failures = [terraform_data.deployment_guard]
}

run "accept_explicit_staging_providers" {
  command = plan
  variables {
    google_oidc_client_ids        = ["123456-synthetic.apps.googleusercontent.com"]
    qoreid_enabled                = true
    qoreid_secret_arn             = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:qoreid-test-ABCDEF"
    qoreid_secret_kms_key_arn     = "arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111"
    notification_delivery_profile = "email-brevo"
  }
  assert {
    condition     = !var.qoreid_nin_only_enrollment_enabled && !var.enable_runtime
    error_message = "Provider configuration must not silently enable NIN-only enrollment or deploy runtime."
  }
}

run "reject_invalid_google_client" {
  command = plan
  variables { google_oidc_client_ids = ["client-secret-is-not-a-client-id"] }
  expect_failures = [var.google_oidc_client_ids]
}

run "accept_production_email_brevo_profile" {
  command = plan
  variables {
    environment                   = "production"
    availability_zones            = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
    public_subnet_cidrs           = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
    application_subnet_cidrs      = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
    database_subnet_cidrs         = ["10.40.20.0/24", "10.40.21.0/24", "10.40.22.0/24"]
    notification_delivery_profile = "email-brevo"
  }
  assert {
    condition     = var.notification_delivery_profile == "email-brevo"
    error_message = "Explicit production channels must not require disabled WhatsApp."
  }
}
