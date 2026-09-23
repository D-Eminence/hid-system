variable "name_prefix" { type = string }
variable "environment" { type = string }
variable "deployment_profile" { type = string }
variable "aws_region" { type = string }
variable "root_domain_name" { type = string }
variable "browser_subdomains" { type = list(string) }
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
variable "desired_counts" { type = map(number) }
variable "scaling_ceilings" { type = map(number) }
variable "enable_runtime" { type = bool }
variable "enable_ingress" { type = bool }
variable "enable_autoscaling" { type = bool }
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "application_subnet_ids" { type = list(string) }
variable "endpoint_security_group_id" { type = string }
variable "s3_prefix_list_id" { type = string }
variable "database_security_group_id" { type = string }
variable "database_enabled" { type = bool }
variable "document_bucket_arn" { type = string }
variable "document_kms_key_arn" { type = string }
variable "database_kms_key_arn" { type = string }
variable "runtime_secret_arns" { type = map(string) }
variable "database_secret_arns" { type = map(string) }
variable "migration_database_secret_arn" { type = string }
variable "event_bus_arn" { type = string }
variable "notification_queue_arn" { type = string }
variable "notification_queue_url" { type = string }
variable "image_uris" { type = map(string) }
variable "migration_image_uri" { type = string }
variable "regional_certificate_arn" { type = string }
variable "internal_certificate_arn" { type = string }
variable "cloudflare_origin_secret" {
  type      = string
  sensitive = true
}
variable "rds_ca_bundle_base64" { type = string }
variable "workload_issuer_url" { type = string }
variable "workload_jwks_url" { type = string }
variable "workload_subjects" { type = map(string) }
variable "staging_novu_api_url" { type = string }
variable "log_retention_days" { type = number }
variable "repository_image_count" { type = number }
variable "alarm_topic_arn" { type = string }
