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
variable "aws_account_id" {
  type = string
}
variable "aws_region" {
  type = string
}
variable "ecs_cluster_name" {
  type = string
}
variable "runtime_services" {
  type    = map(number)
  default = {}
}
variable "load_balancer_targets" {
  type    = map(object({ load_balancer = string, target_group = string }))
  default = {}
}
variable "notification_queue_names" {
  type    = map(string)
  default = {}
}
variable "provider_log_groups" {
  type    = map(string)
  default = {}
}
