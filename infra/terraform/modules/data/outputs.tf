output "kms_key_arn" {
  value = aws_kms_key.data.arn
}

output "document_bucket_arn" {
  value = aws_s3_bucket.documents.arn
}

output "document_bucket_name" {
  value = aws_s3_bucket.documents.id
}

output "application_security_group_id" {
  value = aws_security_group.app.id
}

output "database_security_group_id" {
  value = aws_security_group.database.id
}

output "database_arn" {
  value = var.enable_database ? aws_db_instance.main[0].arn : null
}

output "database_endpoint" {
  value = var.enable_database ? aws_db_instance.main[0].address : null
}

output "database_identifier" {
  value = var.enable_database ? aws_db_instance.main[0].identifier : null
}

output "application_secret_placeholder_arns" {
  value = { for name, secret in aws_secretsmanager_secret.application_placeholders : name => secret.arn }
}
