# The operations module has adopted these existing alarms under the same names.
# Forget the old duplicate bindings without deleting the live AWS alarms.
removed {
  from = module.application.aws_cloudwatch_metric_alarm.running_tasks
  lifecycle {
    destroy = false
  }
}
