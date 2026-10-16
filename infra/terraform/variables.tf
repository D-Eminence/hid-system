variable "aws_region" {
  description = "Approved AWS region. HID currently targets Ireland."
  type        = string
  default     = "eu-west-1"

  validation {
    condition     = var.aws_region == "eu-west-1"
    error_message = "The approved HID region is eu-west-1. Change this only after a documented residency decision."
  }
}

variable "expected_account_id" {
  description = "Expected AWS account ID; prevents plans against the wrong account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "expected_account_id must be a 12-digit AWS account ID."
  }
}

variable "environment" {
  type = string

  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "environment must be development, staging, or production."
  }
}

variable "staging_mode" {
  description = "Staging cost/capacity profile."
  type        = string
  default     = "sleep"

  validation {
    condition     = contains(["sleep", "economy", "fidelity"], var.staging_mode)
    error_message = "staging_mode must be sleep, economy, or fidelity."
  }
}

variable "availability_zones" {
  description = "Explicit AZ names: two for development/staging, three for production."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) >= 2 && length(var.availability_zones) <= 3 && length(distinct(var.availability_zones)) == length(var.availability_zones)
    error_message = "Provide two or three distinct availability zones."
  }
}

variable "public_subnet_cidrs" {
  type = list(string)
}

variable "application_subnet_cidrs" {
  type = list(string)
}

variable "database_subnet_cidrs" {
  type = list(string)
}

variable "root_domain_name" {
  type    = string
  default = "healthidentitydirectory.com"
}

variable "enable_database" {
  description = "Create PostgreSQL after the plan and migration design are approved."
  type        = bool
  default     = false
}

variable "enable_runtime" {
  description = "Create task definitions and ECS services after images and secret values exist."
  type        = bool
  default     = false
}

variable "enable_ingress" {
  description = "Create public/internal ALBs and WAF."
  type        = bool
  default     = false
}

variable "enable_backup_plan" {
  type    = bool
  default = false
}

variable "image_uris" {
  description = "Workload name to immutable ECR repository@sha256 URI."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for uri in values(var.image_uris) : can(regex(".+@sha256:[a-f0-9]{64}$", uri))])
    error_message = "Every image URI must be digest-qualified."
  }
}

variable "migration_image_uri" {
  type    = string
  default = ""

  validation {
    condition     = var.migration_image_uri == "" || can(regex(".+@sha256:[a-f0-9]{64}$", var.migration_image_uri))
    error_message = "migration_image_uri must be empty or digest-qualified."
  }
}

variable "regional_certificate_arn" {
  type    = string
  default = ""
}

variable "internal_certificate_arn" {
  type    = string
  default = ""
}

variable "cloudflare_origin_secret" {
  description = "Independent origin secret checked by AWS WAF. Stored in encrypted Terraform state."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = var.cloudflare_origin_secret == "" || length(var.cloudflare_origin_secret) >= 32
    error_message = "cloudflare_origin_secret must contain at least 32 characters."
  }
}

variable "rds_ca_bundle_base64" {
  type    = string
  default = ""
}

variable "workload_issuer_url" {
  type    = string
  default = ""
}

variable "workload_jwks_url" {
  type    = string
  default = ""
}

variable "workload_subjects" {
  description = "Service identity subjects used outside staging, keyed by identity, ehr, lab, pharmacy, ocr, and outreach."
  type        = map(string)
  default     = {}
}

variable "staging_novu_api_url" {
  type    = string
  default = "https://eu.api.novu.co"

  validation {
    condition     = contains(["https://api.novu.co", "https://eu.api.novu.co"], var.staging_novu_api_url)
    error_message = "Use an explicitly approved Novu endpoint."
  }
}

variable "alert_email" {
  type    = string
  default = ""
}

variable "enable_cost_governance" {
  description = "Create budgets only after checking existing account budgets."
  type        = bool
  default     = false
}

variable "cost_notification_email" {
  type    = string
  default = ""
}

variable "cost_notification_sns_arn" {
  type    = string
  default = ""
}

variable "monthly_cash_budget_usd" {
  type    = number
  default = 416.67
}

variable "monthly_gross_budget_usd" {
  type    = number
  default = 416.67
}

variable "cost_anomaly_threshold_usd" {
  type    = number
  default = 10
}
