output "alert_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "alert_topic_kms_key_arn" {
  value = aws_kms_key.alerts.arn
}

output "monitoring_coverage" {
  value = {
    services      = length(aws_cloudwatch_metric_alarm.runtime_tasks)
    target_groups = length(aws_cloudwatch_metric_alarm.healthy_targets)
    dead_letter   = length(aws_cloudwatch_metric_alarm.notification_dead_letters)
    backlog       = length(aws_cloudwatch_metric_alarm.notification_backlog_age)
    providers     = length(aws_cloudwatch_metric_alarm.provider_failure)
  }
}
