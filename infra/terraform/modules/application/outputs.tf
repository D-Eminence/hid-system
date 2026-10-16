output "ecr_repository_urls" { value = { for name, repository in aws_ecr_repository.workload : name => repository.repository_url } }
output "ecs_cluster_name" { value = aws_ecs_cluster.main.name }
output "public_api_origin" { value = try("https://${aws_lb.public[0].dns_name}", null) }
output "public_load_balancer_dns_name" { value = try(aws_lb.public[0].dns_name, null) }
output "migration_task_definition_arn" { value = try(aws_ecs_task_definition.migration[0].arn, null) }
output "migration_security_group_id" { value = try(aws_security_group.migration[0].id, null) }
output "application_subnet_ids" { value = var.application_subnet_ids }
