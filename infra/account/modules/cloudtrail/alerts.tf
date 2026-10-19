# EventBridge receives CloudTrail API events independently of this trail's S3 delivery.
# This alert is a signal to investigate; the runbook also checks trail delivery status.
data "aws_iam_policy_document" "alert_key" {
  statement {
    sid       = "EnableAccountKeyAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${var.expected_account_id}:root"]
    }
  }

  # AWS does not support SourceArn/SourceAccount conditions for EventBridge
  # delivery to an encrypted SNS topic.
  statement {
    sid       = "AllowEventBridgeEncryptedTopicDelivery"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_kms_key" "alerts" {
  description             = "HID account audit alert encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.alert_key.json
}

resource "aws_sns_topic" "audit_alerts" {
  name              = "hid-account-audit-alerts"
  kms_master_key_id = aws_kms_key.alerts.arn
}

resource "aws_sns_topic_subscription" "security_email" {
  topic_arn = aws_sns_topic.audit_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_event_rule" "trail_change" {
  name = "hid-cloudtrail-configuration-change"
  event_pattern = jsonencode({
    source        = ["aws.cloudtrail"]
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["cloudtrail.amazonaws.com"]
      eventName = [
        "StopLogging",
        "DeleteTrail",
        "UpdateTrail",
        "PutEventSelectors",
        "PutInsightSelectors",
      ]
    }
  })
}

data "aws_iam_policy_document" "audit_alerts" {
  statement {
    sid       = "EnableAccountTopicAdministration"
    actions   = ["sns:*"]
    resources = [aws_sns_topic.audit_alerts.arn]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${var.expected_account_id}:root"]
    }
  }

  statement {
    sid       = "AllowTrailChangeRulePublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.audit_alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.trail_change.arn]
    }
  }
}

resource "aws_sns_topic_policy" "audit_alerts" {
  arn    = aws_sns_topic.audit_alerts.arn
  policy = data.aws_iam_policy_document.audit_alerts.json
}

resource "aws_cloudwatch_event_target" "trail_change" {
  rule      = aws_cloudwatch_event_rule.trail_change.name
  target_id = "audit-alerts"
  arn       = aws_sns_topic.audit_alerts.arn
  input     = jsonencode("HID CloudTrail configuration changed. Check CloudTrail Event history and the account trail status immediately.")

  depends_on = [aws_sns_topic_policy.audit_alerts]
}
