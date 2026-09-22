output "opensearch_endpoint" {
  value = var.enable_opensearch ? aws_opensearch_domain.records[0].endpoint : null
}
