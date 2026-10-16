locals {
  staging_identity_enabled = var.enable_runtime && var.environment == "staging"
  staging_callers = {
    for name, requests in(local.staging_identity_enabled ? local.workload_token_requests : {}) : name => {
      role_arn  = aws_iam_role.task[name].arn
      subject   = "hid:staging:${name}"
      audiences = distinct([for request in requests : request.audience])
    }
  }
}

resource "aws_kms_key" "workload_signing" {
  count = local.staging_identity_enabled ? 1 : 0

  description              = "Staging workload identity ES256 signer"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_NIST_P256"
  deletion_window_in_days  = 30
}

resource "aws_kms_alias" "workload_signing" {
  count         = local.staging_identity_enabled ? 1 : 0
  name          = "alias/hid-staging-workload-signing"
  target_key_id = aws_kms_key.workload_signing[0].key_id
}

data "archive_file" "workload_issuer" {
  count       = local.staging_identity_enabled ? 1 : 0
  type        = "zip"
  source_dir  = "${path.module}/runtime/workload-issuer"
  output_path = "${path.root}/.terraform/workload-issuer.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  count = local.staging_identity_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "workload_issuer" {
  count              = local.staging_identity_enabled ? 1 : 0
  name_prefix        = "${var.name_prefix}-workload-issuer-"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume[0].json
}

resource "aws_iam_role_policy_attachment" "workload_issuer_logs" {
  count      = local.staging_identity_enabled ? 1 : 0
  role       = aws_iam_role.workload_issuer[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "workload_issuer_signing" {
  count = local.staging_identity_enabled ? 1 : 0
  name  = "sign-workload-tokens"
  role  = aws_iam_role.workload_issuer[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kms:GetPublicKey"]
        Resource = aws_kms_key.workload_signing[0].arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Sign"]
        Resource = aws_kms_key.workload_signing[0].arn
        Condition = {
          StringEquals = { "kms:SigningAlgorithm" = "ECDSA_SHA_256" }
        }
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "workload_issuer" {
  count             = local.staging_identity_enabled ? 1 : 0
  name              = "/hid/staging/workload-issuer"
  retention_in_days = 14
}

resource "aws_api_gateway_rest_api" "workload_issuer" {
  count       = local.staging_identity_enabled ? 1 : 0
  name        = "hid-staging-workload-identity"
  description = "IAM authenticated short-lived staging workload tokens and public verification keys"

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

locals {
  staging_issuer_url = local.staging_identity_enabled ? "https://${aws_api_gateway_rest_api.workload_issuer[0].id}.execute-api.${var.aws_region}.amazonaws.com/staging" : var.workload_issuer_url
  staging_jwks_url   = local.staging_identity_enabled ? "${local.staging_issuer_url}/.well-known/jwks.json" : var.workload_jwks_url
}

resource "aws_lambda_function" "workload_issuer" {
  count = local.staging_identity_enabled ? 1 : 0

  function_name    = "hid-staging-workload-issuer"
  role             = aws_iam_role.workload_issuer[0].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.workload_issuer[0].output_path
  source_code_hash = data.archive_file.workload_issuer[0].output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      HID_DEPLOYMENT_ENV          = "staging"
      WORKLOAD_SIGNING_KEY_ID     = aws_kms_key.workload_signing[0].arn
      WORKLOAD_ISSUER_URL         = local.staging_issuer_url
      WORKLOAD_API_ID             = aws_api_gateway_rest_api.workload_issuer[0].id
      WORKLOAD_CALLER_POLICY_JSON = jsonencode(values(local.staging_callers))
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.workload_issuer,
    aws_iam_role_policy_attachment.workload_issuer_logs,
    aws_iam_role_policy.workload_issuer_signing
  ]
}

resource "aws_api_gateway_resource" "token" {
  count       = local.staging_identity_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.workload_issuer[0].id
  parent_id   = aws_api_gateway_rest_api.workload_issuer[0].root_resource_id
  path_part   = "token"
}

resource "aws_api_gateway_resource" "well_known" {
  count       = local.staging_identity_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.workload_issuer[0].id
  parent_id   = aws_api_gateway_rest_api.workload_issuer[0].root_resource_id
  path_part   = ".well-known"
}

resource "aws_api_gateway_resource" "jwks" {
  count       = local.staging_identity_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.workload_issuer[0].id
  parent_id   = aws_api_gateway_resource.well_known[0].id
  path_part   = "jwks.json"
}

resource "aws_api_gateway_method" "token" {
  count         = local.staging_identity_enabled ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.workload_issuer[0].id
  resource_id   = aws_api_gateway_resource.token[0].id
  http_method   = "POST"
  authorization = "AWS_IAM"
}

resource "aws_api_gateway_method" "jwks" {
  count         = local.staging_identity_enabled ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.workload_issuer[0].id
  resource_id   = aws_api_gateway_resource.jwks[0].id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "token" {
  count                   = local.staging_identity_enabled ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.workload_issuer[0].id
  resource_id             = aws_api_gateway_resource.token[0].id
  http_method             = aws_api_gateway_method.token[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.workload_issuer[0].invoke_arn
}

resource "aws_api_gateway_integration" "jwks" {
  count                   = local.staging_identity_enabled ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.workload_issuer[0].id
  resource_id             = aws_api_gateway_resource.jwks[0].id
  http_method             = aws_api_gateway_method.jwks[0].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.workload_issuer[0].invoke_arn
}

resource "aws_lambda_permission" "workload_issuer" {
  count         = local.staging_identity_enabled ? 1 : 0
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.workload_issuer[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.workload_issuer[0].execution_arn}/*/*"
}

resource "aws_api_gateway_deployment" "workload_issuer" {
  count       = local.staging_identity_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.workload_issuer[0].id

  triggers = {
    redeployment = sha256(jsonencode([
      aws_api_gateway_method.token[0].id,
      aws_api_gateway_method.jwks[0].id,
      aws_api_gateway_integration.token[0].id,
      aws_api_gateway_integration.jwks[0].id
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "workload_issuer" {
  count         = local.staging_identity_enabled ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.workload_issuer[0].id
  deployment_id = aws_api_gateway_deployment.workload_issuer[0].id
  stage_name    = "staging"
}

resource "aws_api_gateway_method_settings" "workload_issuer" {
  count       = local.staging_identity_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.workload_issuer[0].id
  stage_name  = aws_api_gateway_stage.workload_issuer[0].stage_name
  method_path = "*/*"

  settings {
    metrics_enabled        = true
    logging_level          = "OFF"
    data_trace_enabled     = false
    throttling_rate_limit  = 30
    throttling_burst_limit = 60
  }
}

resource "aws_iam_role_policy" "workload_token_invoke" {
  for_each = local.staging_identity_enabled ? local.workload_token_requests : {}

  name = "request-staging-workload-tokens"
  role = aws_iam_role.task[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["execute-api:Invoke"]
      Resource = "${aws_api_gateway_rest_api.workload_issuer[0].execution_arn}/staging/POST/token"
    }]
  })
}
