# CloudFormation generates the two independent, base64-compatible key strings
# inside Secrets Manager. Terraform state contains their ARNs, never values.
resource "aws_cloudformation_stack" "migration_crypto" {
  count = var.enable_migration_task ? 1 : 0

  name = "${var.name_prefix}-migration-crypto"
  template_body = jsonencode({
    AWSTemplateFormatVersion = "2010-09-09"
    Description              = "Restricted HID migration field encryption and lookup keys"
    Resources = {
      FieldKey = {
        Type                = "AWS::SecretsManager::Secret"
        DeletionPolicy      = "Retain"
        UpdateReplacePolicy = "Retain"
        Properties = {
          Name        = "/hid/${var.environment}/migration/field-key"
          Description = "Migration field encryption key; retain for decryption of migrated data"
          KmsKeyId    = var.database_kms_key_arn
          GenerateSecretString = {
            PasswordLength          = 44
            ExcludePunctuation      = true
            IncludeSpace            = false
            RequireEachIncludedType = false
          }
        }
      }
      LookupKey = {
        Type                = "AWS::SecretsManager::Secret"
        DeletionPolicy      = "Retain"
        UpdateReplacePolicy = "Retain"
        Properties = {
          Name        = "/hid/${var.environment}/migration/lookup-key"
          Description = "Migration lookup HMAC key; retain for matching migrated data"
          KmsKeyId    = var.database_kms_key_arn
          GenerateSecretString = {
            PasswordLength          = 44
            ExcludePunctuation      = true
            IncludeSpace            = false
            RequireEachIncludedType = false
          }
        }
      }
    }
    Outputs = {
      FieldKeyArn  = { Value = { Ref = "FieldKey" } }
      LookupKeyArn = { Value = { Ref = "LookupKey" } }
    }
  })
}

resource "aws_iam_role_policy" "migration_promotion_secret" {
  count = var.enable_migration_task ? 1 : 0

  name = "migration-promotion-secrets"
  role = aws_iam_role.migration_execution[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue"]
      Resource = [
        aws_cloudformation_stack.migration_crypto[0].outputs["FieldKeyArn"],
        aws_cloudformation_stack.migration_crypto[0].outputs["LookupKeyArn"],
        var.runtime_secret_arns["identity-sensitive"],
      ]
    }]
  })
}

# A one-shot staging task creates restricted database login credentials directly
# in the existing secret containers. No password appears in Terraform state.
resource "aws_iam_role_policy" "migration_runtime_logins" {
  count = var.enable_migration_task && var.environment == "staging" ? 1 : 0

  name = "staging-runtime-database-logins"
  role = aws_iam_role.migration_task[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
        Resource = values(var.database_secret_arns)
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = var.database_kms_key_arn
        Condition = {
          StringEquals = { "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com" }
        }
      },
    ]
  })
}

# Promotion is a separate one-shot task. Its key references are absent from
# the staging/schema task and no secret value appears in ECS overrides.
resource "aws_iam_role_policy" "migration_customer_inputs" {
  count = var.enable_migration_task && var.environment == "staging" && var.migration_source_bucket_arn != "" && var.migration_source_kms_key_arn != "" ? 1 : 0
  name  = "migration-customer-input-version-read"
  role  = aws_iam_role.migration_task[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["s3:GetObjectVersion"]
        Resource = [
          "${var.migration_source_bucket_arn}/migration-inputs/*",
          "${var.document_bucket_arn}/migration-quarantine/*/medical-files/*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = var.migration_source_kms_key_arn
        Condition = {
          StringEquals = { "kms:ViaService" = "s3.${var.aws_region}.amazonaws.com" }
          StringLike   = { "kms:EncryptionContext:aws:s3:arn" = [var.migration_source_bucket_arn, "${var.migration_source_bucket_arn}/migration-inputs/*"] }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = var.document_kms_key_arn
        Condition = {
          StringEquals = { "kms:ViaService" = "s3.${var.aws_region}.amazonaws.com" }
          StringLike   = { "kms:EncryptionContext:aws:s3:arn" = [var.document_bucket_arn, "${var.document_bucket_arn}/migration-quarantine/*/medical-files/*"] }
        }
      },
    ]
  })
}

resource "aws_ecs_task_definition" "migration_promotion" {
  skip_destroy = true
  lifecycle {
    precondition {
      condition     = var.deployment_release_valid
      error_message = "Release inventory or lease changed; refusing a stale promotion image."
    }
  }
  count                    = var.enable_migration_task ? 1 : 0
  family                   = "${var.name_prefix}-identity-promotion"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.migration_execution[0].arn
  task_role_arn            = aws_iam_role.migration_task[0].arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name                   = "identity-promotion"
    image                  = var.migration_image_uri
    essential              = true
    command                = ["scripts/promote-legacy-identity.mjs"]
    readonlyRootFilesystem = true
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "DATABASE_SSL", value = "true" },
      { name = "DATABASE_SSL_ROOT_CERT_BASE64", value = var.rds_ca_bundle_base64 },
      { name = "DATABASE_HOST", value = var.database_endpoint },
      { name = "DATABASE_NAME", value = "hid" },
      { name = "MIGRATION_FIELD_KEY_REFERENCE", value = "${var.environment}-migration-v1" },
      { name = "MIGRATION_ACCEPTED_INPUT_BUCKET", value = trimprefix(var.migration_source_bucket_arn, "arn:aws:s3:::") },
      { name = "MIGRATION_ACCEPTED_INPUT_KMS_KEY_ARN", value = var.migration_source_kms_key_arn },
      { name = "MIGRATION_DOCUMENT_BUCKET", value = trimprefix(var.document_bucket_arn, "arn:aws:s3:::") },
      { name = "MIGRATION_DOCUMENT_KMS_KEY_ARN", value = var.document_kms_key_arn },
    ]
    secrets = [
      { name = "DATABASE_USERNAME", valueFrom = "${var.database_master_secret_arn}:username::" },
      { name = "DATABASE_PASSWORD", valueFrom = "${var.database_master_secret_arn}:password::" },
      { name = "MIGRATION_FIELD_ENCRYPTION_KEY_B64", valueFrom = aws_cloudformation_stack.migration_crypto[0].outputs["FieldKeyArn"] },
      { name = "MIGRATION_LOOKUP_HMAC_KEY_B64", valueFrom = aws_cloudformation_stack.migration_crypto[0].outputs["LookupKeyArn"] },
      { name = "CONTACT_LOOKUP_HMAC_KEY_B64", valueFrom = "${var.runtime_secret_arns["identity-sensitive"]}:contactLookupHmacKeyB64::" },
      { name = "NIN_ENCRYPTION_KEY_B64", valueFrom = "${var.runtime_secret_arns["identity-sensitive"]}:ninEncryptionKeyB64::" },
      { name = "OTP_HMAC_KEY_B64", valueFrom = "${var.runtime_secret_arns["identity-sensitive"]}:otpHmacKeyB64::" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.migration[0].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "promotion"
      }
    }
  }])

  depends_on = [aws_iam_role_policy.migration_promotion_secret, aws_iam_role_policy.migration_customer_inputs]
}
