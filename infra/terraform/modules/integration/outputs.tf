output "provider_api_endpoint" {
  value = var.enable_provider_api ? aws_apigatewayv2_api.provider[0].api_endpoint : null
}
