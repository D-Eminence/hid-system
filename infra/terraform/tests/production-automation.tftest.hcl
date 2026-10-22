mock_provider "aws" {
  mock_resource "aws_lb" {
    override_during = plan
    defaults        = { arn_suffix = "app/fixture/id", arn = "arn:aws:elasticloadbalancing:eu-west-1:659225405023:loadbalancer/app/fixture/id" }
  }
  mock_resource "aws_lb_target_group" {
    override_during = plan
    defaults        = { arn_suffix = "targetgroup/fixture/id", arn = "arn:aws:elasticloadbalancing:eu-west-1:659225405023:targetgroup/fixture/id" }
  }
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "659225405023"
      arn        = "arn:aws:iam::659225405023:root"
      user_id    = "659225405023"
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

  mock_resource "aws_api_gateway_rest_api" {
    override_during = plan
    defaults = {
      id            = "abc123"
      execution_arn = "arn:aws:execute-api:eu-west-1:659225405023:abc123"
    }
  }
}

mock_provider "awscc" {}

mock_provider "external" {
  mock_data "external" { defaults = { result = { valid = "true" } } }
}
run "production_automation_bootstrap" {
  command = plan
  variables {
    expected_account_id                       = "659225405023"
    environment                               = "production"
    promote_existing_staging                  = true
    activate_production_runtime               = true
    production_workload_token_agent_image_uri = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/identity-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    production_api_certificate_arn            = "arn:aws:acm:eu-west-1:659225405023:certificate/33333333-3333-3333-3333-333333333333"
    production_hosts = {
      admin    = "admin.healthidentitydirectory.com"
      web      = "app.healthidentitydirectory.com"
      ehr      = "ehr.healthidentitydirectory.com"
      lab      = "lab.healthidentitydirectory.com"
      pharmacy = "pharmacy.healthidentitydirectory.com"
      ocr      = "migrate.healthidentitydirectory.com"
      outreach = "outreach.healthidentitydirectory.com"
      public   = "healthidentitydirectory.com"
      api      = "api.healthidentitydirectory.com"
    }
    ecs_migration_phase                 = "retired"
    production_deployment_approval_mode = "automatic"
    use_existing_secrets                = true
    staging_mode                        = "sleep"
    staging_worker_min_capacity         = 1
    availability_zones                  = ["eu-west-1a", "eu-west-1b"]
    public_subnet_cidrs                 = ["10.30.0.0/24", "10.30.1.0/24"]
    application_subnet_cidrs            = ["10.30.10.0/24", "10.30.11.0/24"]
    database_subnet_cidrs               = ["10.30.20.0/24", "10.30.21.0/24"]
    enable_database                     = true
    enable_runtime                      = true
    enable_migration_task               = true
    enable_deployment_automation        = true
    deployment_automation_bootstrap     = true
    enable_ingress                      = true
    enable_backup_plan                  = true
    staging_novu_api_url                = "https://eu.api.novu.co"
    notification_delivery_profile       = "email-sms-brevo"
    enable_ai                           = true
    ai_allow_eu_processing              = true
    enable_support_bot                  = true
    support_contact                     = "mailto:support@example.invalid"
    support_faqs = {
      Help = {
        utterances = ["I need help", "How do I get help"]
        answer     = "Please contact the support team for help."
      }
    }
    rds_ca_bundle_base64     = "dGVzdC1jYS1idW5kbGU="
    regional_certificate_arn = "arn:aws:acm:eu-west-1:659225405023:certificate/11111111-1111-1111-1111-111111111111"
    internal_certificate_arn = "arn:aws:acm:eu-west-1:659225405023:certificate/22222222-2222-2222-2222-222222222222"
    cloudflare_origin_secret = "0123456789abcdef0123456789abcdef"
    migration_image_uri      = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ehr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    image_uris = {
      identity-api        = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/identity-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ehr-api             = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ehr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      lab-api             = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/lab-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      pharmacy-api        = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/pharmacy-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ocr-api             = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ocr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ocr-worker          = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ocr-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      outreach-api        = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/outreach-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      notification-api    = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/notification-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      notification-worker = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/notification-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      event-dispatcher    = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/event-dispatcher@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      support-api         = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/support-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      gateway             = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }


  assert {
    condition     = length(output.deployment_automation_configuration.deploy_role_arns) == 2 && output.deployment_automation_configuration.environments.backend == "production-backend" && output.deployment_automation_configuration.environments.frontend == "production-frontend"
    error_message = "Separate protected deploy roles and read-only rollback admission are required."
  }
  assert {
    condition     = output.deployment_automation_configuration.branches.backend == "staging-novu-ci-20261005" && output.deployment_automation_configuration.branches.frontend == "main"
    error_message = "Live and rollback images need protection from ordinary ECR expiry."
  }
  assert {
    condition     = output.deployment_automation_configuration.lease_table == "hid-staging-deployment-leases" && output.deployment_automation_configuration.index_key == "production/current.json"
    error_message = "Physical table is retained while the production index is independently scoped."
  }
  assert {
    condition     = output.deployment_automation_configuration.approval_mode == "automatic" && output.deployment_automation_configuration.github_subject_prefixes.frontend == "repo:D-Eminence@182018869/health@1428636965"
    error_message = "Production must admit only the new frontend identity and record its explicit deployment policy."
  }
}

run "automation_rejected_before_retirement" {
  command = plan
  variables {
    expected_account_id                       = "659225405023"
    environment                               = "production"
    promote_existing_staging                  = true
    activate_production_runtime               = true
    production_workload_token_agent_image_uri = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/identity-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    production_api_certificate_arn            = "arn:aws:acm:eu-west-1:659225405023:certificate/33333333-3333-3333-3333-333333333333"
    production_hosts = {
      admin    = "admin.healthidentitydirectory.com"
      web      = "app.healthidentitydirectory.com"
      ehr      = "ehr.healthidentitydirectory.com"
      lab      = "lab.healthidentitydirectory.com"
      pharmacy = "pharmacy.healthidentitydirectory.com"
      ocr      = "migrate.healthidentitydirectory.com"
      outreach = "outreach.healthidentitydirectory.com"
      public   = "healthidentitydirectory.com"
      api      = "api.healthidentitydirectory.com"
    }
    ecs_migration_phase                 = "active"
    production_deployment_approval_mode = "automatic"
    use_existing_secrets                = true
    staging_mode                        = "sleep"
    staging_worker_min_capacity         = 1
    availability_zones                  = ["eu-west-1a", "eu-west-1b"]
    public_subnet_cidrs                 = ["10.30.0.0/24", "10.30.1.0/24"]
    application_subnet_cidrs            = ["10.30.10.0/24", "10.30.11.0/24"]
    database_subnet_cidrs               = ["10.30.20.0/24", "10.30.21.0/24"]
    enable_database                     = true
    enable_runtime                      = true
    enable_migration_task               = true
    enable_deployment_automation        = true
    deployment_automation_bootstrap     = true
    enable_ingress                      = true
    enable_backup_plan                  = true
    staging_novu_api_url                = "https://eu.api.novu.co"
    notification_delivery_profile       = "email-sms-brevo"
    enable_ai                           = true
    ai_allow_eu_processing              = true
    enable_support_bot                  = true
    support_contact                     = "mailto:support@example.invalid"
    support_faqs = {
      Help = {
        utterances = ["I need help", "How do I get help"]
        answer     = "Please contact the support team for help."
      }
    }
    rds_ca_bundle_base64     = "dGVzdC1jYS1idW5kbGU="
    regional_certificate_arn = "arn:aws:acm:eu-west-1:659225405023:certificate/11111111-1111-1111-1111-111111111111"
    internal_certificate_arn = "arn:aws:acm:eu-west-1:659225405023:certificate/22222222-2222-2222-2222-222222222222"
    cloudflare_origin_secret = "0123456789abcdef0123456789abcdef"
    migration_image_uri      = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ehr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    image_uris = {
      identity-api        = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/identity-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ehr-api             = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ehr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      lab-api             = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/lab-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      pharmacy-api        = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/pharmacy-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ocr-api             = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ocr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ocr-worker          = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ocr-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      outreach-api        = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/outreach-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      notification-api    = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/notification-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      notification-worker = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/notification-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      event-dispatcher    = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/event-dispatcher@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      support-api         = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/support-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      gateway             = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }
  expect_failures = [check.ecs_production_move]
}
