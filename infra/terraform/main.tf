module "network" {
  source = "./modules/network"

  aws_region          = var.aws_region
  environment         = var.environment
  vpc_cidr            = var.vpc_cidr
  az_suffixes         = var.az_suffixes
  public_subnet_cidrs = var.public_subnet_cidrs
  app_subnet_cidrs    = var.app_subnet_cidrs
  data_subnet_cidrs   = var.data_subnet_cidrs
  enable_nat          = var.enable_nat
}

module "data" {
  source = "./modules/data"

  environment              = var.environment
  vpc_id                   = module.network.vpc_id
  data_subnet_ids          = module.network.data_subnet_ids
  enable_database          = var.enable_database
  db_instance_class        = var.db_instance_class
  db_allocated_storage_gb  = var.db_allocated_storage_gb
  db_backup_retention_days = var.db_backup_retention_days
}

module "application" {
  source = "./modules/application"

  environment                   = var.environment
  aws_region                    = var.aws_region
  vpc_id                        = module.network.vpc_id
  public_subnet_ids             = module.network.public_subnet_ids
  app_subnet_ids                = module.network.app_subnet_ids
  application_security_group_id = module.data.application_security_group_id
  database_security_group_id    = module.data.database_security_group_id
  document_bucket_arn           = module.data.document_bucket_arn
  kms_key_arn                   = module.data.kms_key_arn
  enable_nat                    = var.enable_nat
  enable_database               = var.enable_database
  enable_application            = var.enable_application
  application_image             = var.application_image
  application_port              = var.application_port
  health_check_path             = var.health_check_path
  acm_certificate_arn           = var.acm_certificate_arn
  origin_cidrs                  = var.origin_cidrs
  desired_task_count            = var.desired_task_count
  task_cpu                      = var.task_cpu
  task_memory                   = var.task_memory
  application_secret_arns       = var.application_secret_arns
}

module "ai" {
  source = "./modules/ai"

  environment                   = var.environment
  aws_region                    = var.aws_region
  expected_account_id           = var.expected_account_id
  vpc_id                        = module.network.vpc_id
  app_subnet_ids                = module.network.app_subnet_ids
  application_security_group_id = module.data.application_security_group_id
  kms_key_arn                   = module.data.kms_key_arn
  application_role_arn          = module.application.application_role_arn
  application_role_name         = module.application.application_role_name
  enable_application            = var.enable_application
  enable_opensearch             = var.enable_opensearch
  opensearch_engine_version     = var.opensearch_engine_version
  opensearch_instance_type      = var.opensearch_instance_type
  bedrock_model_arns            = var.bedrock_model_arns
}

module "integration" {
  source = "./modules/integration"

  environment                     = var.environment
  vpc_id                          = module.network.vpc_id
  app_subnet_ids                  = module.network.app_subnet_ids
  enable_provider_api             = var.enable_provider_api
  enable_application              = var.enable_application
  provider_jwt_issuer             = var.provider_jwt_issuer
  provider_jwt_audience           = var.provider_jwt_audience
  origin_server_name              = var.origin_server_name
  load_balancer_security_group_id = module.application.load_balancer_security_group_id
  load_balancer_listener_arn      = module.application.load_balancer_listener_arn
}

module "operations" {
  source = "./modules/operations"

  environment              = var.environment
  aws_region               = var.aws_region
  expected_account_id      = var.expected_account_id
  enable_database          = var.enable_database
  database_arn             = module.data.database_arn
  database_identifier      = module.data.database_identifier
  kms_key_arn              = module.data.kms_key_arn
  enable_account_trail     = var.enable_account_trail
  enable_application       = var.enable_application
  ecs_cluster_name         = module.application.ecs_cluster_name
  service_name             = module.application.service_name
  load_balancer_arn_suffix = module.application.load_balancer_arn_suffix
  target_group_arn_suffix  = module.application.target_group_arn_suffix
}
