variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "data_subnet_ids" { type = list(string) }
variable "enable_database" { type = bool }
variable "db_instance_class" { type = string }
variable "db_allocated_storage_gb" { type = number }
variable "db_backup_retention_days" { type = number }
