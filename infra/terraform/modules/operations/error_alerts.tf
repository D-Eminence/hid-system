# Error alerts: server errors, unhealthy or crashed tasks and a stuck OCR queue.
# Every alarm here is named "${var.name_prefix}-*" so the alerts topic and its
# key already admit it (see the policies in main.tf).

locals {
  # Everyone who receives alerts: the original alert_email plus the list the
  # owner sets at apply time. Keyed by protocol and endpoint so adding or
  # removing one person leaves the other subscriptions alone. Entries that
  # differ only in letter case are grouped and the first one is kept, so a
  # repeated address never stops the plan with a duplicate-key error.
  alert_subscriber_groups = {
    for subscriber in var.alert_subscribers : "${subscriber.protocol}:${lower(subscriber.endpoint)}" => subscriber...
    if !(subscriber.protocol == "email" && lower(subscriber.endpoint) == lower(var.alert_email))
  }
  alert_subscribers = { for key, subscribers in local.alert_subscriber_groups : key => subscribers[0] }

  gateway_target = lookup(var.load_balancer_targets, "gateway", { load_balancer = "", target_group = "" })

  ecs_cluster_arn         = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:cluster/${var.ecs_cluster_name}"
  stopped_task_rule_name  = "${var.name_prefix}-service-task-stopped"
  stopped_task_rule_arn   = "arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/${local.stopped_task_rule_name}"
  ocr_alarms_enabled      = var.ocr_worker_log_group != null
  ocr_metric_namespace    = "HID/${var.environment}/OCR"
  ocr_queue_age_threshold = 900
}

resource "aws_sns_topic_subscription" "subscribers" {
  for_each  = local.alert_subscribers
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = each.value.protocol
  endpoint  = each.value.endpoint
}

# What people see: the share of API requests through the public load balancer
# that end in a server error (5xx from the gateway or from the load balancer
# itself when no gateway task can answer). Needs at least 20 requests and 5
# errors in the five minutes so a single failure at night does not page anyone.
# The load balancer only publishes a 5xx count for periods that had one, and
# metric math gives no value where any input is missing, so every input is
# filled with 0. Without that, the alarm would only see periods where both
# kinds of 5xx happened, and would stay quiet in a full outage (load balancer
# 502/503s only).
resource "aws_cloudwatch_metric_alarm" "gateway_error_rate" {
  count               = contains(keys(var.load_balancer_targets), "gateway") ? 1 : 0
  alarm_name          = "${var.name_prefix}-gateway-server-error-rate"
  alarm_description   = "More than 5% of API requests failed with a server error in the last 5 minutes. People see errors on the Health ID sites now."
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "rate"
    label       = "Server error rate (%)"
    expression  = "IF(all_requests >= 20 AND (gateway_5xx + edge_5xx) >= 5, 100 * (gateway_5xx + edge_5xx) / all_requests, 0)"
    return_data = true
  }

  metric_query {
    id         = "gateway_5xx"
    expression = "FILL(target_errors, 0)"
  }

  metric_query {
    id         = "edge_5xx"
    expression = "FILL(edge_errors, 0)"
  }

  metric_query {
    id         = "all_requests"
    expression = "FILL(requests, 0)"
  }

  metric_query {
    id = "target_errors"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      dimensions  = { LoadBalancer = local.gateway_target.load_balancer, TargetGroup = local.gateway_target.target_group }
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id = "edge_errors"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      dimensions  = { LoadBalancer = local.gateway_target.load_balancer }
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      dimensions  = { LoadBalancer = local.gateway_target.load_balancer }
      period      = 300
      stat        = "Sum"
    }
  }
}

# Which service is failing: 10 or more server errors from one service's tasks
# in five minutes.
resource "aws_cloudwatch_metric_alarm" "target_server_errors" {
  for_each            = var.load_balancer_targets
  alarm_name          = "${var.name_prefix}-${each.key}-server-errors"
  alarm_description   = "${each.key} answered 10 or more requests with a server error in the last 5 minutes. Check its logs in CloudWatch (/hid/${var.environment}/${each.key})."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = each.value.load_balancer, TargetGroup = each.value.target_group }
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# A task is running but failing its health check for five minutes in a row.
# New tasks pass within about a minute, so deployments do not trigger it.
resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  for_each            = var.load_balancer_targets
  alarm_name          = "${var.name_prefix}-${each.key}-unhealthy-tasks"
  alarm_description   = "At least one ${each.key} task has failed its health check for 5 minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = each.value.load_balancer, TargetGroup = each.value.target_group }
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# A service task stopped because its main container exited, it could not
# start, or it failed its health checks. Ordinary stops (deployments, scaling
# in, one-off migration tasks) do not match. ECS starts a replacement on its
# own; repeated messages for the same service mean it is crash-looping.
resource "aws_cloudwatch_event_rule" "stopped_tasks" {
  count       = var.notify_stopped_tasks ? 1 : 0
  name        = local.stopped_task_rule_name
  description = "A ${var.ecs_cluster_name} service task stopped unexpectedly."
  event_pattern = jsonencode({
    source        = ["aws.ecs"]
    "detail-type" = ["ECS Task State Change"]
    detail = {
      clusterArn = [local.ecs_cluster_arn]
      lastStatus = ["STOPPED"]
      group      = [{ prefix = "service:" }]
      "$or" = [
        { stopCode = ["EssentialContainerExited", "TaskFailedToStart"] },
        { stoppedReason = [{ prefix = "Task failed" }] },
      ]
    }
  })
}

resource "aws_cloudwatch_event_target" "stopped_tasks" {
  count     = var.notify_stopped_tasks ? 1 : 0
  rule      = aws_cloudwatch_event_rule.stopped_tasks[0].name
  target_id = "operations-alerts"
  arn       = aws_sns_topic.alerts.arn

  input_transformer {
    input_paths = {
      service = "$.detail.group"
      reason  = "$.detail.stoppedReason"
      code    = "$.detail.stopCode"
      time    = "$.time"
    }
    input_template = "\"Health ID ${var.environment}: a server task stopped unexpectedly. Service: <service>. Reason: <reason> (<code>). Time (UTC): <time>. A replacement starts on its own; if this message repeats for the same service, it is crash-looping and needs attention.\""
  }
}

# OCR jobs wait in a database queue, not SQS. The worker logs the age of the
# oldest waiting job each time it picks one up (event ocr.job.claimed). If
# that age stays over 15 minutes, documents are waiting too long.
# Limits: this only sees a queue that is still moving. When no job is picked
# up (every worker exited, every claim loop hung, or the per-facility limit is
# used up by stuck jobs) nothing is logged and this alarm stays quiet; an
# empty queue looks the same, so missing data cannot count as breaching. The
# ocr-worker running-task alarm covers workers that exited. Catching a hung
# worker needs the worker to log the queue age on a timer (OCR worker owner).
resource "aws_cloudwatch_log_metric_filter" "ocr_queue_age" {
  count          = local.ocr_alarms_enabled ? 1 : 0
  name           = "${var.name_prefix}-ocr-oldest-queued-age"
  log_group_name = var.ocr_worker_log_group
  pattern        = "{ $.event = \"ocr.job.claimed\" && $.oldestQueueAgeSeconds >= 0 }"
  metric_transformation {
    name      = "OldestQueuedJobAgeSeconds"
    namespace = local.ocr_metric_namespace
    value     = "$.oldestQueueAgeSeconds"
    unit      = "Seconds"
  }
}

resource "aws_cloudwatch_metric_alarm" "ocr_queue_age" {
  count               = local.ocr_alarms_enabled ? 1 : 0
  alarm_name          = "${var.name_prefix}-ocr-queue-age"
  alarm_description   = "Migrate documents that were picked up had waited more than 15 minutes to be read. The OCR workers are behind. This alarm cannot see a worker that has stopped picking up jobs."
  namespace           = local.ocr_metric_namespace
  metric_name         = aws_cloudwatch_log_metric_filter.ocr_queue_age[0].metric_transformation[0].name
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = local.ocr_queue_age_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_log_metric_filter" "ocr_worker_errors" {
  count          = local.ocr_alarms_enabled ? 1 : 0
  name           = "${var.name_prefix}-ocr-worker-loop-errors"
  log_group_name = var.ocr_worker_log_group
  pattern        = "{ $.event = \"ocr.worker.loop_error\" }"
  metric_transformation {
    name          = "WorkerLoopErrors"
    namespace     = local.ocr_metric_namespace
    value         = "1"
    default_value = 0
  }
}

resource "aws_cloudwatch_metric_alarm" "ocr_worker_errors" {
  count               = local.ocr_alarms_enabled ? 1 : 0
  alarm_name          = "${var.name_prefix}-ocr-worker-errors"
  alarm_description   = "The OCR worker failed to pick up jobs 5 or more times in 5 minutes (usually the database or a setting). Migrate documents are not being read."
  namespace           = local.ocr_metric_namespace
  metric_name         = aws_cloudwatch_log_metric_filter.ocr_worker_errors[0].metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
