variable "name_prefix" {
  type = string
}
variable "environment" {
  type = string
}
variable "enable_database" {
  type = bool
}
variable "database_arn" {
  type    = string
  default = null
}
variable "database_identifier" {
  type    = string
  default = null
}
variable "database_kms_key_arn" {
  type = string
}
variable "database_connection_budget" {
  type = number
}
variable "backup_retention_days" {
  type = number
}
variable "enable_backup_plan" {
  type = bool
}
variable "alert_email" {
  type = string
}
