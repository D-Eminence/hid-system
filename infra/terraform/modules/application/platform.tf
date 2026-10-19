locals {
  # An empty runtime_workloads map prevents task-level resources from being
  # created until the runtime activation gate is enabled.
  runtime_workloads = var.enable_runtime ? var.workloads : {}
  api_workloads = {
    for name, workload in local.runtime_workloads : name => workload
    if workload.browser_routed && name != "gateway"
  }
  database_workloads = {
    for name, workload in local.runtime_workloads : name => workload if workload.database_connections > 0
  }
  service_host_labels = {
    identity-api        = "identity"
    ehr-api             = "ehr"
    lab-api             = "lab"
    pharmacy-api        = "pharmacy"
    ocr-api             = "ocr"
    outreach-api        = "outreach"
    event-dispatcher    = "dispatcher"
    notification-api    = "notification"
    notification-worker = "notification-worker"
    support-api         = "support"
  }
  internal_workloads = {
    for name, label in local.service_host_labels : name => var.workloads[name]
    if var.enable_runtime && contains(keys(var.workloads), name)
  }
  private_zone_name = "internal.${var.environment}.${var.root_domain_name}"
  internal_lb_callers = {
    for name, workload in local.runtime_workloads : name => workload
    if !contains(["gateway", "ocr-worker", "event-dispatcher"], name)
  }
}

# One immutable registry per application workload
resource "aws_ecr_repository" "workload" {
  for_each = setunion(toset(keys(var.workloads)), var.registry_workload_names)

  name                 = "${var.environment}/hid/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.environment == "development"

  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}

locals {
  # Manual production releases need the same live/rollback image protection as
  # automated releases. This creates no deployment roles or release resources.
  protect_release_images = var.enable_deployment_automation || var.deployment_release_environment == "production"
}

resource "aws_ecr_lifecycle_policy" "workload" {
  for_each   = aws_ecr_repository.workload
  repository = each.value.name
  policy = jsonencode({ rules = concat(local.protect_release_images ? [{
    rulePriority = 1
    description  = "Protect named live and rollback digests from lower priority cleanup"
    selection = {
      tagStatus     = "tagged"
      tagPrefixList = ["retain-"]
      countType     = "imageCountMoreThan"
      countNumber   = 1000000
    }
    action = { type = "expire" }
    }] : [], [
    {
      rulePriority = local.protect_release_images ? 2 : 1
      description  = "Expire untagged build residue"
      selection = {
        tagStatus   = "untagged"
        countType   = "sinceImagePushed"
        countUnit   = "days"
        countNumber = 7
      }
      action = {
        type = "expire"
      }
    },
    {
      rulePriority = local.protect_release_images ? 3 : 2
      description  = "Bound retained immutable releases"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = var.repository_image_count
      }
      action = {
        type = "expire"
      }
    }
  ]) })
}

resource "aws_ecs_cluster" "main" {
  count = local.legacy_ecs_retired ? 0 : 1
  name  = var.name_prefix
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

# Private DNS registration for service discovery
resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = "services.${var.environment}.hid"
  description = "Private HID service discovery"
  vpc         = var.vpc_id
}

resource "aws_service_discovery_service" "workload" {
  for_each = {
    for name, workload in local.runtime_workloads : name => workload
    if !contains(["gateway", "ocr-worker"], name)
  }

  name = each.key
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
  # An empty block is omitted by AWS. Explicit threshold enables ECS-managed
  # custom health for private service discovery.
  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_security_group" "workload" {
  for_each = local.runtime_workloads

  name_prefix = "${var.name_prefix}-${each.key}-"
  description = "Network boundary for ${each.key}"
  vpc_id      = var.vpc_id
  # Rules are owned by standalone resources below; inline empty rules would
  # remove those existing connections on the next Terraform refresh/apply.
}

# Workload access to private AWS endpoints and S3
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
  for_each = local.internal_lb_callers

  security_group_id = aws_security_group.workload[each.key].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# Workload access to PostgreSQL
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
  for_each = local.api_workloads

  security_group_id            = aws_security_group.workload["gateway"].id
  referenced_security_group_id = aws_security_group.workload[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}

resource "aws_vpc_security_group_ingress_rule" "api_from_gateway" {
  for_each = local.api_workloads

  security_group_id            = aws_security_group.workload[each.key].id
  referenced_security_group_id = aws_security_group.workload["gateway"].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}
