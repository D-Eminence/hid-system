variable "aws_region" {
  type        = string
  description = "Trail home Region and audit bucket Region."
}

variable "expected_account_id" {
  type        = string
  description = "Account whose AWS API activity is audited."
}

variable "alert_email" {
  type        = string
  description = "Security operations mailbox subscribed to trail-change alerts."
}

variable "clinical_bucket_names" {
  type        = set(string)
  default     = []
  description = "Exact clinical S3 buckets for object read and write events."
}

variable "audit_log_retention_days" {
  type        = number
  default     = 1096
  description = "Days before CloudTrail S3 log objects expire under the provisional audit retention baseline."
}
