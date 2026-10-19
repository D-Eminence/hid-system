variable "configuration_retired" {
  description = "Explicit fence for an environment file whose resource ownership has moved. A retired file cannot plan or apply."
  type        = bool
  default     = false
  validation {
    condition     = !var.configuration_retired
    error_message = "This environment configuration is retired. Permanent resources are owned by production; on-demand staging requires an independent namespace, state and test data."
  }
}

variable "promote_existing_staging" {
  description = "Adopt the existing staging resource identities and approved economy capacity for permanent production. Does not select or migrate Terraform state."
  type        = bool
  default     = false
}

variable "activate_production_runtime" {
  description = "Explicit cutover gate for production runtime identity, browser origins and API certificate during adoption. False preserves existing staging routes/runtime."
  type        = bool
  default     = false
}

variable "production_hosts" {
  description = "Owner-approved production hostnames by app: admin, web, ehr, lab, pharmacy, ocr, outreach, public and api. Empty until the URL layout is approved."
  type        = map(string)
  default     = {}
}

variable "production_api_certificate_arn" {
  description = "Verified ACM certificate for the production API hostname. Existing internal TLS remains bound to retained private DNS."
  type        = string
  default     = ""
}

variable "production_workload_token_agent_image_uri" {
  description = "Separately admitted immutable identity image containing the tested production-capable token agent. Required before runtime cutover."
  type        = string
  default     = ""
}

variable "promotion_state_lineage" {
  description = "Verified lineage of the single existing permanent stack; required for adoption. Never use an empty production state."
  type        = string
  default     = ""
}
variable "promotion_backend_key" {
  description = "Exact current backend key for adoption. Changed only by the guarded one-owner state migration."
  type        = string
  default     = "health-identity/staging/terraform.tfstate"
}
data "external" "production_ownership" {
  count   = var.promote_existing_staging ? 1 : 0
  program = ["python", "${path.module}/scripts/check-production-ownership.py"]
  query = {
    account     = var.expected_account_id
    lineage     = var.promotion_state_lineage
    backend_key = var.promotion_backend_key
  }
}

locals {
  resource_environment = var.promote_existing_staging ? "staging" : var.environment
  runtime_environment  = var.promote_existing_staging && !var.activate_production_runtime ? "staging" : var.environment
  production_app_names = toset(["admin", "web", "ehr", "lab", "pharmacy", "ocr", "outreach", "public", "api"])
  production_origins   = [for app, host in var.production_hosts : "https://${host}" if app != "api"]
  browser_origins = var.promote_existing_staging && var.activate_production_runtime ? local.production_origins : [
    for subdomain in local.browser_subdomains : "https://${subdomain}.${var.root_domain_name}"
  ]
  # Keep the current FAQ untouched during preparation. Only the coordinated
  # runtime cutover moves its public links to the approved production hosts.
  runtime_support_faqs = var.promote_existing_staging && var.activate_production_runtime ? {
    for name, faq in var.support_faqs : name => {
      utterances = faq.utterances
      answer = replace(replace(faq.answer,
        "https://www.staging.${var.root_domain_name}", "https://${try(var.production_hosts["public"], "")}"),
      "https://staging.${var.root_domain_name}", "https://${try(var.production_hosts["web"], "")}")
    }
  } : var.support_faqs
}

resource "terraform_data" "production_promotion_guard" {
  count = var.promote_existing_staging || var.activate_production_runtime ? 1 : 0
  input = {
    environment = var.environment
    active      = var.activate_production_runtime
  }
  lifecycle {
    # A production ownership marker cannot be removed by staging variables or destroy.
    prevent_destroy = true
    precondition {
      condition     = !var.promote_existing_staging || try(data.external.production_ownership[0].result.valid == "true", false)
      error_message = "Production adoption must use the verified existing state, database and cluster in the selected account. New, missing or mismatched state is rejected."
    }

    precondition {
      condition     = !var.promote_existing_staging || (var.environment == "production" && var.staging_mode == "sleep" && !var.staging_prelaunch_sizing && var.staging_worker_min_capacity == 1 && var.use_existing_secrets && var.enable_database && var.enable_runtime && var.enable_ingress && var.backup_retention_days >= 30)
      error_message = "Existing-stack promotion requires production, existing secrets, all current runtime/data gates, at least 30-day RDS backup retention, one worker per service, and no staging-only profile switches."
    }
    precondition {
      condition     = !var.activate_production_runtime || (var.promote_existing_staging && var.environment == "production")
      error_message = "Production cutover requires explicit existing-stack promotion."
    }
    precondition {
      condition = !var.activate_production_runtime || (
        startswith(var.production_workload_token_agent_image_uri, "${var.expected_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/staging/hid/identity-api@sha256:") &&
        can(regex("@sha256:[0-9a-f]{64}$", var.production_workload_token_agent_image_uri)) &&
        var.production_workload_token_agent_image_uri != var.workload_token_agent_image_uri
      )
      error_message = "Production cutover requires an admitted immutable image containing the production-capable token agent; the existing staging-only agent cannot be reused."
    }
    precondition {
      condition = !var.activate_production_runtime || (
        toset(keys(var.production_hosts)) == local.production_app_names &&
        length(distinct(values(var.production_hosts))) == length(local.production_app_names) &&
        alltrue([for host in values(var.production_hosts) :
          can(regex("^[a-z0-9]+([.-][a-z0-9]+)*$", host)) &&
          (host == var.root_domain_name || endswith(host, ".${var.root_domain_name}"))
        ]) &&
        startswith(var.production_api_certificate_arn, "arn:aws:acm:${var.aws_region}:${var.expected_account_id}:certificate/")
      )
      error_message = "Cutover requires all nine distinct approved production hostnames under the HID domain and a verified API certificate in this account/region."
    }
  }
}

output "deployment_environment_configuration" {
  description = "Logical deployment, retained resource identity, capacity and cutover status; contains no credential values."
  value = {
    environment              = var.environment
    resource_namespace       = local.resource_environment
    physical_tag_environment = local.resource_environment
    runtime_environment      = local.runtime_environment
    capacity_profile         = local.deployment_profile
    promotion                = var.promote_existing_staging
    cutover                  = var.activate_production_runtime
    browser_origins          = local.browser_origins
    production_hosts         = var.production_hosts
    application              = module.application.runtime_environment_configuration
  }
}
