variable "name_prefix" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "endpoint_subnet_ids" {
  description = "Application subnets that hold the Bedrock runtime endpoint, one network interface each (USD 0.011 an hour per subnet)."
  type        = list(string)

  validation {
    condition     = length(var.endpoint_subnet_ids) > 0
    error_message = "The Bedrock runtime endpoint needs at least one application subnet."
  }
}

variable "enable_runtime" {
  type = bool
}

variable "ehr_security_group_id" {
  description = "Security group of the EHR API workload, when runtime is enabled."
  type        = string
}

variable "ehr_task_role_arn" {
  type = string
}

variable "ehr_task_role_name" {
  type = string
}

variable "allow_eu_processing" {
  description = "Explicit approval for Sonnet requests to be processed in other EU AWS regions."
  type        = bool
}

variable "enable_bedrock_generation" {
  description = "Disable when generation moves to the direct Claude API; Titan remains enabled."
  type        = bool
  default     = true
}
