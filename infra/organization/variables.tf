variable "aws_region" {
  type        = string
  description = "Approved home region (the Organizations API is global)."

  validation {
    condition     = var.aws_region == "eu-west-1"
    error_message = "The current HID home region is eu-west-1."
  }
}

variable "management_account_id" {
  type        = string
  description = "The AWS Organizations management account. AI services opt-out policies can only be created and attached from it."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.management_account_id))
    error_message = "management_account_id must be a 12-digit AWS account ID."
  }
}
