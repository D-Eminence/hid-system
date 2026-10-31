variable "name_prefix" {
  type = string
}

variable "environment" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "database_subnet_ids" {
  type = list(string)
}

variable "database_instance_class" {
  type = string
}

variable "database_allocated_storage" {
  type = number
}

variable "database_max_storage" {
  type = number
}

variable "database_multi_az" {
  type = bool
}

variable "database_deletion_protection" {
  type = bool
}

variable "database_backup_retention" {
  type = number
}

variable "security_log_retention_days" {
  type = number
}

variable "enable_database" {
  type = bool
}

variable "database_workload_names" {
  type = list(string)
}

variable "use_existing_secrets" {
  description = "Reference pre-existing staging secret containers without managing or changing them."
  type        = bool
  default     = false
}

variable "document_upload_origins" {
  description = "Browser origins whose pages upload documents straight to the documents bucket with presigned PUT links. Empty adds no CORS rule."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for origin in var.document_upload_origins : can(regex("^https://[a-z0-9]+([.-][a-z0-9]+)*$", origin))])
    error_message = "Each document upload origin must be an exact https origin: no wildcard, path or port."
  }
}
