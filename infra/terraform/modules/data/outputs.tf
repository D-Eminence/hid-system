output "database_kms_key_arn" {
  value = aws_kms_key.database.arn
}

output "document_kms_key_arn" {
  value = aws_kms_key.documents.arn
}

output "queue_kms_key_arn" {
  value = aws_kms_key.queue.arn
}

output "document_bucket_name" {
  value = aws_s3_bucket.documents.id
}

output "document_bucket_arn" {
  value = aws_s3_bucket.documents.arn
}

output "database_security_group_id" {
  value = aws_security_group.database.id
}

output "database_arn" {
  value = try(aws_db_instance.main[0].arn, null)
}

output "database_identifier" {
  value = try(aws_db_instance.main[0].identifier, null)
}

output "database_endpoint" {
  value = try(aws_db_instance.main[0].address, null)
}

output "database_master_secret_arn" {
  value = try(aws_db_instance.main[0].master_user_secret[0].secret_arn, null)
}

output "runtime_secret_arns" {
  value = merge(
    { for name, secret in aws_secretsmanager_secret.runtime : name => secret.arn },
    { for name, secret in data.aws_secretsmanager_secret.existing_runtime : name => secret.arn }
  )
}

output "database_secret_arns" {
  value = merge(
    { for name, secret in aws_secretsmanager_secret.database_workload : name => secret.arn },
    { for name, secret in data.aws_secretsmanager_secret.existing_database_workload : name => secret.arn }
  )
}

output "migration_database_secret_arn" {
  value = var.use_existing_secrets ? data.aws_secretsmanager_secret.existing_migration_database[0].arn : aws_secretsmanager_secret.migration_database[0].arn
}

output "malware_protection_plan_arn" {
  description = "GuardDuty Malware Protection plan on clinical/objects/; empty while enable_document_malware_protection is off."
  value       = try(aws_guardduty_malware_protection_plan.documents[0].arn, "")
}

output "guardduty_malware_role_arn" {
  description = "Role the GuardDuty plan uses to read and tag clinical/objects/; empty while off."
  value       = local.guardduty_malware_role_arn
}

output "document_scan_review" {
  description = "Rendered plan, plan-role and bucket-policy statements for tests; no secrets, not exported by the root module."
  value = {
    plan = {
      count           = length(aws_guardduty_malware_protection_plan.documents)
      object_prefixes = try(aws_guardduty_malware_protection_plan.documents[0].protected_resource[0].s3_bucket[0].object_prefixes, [])
      tagging         = try(aws_guardduty_malware_protection_plan.documents[0].actions[0].tagging[0].status, null)
    }
    notification_eventbridge = try(aws_s3_bucket_notification.documents[0].eventbridge, null)
    plan_role_statements = [for statement in try(data.aws_iam_policy_document.guardduty_malware_protection[0].statement, []) : {
      sid        = statement.sid
      actions    = sort(statement.actions)
      resources  = sort(statement.resources)
      conditions = [for condition in coalesce(statement.condition, []) : "${condition.test}:${condition.variable}"]
    }]
    bucket_policy_statements = [for statement in data.aws_iam_policy_document.documents.statement : {
      sid        = statement.sid
      effect     = statement.effect
      actions    = sort(statement.actions)
      resources  = sort(statement.resources)
      conditions = { for condition in coalesce(statement.condition, []) : "${condition.test}:${condition.variable}" => sort(condition.values) }
    }]
  }
}
