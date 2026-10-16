resource "aws_appautoscaling_target" "workload" {
  for_each = var.enable_runtime && var.enable_autoscaling ? {
    for name, workload in var.workloads : name => workload if var.scaling_ceilings[name] > 0
  } : {}

  max_capacity       = var.scaling_ceilings[each.key]
  min_capacity       = var.desired_counts[each.key]
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.workload[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each = aws_appautoscaling_target.workload

  name               = "${var.name_prefix}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension
  service_namespace  = each.value.service_namespace
  target_tracking_scaling_policy_configuration {
    target_value       = var.workloads[each.key].scaling_kind == "request" ? 65 : 70
    scale_in_cooldown  = var.workloads[each.key].scaling_kind == "request" ? 300 : 600
    scale_out_cooldown = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
  }
}

resource "aws_appautoscaling_policy" "memory" {
  for_each = aws_appautoscaling_target.workload

  name               = "${var.name_prefix}-${each.key}-memory"
  policy_type        = "TargetTrackingScaling"
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension
  service_namespace  = each.value.service_namespace
  target_tracking_scaling_policy_configuration {
    target_value       = var.workloads[each.key].scaling_kind == "request" ? 75 : 80
    scale_in_cooldown  = var.workloads[each.key].scaling_kind == "request" ? 300 : 600
    scale_out_cooldown = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageMemoryUtilization" }
  }
}

resource "aws_appautoscaling_policy" "request" {
  for_each = var.enable_ingress ? {
    for name, target in aws_appautoscaling_target.workload : name => target if var.workloads[name].scaling_kind == "request"
  } : {}

  name               = "${var.name_prefix}-${each.key}-requests"
  policy_type        = "TargetTrackingScaling"
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension
  service_namespace  = each.value.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = var.workloads[each.key].request_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label = each.key == "gateway" ? "${aws_lb.public[0].arn_suffix}/${aws_lb_target_group.gateway[0].arn_suffix}" : (
        "${aws_lb.internal[0].arn_suffix}/${aws_lb_target_group.internal[each.key].arn_suffix}"
      )
    }
  }
}

resource "aws_appautoscaling_policy" "notification_backlog" {
  for_each = contains(keys(aws_appautoscaling_target.workload), "notification-worker") ? { notification-worker = aws_appautoscaling_target.workload["notification-worker"] } : {}

  name               = "${var.name_prefix}-notification-worker-backlog"
  policy_type        = "TargetTrackingScaling"
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension
  service_namespace  = each.value.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 20
    scale_in_cooldown  = 600
    scale_out_cooldown = 60

    customized_metric_specification {
      metric_name = "ApproximateNumberOfMessagesVisible"
      namespace   = "AWS/SQS"
      statistic   = "Average"
      dimensions {
        name  = "QueueName"
        value = element(reverse(split("/", var.notification_queue_url)), 0)
      }
    }
  }
}

resource "aws_appautoscaling_policy" "ocr_backlog" {
  for_each = contains(keys(aws_appautoscaling_target.workload), "ocr-worker") ? { ocr-worker = aws_appautoscaling_target.workload["ocr-worker"] } : {}

  name               = "${var.name_prefix}-ocr-worker-backlog"
  policy_type        = "TargetTrackingScaling"
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension
  service_namespace  = each.value.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 10
    scale_in_cooldown  = 600
    scale_out_cooldown = 60

    customized_metric_specification {
      metric_name = "QueueDepth"
      namespace   = "HID/OCR"
      statistic   = "Average"
    }
  }
}

resource "aws_appautoscaling_policy" "outbox_backlog" {
  for_each = contains(keys(aws_appautoscaling_target.workload), "event-dispatcher") ? { event-dispatcher = aws_appautoscaling_target.workload["event-dispatcher"] } : {}

  name               = "${var.name_prefix}-event-dispatcher-backlog"
  policy_type        = "TargetTrackingScaling"
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension
  service_namespace  = each.value.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 25
    scale_in_cooldown  = 600
    scale_out_cooldown = 60

    customized_metric_specification {
      metric_name = "PendingCount"
      namespace   = "HID/EventDelivery"
      statistic   = "Average"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "running_tasks" {
  for_each = var.enable_runtime && var.deployment_profile != "sleep" ? {
    for name in ["gateway", "identity-api", "ehr-api", "ocr-worker", "notification-api", "notification-worker", "event-dispatcher"] :
    name => var.workloads[name] if var.desired_counts[name] > 0
  } : {}

  alarm_name          = "${var.name_prefix}-${each.key}-running-tasks"
  alarm_description   = "${each.key} running task count is below the configured live minimum"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  threshold           = max(1, var.desired_counts[each.key])
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.workload[each.key].name }
  alarm_actions       = [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "notification_queue_age" {
  count = var.enable_runtime ? 1 : 0

  alarm_name          = "${var.name_prefix}-notification-queue-age"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 300
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = element(reverse(split("/", var.notification_queue_url)), 0) }
  alarm_actions       = [var.alarm_topic_arn]
}
