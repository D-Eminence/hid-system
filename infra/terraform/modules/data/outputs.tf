output "database_kms_key_arn" { value = aws_kms_key.database.arn }
output "document_kms_key_arn" { value = aws_kms_key.documents.arn }
output "queue_kms_key_arn" { value = aws_kms_key.queue.arn }
output "document_bucket_name" { value = aws_s3_bucket.documents.id }
output "document_bucket_arn" { value = aws_s3_bucket.documents.arn }
output "database_security_group_id" { value = aws_security_group.database.id }
output "database_arn" { value = try(aws_db_instance.main[0].arn, null) }
output "database_identifier" { value = try(aws_db_instance.main[0].identifier, null) }
output "database_endpoint" { value = try(aws_db_instance.main[0].address, null) }
output "bootstrap_database_secret_arn" { value = try(aws_db_instance.main[0].master_user_secret[0].secret_arn, null) }
output "runtime_secret_arns" { value = { for name, secret in aws_secretsmanager_secret.runtime : name => secret.arn } }
output "database_secret_arns" { value = { for name, secret in aws_secretsmanager_secret.database_workload : name => secret.arn } }
output "migration_database_secret_arn" { value = aws_secretsmanager_secret.migration_database.arn }
