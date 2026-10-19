resource "aws_cloudwatch_metric_alarm" "runtime_tasks" {
  for_each            = var.runtime_services
  alarm_name          = "${each.key}-running-tasks"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
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
