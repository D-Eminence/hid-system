locals {
  runtime_workloads = var.enable_runtime ? var.workloads : {}
  api_workloads     = { for name, workload in local.runtime_workloads : name => workload if workload.browser_routed && name != "gateway" }
  database_workloads = {
    for name, workload in local.runtime_workloads : name => workload if workload.database_connections > 0
  }
  service_host_labels = {
    identity-api     = "identity", ehr-api = "ehr", lab-api = "lab", pharmacy-api = "pharmacy"
    ocr-api          = "ocr", outreach-api = "outreach", event-dispatcher = "dispatcher"
    notification-api = "notification", notification-worker = "notification-worker"
  }
  internal_workloads = { for name, label in local.service_host_labels : name => var.workloads[name] if var.enable_runtime }
  private_zone_name  = "internal.${var.environment}.${var.root_domain_name}"
}

resource "aws_ecr_repository" "workload" {
  for_each = var.workloads

  name                 = "${var.environment}/hid/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.environment == "development"

  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}

resource "aws_ecr_lifecycle_policy" "workload" {
  for_each   = aws_ecr_repository.workload
  repository = each.value.name
  policy = jsonencode({ rules = [
    {
      rulePriority = 1, description = "Expire untagged build residue"
      selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 7 }
      action       = { type = "expire" }
    },
    {
      rulePriority = 2, description = "Bound retained immutable releases"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = var.repository_image_count }
      action       = { type = "expire" }
    }
  ] })
}

resource "aws_ecs_cluster" "main" {
  name = var.name_prefix
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = "services.${var.environment}.hid"
  description = "Private HID service discovery"
  vpc         = var.vpc_id
}

resource "aws_service_discovery_service" "workload" {
  for_each = { for name, workload in local.runtime_workloads : name => workload if !contains(["gateway", "ocr-worker"], name) }

  name = each.key
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

resource "aws_security_group" "workload" {
  for_each = local.runtime_workloads

  name_prefix = "${var.name_prefix}-${each.key}-"
  description = "Network boundary for ${each.key}"
  vpc_id      = var.vpc_id
  egress      = []
}

resource "aws_vpc_security_group_ingress_rule" "endpoint_from_workload" {
  for_each = local.runtime_workloads

  security_group_id            = var.endpoint_security_group_id
  referenced_security_group_id = aws_security_group.workload[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "workload_to_endpoint" {
  for_each = local.runtime_workloads

  security_group_id            = aws_security_group.workload[each.key].id
  referenced_security_group_id = var.endpoint_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "workload_to_s3" {
  for_each = local.runtime_workloads

  security_group_id = aws_security_group.workload[each.key].id
  prefix_list_id    = var.s3_prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "provider_https" {
  for_each = { for name, workload in local.runtime_workloads : name => workload if !contains(["gateway", "ocr-worker", "event-dispatcher"], name) }

  security_group_id = aws_security_group.workload[each.key].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "workload_to_database" {
  for_each = var.database_enabled ? local.database_workloads : {}

  security_group_id            = aws_security_group.workload[each.key].id
  referenced_security_group_id = var.database_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "database_from_workload" {
  for_each = var.database_enabled ? local.database_workloads : {}

  security_group_id            = var.database_security_group_id
  referenced_security_group_id = aws_security_group.workload[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "gateway_to_api" {
  for_each = var.enable_runtime ? local.api_workloads : {}

  security_group_id            = aws_security_group.workload["gateway"].id
  referenced_security_group_id = aws_security_group.workload[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}

resource "aws_vpc_security_group_ingress_rule" "api_from_gateway" {
  for_each = var.enable_runtime ? local.api_workloads : {}

  security_group_id            = aws_security_group.workload[each.key].id
  referenced_security_group_id = aws_security_group.workload["gateway"].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}
