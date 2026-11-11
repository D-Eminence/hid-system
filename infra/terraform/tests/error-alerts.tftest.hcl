# Error alerts: server-error rate, per-service server errors, unhealthy and
# crashed tasks, the OCR queue and the list of people who receive alerts.
mock_provider "aws" {
  mock_resource "aws_sns_topic" {
    override_during = plan
    defaults = {
      arn = "arn:aws:sns:eu-west-1:123456789012:hid-staging-operations-alerts"
    }
  }
}

variables {
  name_prefix                = "hid-staging"
  ecs_cluster_name           = "hid-production"
  runtime_services           = { "hid-production-gateway" = 1, "hid-production-ocr-worker" = 1 }
  environment                = "production"
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
  load_balancer_targets = {
    gateway = { load_balancer = "app/public/id", target_group = "targetgroup/gate/id" }
    ehr-api = { load_balancer = "app/internal/id", target_group = "targetgroup/ehr/id" }
  }
  notification_queue_names = { notification = "hid-staging-notification", dead_letter = "hid-staging-notification-dead-letter" }
  provider_log_groups      = { notification-api = "/hid/production/notification-api" }
  ocr_worker_log_group     = "/hid/production/ocr-worker"
  notify_stopped_tasks     = true
  alert_subscribers = [
    { protocol = "email", endpoint = "operations@example.invalid" },
    { protocol = "email", endpoint = "oncall@example.invalid" },
    { protocol = "sms", endpoint = "+2348000000000" },
  ]
}

run "error_alerts_cover_every_service" {
  command = plan

  module {
    source = "./modules/operations"
  }

  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.gateway_error_rate) == 1 &&
      aws_cloudwatch_metric_alarm.gateway_error_rate[0].alarm_name == "hid-staging-gateway-server-error-rate" &&
      aws_cloudwatch_metric_alarm.gateway_error_rate[0].threshold == 5 &&
      toset(keys(aws_cloudwatch_metric_alarm.target_server_errors)) == toset(["gateway", "ehr-api"]) &&
      toset(keys(aws_cloudwatch_metric_alarm.unhealthy_targets)) == toset(["gateway", "ehr-api"]) &&
      aws_cloudwatch_metric_alarm.target_server_errors["ehr-api"].dimensions.TargetGroup == "targetgroup/ehr/id"
    )
    error_message = "The gateway error-rate alarm and a server-error and unhealthy-task alarm for every load-balanced service must exist."
  }

  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.ocr_queue_age[0].log_group_name == "/hid/production/ocr-worker" &&
      aws_cloudwatch_metric_alarm.ocr_queue_age[0].threshold == 900 &&
      aws_cloudwatch_metric_alarm.ocr_worker_errors[0].alarm_name == "hid-staging-ocr-worker-errors"
    )
    error_message = "The OCR queue-age and worker-error alarms must read the OCR worker's log group."
  }

  assert {
    condition = (
      toset(keys(aws_sns_topic_subscription.subscribers)) == toset(["email:oncall@example.invalid", "sms:+2348000000000"]) &&
      length(aws_sns_topic_subscription.email) == 1
    )
    error_message = "Every listed subscriber gets one subscription, and alert_email is not subscribed twice."
  }

  assert {
    condition = (
      jsondecode(aws_cloudwatch_event_rule.stopped_tasks[0].event_pattern).detail.clusterArn == ["arn:aws:ecs:eu-west-1:123456789012:cluster/hid-production"] &&
      jsondecode(aws_cloudwatch_event_rule.stopped_tasks[0].event_pattern).detail.group == [{ prefix = "service:" }] &&
      jsondecode(aws_kms_key.alerts.policy).Statement[3].Sid == "ScopedEventBridgeStoppedTaskAlerts" &&
      jsondecode(aws_kms_key.alerts.policy).Statement[3].Condition.ArnEquals["aws:SourceArn"] == "arn:aws:events:eu-west-1:123456789012:rule/hid-staging-service-task-stopped" &&
      jsondecode(aws_sns_topic_policy.alerts.policy).Statement[3].Sid == "ScopedEventBridgeStoppedTaskPublish" &&
      jsondecode(aws_sns_topic_policy.alerts.policy).Statement[3].Condition.ArnEquals["aws:SourceArn"] == "arn:aws:events:eu-west-1:123456789012:rule/hid-staging-service-task-stopped"
    )
    error_message = "Crashed service tasks must notify through one EventBridge rule that only the topic and key policies admit."
  }

  # Every new alarm is named after the prefix, so the existing policies admit it.
  assert {
    condition = alltrue([for name in concat(
      aws_cloudwatch_metric_alarm.gateway_error_rate[*].alarm_name,
      [for alarm in values(aws_cloudwatch_metric_alarm.target_server_errors) : alarm.alarm_name],
      [for alarm in values(aws_cloudwatch_metric_alarm.unhealthy_targets) : alarm.alarm_name],
      aws_cloudwatch_metric_alarm.ocr_queue_age[*].alarm_name,
      aws_cloudwatch_metric_alarm.ocr_worker_errors[*].alarm_name,
    ) : startswith(name, "hid-staging-")])
    error_message = "Every error alarm must be named after the name prefix so the alerts topic accepts it."
  }
}

run "nothing_extra_when_switched_off" {
  command = plan

  module {
    source = "./modules/operations"
  }

  variables {
    load_balancer_targets = {}
    ocr_worker_log_group  = null
    notify_stopped_tasks  = false
    alert_subscribers     = []
  }

  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.gateway_error_rate) == 0 &&
      length(aws_cloudwatch_metric_alarm.ocr_queue_age) == 0 &&
      length(aws_cloudwatch_event_rule.stopped_tasks) == 0 &&
      length(aws_sns_topic_subscription.subscribers) == 0 &&
      length(jsondecode(aws_kms_key.alerts.policy).Statement) == 3 &&
      length(jsondecode(aws_sns_topic_policy.alerts.policy).Statement) == 3
    )
    error_message = "Without targets, the OCR log group, stopped-task alerts or subscribers, nothing extra is created and the policies are unchanged."
  }
}

run "subscriber_list_refuses_bad_entries" {
  command = plan

  module {
    source = "./modules/operations"
  }

  variables {
    alert_subscribers = [{ protocol = "sms", endpoint = "08000000000" }]
  }

  expect_failures = [var.alert_subscribers]
}
