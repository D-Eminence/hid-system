output "alert_topic_arn" { value = aws_sns_topic.alerts.arn }
output "backup_vault_arn" { value = try(aws_backup_vault.main[0].arn, null) }
