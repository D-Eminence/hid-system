variable "ecs_migration_phase" {
  description = "ECS-only production move: legacy, prepare, drain, active, retired. Shared data/network/IAM identities remain unchanged."
  type        = string
  default     = "legacy"
  validation {
    condition     = contains(["legacy", "prepare", "drain", "active", "retired"], var.ecs_migration_phase)
    error_message = "Unknown ECS migration phase."
  }
}

output "ecs_migration_configuration" {
  value = module.application.ecs_migration_configuration
}

check "ecs_production_move" {
  assert {
    condition     = var.ecs_migration_phase == "legacy" || (var.promote_existing_staging && var.activate_production_runtime && !var.enable_deployment_automation)
    error_message = "The manual ECS move requires the retained live production stack and disabled deployment automation."
  }
}
