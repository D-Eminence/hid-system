resource "aws_sns_topic" "alerts" {
  name              = "${var.name_prefix}-operations-alerts"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "database_cpu" {
  count = var.enable_database ? 1 : 0

  alarm_name          = "${var.name_prefix}-database-cpu"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = var.database_connection_budget == 0 ? "notBreaching" : "breaching"
  dimensions          = { DBInstanceIdentifier = var.database_identifier }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "database_storage" {
  count = var.enable_database ? 1 : 0

  alarm_name          = "${var.name_prefix}-database-free-storage"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 21474836480
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = var.database_connection_budget == 0 ? "notBreaching" : "breaching"
  dimensions          = { DBInstanceIdentifier = var.database_identifier }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "database_connections" {
  count = var.enable_database && var.database_connection_budget > 0 ? 1 : 0

  alarm_name          = "${var.name_prefix}-database-connections"
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = floor(var.database_connection_budget * 0.85)
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  dimensions          = { DBInstanceIdentifier = var.database_identifier }
  alarm_actions       = [aws_sns_topic.alerts.arn]
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
  count              = var.enable_backup_plan ? 1 : 0
  name_prefix        = "${var.name_prefix}-backup-"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  count      = var.enable_backup_plan ? 1 : 0
  role       = aws_iam_role.backup[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_vault" "main" {
  count       = var.enable_backup_plan ? 1 : 0
  name        = "${var.name_prefix}-backup"
  kms_key_arn = var.database_kms_key_arn
}

resource "aws_backup_plan" "main" {
  count = var.enable_backup_plan ? 1 : 0
  name  = "${var.name_prefix}-daily"
  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.main[0].name
    schedule          = "cron(0 2 * * ? *)"
    lifecycle {
      delete_after = var.backup_retention_days
    }
  }
}

resource "aws_backup_selection" "database" {
  count        = var.enable_backup_plan && var.enable_database ? 1 : 0
  name         = "${var.name_prefix}-database"
  iam_role_arn = aws_iam_role.backup[0].arn
  plan_id      = aws_backup_plan.main[0].id
  resources    = [var.database_arn]
}
