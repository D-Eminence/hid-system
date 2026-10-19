# Naming and environment
variable "google_oidc_client_ids" {
  type    = list(string)
  default = []
}

variable "qoreid_enabled" {
  type    = bool
  default = false
}

variable "qoreid_nin_only_enrollment_enabled" {
  type    = bool
  default = false
}

variable "qoreid_secret_arn" {
  type    = string
  default = ""
}

variable "qoreid_secret_kms_key_arn" {
  type    = string
  default = ""
}

variable "notification_delivery_profile" {
  type    = string
  default = ""
}

variable "name_prefix" {
  type = string
}

variable "environment" {
  type = string
}

variable "deployment_profile" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "root_domain_name" {
  type = string
}

variable "browser_subdomains" {
  type = list(string)
}

# Workload catalogue and capacity
variable "workloads" {
  type = map(object({
    port                 = number
    cpu                  = number
    memory               = number
    database_connections = number
    browser_routed       = bool
    scaling_kind         = string
    request_target       = number
  }))
}

variable "desired_counts" {
  type = map(number)
}

variable "registry_workload_names" {
  description = "Additional repositories to bootstrap before their runtime workloads are enabled."
  type        = set(string)
  default     = []
}

variable "scaling_ceilings" {
  type = map(number)
}

variable "enable_runtime" {
  type = bool
}

variable "enable_migration_task" {
  type = bool
}

variable "enable_ingress" {
  type = bool
}

variable "enable_autoscaling" {
  type = bool
}

# Network inputs
variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "support_contact" {
  type    = string
  default = ""
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "application_subnet_ids" {
  type = list(string)
}

variable "endpoint_security_group_id" {
  type = string
}

variable "s3_prefix_list_id" {
  type = string
}

# Data and messaging inputs
variable "database_security_group_id" {
  type = string
}

variable "database_enabled" {
  type = bool
}

variable "database_endpoint" {
  type = string
}

variable "database_master_secret_arn" {
  type = string
}

variable "document_bucket_arn" {
  type = string
}

variable "document_kms_key_arn" {
  type = string
}

variable "database_kms_key_arn" {
  type = string
}

variable "runtime_secret_arns" {
  type = map(string)
}

variable "database_secret_arns" {
  type = map(string)
}

variable "event_bus_arn" {
  type = string
}

variable "notification_queue_arn" {
  type = string
}

variable "notification_queue_kms_key_arn" {
  type = string
}

variable "notification_queue_url" {
  type = string
}

# Container images and TLS
variable "image_uris" {
  type = map(string)
}

variable "workload_token_agent_image_uri" {
  type    = string
  default = ""
}

variable "migration_image_uri" {
  type = string
}

variable "migration_source_bucket_arn" {
  type = string
}

variable "migration_source_kms_key_arn" {
  type = string
}

variable "regional_certificate_arn" {
  type = string
}

variable "internal_certificate_arn" {
  type = string
}

variable "cloudflare_origin_secret" {
  type      = string
  sensitive = true
}

# Application runtime configuration
variable "rds_ca_bundle_base64" {
  type = string
}

variable "workload_issuer_url" {
  type = string
}

variable "workload_jwks_url" {
  type = string
}

variable "workload_subjects" {
  type = map(string)
}

variable "staging_novu_api_url" {
  type = string
}

variable "enable_ai" {
  type = bool
}

variable "ai_allow_eu_processing" {
  type = bool
}

variable "ai_generation_provider" {
  type    = string
  default = "bedrock"
}
variable "anthropic_model_id" {
  type    = string
  default = "claude-sonnet-4-6"
}
variable "anthropic_secret_arn" {
  type    = string
  default = ""
}
variable "anthropic_secret_json_key" {
  type    = string
  default = "apiKey"
}
variable "anthropic_secret_kms_key_arn" {
  type    = string
  default = ""
}
variable "ai_allow_anthropic_us_processing" {
  type    = bool
  default = false
}

variable "enable_support_bot" {
  type = bool
}

variable "support_bot_id" {
  type = string
}

variable "support_bot_alias_id" {
  type = string
}

variable "support_bot_alias_arn" {
  type = string
}

# Retention, repositories, and alerting
variable "application_log_retention_days" {
  type = number
}

variable "security_log_retention_days" {
  type = number
}

variable "repository_image_count" {
  type = number
}

variable "alarm_topic_arn" {
  type = string
}

variable "enable_deployment_automation" {
  type    = bool
  default = false
}

variable "deployment_release_valid" {
  type    = bool
  default = true
}

variable "deployment_account_id" {
  type    = string
  default = ""
}

variable "deployment_alert_kms_key_arn" {
  type    = string
  default = ""
}

variable "runtime_environment" {
  description = "Runtime/token environment independent of persistent resource naming. Empty preserves the module environment."
  type        = string
  default     = ""
  validation {
    condition     = contains(["", "development", "staging", "production"], var.runtime_environment)
    error_message = "Use an explicit supported runtime environment or the existing environment default."
  }
}
variable "browser_origins" {
  description = "Exact approved browser origins, including an apex when selected. Null preserves subdomain-derived origins."
  type        = list(string)
  default     = null
}

variable "deployment_release_environment" {
  description = "Logical release and approval namespace, independent of retained AWS names."
  type        = string
  default     = "staging"
  validation {
    condition     = contains(["staging", "production"], var.deployment_release_environment)
    error_message = "Release environment must be staging or production."
  }
}
