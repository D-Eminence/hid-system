# Encryption keys
resource "aws_kms_key" "database" {
  description             = "${var.name_prefix} PostgreSQL encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "database" {
  name          = "alias/${var.name_prefix}-database"
  target_key_id = aws_kms_key.database.key_id
}

resource "aws_kms_key" "documents" {
  description             = "${var.name_prefix} clinical document encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "documents" {
  name          = "alias/${var.name_prefix}-documents"
  target_key_id = aws_kms_key.documents.key_id
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_region" "current" {}

data "aws_iam_policy_document" "queue_key" {
  statement {
    sid       = "EnableAccountPermissions"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowEventBridgeEncryptedQueueDelivery"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:events:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:rule/${var.name_prefix}/${var.name_prefix}-ordinary-notifications"]
    }
  }
}

resource "aws_kms_key" "queue" {
  description             = "${var.name_prefix} notification queue encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.queue_key.json
}

resource "aws_kms_alias" "queue" {
  name          = "alias/${var.name_prefix}-notification-queue"
  target_key_id = aws_kms_key.queue.key_id
}

# Clinical document storage
resource "aws_s3_bucket" "documents" {
  bucket_prefix = "${var.name_prefix}-documents-"
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.documents.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_ownership_controls" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "documents" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "documents" {
  bucket = aws_s3_bucket.documents.id
  policy = data.aws_iam_policy_document.documents.json
}

# This removes only unfinished uploads. Completed clinical objects do not expire.
resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Empty secret containers. Values are populated outside Terraform.
locals {
  runtime_secret_names  = toset(["auth", "identity-sensitive", "notification-provider"])
  database_secret_names = toset(var.database_workload_names)
}

resource "aws_secretsmanager_secret" "runtime" {
  for_each = var.use_existing_secrets ? toset([]) : local.runtime_secret_names

  name                    = "/hid/${var.environment}/${each.value}"
  description             = "Container only; populate outside Terraform before runtime activation"
  recovery_window_in_days = var.environment == "development" ? 7 : 30
  kms_key_id              = aws_kms_key.documents.arn
}

resource "aws_secretsmanager_secret" "database_workload" {
  for_each = var.use_existing_secrets ? toset([]) : local.database_secret_names

  name                    = "/hid/${var.environment}/database/${each.value}"
  description             = "Non-owner PostgreSQL login for ${each.value}; populate outside Terraform"
  recovery_window_in_days = var.environment == "development" ? 7 : 30
  kms_key_id              = aws_kms_key.database.arn
}

resource "aws_secretsmanager_secret" "migration_database" {
  count                   = var.use_existing_secrets ? 0 : 1
  name                    = "/hid/${var.environment}/database/migration"
  description             = "Deployment-only PostgreSQL migration administrator; populate outside Terraform"
  recovery_window_in_days = var.environment == "development" ? 7 : 30
  kms_key_id              = aws_kms_key.database.arn
}

data "aws_secretsmanager_secret" "existing_runtime" {
  for_each = var.use_existing_secrets ? local.runtime_secret_names : toset([])
  name     = "/hid/${var.environment}/${each.value}"
}

data "aws_secretsmanager_secret" "existing_database_workload" {
  for_each = var.use_existing_secrets ? local.database_secret_names : toset([])
  name     = "/hid/${var.environment}/database/${each.value}"
}

data "aws_secretsmanager_secret" "existing_migration_database" {
  count = var.use_existing_secrets ? 1 : 0
  name  = "/hid/${var.environment}/database/migration-admin"
}

resource "aws_security_group" "database" {
  name_prefix = "${var.name_prefix}-database-"
  description = "PostgreSQL accepts traffic only from registered workload security groups"
  vpc_id      = var.vpc_id
  egress      = []
}

# PostgreSQL network and engine configuration
resource "aws_db_subnet_group" "main" {
  name       = "${var.name_prefix}-database"
  subnet_ids = var.database_subnet_ids
}

resource "aws_db_parameter_group" "postgres" {
  name_prefix = "${var.name_prefix}-postgres16-"
  family      = "postgres16"
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
  lifecycle {
    create_before_destroy = true
  }
}

data "aws_iam_policy_document" "rds_monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

# Optional PostgreSQL instance and enhanced monitoring
resource "aws_iam_role" "rds_monitoring" {
  count              = var.enable_database ? 1 : 0
  name_prefix        = "${var.name_prefix}-rds-monitoring-"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoring_assume.json
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  count      = var.enable_database ? 1 : 0
  role       = aws_iam_role.rds_monitoring[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_cloudwatch_log_group" "postgres" {
  count             = var.enable_database ? 1 : 0
  name              = "/aws/rds/instance/${var.name_prefix}-postgres/postgresql"
  retention_in_days = var.security_log_retention_days
}

resource "aws_db_instance" "main" {
  count = var.enable_database ? 1 : 0

  identifier                      = "${var.name_prefix}-postgres"
  engine                          = "postgres"
  engine_version                  = "16"
  instance_class                  = var.database_instance_class
  allocated_storage               = var.database_allocated_storage
  max_allocated_storage           = var.database_max_storage
  storage_type                    = "gp3"
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.database.arn
  db_name                         = "hid"
  username                        = "hid_platform_bootstrap"
  manage_master_user_password     = true
  master_user_secret_kms_key_id   = aws_kms_key.database.arn
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.database.id]
  parameter_group_name            = aws_db_parameter_group.postgres.name
  publicly_accessible             = false
  multi_az                        = var.database_multi_az
  backup_retention_period         = var.database_backup_retention
  deletion_protection             = var.database_deletion_protection
  auto_minor_version_upgrade      = true
  monitoring_interval             = 60
  monitoring_role_arn             = aws_iam_role.rds_monitoring[0].arn
  performance_insights_enabled    = true
  enabled_cloudwatch_logs_exports = ["postgresql"]
  copy_tags_to_snapshot           = true
  skip_final_snapshot             = var.environment == "development"
  final_snapshot_identifier       = var.environment == "development" ? null : "${var.name_prefix}-final"

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [aws_cloudwatch_log_group.postgres]
}
