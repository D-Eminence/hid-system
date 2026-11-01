# Container Insights "enhanced" was the largest monitoring cost. The running-task
# alarms must therefore read the free AWS/ECS LiveTaskCount metric, and keep
# their names, thresholds, timing, missing-data rule and SNS actions.
mock_provider "aws" {
  mock_resource "aws_sns_topic" {
    override_during = plan
    defaults = {
      arn = "arn:aws:sns:eu-west-1:123456789012:hid-staging-operations-alerts"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      id   = "mock-policy"
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  name_prefix                = "hid-staging"
  environment                = "staging"
  enable_database            = false
  database_kms_key_arn       = "arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111"
  database_connection_budget = 0
  backup_retention_days      = 30
  enable_backup_plan         = false
  alert_email                = "operations@example.invalid"
  aws_account_id             = "123456789012"
  aws_region                 = "eu-west-1"
  ecs_cluster_name           = "hid-production"
  runtime_services = {
    "hid-production-gateway"      = 1
    "hid-production-identity-api" = 1
    "hid-production-ocr-worker"   = 2
  }
}

run "runtime_task_alarms_use_the_free_ecs_metric" {
  command = plan

  module {
    source = "./modules/operations"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.runtime_tasks) == 3
    error_message = "Every runtime service must keep its running-task alarm."
  }

  assert {
    condition = alltrue([for name, alarm in aws_cloudwatch_metric_alarm.runtime_tasks :
      alarm.namespace == "AWS/ECS" && alarm.metric_name == "LiveTaskCount"
    ])
    error_message = "Running-task alarms must read the free AWS/ECS LiveTaskCount metric, not Container Insights."
  }

  assert {
    condition = alltrue([for name, alarm in aws_cloudwatch_metric_alarm.runtime_tasks :
      alarm.namespace != "ECS/ContainerInsights"
    ])
    error_message = "No running-task alarm may depend on Container Insights, which production turns off."
  }

  assert {
    condition = alltrue([for name, alarm in aws_cloudwatch_metric_alarm.runtime_tasks :
      alarm.alarm_name == "${name}-running-tasks" &&
      alarm.dimensions == tomap({ ClusterName = "hid-production", ServiceName = name })
    ])
    error_message = "Alarm names and service dimensions must stay the same, so alarm history and subscriptions carry over."
  }

  assert {
    condition = alltrue([for name, alarm in aws_cloudwatch_metric_alarm.runtime_tasks :
      alarm.statistic == "Minimum" &&
      alarm.period == 60 &&
      alarm.evaluation_periods == 3 &&
      alarm.datapoints_to_alarm == 3 &&
      alarm.threshold == var.runtime_services[name] &&
      alarm.comparison_operator == "LessThanThreshold" &&
      alarm.treat_missing_data == "breaching"
    ])
    error_message = "Each alarm must still fire after three one-minute periods below that service's task count, and when no data arrives."
  }

  assert {
    condition = alltrue([for name, alarm in aws_cloudwatch_metric_alarm.runtime_tasks :
      alarm.alarm_actions == toset([aws_sns_topic.alerts.arn]) &&
      alarm.ok_actions == toset([aws_sns_topic.alerts.arn])
    ])
    error_message = "Alarm and recovery notifications must still go to the operations alerts topic."
  }

  assert {
    condition = alltrue([for name, alarm in output.runtime_task_alarms :
      alarm.namespace == "AWS/ECS" && alarm.metric_name == "LiveTaskCount"
    ]) && length(output.runtime_task_alarms) == 3
    error_message = "The runtime_task_alarms output must describe the alarms as planned."
  }
}
