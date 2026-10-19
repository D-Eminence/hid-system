mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }

  mock_data "aws_region" {
    defaults = { region = "eu-west-1" }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      id   = "mock-policy"
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_data "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:existing" }
  }
}

mock_provider "awscc" {}

run "database_backup_and_security_logs" {
  command = plan

  module {
    source = "./modules/data"
  }

  variables {
    name_prefix                  = "hid-development"
    environment                  = "development"
    vpc_id                       = "vpc-12345678"
    database_subnet_ids          = ["subnet-12345678", "subnet-87654321"]
    database_instance_class      = "db.t4g.small"
    database_allocated_storage   = 50
    database_max_storage         = 100
    database_multi_az            = false
    database_deletion_protection = false
    database_backup_retention    = 30
    security_log_retention_days  = 365
    enable_database              = true
    database_workload_names      = ["identity-api"]
  }

  assert {
    condition = (
      aws_db_instance.main[0].backup_retention_period == 30 &&
      aws_cloudwatch_log_group.postgres[0].retention_in_days == 365
    )
    error_message = "RDS backups and PostgreSQL security logs must use the configured periods."
  }

  assert {
    condition = (
      length(aws_s3_bucket_lifecycle_configuration.documents.rule[0].expiration) == 0 &&
      length(aws_s3_bucket_lifecycle_configuration.documents.rule[0].noncurrent_version_expiration) == 0
    )
    error_message = "Completed clinical objects and versions must have no expiry."
  }
}

run "optional_backup_plan" {
  command = plan

  module {
    source = "./modules/operations"
  }

  variables {
    name_prefix                = "hid-development"
    environment                = "development"
    enable_database            = true
    database_arn               = "arn:aws:rds:eu-west-1:123456789012:db:hid-development-postgres"
    database_identifier        = "hid-development-postgres"
    database_kms_key_arn       = "arn:aws:kms:eu-west-1:123456789012:key/example"
    database_connection_budget = 120
    backup_retention_days      = 30
    enable_backup_plan         = true
    alert_email                = ""
    aws_account_id             = "123456789012"
    aws_region                 = "eu-west-1"
    ecs_cluster_name           = "hid-development"
  }

  assert {
    condition     = alltrue([for rule in aws_backup_plan.main[0].rule : rule.lifecycle[0].delete_after == 30])
    error_message = "AWS Backup recovery points must use the configured rolling period."
  }
}

run "reference_existing_staging_secrets" {
  command = plan

  module {
    source = "./modules/data"
  }

  variables {
    name_prefix                  = "hid-staging"
    environment                  = "staging"
    vpc_id                       = "vpc-12345678"
    database_subnet_ids          = ["subnet-12345678", "subnet-87654321"]
    database_instance_class      = "db.t4g.small"
    database_allocated_storage   = 100
    database_max_storage         = 300
    database_multi_az            = false
    database_deletion_protection = true
    database_backup_retention    = 30
    security_log_retention_days  = 365
    enable_database              = false
    database_workload_names      = ["identity-api"]
    use_existing_secrets         = true
  }

  assert {
    condition = (
      length(aws_secretsmanager_secret.runtime) == 0 &&
      length(aws_secretsmanager_secret.database_workload) == 0 &&
      length(aws_secretsmanager_secret.migration_database) == 0 &&
      length(output.runtime_secret_arns) == 3 &&
      length(output.database_secret_arns) == 1
    )
    error_message = "Staging must reference existing secret metadata without creating duplicate containers."
  }
}
