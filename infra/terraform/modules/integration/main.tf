locals {
  name = "health-identity-${var.environment}"
}

resource "aws_security_group" "api_link" {
  count       = var.enable_provider_api ? 1 : 0
  name_prefix = "${local.name}-api-link-"
  description = "API Gateway VPC link to the application load balancer"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "api_link_https" {
  count                        = var.enable_provider_api ? 1 : 0
  security_group_id            = aws_security_group.api_link[0].id
  referenced_security_group_id = var.load_balancer_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_ingress_rule" "load_balancer_from_api" {
  count                        = var.enable_provider_api ? 1 : 0
  security_group_id            = var.load_balancer_security_group_id
  referenced_security_group_id = aws_security_group.api_link[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_apigatewayv2_vpc_link" "provider" {
  count              = var.enable_provider_api ? 1 : 0
  name               = "${local.name}-provider"
  subnet_ids         = var.app_subnet_ids
  security_group_ids = [aws_security_group.api_link[0].id]
}

resource "aws_apigatewayv2_api" "provider" {
  count         = var.enable_provider_api ? 1 : 0
  name          = "${local.name}-provider"
  protocol_type = "HTTP"

  lifecycle {
    precondition {
      condition     = var.enable_application && var.provider_jwt_issuer != "" && length(var.provider_jwt_audience) > 0 && var.origin_server_name != ""
      error_message = "The provider API needs the application, origin server name, and an approved JWT issuer and audience."
    }
  }
}

resource "aws_apigatewayv2_authorizer" "provider" {
  count            = var.enable_provider_api ? 1 : 0
  api_id           = aws_apigatewayv2_api.provider[0].id
  authorizer_type  = "JWT"
  name             = "provider-jwt"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    audience = var.provider_jwt_audience
    issuer   = var.provider_jwt_issuer
  }
}

resource "aws_apigatewayv2_integration" "provider" {
  count              = var.enable_provider_api ? 1 : 0
  api_id             = aws_apigatewayv2_api.provider[0].id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = var.load_balancer_listener_arn
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.provider[0].id

  tls_config {
    server_name_to_verify = var.origin_server_name
  }

  request_parameters = {
    "overwrite:path" = "$request.path"
  }
}

resource "aws_apigatewayv2_route" "provider" {
  count              = var.enable_provider_api ? 1 : 0
  api_id             = aws_apigatewayv2_api.provider[0].id
  route_key          = "ANY /fhir/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.provider[0].id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.provider[0].id
}

resource "aws_cloudwatch_log_group" "provider_api" {
  count             = var.enable_provider_api ? 1 : 0
  name              = "/apigateway/${local.name}/provider"
  retention_in_days = 30
}

resource "aws_apigatewayv2_stage" "provider" {
  count       = var.enable_provider_api ? 1 : 0
  api_id      = aws_apigatewayv2_api.provider[0].id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.provider_api[0].arn
    format          = jsonencode({ requestId = "$context.requestId", routeKey = "$context.routeKey", status = "$context.status", sourceIp = "$context.identity.sourceIp" })
  }
}
