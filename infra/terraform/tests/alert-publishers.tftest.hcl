# Alerts from the production running-task alarms. The alerts topic and its KMS
# key let CloudWatch publish only for alarms named after the name prefix
# (hid-staging-*), but the running-task alarms are named after the ECS cluster
# (hid-production-<service>-running-tasks). Both policies now also admit exactly
# those alarms, in this account and region, where the prefix does not cover them.
mock_provider "aws" {
  mock_resource "aws_sns_topic" {
    override_during = plan
    defaults = {
      arn = "arn:aws:sns:eu-west-1:123456789012:hid-staging-operations-alerts"
    }
  }

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
    defaults = { region = "eu-west-1" }
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
  ecs_migration_phase            = "retired"
}

run "production_running_task_alarms_may_notify" {
  command = plan

  module {
    source = "./modules/operations"
  }

  variables {
    name_prefix      = "hid-staging"
    ecs_cluster_name = "hid-production"
    runtime_services = {
      "hid-production-gateway"      = 1
      "hid-production-identity-api" = 1
      "hid-production-ocr-worker"   = 1
    }
    environment                = "staging"
    enable_database            = true
    database_arn               = "arn:aws:rds:eu-west-1:123456789012:db:hid-staging-postgres"
    database_identifier        = "hid-staging-postgres"
    database_kms_key_arn       = "arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111"
    database_connection_budget = 120
    backup_retention_days      = 30
    enable_backup_plan         = false
    alert_email                = "operations@example.invalid"
    aws_account_id             = "123456789012"
    aws_region                 = "eu-west-1"
    load_balancer_targets      = { gateway = { load_balancer = "app/fixture/id", target_group = "targetgroup/fixture/id" } }
    notification_queue_names   = { notification = "hid-staging-notifications", dead_letter = "hid-staging-notifications-dead-letter" }
    provider_log_groups        = { notification-api = "/hid/staging/notification-api" }
  }

  assert {
    condition = [for statement in jsondecode(aws_kms_key.alerts.policy).Statement : statement.Sid] == ["AccountAdministration", "ScopedCloudWatchAlerts", "ScopedCloudWatchRunningTaskAlerts"] && jsondecode(aws_kms_key.alerts.policy).Statement[2] == {
      Sid       = "ScopedCloudWatchRunningTaskAlerts"
      Effect    = "Allow"
      Principal = { Service = "cloudwatch.amazonaws.com" }
      Action    = ["kms:Decrypt", "kms:GenerateDataKey*"]
      Resource  = "*"
      Condition = {
        StringEquals = { "aws:SourceAccount" = "123456789012" }
        ArnLike      = { "aws:SourceArn" = "arn:aws:cloudwatch:eu-west-1:123456789012:alarm:hid-production-*-running-tasks" }
      }
    }
    error_message = "The alerts key must let CloudWatch use it for the hid-production running-task alarms only, in this account and region."
  }

  assert {
    condition = [for statement in jsondecode(aws_sns_topic_policy.alerts.policy).Statement : statement.Sid] == ["AccountAdministration", "ScopedCloudWatchPublish", "ScopedCloudWatchRunningTaskPublish"] && jsondecode(aws_sns_topic_policy.alerts.policy).Statement[2] == {
      Sid       = "ScopedCloudWatchRunningTaskPublish"
      Effect    = "Allow"
      Principal = { Service = "cloudwatch.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = "arn:aws:sns:eu-west-1:123456789012:hid-staging-operations-alerts"
      Condition = {
        StringEquals = { "aws:SourceAccount" = "123456789012" }
        ArnLike      = { "aws:SourceArn" = "arn:aws:cloudwatch:eu-west-1:123456789012:alarm:hid-production-*-running-tasks" }
      }
    }
    error_message = "The alerts topic must let CloudWatch publish for the hid-production running-task alarms only, in this account and region."
  }

  assert {
    condition = (
      jsondecode(aws_kms_key.alerts.policy).Statement[1].Condition.ArnLike["aws:SourceArn"] == "arn:aws:cloudwatch:eu-west-1:123456789012:alarm:hid-staging-*" &&
      jsondecode(aws_sns_topic_policy.alerts.policy).Statement[1].Condition.ArnLike["aws:SourceArn"] == "arn:aws:cloudwatch:eu-west-1:123456789012:alarm:hid-staging-*" &&
      jsondecode(aws_kms_key.alerts.policy).Statement[0] == { Sid = "AccountAdministration", Effect = "Allow", Principal = { AWS = "arn:aws:iam::123456789012:root" }, Action = "kms:*", Resource = "*" }
    )
    error_message = "The hid-staging alarm statements and the key's account administration statement must stay as they are."
  }

  assert {
    condition     = output.alert_source_arns == ["arn:aws:cloudwatch:eu-west-1:123456789012:alarm:hid-staging-*", "arn:aws:cloudwatch:eu-west-1:123456789012:alarm:hid-production-*-running-tasks"]
    error_message = "CloudWatch may publish only for the hid-staging alarms and the hid-production running-task alarms."
  }

  # Every alarm that notifies the topic must be admitted by both policies.
  assert {
    condition = alltrue(flatten([for policy in [aws_kms_key.alerts.policy, aws_sns_topic_policy.alerts.policy] : [
      for name in concat(
        [for alarm in values(aws_cloudwatch_metric_alarm.runtime_tasks) : alarm.alarm_name],
        [for alarm in values(aws_cloudwatch_metric_alarm.healthy_targets) : alarm.alarm_name],
        [for alarm in values(aws_cloudwatch_metric_alarm.provider_failure) : alarm.alarm_name],
        aws_cloudwatch_metric_alarm.database_cpu[*].alarm_name,
        aws_cloudwatch_metric_alarm.database_storage[*].alarm_name,
        aws_cloudwatch_metric_alarm.database_connections[*].alarm_name,
        aws_cloudwatch_metric_alarm.notification_dead_letters[*].alarm_name,
        aws_cloudwatch_metric_alarm.notification_backlog_age[*].alarm_name,
        ) : anytrue([for statement in jsondecode(policy).Statement :
          can(regex("^${replace(statement.Condition.ArnLike["aws:SourceArn"], "*", ".*")}$", "arn:aws:cloudwatch:eu-west-1:123456789012:alarm:${name}")) &&
          statement.Condition.StringEquals["aws:SourceAccount"] == "123456789012"
          if try(statement.Principal.Service, "") == "cloudwatch.amazonaws.com"
      ])
    ]]))
    error_message = "Every alarm that notifies the alerts topic must be allowed to publish by the topic policy and to use its KMS key."
  }
}

run "covered_alarm_names_keep_the_policies" {
  command = plan

  module {
    source = "./modules/operations"
  }

  variables {
    name_prefix                = "hid-development"
    ecs_cluster_name           = "hid-development"
    runtime_services           = { "hid-development-gateway" = 1 }
    environment                = "staging"
    enable_database            = true
    database_arn               = "arn:aws:rds:eu-west-1:123456789012:db:hid-staging-postgres"
    database_identifier        = "hid-staging-postgres"
    database_kms_key_arn       = "arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111"
    database_connection_budget = 120
    backup_retention_days      = 30
    enable_backup_plan         = false
    alert_email                = "operations@example.invalid"
    aws_account_id             = "123456789012"
    aws_region                 = "eu-west-1"
    load_balancer_targets      = { gateway = { load_balancer = "app/fixture/id", target_group = "targetgroup/fixture/id" } }
    notification_queue_names   = { notification = "hid-staging-notifications", dead_letter = "hid-staging-notifications-dead-letter" }
    provider_log_groups        = { notification-api = "/hid/staging/notification-api" }
  }

  assert {
    condition = (
      [for statement in jsondecode(aws_kms_key.alerts.policy).Statement : statement.Sid] == ["AccountAdministration", "ScopedCloudWatchAlerts"] &&
      [for statement in jsondecode(aws_sns_topic_policy.alerts.policy).Statement : statement.Sid] == ["AccountAdministration", "ScopedCloudWatchPublish"] &&
      output.alert_source_arns == ["arn:aws:cloudwatch:eu-west-1:123456789012:alarm:hid-development-*"]
    )
    error_message = "Where the name prefix covers the running-task alarms, both policies must stay as they were."
  }

  # Every alarm that notifies the topic must be admitted by both policies.
  assert {
    condition = alltrue(flatten([for policy in [aws_kms_key.alerts.policy, aws_sns_topic_policy.alerts.policy] : [
      for name in concat(
        [for alarm in values(aws_cloudwatch_metric_alarm.runtime_tasks) : alarm.alarm_name],
        [for alarm in values(aws_cloudwatch_metric_alarm.healthy_targets) : alarm.alarm_name],
        [for alarm in values(aws_cloudwatch_metric_alarm.provider_failure) : alarm.alarm_name],
        aws_cloudwatch_metric_alarm.database_cpu[*].alarm_name,
        aws_cloudwatch_metric_alarm.database_storage[*].alarm_name,
        aws_cloudwatch_metric_alarm.database_connections[*].alarm_name,
        aws_cloudwatch_metric_alarm.notification_dead_letters[*].alarm_name,
        aws_cloudwatch_metric_alarm.notification_backlog_age[*].alarm_name,
        ) : anytrue([for statement in jsondecode(policy).Statement :
          can(regex("^${replace(statement.Condition.ArnLike["aws:SourceArn"], "*", ".*")}$", "arn:aws:cloudwatch:eu-west-1:123456789012:alarm:${name}")) &&
          statement.Condition.StringEquals["aws:SourceAccount"] == "123456789012"
          if try(statement.Principal.Service, "") == "cloudwatch.amazonaws.com"
      ])
    ]]))
    error_message = "Every alarm that notifies the alerts topic must be allowed to publish by the topic policy and to use its KMS key."
  }
}

run "no_running_task_alarms_no_extra_statement" {
  command = plan

  module {
    source = "./modules/operations"
  }

  variables {
    name_prefix                = "hid-staging"
    ecs_cluster_name           = "hid-production"
    runtime_services           = {}
    environment                = "staging"
    enable_database            = true
    database_arn               = "arn:aws:rds:eu-west-1:123456789012:db:hid-staging-postgres"
    database_identifier        = "hid-staging-postgres"
    database_kms_key_arn       = "arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111"
    database_connection_budget = 120
    backup_retention_days      = 30
    enable_backup_plan         = false
    alert_email                = "operations@example.invalid"
    aws_account_id             = "123456789012"
    aws_region                 = "eu-west-1"
    load_balancer_targets      = { gateway = { load_balancer = "app/fixture/id", target_group = "targetgroup/fixture/id" } }
    notification_queue_names   = { notification = "hid-staging-notifications", dead_letter = "hid-staging-notifications-dead-letter" }
    provider_log_groups        = { notification-api = "/hid/staging/notification-api" }
  }

  assert {
    condition = (
      length(jsondecode(aws_kms_key.alerts.policy).Statement) == 2 &&
      length(jsondecode(aws_sns_topic_policy.alerts.policy).Statement) == 2
    )
    error_message = "Without running-task alarms the policies must not admit any other alarm names."
  }
}

run "production_plan_admits_all_twelve_running_task_alarms" {
  command = plan

  variables {
    ecs_migration_phase = "retired"
  }

  assert {
    condition = (
      module.operations.alert_source_arns == ["arn:aws:cloudwatch:eu-west-1:123456789012:alarm:hid-staging-*", "arn:aws:cloudwatch:eu-west-1:123456789012:alarm:hid-production-*-running-tasks"] &&
      length(module.operations.runtime_task_alarms) == 12 &&
      alltrue([for name, alarm in module.operations.runtime_task_alarms :
        can(regex("^arn:aws:cloudwatch:eu-west-1:123456789012:alarm:hid-production-.*-running-tasks$", "arn:aws:cloudwatch:eu-west-1:123456789012:alarm:${name}"))
      ])
    )
    error_message = "In production the alerts topic and key must admit the twelve hid-production running-task alarms, besides the hid-staging alarms."
  }

  # Every alarm in the configuration notifies the alerts topic (operations and
  # application modules, all modules share the name prefix). Each must be named
  # after the name prefix or be a running-task alarm, so the two policies admit
  # it; an alarm named any other way needs a policy statement first.
  assert {
    condition = (
      length(module.operations.alert_source_arns) == 2 &&
      length(flatten([for path in fileset(".", "modules/**/*.tf") : regexall("(?m)^\\s*alarm_name\\s*=", file(path))])) >= 9 &&
      length(flatten([for path in fileset(".", "modules/**/*.tf") : regexall("(?m)^\\s*alarm_name\\s*=", file(path))])) ==
      length(flatten([for path in fileset(".", "modules/**/*.tf") : regexall("(?m)^\\s*alarm_name\\s*=\\s*\"(?:\\$\\{var\\.name_prefix\\}-[^\"]+|\\$\\{each\\.key\\}-running-tasks)\"\\s*$", file(path))]))
    )
    error_message = "Every alarm must be named after the name prefix or be a running-task alarm, or the alerts topic and key refuse its notifications."
  }
}
