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
  description = "Browser origins whose pages upload documents to the documents bucket with presigned PUT links and read them back with presigned GET links. Empty adds no CORS rule."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for origin in var.document_upload_origins : can(regex("^https://[a-z0-9]+([.-][a-z0-9]+)*$", origin))])
    error_message = "Each document upload origin must be an exact https origin: no wildcard, path or port."
  }
}

variable "enable_document_malware_protection" {
  description = "Create the GuardDuty Malware Protection for S3 plan on clinical/objects/ of the documents bucket, its role, and the bucket's EventBridge notification. Off creates nothing."
  type        = bool
  default     = false
}

variable "document_scan_enforce_tags" {
  description = "Stage 5, only after the backfill: deny reads of clinical objects not tagged NO_THREATS_FOUND (except GuardDuty and the exempt roles), deny reads of THREATS_FOUND objects (except GuardDuty), and deny scan-tag writes and tagged uploads by anyone else."
  type        = bool
  default     = false
}

variable "document_scan_read_exempt_role_arns" {
  description = "IAM role ARNs that may still read clinical objects GuardDuty has not tagged clean while document_scan_enforce_tags is on: the ehr-api task role (upload completion and the media-type sniff)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for arn in var.document_scan_read_exempt_role_arns : can(regex("^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_-]+$", arn))])
    error_message = "Each exempt ARN must be an IAM role ARN without a path."
  }
}
