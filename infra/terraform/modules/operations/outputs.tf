output "alert_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "alert_topic_kms_key_arn" {
  value = aws_kms_key.alerts.arn
}

output "alert_source_arns" {
  description = "Alarm ARN patterns CloudWatch may publish to the alerts topic for (topic and key policies)."
  value       = concat([local.prefix_alarm_source_arn], local.runtime_alarm_source_arns)
}

output "runtime_task_alarms" {
  value = { for name, alarm in aws_cloudwatch_metric_alarm.runtime_tasks : alarm.alarm_name => {
    namespace   = alarm.namespace
    metric_name = alarm.metric_name
    statistic   = alarm.statistic
    threshold   = alarm.threshold
  } }
}

output "monitoring_coverage" {
  value = {
    services      = length(aws_cloudwatch_metric_alarm.runtime_tasks)
    target_groups = length(aws_cloudwatch_metric_alarm.healthy_targets)
    dead_letter   = length(aws_cloudwatch_metric_alarm.notification_dead_letters)
    backlog       = length(aws_cloudwatch_metric_alarm.notification_backlog_age)
    providers     = length(aws_cloudwatch_metric_alarm.provider_failure)
    error_rate    = length(aws_cloudwatch_metric_alarm.gateway_error_rate)
    server_errors = length(aws_cloudwatch_metric_alarm.target_server_errors)
    unhealthy     = length(aws_cloudwatch_metric_alarm.unhealthy_targets)
    stopped_tasks = length(aws_cloudwatch_event_rule.stopped_tasks)
    ocr_queue     = length(aws_cloudwatch_metric_alarm.ocr_queue_age) + length(aws_cloudwatch_metric_alarm.ocr_worker_errors)
    subscribers   = length(aws_sns_topic_subscription.email) + length(aws_sns_topic_subscription.subscribers)
  }
}
