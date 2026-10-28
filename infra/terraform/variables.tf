variable "aws_region" {
  description = "Approved AWS region. HID currently targets Ireland."
  type        = string
  default     = "eu-west-1"

  validation {
    condition     = var.aws_region == "eu-west-1"
    error_message = "The approved HID region is eu-west-1. Change this only after a documented residency decision."
  }
}

variable "expected_account_id" {
  description = "Expected AWS account ID; prevents plans against the wrong account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "expected_account_id must be a 12-digit AWS account ID."
  }
}

variable "environment" {
  type = string

  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "environment must be development, staging, or production."
  }
}

variable "staging_mode" {
  description = "Staging cost/capacity profile."
  type        = string
  default     = "sleep"

  validation {
    condition     = contains(["sleep", "economy", "fidelity"], var.staging_mode)
    error_message = "staging_mode must be sleep, economy, or fidelity."
  }
}

variable "staging_prelaunch_sizing" {
  description = "Opt in to measured pre-launch task sizes for staging economy only."
  type        = bool
  default     = false
}

variable "staging_worker_min_capacity" {
  description = "Keep one worker per staging service running during connected acceptance; zero retains the economy default."
  type        = number
  default     = 0

  validation {
    condition     = contains([0, 1], var.staging_worker_min_capacity)
    error_message = "staging_worker_min_capacity must be zero or one."
  }
}

variable "availability_zones" {
  description = "Explicit AZ names: two for development/staging, three for production."
  type        = list(string)

  validation {
    condition = (
      length(var.availability_zones) >= 2 &&
      length(var.availability_zones) <= 3 &&
      length(distinct(var.availability_zones)) == length(var.availability_zones)
    )
    error_message = "Provide two or three distinct availability zones."
  }
}

variable "public_subnet_cidrs" {
  type = list(string)
}

variable "application_subnet_cidrs" {
  type = list(string)
}

variable "database_subnet_cidrs" {
  type = list(string)
}

variable "root_domain_name" {
  type    = string
  default = "healthidentitydirectory.com"
}

variable "enable_database" {
  description = "Create PostgreSQL after the plan and migration design are approved."
  type        = bool
  default     = false
}

variable "use_existing_secrets" {
  description = "Reference the pre-existing staging secret containers without managing their lifecycle."
  type        = bool
  default     = false
}

variable "enable_runtime" {
  description = "Create task definitions and ECS services after images and secret values exist."
  type        = bool
  default     = false
}

variable "enable_migration_task" {
  description = "Create the one-shot database schema migration task before the application runtime."
  type        = bool
  default     = false
}

variable "enable_ingress" {
  description = "Create public/internal ALBs and WAF."
  type        = bool
  default     = false
}

variable "enable_backup_plan" {
  type    = bool
  default = false
}

variable "backup_retention_days" {
  type        = number
  default     = 30
  description = "Rolling retention for RDS automated backups and the optional AWS Backup plan."

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35 && floor(var.backup_retention_days) == var.backup_retention_days
    error_message = "backup_retention_days must be a whole number from 1 to 35 for RDS."
  }
}

variable "application_log_retention_days" {
  type        = number
  default     = 90
  description = "CloudWatch retention for ECS application and migration technical logs."

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.application_log_retention_days)
    error_message = "application_log_retention_days must be an AWS CloudWatch Logs retention value."
  }
}

variable "security_log_retention_days" {
  type        = number
  default     = 365
  description = "CloudWatch retention for identity and infrastructure authentication logs."

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.security_log_retention_days)
    error_message = "security_log_retention_days must be an AWS CloudWatch Logs retention value."
  }
}

variable "enable_ai" {
  description = "Give the EHR API private Bedrock access for patient-record chat. Requires enable_database."
  type        = bool
  default     = false
}

variable "ai_allow_eu_processing" {
  description = "Set only after approval to process Sonnet 4.6 prompts across EU AWS regions."
  type        = bool
  default     = false
}

variable "ai_generation_provider" {
  description = "Generation transport; select anthropic only with its approved credential/configuration and new EHR image."
  type        = string
  default     = "bedrock"
  validation {
    condition     = contains(["bedrock", "anthropic"], var.ai_generation_provider)
    error_message = "Generation provider must be bedrock or anthropic."
  }
}

variable "anthropic_model_id" {
  type    = string
  default = "claude-sonnet-4-6"
  validation {
    condition     = can(regex("^claude-[a-z0-9-]+$", var.anthropic_model_id))
    error_message = "Use a first-party Claude model ID, not a Bedrock inference profile."
  }
}

variable "anthropic_secret_arn" {
  description = "Existing server-only Anthropic credential secret ARN; no key value enters Terraform."
  type        = string
  default     = ""
}

variable "anthropic_secret_json_key" {
  type    = string
  default = "apiKey"
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]+$", var.anthropic_secret_json_key))
    error_message = "Use an explicit simple JSON key for the Anthropic credential."
  }
}

variable "anthropic_secret_kms_key_arn" {
  type    = string
  default = ""
}

variable "ai_allow_anthropic_us_processing" {
  description = "Explicit HID approval for US processing/storage of staging chat through the direct Claude API."
  type        = bool
  default     = false
}

variable "enable_support_bot" {
  description = "Create the Lex support bot and support API workload after FAQ text is approved."
  type        = bool
  default     = false
}

variable "support_faqs" {
  description = "Approved non-clinical support intents with sample questions and responses."
  type = map(object({
    utterances = list(string)
    answer     = string
  }))
  default = {}

  validation {
    condition = length(var.support_faqs) <= 40 && alltrue([for name, faq in var.support_faqs :
      can(regex("^[A-Za-z][A-Za-z0-9_]{1,49}$", name)) && !contains(["Fallback", "FallbackIntent"], name) &&
      length(faq.utterances) >= 2 && length(faq.utterances) <= 10 &&
      alltrue([for utterance in faq.utterances : length(trimspace(utterance)) >= 3 && length(utterance) <= 200]) &&
      length(trimspace(faq.answer)) >= 10 && length(faq.answer) <= 1000
    ])
    error_message = "Each FAQ needs a valid intent name, two sample questions, and an answer of at least ten characters."
  }
}

variable "enable_deployment_automation" {
  description = "Create environment-scoped release resources; deployment stays behind GitHub approval and an explicit enable flag."
  type        = bool
  default     = false
}

variable "production_deployment_approval_mode" {
  description = "Production release policy; protected requires reviewers, automatic requires successful candidate checks and exact branch admission."
  type        = string
  default     = "protected"
  validation {
    condition     = contains(["automatic", "protected"], var.production_deployment_approval_mode)
    error_message = "Production approval mode must be automatic or protected."
  }
}

variable "enforce_release_index" {
  description = "Require the bootstrapped verified release index and shared lease for automation-managed Terraform operations."
  type        = bool
  default     = false
}

variable "deployment_automation_bootstrap" {
  description = "Explicit first-install exception before the verified release index exists; never use for ordinary infrastructure updates."
  type        = bool
  default     = false
}

variable "release_index_version_id" {
  type    = string
  default = ""
}

variable "release_index_sha256" {
  type    = string
  default = ""
}

variable "release_lease_holder" {
  type    = string
  default = ""
}

variable "release_lease_generation" {
  type    = string
  default = ""
}

variable "support_contact" {
  description = "Approved public escalation mailto or HTTPS address; test recipients are not automatically support contacts."
  type        = string
  default     = ""
  validation {
    condition     = var.support_contact == "" || (length(var.support_contact) <= 200 && can(regex("^(mailto:[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}|https://[A-Za-z0-9.-]+(/[A-Za-z0-9/_-]*)?)$", var.support_contact)))
    error_message = "Support contact must be a reviewed mailto address or HTTPS support URL."
  }
}

variable "image_uris" {
  description = "Workload name to immutable ECR repository@sha256 URI."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for uri in values(var.image_uris) : can(regex(".+@sha256:[a-f0-9]{64}$", uri))])
    error_message = "Every image URI must be digest-qualified."
  }
}

variable "workload_token_agent_image_uri" {
  description = "Optional separate immutable image pin for the unchanged workload-token sidecar."
  type        = string
  default     = ""

  validation {
    condition     = var.workload_token_agent_image_uri == "" || can(regex(".+@sha256:[a-f0-9]{64}$", var.workload_token_agent_image_uri))
    error_message = "workload_token_agent_image_uri must be empty or digest-qualified."
  }
}

variable "migration_image_uri" {
  type    = string
  default = ""

  validation {
    condition     = var.migration_image_uri == "" || can(regex(".+@sha256:[a-f0-9]{64}$", var.migration_image_uri))
    error_message = "migration_image_uri must be empty or digest-qualified."
  }
}

variable "migration_source_bucket_arn" {
  type    = string
  default = ""
}

variable "migration_source_kms_key_arn" {
  type    = string
  default = ""
}

variable "regional_certificate_arn" {
  type    = string
  default = ""
}

variable "internal_certificate_arn" {
  type    = string
  default = ""
}

variable "cloudflare_origin_secret" {
  description = "Independent origin secret checked by AWS WAF. Stored in encrypted Terraform state."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = var.cloudflare_origin_secret == "" || length(var.cloudflare_origin_secret) >= 32
    error_message = "cloudflare_origin_secret must contain at least 32 characters."
  }
}

variable "rds_ca_bundle_base64" {
  type    = string
  default = ""
}

variable "workload_issuer_url" {
  type    = string
  default = ""
}

variable "workload_jwks_url" {
  type    = string
  default = ""
}

variable "workload_subjects" {
  description = "Development service identity subjects, keyed by identity, ehr, lab, pharmacy, ocr, and outreach. Staging and production create their own issuer and subjects."
  type        = map(string)
  default     = {}
}

variable "google_oidc_client_ids" {
  description = "Public Google web client IDs accepted by Identity; configure matching frontend IDs and allowed origins."
  type        = list(string)
  default     = []
  validation {
    condition = length(distinct(var.google_oidc_client_ids)) == length(var.google_oidc_client_ids) && alltrue([
      for id in var.google_oidc_client_ids : can(regex("^[A-Za-z0-9._-]+\\.apps\\.googleusercontent\\.com$", id))
    ])
    error_message = "Google web client IDs must be unique and use the Google OAuth client ID format."
  }
}

variable "qoreid_enabled" {
  type    = bool
  default = false
}

variable "qoreid_nin_only_enrollment_enabled" {
  description = "Enable only after the entitled NIN-only contract and legacy NIN inventory are accepted."
  type        = bool
  default     = false
}

variable "qoreid_secret_arn" {
  description = "Existing secret containing clientId and secret. Terraform never stores their values."
  type        = string
  default     = ""
  validation {
    condition     = var.qoreid_secret_arn == "" || can(regex("^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:", var.qoreid_secret_arn))
    error_message = "Supply a Secrets Manager ARN, not QoreID credentials."
  }
}

variable "notification_delivery_profile" {
  description = "Enabled delivery channels: email-only, email-brevo, email-sms-brevo, or full including WhatsApp. Empty selects the environment default."
  type        = string
  default     = ""
  validation {
    condition     = contains(["", "full", "email-only", "email-brevo", "email-sms-brevo"], var.notification_delivery_profile)
    error_message = "Choose full, email-only, email-brevo, email-sms-brevo, or the environment default."
  }
}

variable "qoreid_secret_kms_key_arn" {
  description = "Customer managed KMS key for the QoreID secret, if used; empty for the AWS managed Secrets Manager key."
  type        = string
  default     = ""
  validation {
    condition     = var.qoreid_secret_kms_key_arn == "" || can(regex("^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]+$", var.qoreid_secret_kms_key_arn))
    error_message = "Supply a KMS key ARN, not an alias or secret value."
  }
}

variable "staging_novu_api_url" {
  description = "API endpoint for HID's existing Novu staging environment; select its actual region before enabling runtime."
  type        = string
  default     = ""

  validation {
    condition     = var.staging_novu_api_url == "" || contains(["https://api.novu.co", "https://eu.api.novu.co"], var.staging_novu_api_url)
    error_message = "Use the endpoint for HID's existing Novu environment."
  }
}

variable "emergency_contact_notification_enabled" {
  description = "Let notification-api send emergency-contact verification codes and emergency-access alerts (EMERGENCY_CONTACT_DELIVERY_ENABLED). Switch on before, and off after, emergency_contact_delivery_enabled."
  type        = bool
  default     = false
}

variable "emergency_contact_delivery_enabled" {
  description = "Let identity-api accept emergency contacts, send their verification codes and dispatch emergency-access alerts (EMERGENCY_CONTACT_DELIVERY_ENABLED). Requires emergency_contact_notification_enabled."
  type        = bool
  default     = false
}

variable "emergency_contact_dispatch_seconds" {
  description = "Seconds between identity-api emergency-access alert dispatch runs (PATIENT_LIFECYCLE_SWEEP_SECONDS); used only while emergency_contact_delivery_enabled."
  type        = number
  default     = 60

  validation {
    condition     = var.emergency_contact_dispatch_seconds >= 1 && var.emergency_contact_dispatch_seconds <= 3600 && floor(var.emergency_contact_dispatch_seconds) == var.emergency_contact_dispatch_seconds
    error_message = "emergency_contact_dispatch_seconds must be a whole number from 1 to 3600."
  }
}

variable "emergency_contact_pilot_account_ids" {
  description = "Patient account UUIDs, at most 20, that alone may use emergency contacts while identity delivery is on (EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS). Empty means every patient."
  type        = list(string)
  default     = []

  validation {
    condition = (
      length(var.emergency_contact_pilot_account_ids) <= 20 &&
      length(distinct([for id in var.emergency_contact_pilot_account_ids : lower(id)])) == length(var.emergency_contact_pilot_account_ids) &&
      alltrue([for id in var.emergency_contact_pilot_account_ids :
        can(regex("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$", id))
      ])
    )
    error_message = "emergency_contact_pilot_account_ids must be at most 20 unique patient account UUIDs."
  }
}

variable "web_push_enabled" {
  description = "Turn on patient web push (B6): WEB_PUSH_VAPID_PUBLIC_KEY and WEB_PUSH_SUBJECT on identity-api and notification-api, and WEB_PUSH_VAPID_PRIVATE_KEY (notification-provider secret key webPushVapidPrivateKey) on notification-api only. Store the private key first: a missing key stops notification-api's new tasks from starting."
  type        = bool
  default     = false
}

variable "web_push_vapid_public_key" {
  description = "VAPID public key (87 base64url characters) whose private half is webPushVapidPrivateKey in the notification-provider secret. Required while web_push_enabled; never the private key."
  type        = string
  default     = ""

  validation {
    condition     = var.web_push_vapid_public_key == "" || can(regex("^[A-Za-z0-9_-]{87}$", var.web_push_vapid_public_key))
    error_message = "web_push_vapid_public_key must be empty or the 87-character base64url VAPID public key."
  }
}

variable "web_push_subject" {
  description = "VAPID subject the push services may contact (WEB_PUSH_SUBJECT): mailto: and an address, or an https URL."
  type        = string
  default     = "mailto:support@healthidentitydirectory.com"

  validation {
    condition = length(var.web_push_subject) <= 256 && (
      can(regex("^mailto:[^@/?#\\s]+@[^@/?#\\s]+\\.[^@/?#\\s]+$", var.web_push_subject)) ||
      can(regex("^https://[^/?#@\\s]+(/\\S*)?$", var.web_push_subject))
    )
    error_message = "web_push_subject must be mailto: and an address, or an https URL with a host, at most 256 characters."
  }
}

variable "alert_email" {
  type    = string
  default = ""
}

variable "enable_cost_governance" {
  description = "Create budgets only after checking existing account budgets."
  type        = bool
  default     = false
}

variable "cost_notification_email" {
  type    = string
  default = ""
}

variable "cost_notification_sns_arn" {
  type    = string
  default = ""
}

variable "monthly_cash_budget_usd" {
  type    = number
  default = 416.67
}

variable "monthly_gross_budget_usd" {
  type    = number
  default = 416.67
}

variable "cost_anomaly_threshold_usd" {
  type    = number
  default = 10
}
