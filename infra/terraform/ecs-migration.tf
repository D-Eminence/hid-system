variable "ecs_migration_phase" {
  description = "ECS-only production move: legacy, prepare, drain, active, retired. Shared data/network/IAM identities remain unchanged."
  type        = string
  default     = "legacy"
  validation {
    condition     = contains(["legacy", "prepare", "drain", "active", "retired"], var.ecs_migration_phase)
    error_message = "Unknown ECS migration phase."
  }
}

variable "ecs_container_insights" {
  description = "CloudWatch Container Insights level for the ECS clusters: enhanced, enabled or disabled. Enhanced is billed per container metric; the running-task alarms use the free AWS/ECS LiveTaskCount metric instead. The default keeps today's level, so only environments that set this change."
  type        = string
  default     = "enhanced"
  validation {
    condition     = contains(["enhanced", "enabled", "disabled"], var.ecs_container_insights)
    error_message = "ecs_container_insights must be enhanced, enabled or disabled."
  }
}

output "ecs_migration_configuration" {
  value = module.application.ecs_migration_configuration
}

check "ecs_production_move" {
  assert {
    condition     = var.ecs_migration_phase == "legacy" || (var.promote_existing_staging && var.activate_production_runtime && (var.ecs_migration_phase == "retired" || !var.enable_deployment_automation))
    error_message = "The manual ECS move requires the retained live production stack; deployment automation must remain disabled until the old cluster is retired."
  }
}
