# 1. Network boundary shared by all regional resources.
module "network" {
  source = "./modules/network"

  name_prefix                 = local.name_prefix
  vpc_cidr                    = local.profile.vpc_cidr
  availability_zones          = var.availability_zones
  public_subnet_cidrs         = var.public_subnet_cidrs
  application_subnet_cidrs    = var.application_subnet_cidrs
  database_subnet_cidrs       = var.database_subnet_cidrs
  nat_gateway_count           = local.profile.nat_gateway_count
  interface_endpoint_services = local.profile.interface_endpoint_services
  interface_endpoint_az_count = local.profile.interface_endpoint_az_count
}

# 2. Persistent storage, encryption keys, secrets, and optional PostgreSQL.
module "data" {
  source = "./modules/data"

  name_prefix                  = local.name_prefix
  environment                  = local.resource_environment
  vpc_id                       = module.network.vpc_id
  database_subnet_ids          = module.network.database_subnet_ids
  database_instance_class      = local.profile.database_instance_class
  database_allocated_storage   = local.profile.database_allocated_storage
  database_max_storage         = local.profile.database_max_storage
  database_multi_az            = local.profile.database_multi_az
  database_deletion_protection = local.profile.database_deletion_protection
  database_backup_retention    = var.backup_retention_days
  security_log_retention_days  = var.security_log_retention_days
  enable_database              = var.enable_database
  database_workload_names      = local.database_workload_names
  use_existing_secrets         = var.use_existing_secrets
  document_upload_origins      = local.document_upload_origins
}

# 3. Asynchronous domain events and notification delivery.
module "messaging" {
  source = "./modules/messaging"

  name_prefix             = local.name_prefix
  environment             = local.resource_environment
  queue_kms_key_arn       = module.data.queue_kms_key_arn
  include_emergency_event = local.resource_environment == "staging"
}

# 4. Container registries, ECS runtime, service networking, and ingress.
module "support_bot" {
  count  = var.enable_support_bot ? 1 : 0
  source = "./modules/support-bot"

  name_prefix     = local.name_prefix
  faqs            = local.runtime_support_faqs
  support_contact = var.support_contact
  partner_apn_id  = local.partner_apn_id
}

module "application" {
  source                         = "./modules/application"
  deployment_release_environment = var.promote_existing_staging ? "production" : (var.environment == "production" ? "production" : "staging")
  deployment_release_valid = !var.enforce_release_index || try(
    data.external.release_state[0].result.valid == "true" &&
    tomap(jsondecode(data.external.release_state[0].result.image_uris)) == var.image_uris &&
  data.external.release_state[0].result.migration_image_uri == var.migration_image_uri, false)

  # Prepare the repository independently of Lex/content/runtime activation.
  # The support image can be published before its digest is required by ECS.
  registry_workload_names = ["support-api"]

  name_prefix                         = local.name_prefix
  environment                         = local.resource_environment
  ecs_migration_phase                 = var.ecs_migration_phase
  runtime_environment                 = local.runtime_environment
  browser_origins                     = local.browser_origins
  deployment_profile                  = local.deployment_profile
  aws_region                          = var.aws_region
  root_domain_name                    = var.root_domain_name
  browser_subdomains                  = local.browser_subdomains
  workloads                           = local.workloads
  desired_counts                      = local.desired_counts
  scaling_ceilings                    = local.scaling_ceilings
  enable_runtime                      = var.enable_runtime
  enable_migration_task               = var.enable_migration_task
  enable_ingress                      = var.enable_ingress
  enable_autoscaling                  = local.profile.enable_autoscaling
  vpc_id                              = module.network.vpc_id
  vpc_cidr                            = local.profile.vpc_cidr
  public_subnet_ids                   = module.network.public_subnet_ids
  application_subnet_ids              = module.network.application_subnet_ids
  endpoint_security_group_id          = module.network.endpoint_security_group_id
  s3_prefix_list_id                   = module.network.s3_prefix_list_id
  database_security_group_id          = module.data.database_security_group_id
  database_enabled                    = var.enable_database
  database_endpoint                   = module.data.database_endpoint
  database_master_secret_arn          = module.data.database_master_secret_arn
  document_bucket_arn                 = module.data.document_bucket_arn
  document_kms_key_arn                = module.data.document_kms_key_arn
  database_kms_key_arn                = module.data.database_kms_key_arn
  runtime_secret_arns                 = module.data.runtime_secret_arns
  database_secret_arns                = module.data.database_secret_arns
  event_bus_arn                       = module.messaging.event_bus_arn
  notification_queue_arn              = module.messaging.notification_queue_arn
  notification_queue_kms_key_arn      = module.data.queue_kms_key_arn
  notification_queue_url              = module.messaging.notification_queue_url
  image_uris                          = var.image_uris
  workload_token_agent_image_uri      = var.activate_production_runtime ? var.production_workload_token_agent_image_uri : var.workload_token_agent_image_uri
  migration_image_uri                 = var.migration_image_uri
  migration_source_bucket_arn         = var.migration_source_bucket_arn
  migration_source_kms_key_arn        = var.migration_source_kms_key_arn
  regional_certificate_arn            = var.activate_production_runtime ? var.production_api_certificate_arn : var.regional_certificate_arn
  internal_certificate_arn            = var.internal_certificate_arn
  cloudflare_origin_secret            = var.cloudflare_origin_secret
  rds_ca_bundle_base64                = var.rds_ca_bundle_base64
  workload_issuer_url                 = var.workload_issuer_url
  workload_jwks_url                   = var.workload_jwks_url
  workload_subjects                   = var.workload_subjects
  staging_novu_api_url                = var.staging_novu_api_url
  google_oidc_client_ids              = var.google_oidc_client_ids
  qoreid_enabled                      = var.qoreid_enabled
  qoreid_nin_only_enrollment_enabled  = var.qoreid_nin_only_enrollment_enabled
  qoreid_secret_arn                   = var.qoreid_secret_arn
  qoreid_secret_kms_key_arn           = var.qoreid_secret_kms_key_arn
  notification_delivery_profile       = var.notification_delivery_profile
  enable_ai                           = var.enable_ai
  ai_allow_eu_processing              = var.ai_allow_eu_processing
  ai_generation_provider              = var.ai_generation_provider
  anthropic_model_id                  = var.anthropic_model_id
  anthropic_secret_arn                = var.anthropic_secret_arn
  anthropic_secret_json_key           = var.anthropic_secret_json_key
  anthropic_secret_kms_key_arn        = var.anthropic_secret_kms_key_arn
  ai_allow_anthropic_us_processing    = var.ai_allow_anthropic_us_processing
  enable_support_bot                  = var.enable_support_bot
  support_bot_id                      = var.enable_support_bot ? module.support_bot[0].bot_id : ""
  support_bot_alias_id                = var.enable_support_bot ? module.support_bot[0].alias_id : ""
  support_bot_alias_arn               = var.enable_support_bot ? module.support_bot[0].alias_arn : ""
  support_contact                     = var.support_contact
  application_log_retention_days      = var.application_log_retention_days
  security_log_retention_days         = var.security_log_retention_days
  repository_image_count              = local.profile.repository_image_count
  alarm_topic_arn                     = module.operations.alert_topic_arn
  enable_deployment_automation        = var.enable_deployment_automation
  production_deployment_approval_mode = var.production_deployment_approval_mode
  deployment_account_id               = var.expected_account_id
  deployment_alert_kms_key_arn        = module.operations.alert_topic_kms_key_arn

  # Emergency-contact delivery. Each switch adds its keys only while on.
  emergency_contact_notification_enabled = var.emergency_contact_notification_enabled
  emergency_contact_delivery_enabled     = var.emergency_contact_delivery_enabled
  emergency_contact_dispatch_seconds     = var.emergency_contact_dispatch_seconds
  emergency_contact_pilot_account_ids    = var.emergency_contact_pilot_account_ids

  # Patient web push (B6). Adds its keys and secret only while on.
  web_push_enabled          = var.web_push_enabled
  web_push_vapid_public_key = var.web_push_vapid_public_key
  web_push_subject          = var.web_push_subject
}

# 5. Private Bedrock access for the EHR patient-record chat.
module "ai" {
  count  = var.enable_ai ? 1 : 0
  source = "./modules/ai"

  name_prefix               = local.name_prefix
  aws_region                = var.aws_region
  vpc_id                    = module.network.vpc_id
  application_subnet_ids    = module.network.application_subnet_ids
  enable_runtime            = var.enable_runtime
  ehr_security_group_id     = module.application.ehr_security_group_id
  ehr_task_role_arn         = module.application.ehr_task_role_arn
  ehr_task_role_name        = module.application.ehr_task_role_name
  allow_eu_processing       = var.ai_allow_eu_processing
  enable_bedrock_generation = var.ai_generation_provider == "bedrock"
}

# 6. Shared alerts and optional database backups.
module "operations" {
  source = "./modules/operations"

  name_prefix                = local.name_prefix
  environment                = local.resource_environment
  enable_database            = var.enable_database
  database_arn               = module.data.database_arn
  database_identifier        = module.data.database_identifier
  database_kms_key_arn       = module.data.database_kms_key_arn
  database_connection_budget = local.profile.database_connection_budget
  backup_retention_days      = var.backup_retention_days
  enable_backup_plan         = var.enable_backup_plan
  alert_email                = var.alert_email
  aws_account_id             = var.expected_account_id
  aws_region                 = var.aws_region
  ecs_cluster_name           = module.application.ecs_migration_configuration.cluster
  runtime_services           = var.enable_runtime ? { for name, count in local.desired_counts : "${module.application.ecs_migration_configuration.cluster}-${name}" => count if count > 0 } : {}
  load_balancer_targets      = module.application.operational_target_dimensions
  notification_queue_names   = var.enable_runtime ? module.messaging.queue_names : {}
  provider_log_groups        = module.application.provider_log_groups
}

# 7. Account-level budgets and anomaly monitoring. Disabled until the existing
# AWS Budgets configuration has been inventoried.
module "cost_governance" {
  count  = var.enable_cost_governance ? 1 : 0
  source = "./modules/cost-governance"

  notification_email       = var.cost_notification_email
  notification_sns_arn     = var.cost_notification_sns_arn
  monthly_cash_budget_usd  = var.monthly_cash_budget_usd
  monthly_gross_budget_usd = var.monthly_gross_budget_usd
  anomaly_threshold_usd    = var.cost_anomaly_threshold_usd
}
