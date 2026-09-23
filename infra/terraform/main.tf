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

module "data" {
  source = "./modules/data"

  name_prefix                  = local.name_prefix
  environment                  = var.environment
  vpc_id                       = module.network.vpc_id
  database_subnet_ids          = module.network.database_subnet_ids
  database_instance_class      = local.profile.database_instance_class
  database_allocated_storage   = local.profile.database_allocated_storage
  database_max_storage         = local.profile.database_max_storage
  database_multi_az            = local.profile.database_multi_az
  database_deletion_protection = local.profile.database_deletion_protection
  database_backup_retention    = local.profile.database_backup_retention
  log_retention_days           = local.profile.log_retention_days
  enable_database              = var.enable_database
  database_workload_names      = local.database_workload_names
}

module "messaging" {
  source = "./modules/messaging"

  name_prefix             = local.name_prefix
  environment             = var.environment
  queue_kms_key_arn       = module.data.queue_kms_key_arn
  include_emergency_event = var.environment == "staging"
}

module "application" {
  source = "./modules/application"

  name_prefix                   = local.name_prefix
  environment                   = var.environment
  deployment_profile            = local.deployment_profile
  aws_region                    = var.aws_region
  root_domain_name              = var.root_domain_name
  browser_subdomains            = local.browser_subdomains
  workloads                     = local.workloads
  desired_counts                = local.desired_counts
  scaling_ceilings              = local.scaling_ceilings
  enable_runtime                = var.enable_runtime
  enable_ingress                = var.enable_ingress
  enable_autoscaling            = local.profile.enable_autoscaling
  vpc_id                        = module.network.vpc_id
  vpc_cidr                      = local.profile.vpc_cidr
  public_subnet_ids             = module.network.public_subnet_ids
  application_subnet_ids        = module.network.application_subnet_ids
  endpoint_security_group_id    = module.network.endpoint_security_group_id
  s3_prefix_list_id             = module.network.s3_prefix_list_id
  database_security_group_id    = module.data.database_security_group_id
  database_enabled              = var.enable_database
  document_bucket_arn           = module.data.document_bucket_arn
  document_kms_key_arn          = module.data.document_kms_key_arn
  database_kms_key_arn          = module.data.database_kms_key_arn
  runtime_secret_arns           = module.data.runtime_secret_arns
  database_secret_arns          = module.data.database_secret_arns
  migration_database_secret_arn = module.data.migration_database_secret_arn
  event_bus_arn                 = module.messaging.event_bus_arn
  notification_queue_arn        = module.messaging.notification_queue_arn
  notification_queue_url        = module.messaging.notification_queue_url
  image_uris                    = var.image_uris
  migration_image_uri           = var.migration_image_uri
  regional_certificate_arn      = var.regional_certificate_arn
  internal_certificate_arn      = var.internal_certificate_arn
  cloudflare_origin_secret      = var.cloudflare_origin_secret
  rds_ca_bundle_base64          = var.rds_ca_bundle_base64
  workload_issuer_url           = var.workload_issuer_url
  workload_jwks_url             = var.workload_jwks_url
  workload_subjects             = var.workload_subjects
  staging_novu_api_url          = var.staging_novu_api_url
  log_retention_days            = local.profile.log_retention_days
  repository_image_count        = local.profile.repository_image_count
  alarm_topic_arn               = module.operations.alert_topic_arn
}

module "operations" {
  source = "./modules/operations"

  name_prefix                = local.name_prefix
  environment                = var.environment
  enable_database            = var.enable_database
  database_arn               = module.data.database_arn
  database_identifier        = module.data.database_identifier
  database_kms_key_arn       = module.data.database_kms_key_arn
  database_connection_budget = local.profile.database_connection_budget
  backup_retention_days      = local.profile.database_backup_retention
  enable_backup_plan         = var.enable_backup_plan
  alert_email                = var.alert_email
}

module "cost_governance" {
  count  = var.enable_cost_governance ? 1 : 0
  source = "./modules/cost-governance"

  notification_email       = var.cost_notification_email
  notification_sns_arn     = var.cost_notification_sns_arn
  monthly_cash_budget_usd  = var.monthly_cash_budget_usd
  monthly_gross_budget_usd = var.monthly_gross_budget_usd
  anomaly_threshold_usd    = var.cost_anomaly_threshold_usd
}
