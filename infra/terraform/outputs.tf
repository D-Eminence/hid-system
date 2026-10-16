output "ecr_repository_urls" {
  value       = module.application.ecr_repository_urls
  description = "Repositories used by the release pipeline."
}

output "database_endpoint" {
  value       = module.data.database_endpoint
  description = "Private PostgreSQL endpoint when enabled."
}

output "document_bucket_name" {
  value       = module.data.document_bucket_name
  description = "Private clinical document bucket."
}

output "public_api_origin" {
  value       = module.application.public_api_origin
  description = "AWS API origin handed to the Cloudflare team when ingress is enabled."
}

output "migration_task_definition_arn" {
  value       = module.application.migration_task_definition_arn
  description = "One-shot migration task definition."
}

output "runtime_secret_arns" {
  value       = module.data.runtime_secret_arns
  description = "Secret containers that must be populated outside Terraform before runtime starts."
}
