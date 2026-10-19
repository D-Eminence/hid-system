output "event_bus_arn" {
  value = aws_cloudwatch_event_bus.platform.arn
}

output "notification_queue_arn" {
  value = aws_sqs_queue.notification.arn
}

output "notification_queue_url" {
  value = aws_sqs_queue.notification.url
}
output "queue_names" {
  value = { notification = aws_sqs_queue.notification.name, dead_letter = aws_sqs_queue.dead_letter.name }
}
