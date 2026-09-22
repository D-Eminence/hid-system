locals {
  name = "health-identity-${var.environment}"
}

data "aws_partition" "current" {}

resource "aws_ecr_repository" "application" {
  name                 = "${local.name}-application"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = "${local.name}.internal"
  description = "Private discovery for Health Identity services"
  vpc         = var.vpc_id
}

resource "aws_service_discovery_service" "application" {
  count = var.enable_application ? 1 : 0
  name  = "application"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"

    dns_records {
      ttl  = 10
      type = "A"
    }
  }

  health_check_custom_config {}
}

resource "aws_cloudwatch_log_group" "application" {
  name              = "/ecs/${local.name}/application"
  retention_in_days = 30
}
