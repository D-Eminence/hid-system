resource "aws_sqs_queue" "dead_letter" {
  name                      = "${var.name_prefix}-notification-dead-letter"
  kms_master_key_id         = var.queue_kms_key_arn
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "notification" {
  name                       = "${var.name_prefix}-notification"
  kms_master_key_id          = var.queue_kms_key_arn
  visibility_timeout_seconds = 90
  message_retention_seconds  = 345600
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letter.arn
    maxReceiveCount     = 8
  })
}

resource "aws_cloudwatch_event_bus" "platform" {
  name = var.name_prefix
}

resource "aws_cloudwatch_event_rule" "ordinary_notifications" {
  name           = "${var.name_prefix}-ordinary-notifications"
  description    = "Minimum necessary ordinary events; authentication OTP never enters this path"
  event_bus_name = aws_cloudwatch_event_bus.platform.name
  event_pattern = jsonencode({
    source = ["ng.hid.identity", "ng.hid.ocr", "ng.hid.lab", "ng.hid.pharmacy", "ng.hid.outreach"]
    detail-type = concat([
      "PatientRegistered.v1", "PatientIdentityResolved.v1", "OcrPublicationSucceeded.v1",
      "LabResultReleased.v1", "MedicationDispensed.v1", "OutreachPatientResolved.v1"
    ], var.include_emergency_event ? ["EmergencyAccessActivated.v1"] : [])
  })
}

resource "aws_cloudwatch_event_target" "notification" {
  rule           = aws_cloudwatch_event_rule.ordinary_notifications.name
  event_bus_name = aws_cloudwatch_event_bus.platform.name
  target_id      = "notification-queue"
  arn            = aws_sqs_queue.notification.arn
  dead_letter_config {
    arn = aws_sqs_queue.dead_letter.arn
  }
  retry_policy {
    maximum_event_age_in_seconds = 86400
    maximum_retry_attempts       = 8
  }
}

data "aws_iam_policy_document" "eventbridge_queue" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [aws_sqs_queue.notification.arn]
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

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.notification.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.ordinary_notifications.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "eventbridge" {
  queue_url = aws_sqs_queue.notification.id
  policy    = data.aws_iam_policy_document.eventbridge_queue.json
}

data "aws_iam_policy_document" "dead_letter" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [aws_sqs_queue.dead_letter.arn]
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

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dead_letter.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.ordinary_notifications.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "dead_letter" {
  queue_url = aws_sqs_queue.dead_letter.id
  policy    = data.aws_iam_policy_document.dead_letter.json
}
