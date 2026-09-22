locals {
  name = "health-identity-${var.environment}"
}

data "aws_partition" "current" {}

resource "aws_backup_vault" "main" {
  name        = "${local.name}-backup"
  kms_key_arn = var.kms_key_arn
}

resource "aws_backup_plan" "daily" {
  name = "${local.name}-daily"

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(0 2 * * ? *)"

    lifecycle {
      delete_after = var.environment == "prod" ? 35 : 14
    }
  }
}

data "aws_iam_policy_document" "backup_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${local.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_selection" "database" {
  count        = var.enable_database ? 1 : 0
  name         = "${local.name}-database"
  plan_id      = aws_backup_plan.daily.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [var.database_arn]

  depends_on = [aws_iam_role_policy_attachment.backup]
}
