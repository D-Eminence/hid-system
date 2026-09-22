output "ecr_repository_url" {
  description = "Repository used by the application image build and release pipeline."
  value       = module.application.ecr_repository_url
}

output "document_bucket_name" {
  description = "Bucket targeted by the document migration and ingestion process."
  value       = module.data.document_bucket_name
}

output "database_endpoint" {
  description = "Database hostname used during migration and application configuration; null when RDS is disabled."
  value       = var.enable_database ? module.data.database_endpoint : null
}

output "load_balancer_dns_name" {
  description = "AWS origin used by the separate Cloudflare DNS stack; null when the application is disabled."
  value       = module.application.load_balancer_dns_name
}

output "provider_api_endpoint" {
  description = "Endpoint supplied to the representative healthcare integration partner; null when the API is disabled."
  value       = module.integration.provider_api_endpoint
}

output "opensearch_endpoint" {
  description = "Private search endpoint used by the ingestion and retrieval services; null when OpenSearch is disabled."
  value       = module.ai.opensearch_endpoint
}

output "alert_topic_arn" {
  description = "SNS topic to which the approved alert destinations are subscribed."
  value       = module.operations.alert_topic_arn
}

output "application_secret_placeholder_arns" {
  description = "Secrets that operators populate before enabling application workloads."
  value       = module.data.application_secret_placeholder_arns
}
