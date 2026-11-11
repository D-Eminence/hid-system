# Free AWS/ECS task count: no Container Insights needed. LiveTaskCount also
# counts tasks still starting or draining (deregistration delay 30-60 s), and
# ECS sends nothing for a service with no tasks, so missing data stays breaching.
resource "aws_cloudwatch_metric_alarm" "runtime_tasks" {
  for_each            = var.runtime_services
  alarm_name          = "${each.key}-running-tasks"
  namespace           = "AWS/ECS"
  metric_name         = "LiveTaskCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = each.value
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = each.key }
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "healthy_targets" {
  for_each            = var.load_balancer_targets
  alarm_name          = "${var.name_prefix}-${each.key}-healthy-targets"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  dimensions          = { LoadBalancer = each.value.load_balancer, TargetGroup = each.value.target_group }
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "notification_dead_letters" {
  count               = contains(keys(var.notification_queue_names), "dead_letter") ? 1 : 0
  alarm_name          = "${var.name_prefix}-notification-dead-letters"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = var.notification_queue_names["dead_letter"] }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "notification_backlog_age" {
  count               = contains(keys(var.notification_queue_names), "notification") ? 1 : 0
  alarm_name          = "${var.name_prefix}-notification-backlog-age"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 300
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = var.notification_queue_names["notification"] }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_log_metric_filter" "provider_failure" {
  for_each       = var.provider_log_groups
  name           = "${var.name_prefix}-${each.key}-provider-failure"
  log_group_name = each.value
  pattern        = "{ $.event = \"hid.provider.result\" && ($.outcome = \"definitive_failure\" || $.outcome = \"unknown\") }"
  metric_transformation {
    name          = "${each.key}-provider-failure"
    namespace     = "HID/${var.environment}/Providers"
    value         = "1"
    default_value = 0
  }
}

resource "aws_cloudwatch_metric_alarm" "provider_failure" {
  for_each            = var.provider_log_groups
  alarm_name          = "${var.name_prefix}-${each.key}-provider-failure"
  namespace           = "HID/${var.environment}/Providers"
  metric_name         = "${each.key}-provider-failure"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# 7-day deletion of OCR sources: every sweep round (every 15 minutes) the
# OCR worker logs {"event":"ocr.source_deletion.overdue","overdue":n,...}, n =
# sources still present more than 7 days and 2 hours after their job finished. The alarm
# fires when any is overdue, and also when no round has been logged (missing
# data is breaching): a stopped sweeper is as bad as a failing one.
resource "aws_cloudwatch_log_metric_filter" "ocr_source_deletion_overdue" {
  count          = var.ocr_worker_log_group == null ? 0 : 1
  name           = "${var.name_prefix}-ocr-source-deletion-overdue"
  log_group_name = var.ocr_worker_log_group
  pattern        = "{ $.event = \"ocr.source_deletion.overdue\" }"
  metric_transformation {
    name      = "ocr-source-deletion-overdue"
    namespace = "HID/${var.environment}/OCR"
    value     = "$.overdue"
  }
}

resource "aws_cloudwatch_metric_alarm" "ocr_source_deletion_overdue" {
  count               = var.ocr_worker_log_group == null ? 0 : 1
  alarm_name          = "${var.name_prefix}-ocr-source-deletion-overdue"
  alarm_description   = "OCR sources are still stored more than 7 days and 2 hours after their job finished, or the deletion sweeper has not reported for an hour."
  namespace           = "HID/${var.environment}/OCR"
  metric_name         = "ocr-source-deletion-overdue"
  statistic           = "Maximum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
