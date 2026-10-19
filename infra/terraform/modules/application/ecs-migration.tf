variable "ecs_migration_phase" {
  description = "ECS-only production move: legacy, prepare, drain, active, retired. Shared data/network/IAM identities remain unchanged."
  type        = string
  default     = "legacy"
  validation {
    condition     = contains(["legacy", "prepare", "drain", "active", "retired"], var.ecs_migration_phase)
    error_message = "Unknown ECS migration phase."
  }
}

locals {
  production_ecs_enabled    = var.ecs_migration_phase != "legacy"
  production_ecs_active     = contains(["active", "retired"], var.ecs_migration_phase)
  production_scaling_active = contains(["drain", "active", "retired"], var.ecs_migration_phase)
  legacy_ecs_retired        = var.ecs_migration_phase == "retired"
  background_workers        = toset(["notification-worker", "ocr-worker", "event-dispatcher"])
  legacy_ecs_workloads      = local.legacy_ecs_retired ? {} : local.runtime_workloads
  production_ecs_workloads  = local.production_ecs_enabled ? local.runtime_workloads : {}
  active_ecs_cluster        = local.production_scaling_active ? aws_ecs_cluster.production[0] : aws_ecs_cluster.main[0]
  active_ecs_services       = local.production_scaling_active ? aws_ecs_service.production : aws_ecs_service.workload
  active_ecs_prefix         = local.production_scaling_active ? "hid-production" : var.name_prefix
  active_internal_groups    = local.production_ecs_active ? aws_lb_target_group.production_internal : aws_lb_target_group.internal
  active_gateway_group      = var.enable_ingress ? (local.production_ecs_active ? aws_lb_target_group.production_gateway[0] : aws_lb_target_group.gateway[0]) : null
  scaling_internal_groups   = local.production_scaling_active ? aws_lb_target_group.production_internal : aws_lb_target_group.internal
  scaling_gateway_group     = var.enable_ingress ? (local.production_scaling_active ? aws_lb_target_group.production_gateway[0] : aws_lb_target_group.gateway[0]) : null
}

moved {
  from = aws_ecs_cluster.main
  to   = aws_ecs_cluster.main[0]
}

resource "aws_ecs_cluster" "production" {
  count = local.production_ecs_enabled ? 1 : 0
  name  = "hid-production"
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
  tags = { Environment = "production", Name = "hid-production" }
}

output "ecs_migration_configuration" {
  value = {
    phase                          = var.ecs_migration_phase
    cluster                        = local.active_ecs_cluster.name
    services                       = { for name, service in local.active_ecs_services : name => service.name }
    legacy_cluster_count           = length(aws_ecs_cluster.main)
    legacy_desired_counts          = { for name, service in aws_ecs_service.workload : name => service.desired_count }
    production_desired_counts      = { for name, service in aws_ecs_service.production : name => service.desired_count }
    gateway_scaling_resource_label = try(aws_appautoscaling_policy.request["gateway"].target_tracking_scaling_policy_configuration[0].predefined_metric_specification[0].resource_label, null)
    production_targets = merge({ for name, group in aws_lb_target_group.production_internal : name => group.arn },
    local.production_ecs_enabled && var.enable_ingress ? { gateway = aws_lb_target_group.production_gateway[0].arn } : {})
  }
}

resource "aws_ecs_task_definition" "production" {
  lifecycle {
    precondition {
      condition     = var.deployment_release_valid
      error_message = "Release inventory or lease changed; regenerate the infrastructure plan."
    }
  }
  for_each = local.production_ecs_workloads

  family = "hid-production-${each.key}"
  tags   = { Environment = "production" }
  # Preserve every staging revision so sizing and application changes can roll
  # back to their exact prior definitions. Existing retention elsewhere remains.
  skip_destroy             = true
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  dynamic "volume" {
    for_each = local.managed_identity_enabled && contains(keys(local.workload_token_files), each.key) ? [1] : []
    content {
      name                = "workload-tokens"
      configure_at_launch = false
    }
  }

  container_definitions = jsonencode(concat([
    merge({
      name                   = each.key
      image                  = var.image_uris[each.key]
      essential              = true
      readonlyRootFilesystem = each.key != "gateway"
      environment = [
        for key, value in local.workload_environment[each.key] : {
          name  = key
          value = value
        }
      ]
      secrets = [for spec in local.workload_secret_specs[each.key] : {
        name      = spec.name
        valueFrom = "${spec.arn}:${spec.key}::"
      }]
      portMappings = each.value.port == 0 ? [] : [{
        containerPort = each.value.port
        hostPort      = each.value.port
        protocol      = "tcp"
      }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.workload[each.key].name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = each.key
        }
      }
      }, each.value.port == 0 ? {} : {
      healthCheck = {
        command = each.key == "gateway" ? [
          "CMD", "wget", "-q", "-O", "/dev/null",
          "http://127.0.0.1:${each.value.port}/gateway-health/ready"
          ] : [
          "CMD", "/nodejs/bin/node", "-e",
          "fetch('http://127.0.0.1:${each.value.port}/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        ]
        interval    = 30
        timeout     = 10
        retries     = 3
        startPeriod = 20
      }
      }, {
      # Separate typed comprehensions prevent Terraform from converting the
      # mixed mountPoints/dependsOn object into lists of string-valued maps.
      mountPoints = [for enabled in(local.managed_identity_enabled && contains(keys(local.workload_token_files), each.key) ? [true] : []) : {
        containerPath = local.token_root
        sourceVolume  = "workload-tokens"
        readOnly      = true
      }]
      dependsOn = [for enabled in(local.managed_identity_enabled && contains(keys(local.workload_token_files), each.key) ? [true] : []) : {
        containerName = "workload-token-agent"
        condition     = "HEALTHY"
      }]
    })
    ], local.managed_identity_enabled && contains(keys(local.workload_token_files), each.key) ? [{
      name                   = "workload-token-agent"
      image                  = var.workload_token_agent_image_uri != "" ? var.workload_token_agent_image_uri : var.image_uris["identity-api"]
      command                = ["/app/services/workload-token-agent/src/main.mjs"]
      user                   = "65532:65532"
      readonlyRootFilesystem = true
      essential              = true
      memoryReservation      = 64
      environment = [for key, value in {
        HID_DEPLOYMENT_ENV        = local.workload_identity_environment
        AWS_REGION                = var.aws_region
        WORKLOAD_ISSUER_URL       = local.managed_issuer_url
        WORKLOAD_JWKS_URL         = local.managed_jwks_url
        WORKLOAD_SUBJECT          = "hid:${local.workload_identity_environment}:${each.key}"
        WORKLOAD_TOKEN_DIRECTORY  = local.token_root
        WORKLOAD_TOKEN_FILES_JSON = jsonencode(local.workload_token_requests[each.key])
        } : {
        name  = key
        value = value
      }]
      mountPoints = [{
        containerPath = local.token_root
        sourceVolume  = "workload-tokens"
        readOnly      = false
      }]
      healthCheck = {
        command     = ["CMD", "/nodejs/bin/node", "/app/services/workload-token-agent/src/health.mjs"]
        interval    = 10
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.workload[each.key].name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "workload-token-agent"
        }
      }
  }] : []))

  depends_on = [aws_iam_role_policy_attachment.execution]
}


resource "aws_ecs_service" "production" {
  lifecycle {
    precondition {
      condition     = var.deployment_release_valid
      error_message = "Release inventory or lease changed; refusing a stale service update."
    }
  }
  for_each = local.production_ecs_workloads

  name                               = "hid-production-${each.key}"
  cluster                            = aws_ecs_cluster.production[0].id
  task_definition                    = aws_ecs_task_definition.production[each.key].arn
  desired_count                      = contains(local.background_workers, each.key) && !local.production_ecs_active ? 0 : var.desired_counts[each.key]
  launch_type                        = "FARGATE"
  tags                               = { Environment = "production" }
  enable_execute_command             = false
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"
  health_check_grace_period_seconds  = each.value.port == 0 ? null : 90
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = var.application_subnet_ids
    security_groups  = [aws_security_group.workload[each.key].id]
    assign_public_ip = false
  }

  dynamic "service_registries" {
    for_each = contains(keys(aws_service_discovery_service.workload), each.key) ? [1] : []
    content { registry_arn = aws_service_discovery_service.workload[each.key].arn }
  }

  dynamic "load_balancer" {
    for_each = var.enable_ingress && each.key == "gateway" ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.production_gateway[0].arn
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  dynamic "load_balancer" {
    for_each = var.enable_ingress && contains(keys(local.internal_workloads), each.key) ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.production_internal[each.key].arn
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener_rule.gateway, aws_lb_listener_rule.internal]
}


resource "aws_lb_target_group" "production_internal" {
  for_each = var.enable_ingress && local.production_ecs_enabled ? local.internal_workloads : {}

  name_prefix          = substr(replace(each.key, "-", ""), 0, 6)
  port                 = each.value.port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = each.key == "event-dispatcher" ? 60 : 30

  tags = { Environment = "production" }
  health_check {
    enabled             = true
    path                = "/api/v1/health/ready"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    matcher             = "200"
  }
}


resource "aws_lb_target_group" "production_gateway" {
  count                = var.enable_ingress && local.production_ecs_enabled ? 1 : 0
  name_prefix          = "gate-"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  tags = { Environment = "production" }
  health_check {
    enabled             = true
    path                = "/gateway-health/ready"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    matcher             = "200"
  }
}
