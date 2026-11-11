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
variable "alert_subscribers" {
  description = "Extra people who receive every operational alert. Each entry is { protocol = \"email\" or \"sms\", endpoint = mailbox or E.164 phone number }. Set at apply time; never commit real addresses."
  type        = list(object({ protocol = string, endpoint = string }))
  default     = []
  validation {
    condition = alltrue([for subscriber in var.alert_subscribers : (
      (subscriber.protocol == "email" && can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", subscriber.endpoint))) ||
      (subscriber.protocol == "sms" && can(regex("^\\+[1-9][0-9]{7,14}$", subscriber.endpoint)))
    )])
    error_message = "Each alert subscriber must be an email (a mailbox address) or sms (a phone number in +<country><number> form, for example +2348000000000)."
  }
}
variable "notify_stopped_tasks" {
  description = "Send an alert when a service task stops because it crashed or failed its health checks."
  type        = bool
  default     = false
}
variable "ocr_worker_log_group" {
  description = "The OCR worker's log group; its queue-age, loop-error and source-deletion lines feed the OCR alarms. Null turns those alarms off."
  type        = string
  default     = null
}
