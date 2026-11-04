# Document virus scanning: the GuardDuty result bridge (owner decision D1,
# 31 October 2026). Off by default: with enable_document_scanning = false
# nothing here is created and the workload issuer keeps its six callers.
#
# GuardDuty result event -> rule document-scan-results -> SQS (retries, DLQ)
# -> bridge Lambda in the application subnets -> ehr-api over the internal ALB
# (POST scan-targets/resolve, then POST scan-events) with a workload token for
# hid-identity-api minted by the managed issuer. A 15-minute schedule runs the
# same Lambda as reconcile (on-demand scans for documents with no result).
# The bridge never reads object bytes, tags, metadata or the documents key.

locals {
  document_scanner_enabled   = local.managed_identity_enabled && var.enable_document_scanning
  document_scan_name         = "hid-${var.environment}-document-scan-bridge"
  document_bucket_name       = trimprefix(var.document_bucket_arn, "arn:aws:s3:::")
  document_scan_subject      = "hid:${local.workload_identity_environment}:document-scanner"
  document_scan_alarm_prefix = "${var.name_prefix}-document-scan"
  # The results queue's redrive limit. The bridge is told it as well, so that
  # it acknowledges a result for an upload never completed on one of the last
  # two receives instead of sending it to the DLQ.
  document_scan_max_receive_count = 12
  # Bridge metrics (embedded metric format) and their alarms.
  document_scan_metric_alarms = local.document_scanner_enabled ? {
    oldest-pending = { metric = "OldestPendingScanSeconds", statistic = "Maximum", threshold = 3600, period = 900,
    description = "A completed upload has waited more than an hour for a virus scan result." }
    threats-found = { metric = "ThreatsFound", statistic = "Sum", threshold = 0, period = 300,
    description = "GuardDuty found a threat in an uploaded document; it was refused, unless threat-after-terminal fired too." }
    threat-after-terminal = { metric = "ThreatAfterTerminal", statistic = "Sum", threshold = 0, period = 300,
    description = "GuardDuty found a threat in a version that already had a terminal scan result; if that result was clean, the document is still open and must be withdrawn." }
    access-denied = { metric = "ScanAccessDenied", statistic = "Sum", threshold = 0, period = 300,
    description = "GuardDuty could not read or scan a document (configuration fault)." }
    scan-start-failed = { metric = "ScanStartFailed", statistic = "Sum", threshold = 0, period = 900,
    description = "GuardDuty refused or did not answer an on-demand scan request; no attempt was used." }
    reconcile-exhausted = { metric = "ReconcileExhausted", statistic = "Sum", threshold = 0, period = 900,
    description = "Three on-demand scans GuardDuty accepted gave no result for a document; a person must scan it by hand." }
    plan-status = { metric = "PlanStatusProblem", statistic = "Sum", threshold = 0, period = 300,
    description = "GuardDuty reported a warning or error for the malware protection plan." }
    event-refused = { metric = "ScanEventRefused", statistic = "Sum", threshold = 0, period = 300,
    description = "ehr-api refused a scan event the bridge cannot retry; the document stays blocked." }
  } : {}
}

check "document_scanning_prerequisites" {
  assert {
    condition     = !var.enable_document_scanning || local.managed_identity_enabled
    error_message = "enable_document_scanning creates nothing without the managed workload issuer (staging or production with runtime on)."
  }
}

data "archive_file" "document_scan_bridge" {
  count       = local.document_scanner_enabled ? 1 : 0
  type        = "zip"
  source_dir  = "${path.module}/runtime/document-scan-bridge"
  output_path = "${path.root}/.terraform/document-scan-bridge.zip"
}

resource "aws_iam_role" "document_scan_bridge" {
  count              = local.document_scanner_enabled ? 1 : 0
  name_prefix        = "${var.name_prefix}-scan-bridge-"
  description        = "Document scan bridge: workload token, its own queue and on-demand scans; no S3 or KMS"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume[0].json
}

resource "aws_iam_role_policy_attachment" "document_scan_bridge_vpc" {
  count      = local.document_scanner_enabled ? 1 : 0
  role       = aws_iam_role.document_scan_bridge[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Exactly three grants. No S3 and no KMS: the bridge never sees bytes or tags.
resource "aws_iam_role_policy" "document_scan_bridge" {
  count = local.document_scanner_enabled ? 1 : 0
  name  = "document-scan-bridge"
  role  = aws_iam_role.document_scan_bridge[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RequestWorkloadToken"
        Effect   = "Allow"
        Action   = ["execute-api:Invoke"]
        Resource = "${aws_api_gateway_rest_api.workload_issuer[0].execution_arn}/${local.workload_identity_environment}/POST/token"
      },
      {
        Sid      = "ConsumeScanResults"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.document_scan_results[0].arn
      },
      {
        # Resource-level support for this action is unconfirmed offline, so
        # the grant is "*" in this Region only. The scan always runs with the
        # plan's own role, which can read clinical/objects/ only.
        Sid      = "StartOnDemandScans"
        Effect   = "Allow"
        Action   = ["guardduty:SendObjectMalwareScan"]
        Resource = "*"
        Condition = {
          StringEquals = { "aws:RequestedRegion" = var.aws_region }
        }
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "document_scan_bridge" {
  count             = local.document_scanner_enabled ? 1 : 0
  name              = "/hid/${var.environment}/document-scan-bridge"
  retention_in_days = var.security_log_retention_days
}

# Results queue. A result that arrives before /complete, or during an ehr-api
# outage, is retried with a doubling delay for about 41 hours (12 receives),
# then goes to the DLQ, which keeps it for 14 days. A result for an upload
# that is still not completed on one of the last two receives is acknowledged
# by the bridge instead (reconcile scans it if the upload is completed later).
resource "aws_sqs_queue" "document_scan_results_dlq" {
  count                     = local.document_scanner_enabled ? 1 : 0
  name                      = "${var.name_prefix}-document-scan-results-dlq"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "document_scan_results" {
  count                      = local.document_scanner_enabled ? 1 : 0
  name                       = "${var.name_prefix}-document-scan-results"
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = 180
  message_retention_seconds  = 1209600
  receive_wait_time_seconds  = 20
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.document_scan_results_dlq[0].arn
    maxReceiveCount     = local.document_scan_max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "document_scan_results_dlq" {
  count     = local.document_scanner_enabled ? 1 : 0
  queue_url = aws_sqs_queue.document_scan_results_dlq[0].id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.document_scan_results[0].arn]
  })
}

resource "aws_cloudwatch_event_rule" "document_scan_results" {
  count       = local.document_scanner_enabled ? 1 : 0
  name        = "${var.name_prefix}-document-scan-results"
  description = "GuardDuty scan results for clinical/objects/ of the documents bucket"
  event_pattern = jsonencode({
    source        = ["aws.guardduty"]
    "detail-type" = ["GuardDuty Malware Protection Object Scan Result"]
    resources     = [var.malware_protection_plan_arn]
    detail = {
      s3ObjectDetails = {
        bucketName = [local.document_bucket_name]
        objectKey  = [{ prefix = "clinical/objects/" }]
      }
    }
  })
}

resource "aws_cloudwatch_event_target" "document_scan_results" {
  count     = local.document_scanner_enabled ? 1 : 0
  rule      = aws_cloudwatch_event_rule.document_scan_results[0].name
  target_id = "document-scan-results-queue"
  arn       = aws_sqs_queue.document_scan_results[0].arn

  # A result EventBridge cannot deliver lands in the DLQ (and its alarm).
  dead_letter_config {
    arn = aws_sqs_queue.document_scan_results_dlq[0].arn
  }
}

resource "aws_sqs_queue_policy" "document_scan_results" {
  count     = local.document_scanner_enabled ? 1 : 0
  queue_url = aws_sqs_queue.document_scan_results[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sqs:*"
        Resource  = aws_sqs_queue.document_scan_results[0].arn
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "AllowScanResultRule"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.document_scan_results[0].arn
        Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.document_scan_results[0].arn } }
      },
    ]
  })
}

resource "aws_sqs_queue_policy" "document_scan_results_dlq" {
  count     = local.document_scanner_enabled ? 1 : 0
  queue_url = aws_sqs_queue.document_scan_results_dlq[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sqs:*"
        Resource  = aws_sqs_queue.document_scan_results_dlq[0].arn
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "AllowUndeliveredScanResults"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.document_scan_results_dlq[0].arn
        Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.document_scan_results[0].arn } }
      },
    ]
  })
}

# Network: HTTPS to the internal ALB (ehr-api), to the VPC endpoints (SQS) and,
# through the NAT, to the issuer's regional execute-api and the GuardDuty API.
resource "aws_security_group" "document_scan_bridge" {
  count       = local.document_scanner_enabled ? 1 : 0
  name_prefix = "${var.name_prefix}-scan-bridge-"
  description = "Document scan bridge Lambda: HTTPS egress only"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "document_scan_bridge_to_internal_lb" {
  count                        = local.document_scanner_enabled ? 1 : 0
  security_group_id            = aws_security_group.document_scan_bridge[0].id
  referenced_security_group_id = aws_security_group.internal_lb[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_ingress_rule" "internal_lb_from_document_scan_bridge" {
  count                        = local.document_scanner_enabled ? 1 : 0
  security_group_id            = aws_security_group.internal_lb[0].id
  referenced_security_group_id = aws_security_group.document_scan_bridge[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "document_scan_bridge_to_endpoint" {
  count                        = local.document_scanner_enabled ? 1 : 0
  security_group_id            = aws_security_group.document_scan_bridge[0].id
  referenced_security_group_id = var.endpoint_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_ingress_rule" "endpoint_from_document_scan_bridge" {
  count                        = local.document_scanner_enabled ? 1 : 0
  security_group_id            = var.endpoint_security_group_id
  referenced_security_group_id = aws_security_group.document_scan_bridge[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "document_scan_bridge_https" {
  count             = local.document_scanner_enabled ? 1 : 0
  security_group_id = aws_security_group.document_scan_bridge[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_lambda_function" "document_scan_bridge" {
  count = local.document_scanner_enabled ? 1 : 0

  function_name                  = local.document_scan_name
  description                    = "GuardDuty scan results to ehr-api scan events"
  role                           = aws_iam_role.document_scan_bridge[0].arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = "index.handler"
  filename                       = data.archive_file.document_scan_bridge[0].output_path
  source_code_hash               = data.archive_file.document_scan_bridge[0].output_base64sha256
  timeout                        = 30
  memory_size                    = 256
  reserved_concurrent_executions = var.document_scan_bridge_reserved_concurrency

  vpc_config {
    subnet_ids         = var.application_subnet_ids
    security_group_ids = [aws_security_group.document_scan_bridge[0].id]
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.document_scan_bridge[0].name
  }

  environment {
    variables = {
      HID_DEPLOYMENT_ENV          = local.workload_identity_environment
      WORKLOAD_ISSUER_URL         = local.managed_issuer_url
      WORKLOAD_JWKS_URL           = local.managed_jwks_url
      WORKLOAD_SUBJECT            = local.document_scan_subject
      EHR_API_URL                 = local.service_urls["ehr-api"]
      DOCUMENT_BUCKET             = local.document_bucket_name
      OBJECT_PREFIX               = "clinical/objects/"
      MALWARE_PROTECTION_PLAN_ARN = var.malware_protection_plan_arn
      RESULTS_QUEUE_URL           = aws_sqs_queue.document_scan_results[0].url
      RESULTS_MAX_RECEIVE_COUNT   = tostring(local.document_scan_max_receive_count)
      BRIDGE_MODE                 = var.document_scan_bridge_mode
    }
  }

  lifecycle {
    precondition {
      condition     = var.malware_protection_plan_arn != ""
      error_message = "enable_document_scanning needs enable_document_malware_protection: without the GuardDuty plan no result ever arrives."
    }
    precondition {
      condition     = var.enable_ingress && contains(keys(var.workloads), "ehr-api")
      error_message = "The bridge reaches ehr-api through the internal ALB, so it needs enable_ingress and the ehr-api workload."
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.document_scan_bridge,
    aws_iam_role_policy_attachment.document_scan_bridge_vpc,
    aws_iam_role_policy.document_scan_bridge,
  ]
}

# ehr-api's scanner pool has 3 connections: never more than 2 bridges at once.
resource "aws_lambda_event_source_mapping" "document_scan_results" {
  count                   = local.document_scanner_enabled ? 1 : 0
  event_source_arn        = aws_sqs_queue.document_scan_results[0].arn
  function_name           = aws_lambda_function.document_scan_bridge[0].arn
  batch_size              = 5
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2
  }
}

# Reconcile: created disabled; turned on at stage 4 after the backfill.
resource "aws_cloudwatch_event_rule" "document_scan_reconcile" {
  count               = local.document_scanner_enabled ? 1 : 0
  name                = "${var.name_prefix}-document-scan-reconcile"
  description         = "Every 15 minutes: on-demand scans for uploaded documents with no scan result"
  schedule_expression = "rate(15 minutes)"
  state               = var.document_scan_reconcile_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "document_scan_reconcile" {
  count     = local.document_scanner_enabled ? 1 : 0
  rule      = aws_cloudwatch_event_rule.document_scan_reconcile[0].name
  target_id = "document-scan-reconcile"
  arn       = aws_lambda_function.document_scan_bridge[0].arn
  input     = jsonencode({ action = "reconcile" })
}

resource "aws_lambda_permission" "document_scan_reconcile" {
  count         = local.document_scanner_enabled ? 1 : 0
  statement_id  = "AllowReconcileSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.document_scan_bridge[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.document_scan_reconcile[0].arn
}

# Plan status problems go to the bridge, which records PlanStatusProblem for
# the alarm below. The shared alert topic and its key admit only CloudWatch
# alarms, so EventBridge is not given publish rights on them.
resource "aws_cloudwatch_event_rule" "malware_plan_status" {
  count       = local.document_scanner_enabled ? 1 : 0
  name        = "${var.name_prefix}-malware-plan-status"
  description = "GuardDuty Malware Protection plan warnings, errors and failed post-scan tagging"
  event_pattern = jsonencode({
    source = ["aws.guardduty"]
    "detail-type" = [
      "GuardDuty Malware Protection Resource Status Warning",
      "GuardDuty Malware Protection Resource Status Error",
      "GuardDuty Malware Protection Post Scan Action Failed",
    ]
    resources = [var.malware_protection_plan_arn]
  })
}

resource "aws_cloudwatch_event_target" "malware_plan_status" {
  count     = local.document_scanner_enabled ? 1 : 0
  rule      = aws_cloudwatch_event_rule.malware_plan_status[0].name
  target_id = "malware-plan-status"
  arn       = aws_lambda_function.document_scan_bridge[0].arn
}

resource "aws_lambda_permission" "malware_plan_status" {
  count         = local.document_scanner_enabled ? 1 : 0
  statement_id  = "AllowMalwarePlanStatus"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.document_scan_bridge[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.malware_plan_status[0].arn
}

# Alarms. Names start with the name prefix: the alert topic and its key admit
# only alarms named "${var.name_prefix}-*".
resource "aws_cloudwatch_metric_alarm" "document_scan_dlq" {
  count               = local.document_scanner_enabled ? 1 : 0
  alarm_name          = "${var.name_prefix}-document-scan-dead-letters"
  alarm_description   = "A scan result could not be delivered or processed after ${local.document_scan_max_receive_count} attempts; the document stays blocked."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.document_scan_results_dlq[0].name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "document_scan_errors" {
  count               = local.document_scanner_enabled ? 1 : 0
  alarm_name          = "${var.name_prefix}-document-scan-errors"
  alarm_description   = "The document scan bridge Lambda failed (configuration, reconcile listing or a crash)."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.document_scan_bridge[0].function_name }
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "document_scan_metric" {
  for_each            = local.document_scan_metric_alarms
  alarm_name          = "${var.name_prefix}-document-scan-${each.key}"
  alarm_description   = each.value.description
  namespace           = "HID/DocumentScanning"
  metric_name         = each.value.metric
  dimensions          = { Environment = local.workload_identity_environment }
  statistic           = each.value.statistic
  period              = each.value.period
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
}
