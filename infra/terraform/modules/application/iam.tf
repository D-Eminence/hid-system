# EHR document read/write permissions
data "aws_iam_policy_document" "ehr_documents" {
  statement {
    sid       = "PatientAttachmentTextExtraction"
    actions   = ["textract:StartDocumentTextDetection", "textract:GetDocumentTextDetection"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }
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

# OCR document read and Textract permissions
locals {
  # Paper records are read with text detection: DetectDocumentText for single
  # images, and the asynchronous text detection pair for multi-page PDFs.
  ocr_textract_actions = [
    "textract:AnalyzeDocument",
    "textract:DetectDocumentText",
    "textract:StartDocumentTextDetection",
    "textract:GetDocumentTextDetection",
  ]
}

output "ocr_textract_actions" {
  description = "Textract actions in the ocr-worker task role policy (action names only)."
  value = sort(flatten([
    for statement in data.aws_iam_policy_document.ocr_documents.statement :
    [for action in statement.actions : action if startswith(action, "textract:")]
  ]))
}

output "ocr_source_deletion_permissions" {
  description = "The OCR worker's 7-day deletion statements: sid, actions, resources and conditions (no ARNs beyond the bucket)."
  value = [
    for statement in data.aws_iam_policy_document.ocr_documents.statement : {
      sid       = statement.sid
      actions   = sort(statement.actions)
      resources = sort(statement.resources)
      conditions = [for condition in(statement.condition == null ? [] : statement.condition) : {
        test = condition.test, variable = condition.variable, values = condition.values
      }]
    } if statement.sid != null && startswith(statement.sid, "OcrSource")
  ]
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
  # 7-day deletion of OCR sources (owner condition before the first real
  # patient; the sweeper in services/ocr-worker): list every version and delete
  # marker of one exact uploaded document key, and delete them. Only uploads
  # (clinical/objects/), never other prefixes; nothing else can be deleted.
  statement {
    sid       = "OcrSourceVersionsList"
    actions   = ["s3:ListBucketVersions"]
    resources = [var.document_bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["clinical/objects/*"]
    }
  }
  statement {
    sid       = "OcrSourceVersionsDelete"
    actions   = ["s3:DeleteObjectVersion"]
    resources = ["${var.document_bucket_arn}/clinical/objects/*"]
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
    actions   = local.ocr_textract_actions
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

# Service-specific AWS API permissions
resource "aws_iam_role_policy" "event_dispatcher" {
  count = var.enable_runtime ? 1 : 0
  name  = "event-bus"
  role  = aws_iam_role.task["event-dispatcher"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["events:DescribeEventBus", "events:PutEvents"]
      Resource = var.event_bus_arn
    }]
  })
}

resource "aws_iam_role_policy" "notification_api" {
  count = var.enable_runtime ? 1 : 0
  name  = "ses-email"
  role  = aws_iam_role.task["notification-api"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ses:SendEmail"]
      Resource = "*"
      Condition = {
        StringEquals = {
          "aws:RequestedRegion" = var.aws_region
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "notification_worker" {
  count = var.enable_runtime ? 1 : 0
  name  = "notification-queue"
  role  = aws_iam_role.task["notification-worker"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:ChangeMessageVisibility",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
        ]
        Resource = var.notification_queue_arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = var.notification_queue_kms_key_arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "support_lex" {
  count = var.enable_runtime && var.enable_support_bot ? 1 : 0
  name  = "support-lex"
  role  = aws_iam_role.task["support-api"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lex:RecognizeText"]
      Resource = var.support_bot_alias_arn
    }]
  })
}
