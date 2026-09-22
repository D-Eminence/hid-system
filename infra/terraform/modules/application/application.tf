data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "application" {
  name               = "${local.name}-application"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "application" {
  statement {
    sid       = "Documents"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${var.document_bucket_arn}/*"]
  }

  statement {
    sid       = "DocumentListing"
    actions   = ["s3:ListBucket"]
    resources = [var.document_bucket_arn]
  }

  statement {
    sid       = "DocumentEncryption"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [var.kms_key_arn]
  }

}

resource "aws_iam_role_policy" "application" {
  name   = "${local.name}-application"
  role   = aws_iam_role.application.id
  policy = data.aws_iam_policy_document.application.json
}

data "aws_iam_policy_document" "ecs_secrets" {
  count = length(var.application_secret_arns) > 0 ? 1 : 0

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = values(var.application_secret_arns)
  }
}

resource "aws_iam_role_policy" "ecs_secrets" {
  count  = length(var.application_secret_arns) > 0 ? 1 : 0
  name   = "${local.name}-ecs-secrets"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.ecs_secrets[0].json
}

resource "aws_vpc_security_group_egress_rule" "app_https" {
  count             = var.enable_application ? 1 : 0
  security_group_id = var.application_security_group_id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "app_postgres" {
  count                        = var.enable_application && var.enable_database ? 1 : 0
  security_group_id            = var.application_security_group_id
  referenced_security_group_id = var.database_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_ecs_task_definition" "application" {
  count                    = var.enable_application ? 1 : 0
  family                   = "${local.name}-application"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.application.arn

  container_definitions = jsonencode([{
    name      = "application"
    image     = var.application_image
    essential = true
    portMappings = [{
      containerPort = var.application_port
      hostPort      = var.application_port
      protocol      = "tcp"
    }]
    secrets = [for name, arn in var.application_secret_arns : {
      name      = name
      valueFrom = arn
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.application.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "application"
      }
    }
  }])

  depends_on = [aws_iam_role_policy_attachment.ecs_execution]
}

resource "aws_ecs_service" "application" {
  count           = var.enable_application ? 1 : 0
  name            = "${local.name}-application"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.application[0].arn
  desired_count   = max(var.desired_task_count, var.environment == "prod" ? 2 : 1)
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [var.application_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.application[0].arn
    container_name   = "application"
    container_port   = var.application_port
  }

  service_registries {
    registry_arn = aws_service_discovery_service.application[0].arn
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.https]
}

resource "aws_appautoscaling_target" "application" {
  count              = var.enable_application ? 1 : 0
  max_capacity       = var.environment == "prod" ? 6 : 2
  min_capacity       = var.environment == "prod" ? 2 : 1
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.application[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "application_cpu" {
  count              = var.enable_application ? 1 : 0
  name               = "${local.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.application[0].resource_id
  scalable_dimension = aws_appautoscaling_target.application[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.application[0].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
