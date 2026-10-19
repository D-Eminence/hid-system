mock_provider "aws" {
  mock_resource "aws_lb" {
    override_during = plan
    defaults = {
      arn_suffix = "app/fixture/id"
      arn        = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:loadbalancer/app/fixture/id"
    }
  }
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

  mock_resource "aws_api_gateway_rest_api" {
    override_during = plan
    defaults = {
      id            = "abc123"
      execution_arn = "arn:aws:execute-api:eu-west-1:123456789012:abc123"
    }
  }
}

mock_provider "awscc" {}

override_resource {
  target          = module.application.aws_lb_target_group.gateway[0]
  override_during = plan
  values = {
    arn_suffix = "targetgroup/legacy-gateway/id"
    arn        = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/legacy-gateway/id"
  }
}
override_resource {
  target          = module.application.aws_lb_target_group.production_gateway[0]
  override_during = plan
  values = {
    arn_suffix = "targetgroup/production-gateway/id"
    arn        = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/production-gateway/id"
  }
}

mock_provider "external" {
  mock_data "external" {
    defaults = { result = { valid = "true" } }
  }
}

variables {
  expected_account_id           = "123456789012"
  environment                   = "production"
  staging_mode                  = "sleep"
  staging_worker_min_capacity   = 1
  availability_zones            = ["eu-west-1a", "eu-west-1b"]
  public_subnet_cidrs           = ["10.30.0.0/24", "10.30.1.0/24"]
  application_subnet_cidrs      = ["10.30.10.0/24", "10.30.11.0/24"]
  database_subnet_cidrs         = ["10.30.20.0/24", "10.30.21.0/24"]
  enable_database               = true
  enable_runtime                = true
  enable_ingress                = true
  enable_backup_plan            = false
  staging_novu_api_url          = "https://eu.api.novu.co"
  notification_delivery_profile = "email-sms-brevo"
  enable_ai                     = true
  ai_allow_eu_processing        = true
  enable_support_bot            = true
  support_contact               = "mailto:support@example.invalid"
  support_faqs = {
    Help = {
      utterances = ["I need help", "How do I get help"]
      answer     = "Public: https://www.staging.healthidentitydirectory.com/about Patient: https://staging.healthidentitydirectory.com/sign-in"
    }
  }
  rds_ca_bundle_base64     = "dGVzdC1jYS1idW5kbGU="
  regional_certificate_arn = "arn:aws:acm:eu-west-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
  internal_certificate_arn = "arn:aws:acm:eu-west-1:123456789012:certificate/22222222-2222-2222-2222-222222222222"
  cloudflare_origin_secret = "0123456789abcdef0123456789abcdef"
  migration_image_uri      = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ehr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  image_uris = {
    identity-api        = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/identity-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ehr-api             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ehr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    lab-api             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/lab-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    pharmacy-api        = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/pharmacy-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ocr-api             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ocr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ocr-worker          = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ocr-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    outreach-api        = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/outreach-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    notification-api    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/notification-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    notification-worker = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/notification-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    event-dispatcher    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/event-dispatcher@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    support-api         = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/support-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    gateway             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  promote_existing_staging                  = true
  use_existing_secrets                      = true
  production_workload_token_agent_image_uri = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/identity-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  activate_production_runtime               = true
  production_hosts = {
    admin    = "admin.healthidentitydirectory.com"
    web      = "healthidentitydirectory.com"
    ehr      = "ehr.healthidentitydirectory.com"
    lab      = "lab.healthidentitydirectory.com"
    pharmacy = "pharmacy.healthidentitydirectory.com"
    ocr      = "migrate.healthidentitydirectory.com"
    outreach = "outreach.healthidentitydirectory.com"
    public   = "www.healthidentitydirectory.com"
    api      = "api.healthidentitydirectory.com"
  }
  production_api_certificate_arn = "arn:aws:acm:eu-west-1:123456789012:certificate/33333333-3333-3333-3333-333333333333"
}

run "ecs_prepare" {
  command = plan
  assert {
    condition     = output.ecs_migration_configuration.gateway_scaling_resource_label == "app/fixture/id/targetgroup/legacy-gateway/id"
    error_message = "Scaling must reference the target group attached to the selected ECS service, including during drain."
  }
  variables { ecs_migration_phase = "prepare" }
  assert {
    condition     = output.ecs_migration_configuration.legacy_cluster_count == 1
    error_message = "Legacy cluster must remain until retirement."
  }
  assert {
    condition = length(output.ecs_migration_configuration.production_desired_counts) == 12 && alltrue([
      for name, count in output.ecs_migration_configuration.production_desired_counts :
      count == (contains(["notification-worker", "ocr-worker", "event-dispatcher"], name) && contains(["prepare", "drain"], var.ecs_migration_phase) ? 0 : 1)
    ])
    error_message = "Production workers must stay stopped until old workers are drained; preserve twelve-service baseline."
  }
  assert {
    condition = length(output.ecs_migration_configuration.legacy_desired_counts) == 12 && alltrue([
      for name, count in output.ecs_migration_configuration.legacy_desired_counts :
      count == (contains(["notification-worker", "ocr-worker", "event-dispatcher"], name) && contains(["drain", "active"], var.ecs_migration_phase) ? 0 : 1)
    ])
    error_message = "Drain old workers before activating replacements; retain APIs until cutover verified."
  }
  assert {
    condition     = output.ecs_migration_configuration.cluster == "hid-staging" && output.deployment_environment_configuration.application.issuer_path == "staging"
    error_message = "Monitoring/deployment must track the selected cluster without changing retained workload authentication."
  }
}
run "ecs_drain" {
  command = plan
  assert {
    condition     = output.ecs_migration_configuration.gateway_scaling_resource_label == "app/fixture/id/targetgroup/production-gateway/id"
    error_message = "Scaling must reference the target group attached to the selected ECS service, including during drain."
  }
  variables { ecs_migration_phase = "drain" }
  assert {
    condition     = output.ecs_migration_configuration.legacy_cluster_count == 1
    error_message = "Legacy cluster must remain until retirement."
  }
  assert {
    condition = length(output.ecs_migration_configuration.production_desired_counts) == 12 && alltrue([
      for name, count in output.ecs_migration_configuration.production_desired_counts :
      count == (contains(["notification-worker", "ocr-worker", "event-dispatcher"], name) && contains(["prepare", "drain"], var.ecs_migration_phase) ? 0 : 1)
    ])
    error_message = "Production workers must stay stopped until old workers are drained; preserve twelve-service baseline."
  }
  assert {
    condition = length(output.ecs_migration_configuration.legacy_desired_counts) == 12 && alltrue([
      for name, count in output.ecs_migration_configuration.legacy_desired_counts :
      count == (contains(["notification-worker", "ocr-worker", "event-dispatcher"], name) && contains(["drain", "active"], var.ecs_migration_phase) ? 0 : 1)
    ])
    error_message = "Drain old workers before activating replacements; retain APIs until cutover verified."
  }
  assert {
    condition     = output.ecs_migration_configuration.cluster == "hid-production" && output.deployment_environment_configuration.application.issuer_path == "staging"
    error_message = "Monitoring/deployment must track the selected cluster without changing retained workload authentication."
  }
}
run "ecs_active" {
  command = plan
  assert {
    condition     = output.ecs_migration_configuration.gateway_scaling_resource_label == "app/fixture/id/targetgroup/production-gateway/id"
    error_message = "Scaling must reference the target group attached to the selected ECS service, including during drain."
  }
  variables { ecs_migration_phase = "active" }
  assert {
    condition     = output.ecs_migration_configuration.legacy_cluster_count == 1
    error_message = "Legacy cluster must remain until retirement."
  }
  assert {
    condition = length(output.ecs_migration_configuration.production_desired_counts) == 12 && alltrue([
      for name, count in output.ecs_migration_configuration.production_desired_counts :
      count == (contains(["notification-worker", "ocr-worker", "event-dispatcher"], name) && contains(["prepare", "drain"], var.ecs_migration_phase) ? 0 : 1)
    ])
    error_message = "Production workers must stay stopped until old workers are drained; preserve twelve-service baseline."
  }
  assert {
    condition = length(output.ecs_migration_configuration.legacy_desired_counts) == 12 && alltrue([
      for name, count in output.ecs_migration_configuration.legacy_desired_counts :
      count == (contains(["notification-worker", "ocr-worker", "event-dispatcher"], name) && contains(["drain", "active"], var.ecs_migration_phase) ? 0 : 1)
    ])
    error_message = "Drain old workers before activating replacements; retain APIs until cutover verified."
  }
  assert {
    condition     = output.ecs_migration_configuration.cluster == "hid-production" && output.deployment_environment_configuration.application.issuer_path == "staging"
    error_message = "Monitoring/deployment must track the selected cluster without changing retained workload authentication."
  }
}
run "ecs_retired" {
  command = plan
  assert {
    condition     = output.ecs_migration_configuration.gateway_scaling_resource_label == "app/fixture/id/targetgroup/production-gateway/id"
    error_message = "Scaling must reference the target group attached to the selected ECS service, including during drain."
  }
  variables { ecs_migration_phase = "retired" }
  assert {
    condition     = output.ecs_migration_configuration.legacy_cluster_count == 0
    error_message = "Legacy cluster must remain until retirement."
  }
  assert {
    condition = length(output.ecs_migration_configuration.production_desired_counts) == 12 && alltrue([
      for name, count in output.ecs_migration_configuration.production_desired_counts :
      count == (contains(["notification-worker", "ocr-worker", "event-dispatcher"], name) && contains(["prepare", "drain"], var.ecs_migration_phase) ? 0 : 1)
    ])
    error_message = "Production workers must stay stopped until old workers are drained; preserve twelve-service baseline."
  }
  assert {
    condition = length(output.ecs_migration_configuration.legacy_desired_counts) == 0 && alltrue([
      for name, count in output.ecs_migration_configuration.legacy_desired_counts :
      count == (contains(["notification-worker", "ocr-worker", "event-dispatcher"], name) && contains(["drain", "active"], var.ecs_migration_phase) ? 0 : 1)
    ])
    error_message = "Drain old workers before activating replacements; retain APIs until cutover verified."
  }
  assert {
    condition     = output.ecs_migration_configuration.cluster == "hid-production" && output.deployment_environment_configuration.application.issuer_path == "staging"
    error_message = "Monitoring/deployment must track the selected cluster without changing retained workload authentication."
  }
}
