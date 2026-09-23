output "event_bus_arn" { value = aws_cloudwatch_event_bus.platform.arn }
output "notification_queue_arn" { value = aws_sqs_queue.notification.arn }
output "notification_queue_url" { value = aws_sqs_queue.notification.url }
output "dead_letter_queue_arn" { value = aws_sqs_queue.dead_letter.arn }
