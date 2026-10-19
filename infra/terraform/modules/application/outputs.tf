output "ecr_repository_urls" {
  value = {
    for name, repository in aws_ecr_repository.workload :
    name => repository.repository_url
  }
}
output "ai_generation_configuration" {
  description = "Generation transport and EHR secret binding names only; no credential values."
  value = {
    provider            = var.ai_generation_provider
    model_id            = local.workload_environment["ehr-api"].AI_GENERATION_MODEL_ID
    ehr_secret_fields   = [for spec in local.fixed_secret_specs["ehr-api"] : spec.name]
    other_secret_fields = flatten([for name, specs in local.fixed_secret_specs : [for spec in specs : spec.name] if name != "ehr-api"])
  }
}

output "notification_delivery_configuration" {
  description = "Selected delivery profile and secret binding names only; no credential values."
  value = var.enable_runtime ? {
    profile = local.notification_profile
    # This is the same specification used to generate the container secrets.
    # Names remain plan-readable even when secret ARNs are not known yet.
    secret_fields = [for spec in local.workload_secret_specs["notification-api"] : spec.name]
  } : null
}

output "operational_target_dimensions" {
  value = var.enable_ingress ? merge({
    for name, group in local.active_internal_groups : name => {
      load_balancer = aws_lb.internal[0].arn_suffix
      target_group  = group.arn_suffix
    }
    }, { gateway = {
      load_balancer = aws_lb.public[0].arn_suffix
      target_group  = local.active_gateway_group.arn_suffix
  } }) : {}
}

output "provider_log_groups" {
  value = var.enable_runtime ? {
    for name in ["notification-api", "notification-worker"] : name => aws_cloudwatch_log_group.workload[name].name
  } : {}
}

output "api_load_balancer_dns_name" {
  value = try(aws_lb.public[0].dns_name, null)
}

output "workload_issuer_url" {
  value = var.enable_runtime ? local.managed_issuer_url : null
}

output "migration_task_definition_arn" {
  value = try(aws_ecs_task_definition.migration[0].arn, null)
}

output "migration_promotion_task_definition_arn" {
  value = try(aws_ecs_task_definition.migration_promotion[0].arn, null)
}

output "migration_security_group_id" {
  value = try(aws_security_group.migration[0].id, null)
}

output "ehr_task_role_arn" {
  value = try(aws_iam_role.task["ehr-api"].arn, null)
}

output "ehr_task_role_name" {
  value = try(aws_iam_role.task["ehr-api"].name, null)
}

output "ehr_security_group_id" {
  value = try(aws_security_group.workload["ehr-api"].id, null)
}
output "migration_customer_input_access" {
  description = "Rendered version-read policy for migration review; contains no input values or secrets."
  value       = try(jsondecode(aws_iam_role_policy.migration_customer_inputs[0].policy), null)
}

output "runtime_environment_configuration" {
  description = "Public/non-secret runtime identity, origin and provider endpoint settings for release review."
  value = {
    resource_environment = var.environment
    runtime_environment  = local.runtime_environment
    browser_origins      = local.browser_origins
    identity_origins     = local.workload_environment["identity-api"].CORS_ORIGINS
    nin_provider_mode    = local.workload_environment["identity-api"].NIN_PROVIDER_MODE
    novu_api_url         = try(local.workload_environment["notification-worker"].NOVU_API_URL, null)
    subjects             = local.identity_subjects
    issuer_path          = local.workload_identity_environment

    repositories = { for name, repository in aws_ecr_repository.workload : name => repository.name }
  }
}
