output "runtime_capacity_configuration" {
  description = "Non-secret task sizes and configured service capacity for operator verification."
  value = {
    for name, workload in local.workloads : name => {
      cpu           = workload.cpu
      memory        = workload.memory
      desired_count = local.desired_counts[name]
      max_capacity  = local.scaling_ceilings[name]
    }
  }
}

output "ecr_repository_urls" {
  value       = module.application.ecr_repository_urls
  description = "Repositories used by the release pipeline."
}

output "deployment_automation_configuration" {
  value = module.application.deployment_automation_configuration
}

output "notification_delivery_configuration" {
  value       = module.application.notification_delivery_configuration
  description = "Notification profile and secret binding names only, when runtime is enabled."
}

output "emergency_contacts" {
  value       = module.application.emergency_contact_configuration
  description = "Emergency-contact switches, dispatch interval, channels and pilot account count; never the account IDs."
}

output "database_endpoint" {
  value       = module.data.database_endpoint
  description = "Private PostgreSQL endpoint when enabled."
}

output "document_bucket_name" {
  value       = module.data.document_bucket_name
  description = "Private clinical document bucket."
}

output "api_load_balancer_dns_name" {
  value       = module.application.api_load_balancer_dns_name
  description = "DNS target for the approved API hostname in Cloudflare when ingress is enabled."
}

output "workload_issuer_url" {
  value       = module.application.workload_issuer_url
  description = "Issuer URL for ECS service tokens; the JWKS URL is this value plus /.well-known/jwks.json."
}

output "migration_task_definition_arn" {
  value       = module.application.migration_task_definition_arn
  description = "One-shot migration task definition."
}

output "migration_promotion_task_definition_arn" {
  value       = module.application.migration_promotion_task_definition_arn
  description = "One-shot identity promotion and reconciliation task definition."
}

output "migration_security_group_id" {
  value       = module.application.migration_security_group_id
  description = "Security group needed to run the one-shot migration task."
}

output "migration_subnet_ids" {
  value       = module.network.application_subnet_ids
  description = "Private subnets for the one-shot migration task."
}

output "runtime_secret_arns" {
  value       = module.data.runtime_secret_arns
  description = "Secret containers that must be populated outside Terraform before runtime starts."
}

output "bedrock_endpoint_id" {
  value       = var.enable_ai ? module.ai[0].bedrock_endpoint_id : null
  description = "Private Bedrock endpoint for patient-record chat when enabled."
}

output "support_bot_id" {
  value       = var.enable_support_bot ? module.support_bot[0].bot_id : null
  description = "Lex V2 bot ID used by the support API when enabled."
}
