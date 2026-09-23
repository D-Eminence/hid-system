data "aws_iam_policy_document" "ehr_documents" {
  statement {
    sid       = "DocumentBucketMetadata"
    actions   = ["s3:ListBucket", "s3:GetBucketVersioning"]
    resources = [var.document_bucket_arn]
  }
  statement {
    sid       = "DocumentObjectReadWrite"
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]
    resources = ["${var.document_bucket_arn}/*"]
  }
  statement {
    sid       = "DocumentKeyUse"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [var.document_kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "ehr_documents" {
  count  = var.enable_runtime ? 1 : 0
  name   = "documents"
  role   = aws_iam_role.task["ehr-api"].id
  policy = data.aws_iam_policy_document.ehr_documents.json
}

data "aws_iam_policy_document" "ocr_documents" {
  statement {
    actions   = ["s3:ListBucket"]
    resources = [var.document_bucket_arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${var.document_bucket_arn}/*"]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [var.document_kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }
  }
  statement {
    actions   = ["textract:AnalyzeDocument", "textract:StartDocumentTextDetection", "textract:GetDocumentTextDetection"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }
}

resource "aws_iam_role_policy" "ocr_documents" {
  count  = var.enable_runtime ? 1 : 0
  name   = "documents-and-textract"
  role   = aws_iam_role.task["ocr-worker"].id
  policy = data.aws_iam_policy_document.ocr_documents.json
}

resource "aws_iam_role_policy" "event_dispatcher" {
  count = var.enable_runtime ? 1 : 0
  name  = "event-bus"
  role  = aws_iam_role.task["event-dispatcher"].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = ["events:PutEvents"], Resource = var.event_bus_arn
  }] })
}

resource "aws_iam_role_policy" "notification_api" {
  count = var.enable_runtime ? 1 : 0
  name  = "ses-email"
  role  = aws_iam_role.task["notification-api"].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow", Action = ["ses:SendEmail"], Resource = "*"
    Condition = { StringEquals = { "aws:RequestedRegion" = var.aws_region } }
  }] })
}

resource "aws_iam_role_policy" "notification_worker" {
  count = var.enable_runtime ? 1 : 0
  name  = "notification-queue"
  role  = aws_iam_role.task["notification-worker"].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect   = "Allow"
    Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]
    Resource = var.notification_queue_arn
  }] })
}
