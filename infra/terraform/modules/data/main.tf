locals {
  name = "health-identity-${var.environment}"
}

resource "aws_kms_key" "data" {
  description             = "${local.name} data encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_s3_bucket" "documents" {
  bucket_prefix = "${local.name}-documents-"
  force_destroy = false
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
      kms_master_key_id = aws_kms_key.data.arn
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

resource "aws_secretsmanager_secret" "application_placeholders" {
  for_each                = toset(["application", "auth", "notification"])
  name                    = "${local.name}/${each.value}"
  description             = "Set a value outside Terraform before wiring this into a task"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 30
}

resource "aws_security_group" "app" {
  name_prefix = "${local.name}-app-"
  description = "Application tasks; ingress is added with the load balancer"
  vpc_id      = var.vpc_id
  tags        = { Name = "${local.name}-app" }
}

resource "aws_security_group" "database" {
  name_prefix = "${local.name}-db-"
  description = "PostgreSQL from application tasks only"
  vpc_id      = var.vpc_id
  tags        = { Name = "${local.name}-db" }
}

resource "aws_vpc_security_group_ingress_rule" "database_from_app" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-data"
  subnet_ids = var.data_subnet_ids
}

resource "aws_db_instance" "main" {
  count                           = var.enable_database ? 1 : 0
  identifier                      = "${local.name}-postgres"
  engine                          = "postgres"
  instance_class                  = var.db_instance_class
  allocated_storage               = var.db_allocated_storage_gb
  storage_type                    = "gp3"
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.data.arn
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.database.id]
  publicly_accessible             = false
  multi_az                        = var.environment == "prod"
  username                        = "healthidentityadmin"
  manage_master_user_password     = true
  backup_retention_period         = var.db_backup_retention_days
  copy_tags_to_snapshot           = true
  deletion_protection             = var.environment == "prod"
  skip_final_snapshot             = var.environment != "prod"
  final_snapshot_identifier       = var.environment == "prod" ? "${local.name}-final" : null
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
}
