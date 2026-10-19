# Disabled by default. Application CI has no production/infrastructure mutation permission.
locals {
  automation_enabled  = var.enable_deployment_automation && contains(["staging", "production"], var.environment) && var.enable_runtime && var.enable_migration_task && var.enable_support_bot
  release_bucket_name = "${var.name_prefix}-releases-${var.deployment_account_id}-${var.aws_region}"
  github_subject_prefixes = {
    backend  = "repo:D-Eminence@182018869/hid-system@1317340803"
    frontend = "repo:D-Eminence@182018869/Health-id@1396718647"
  }
  release_environment        = var.deployment_release_environment
  deployment_environments    = { backend = "${local.release_environment}-backend", frontend = "${local.release_environment}-frontend" }
  deployment_branches        = { backend = "staging-novu-ci-20261005", frontend = "main" }
  deployment_roles           = local.automation_enabled ? local.deployment_environments : {}
  automation_repository_arns = [for name in keys(local.runtime_workloads) : aws_ecr_repository.workload[name].arn]
  automation_task_arns = [for name in keys(local.runtime_workloads) :
  "arn:aws:ecs:${var.aws_region}:${var.deployment_account_id}:task-definition/${local.active_ecs_prefix}-${name}:*"]
  automation_service_arns = [for name in keys(local.runtime_workloads) :
  "arn:aws:ecs:${var.aws_region}:${var.deployment_account_id}:service/${local.active_ecs_prefix}/${local.active_ecs_prefix}-${name}"]
}

resource "aws_kms_key" "deployment_releases" {
  count                   = local.automation_enabled ? 1 : 0
  description             = "HID deployment receipts and rollback archives"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  lifecycle { prevent_destroy = true }
}

resource "aws_kms_alias" "deployment_releases" {
  count         = local.automation_enabled ? 1 : 0
  name          = "alias/${var.name_prefix}-deployment-releases"
  target_key_id = aws_kms_key.deployment_releases[0].key_id
}

resource "aws_s3_bucket" "deployment_releases" {
  count         = local.automation_enabled ? 1 : 0
  bucket        = local.release_bucket_name
  force_destroy = false
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "deployment_releases" {
  count  = local.automation_enabled ? 1 : 0
  bucket = aws_s3_bucket.deployment_releases[0].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "deployment_releases" {
  count                   = local.automation_enabled ? 1 : 0
  bucket                  = aws_s3_bucket.deployment_releases[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "deployment_releases" {
  count  = local.automation_enabled ? 1 : 0
  bucket = aws_s3_bucket.deployment_releases[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.deployment_releases[0].arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_policy" "deployment_releases" {
  count  = local.automation_enabled ? 1 : 0
  bucket = aws_s3_bucket.deployment_releases[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid      = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*",
        Resource = [aws_s3_bucket.deployment_releases[0].arn, "${aws_s3_bucket.deployment_releases[0].arn}/*"],
      Condition = { Bool = { "aws:SecureTransport" = "false" } } },
      { Sid      = "RequireKmsWrites", Effect = "Deny", Principal = "*", Action = "s3:PutObject",
        Resource = "${aws_s3_bucket.deployment_releases[0].arn}/*",
      Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" } } },
      { Sid      = "RequireReleaseKey", Effect = "Deny", Principal = "*", Action = "s3:PutObject",
        Resource = "${aws_s3_bucket.deployment_releases[0].arn}/*",
      Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = aws_kms_key.deployment_releases[0].arn } } },
      { Sid      = "RequireConditionalIndexWrites", Effect = "Deny", Principal = "*", Action = "s3:PutObject",
        Resource = "${aws_s3_bucket.deployment_releases[0].arn}/${local.release_environment}/current.json",
      Condition = { Null = { "s3:if-match" = "true", "s3:if-none-match" = "true" } } },
      { Sid      = "ImmutableReceiptsAndArchives", Effect = "Deny", Principal = "*", Action = "s3:PutObject",
        Resource = ["${aws_s3_bucket.deployment_releases[0].arn}/${local.release_environment}/releases/*", "${aws_s3_bucket.deployment_releases[0].arn}/${local.release_environment}/archives/*"],
      Condition = { StringNotEquals = { "s3:if-none-match" = "*" } } }
    ]
  })
}

resource "aws_dynamodb_table" "deployment_lease" {
  count        = local.automation_enabled ? 1 : 0
  name         = "${var.name_prefix}-deployment-leases"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "environment"
  attribute {
    name = "environment"
    type = "S"
  }
  server_side_encryption { enabled = true }
  # The generation counter is persistent; TTL must not delete it.
  lifecycle { prevent_destroy = true }
}

data "aws_iam_policy_document" "deployment_trust" {
  for_each = local.deployment_roles
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = ["arn:aws:iam::${var.deployment_account_id}:oidc-provider/token.actions.githubusercontent.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["${local.github_subject_prefixes[each.key]}:environment:${each.value}"]
    }
  }
}

resource "aws_iam_role" "deployment" {
  for_each             = local.deployment_roles
  name                 = "${var.name_prefix}-github-${each.key}-deploy"
  assume_role_policy   = data.aws_iam_policy_document.deployment_trust[each.key].json
  max_session_duration = 7200
}

resource "aws_iam_role" "release_read" {
  count                = local.automation_enabled ? 1 : 0
  name                 = "${var.name_prefix}-github-release-read"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRoleWithWebIdentity",
      Principal = { Federated = "arn:aws:iam::${var.deployment_account_id}:oidc-provider/token.actions.githubusercontent.com" },
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub" = [for kind, prefix in local.github_subject_prefixes :
        "${prefix}:ref:refs/heads/${local.deployment_branches[kind]}"]
      } }
    }]
  })
}

resource "aws_iam_role_policy" "release_read" {
  count = local.automation_enabled ? 1 : 0
  name  = "staging-release-metadata-read"
  role  = aws_iam_role.release_read[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"],
        Resource = ["${aws_s3_bucket.deployment_releases[0].arn}/${local.release_environment}/current.json",
      "${aws_s3_bucket.deployment_releases[0].arn}/${local.release_environment}/releases/*"] },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.deployment_releases[0].arn,
      Condition = { StringEquals = { "kms:ViaService" = "s3.${var.aws_region}.amazonaws.com" } } }
    ]
  })
}

resource "aws_iam_role_policy" "deployment_shared" {
  for_each = local.deployment_roles
  name     = "staging-release-state"
  role     = aws_iam_role.deployment[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"],
      Resource = "${aws_s3_bucket.deployment_releases[0].arn}/${local.release_environment}/*" },
      { Effect   = "Allow", Action = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
        Resource = aws_kms_key.deployment_releases[0].arn,
      Condition = { StringEquals = { "kms:ViaService" = "s3.${var.aws_region}.amazonaws.com" } } },
      { Effect   = "Allow", Action = ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        Resource = aws_dynamodb_table.deployment_lease[0].arn,
      Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["hid-${local.release_environment}"] } } },
      { Effect = "Allow", Action = ["sns:Publish"], Resource = var.alarm_topic_arn },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = var.deployment_alert_kms_key_arn,
      Condition = { StringEquals = { "kms:ViaService" = "sns.${var.aws_region}.amazonaws.com" } } }
    ]
  })
}

resource "aws_iam_role_policy" "deployment_backend" {
  count = local.automation_enabled ? 1 : 0
  name  = "staging-image-rollout-only"
  role  = aws_iam_role.deployment["backend"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecs:DescribeServices", "ecs:UpdateService"], Resource = local.automation_service_arns },
      { Effect = "Allow", Action = ["ecs:ListTasks"], Resource = "*",
      Condition = { ArnEquals = { "ecs:cluster" = local.active_ecs_cluster.arn } } },
      { Effect = "Allow", Action = ["ecs:DescribeTasks"], Resource = "arn:aws:ecs:${var.aws_region}:${var.deployment_account_id}:task/${local.active_ecs_prefix}/*" },
      # RegisterTaskDefinition and DescribeTaskDefinition do not support family-scoped IAM resources.
      # The controller validates the exact family and preserves the current task configuration.
      { Effect = "Allow", Action = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"], Resource = "*" },
      { Effect   = "Allow", Action = ["ecs:RunTask"],
        Resource = "arn:aws:ecs:${var.aws_region}:${var.deployment_account_id}:task-definition/${var.name_prefix}-database-migration:*",
      Condition = { ArnEquals = { "ecs:cluster" = local.active_ecs_cluster.arn } } },
      { Effect = "Allow", Action = ["iam:PassRole"],
        Resource = concat([for r in aws_iam_role.task : r.arn], [for r in aws_iam_role.execution : r.arn],
        [aws_iam_role.migration_task[0].arn, aws_iam_role.migration_execution[0].arn]),
      Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } } },
      { Effect = "Allow", Action = ["ecr:DescribeImages", "ecr:GetLifecyclePolicy", "ecr:BatchGetImage", "ecr:PutImage"],
      Resource = local.automation_repository_arns },
      { Effect = "Allow", Action = ["elasticloadbalancing:DescribeTargetHealth"], Resource = "*" },
      { Effect = "Allow", Action = ["logs:GetLogEvents"],
      Resource = "arn:aws:logs:${var.aws_region}:${var.deployment_account_id}:log-group:/hid/staging/database-migration:log-stream:migration/database-migration/*" }
    ]
  })
}

data "aws_secretsmanager_secret" "deployment_origin" {
  count = local.automation_enabled ? 1 : 0
  name  = "/hid/${var.environment}/cloudflare-origin"
}

resource "aws_iam_role_policy" "deployment_frontend" {
  count = local.automation_enabled ? 1 : 0
  name  = "staging-worker-origin-only"
  role  = aws_iam_role.deployment["frontend"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"],
        Resource = [data.aws_secretsmanager_secret.deployment_origin[0].arn,
        "arn:aws:secretsmanager:${var.aws_region}:${var.deployment_account_id}:secret:/hid/${var.environment}/cloudflare-deployment-??????"]
      },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.database_kms_key_arn,
        Condition = {
          StringEquals = { "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com" }
          StringLike = { "kms:EncryptionContext:SecretARN" = [data.aws_secretsmanager_secret.deployment_origin[0].arn,
          "arn:aws:secretsmanager:${var.aws_region}:${var.deployment_account_id}:secret:/hid/${var.environment}/cloudflare-deployment-??????"] }
        }
      }
    ]
  })
}

output "deployment_automation_configuration" {
  value = local.automation_enabled ? {
    account                   = var.deployment_account_id
    region                    = var.aws_region
    release_bucket            = aws_s3_bucket.deployment_releases[0].id
    release_kms_key_arn       = aws_kms_key.deployment_releases[0].arn
    lease_table               = aws_dynamodb_table.deployment_lease[0].name
    index_key                 = "${local.release_environment}/current.json"
    alert_topic_arn           = var.alarm_topic_arn
    read_role_arn             = aws_iam_role.release_read[0].arn
    deploy_role_arns          = { for kind, role in aws_iam_role.deployment : kind => role.arn }
    environments              = local.deployment_environments
    branches                  = local.deployment_branches
    migration_task_definition = aws_ecs_task_definition.migration[0].arn
    migration_network = {
      subnets        = var.application_subnet_ids
      securityGroups = [aws_security_group.migration[0].id]
      assignPublicIp = "DISABLED"
    }
  } : null
}
