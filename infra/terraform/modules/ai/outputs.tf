output "bedrock_endpoint_id" {
  value = aws_vpc_endpoint.bedrock_runtime.id
}
output "bedrock_inference_policy" {
  description = "Exact model permissions used by both the EHR role and endpoint; contains no credentials."
  value       = { Version = "2012-10-17", Statement = local.inference_statements }
}
