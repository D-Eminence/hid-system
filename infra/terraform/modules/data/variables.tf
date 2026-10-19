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
