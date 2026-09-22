variable "aws_region" {
  description = "Approved AWS region for this environment. Confirm data residency before applying."
  type        = string
}

variable "expected_account_id" {
  description = "Expected 12-digit AWS account ID; prevents applying to the wrong account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "expected_account_id must be a 12-digit AWS account ID."
  }
}

variable "environment" {
  description = "Environment name. Use a separate state and variables for each environment."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging, or prod."
  }
}

variable "vpc_cidr" {
  description = "VPC CIDR. Choose non-overlapping ranges across environments."
  type        = string
}

variable "az_suffixes" {
  description = "Two availability-zone suffixes in the selected region."
  type        = list(string)
  default     = ["a", "b"]

  validation {
    condition     = length(var.az_suffixes) == 2 && length(distinct(var.az_suffixes)) == 2
    error_message = "Provide two distinct availability-zone suffixes."
  }
}

variable "public_subnet_cidrs" {
  type        = list(string)
  description = "Two public subnet CIDRs, one per AZ."
}

variable "app_subnet_cidrs" {
  type        = list(string)
  description = "Two private application subnet CIDRs, one per AZ."
}

variable "data_subnet_cidrs" {
  type        = list(string)
  description = "Two isolated database subnet CIDRs, one per AZ."
}

variable "enable_nat" {
  description = "Enable private application egress. Dev/staging use one NAT; production uses one NAT per AZ."
  type        = bool
  default     = false
}

variable "enable_database" {
  description = "Provision the PostgreSQL database after sizing and migration design are approved."
  type        = bool
  default     = false
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "db_backup_retention_days" {
  type    = number
  default = 7
}

variable "enable_application" {
  description = "Deploy the HTTPS load balancer, WAF, ECS task, and ECS service once an application image is available."
  type        = bool
  default     = false
}

variable "application_image" {
  description = "Immutable application image URI, preferably an ECR image digest."
  type        = string
  default     = ""
}

variable "application_port" {
  type    = number
  default = 8080
}

variable "health_check_path" {
  type    = string
  default = "/health"
}

variable "acm_certificate_arn" {
  description = "ACM certificate for the origin HTTPS listener."
  type        = string
  default     = ""
}

variable "origin_cidrs" {
  description = "Approved Cloudflare origin source CIDRs. Required before enabling the public ALB."
  type        = list(string)
  default     = []
}

variable "desired_task_count" {
  type    = number
  default = 1
}

variable "task_cpu" {
  type    = number
  default = 512
}

variable "task_memory" {
  type    = number
  default = 1024
}

variable "application_secret_arns" {
  description = "Environment variable name to existing Secrets Manager secret ARN. Never put secret values in tfvars."
  type        = map(string)
  default     = {}
}

variable "enable_provider_api" {
  description = "Expose the provider integration API after a JWT issuer, audience, and backend route are agreed."
  type        = bool
  default     = false
}

variable "provider_jwt_issuer" {
  type    = string
  default = ""
}

variable "provider_jwt_audience" {
  type    = list(string)
  default = []
}

variable "origin_server_name" {
  description = "Hostname on the ALB certificate used by API Gateway for private HTTPS verification."
  type        = string
  default     = ""
}

variable "enable_opensearch" {
  description = "Provision the private OpenSearch domain after sizing and retrieval design are approved."
  type        = bool
  default     = false
}

variable "opensearch_engine_version" {
  type    = string
  default = "OpenSearch_2.19"
}

variable "opensearch_instance_type" {
  type    = string
  default = "t3.small.search"
}

variable "bedrock_model_arns" {
  description = "Approved Bedrock model ARNs the app task may invoke; empty disables model permissions."
  type        = list(string)
  default     = []
}

variable "enable_account_trail" {
  description = "Create one account-wide CloudTrail trail from the chosen home-region stack only."
  type        = bool
  default     = false
}
