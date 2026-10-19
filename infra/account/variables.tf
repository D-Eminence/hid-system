variable "aws_region" {
  type        = string
  description = "Approved home region for the audit bucket and trail."

  validation {
    condition     = var.aws_region == "eu-west-1"
    error_message = "The current HID home region is eu-west-1."
  }
}

variable "expected_account_id" {
  type        = string
  description = "AWS account that owns the trail."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "expected_account_id must be a 12-digit AWS account ID."
  }
}

variable "alert_email" {
  type        = string
  description = "Security operations mailbox for CloudTrail configuration change alerts. The recipient must confirm the SNS subscription."

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be a mailbox address."
  }
}

variable "clinical_bucket_names" {
  type        = set(string)
  default     = []
  description = "Exact clinical S3 bucket names from the regional environment outputs. Add each after it exists; object data events incur charges."

  validation {
    condition = alltrue([
      for name in var.clinical_bucket_names : can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", name))
    ])
    error_message = "Every clinical_bucket_names entry must be an S3 bucket name."
  }
}

variable "audit_log_retention_days" {
  type        = number
  default     = 1096
  description = "Initial three-year CloudTrail S3 lifecycle baseline. 1096 days covers a leap day; review with the final retention policy."

  validation {
    condition     = var.audit_log_retention_days >= 1 && floor(var.audit_log_retention_days) == var.audit_log_retention_days
    error_message = "audit_log_retention_days must be a positive whole number."
  }
}
