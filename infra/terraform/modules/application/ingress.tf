resource "aws_security_group" "load_balancer" {
  count       = var.enable_application ? 1 : 0
  name_prefix = "${local.name}-alb-"
  description = "HTTPS origin for Cloudflare"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "load_balancer_https" {
  for_each          = var.enable_application ? toset(var.origin_cidrs) : toset([])
  security_group_id = aws_security_group.load_balancer[0].id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "load_balancer_to_app" {
  count                        = var.enable_application ? 1 : 0
  security_group_id            = aws_security_group.load_balancer[0].id
  referenced_security_group_id = var.application_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = var.application_port
  to_port                      = var.application_port
}

resource "aws_vpc_security_group_ingress_rule" "app_from_load_balancer" {
  count                        = var.enable_application ? 1 : 0
  security_group_id            = var.application_security_group_id
  referenced_security_group_id = aws_security_group.load_balancer[0].id
  ip_protocol                  = "tcp"
  from_port                    = var.application_port
  to_port                      = var.application_port
}

resource "aws_lb" "application" {
  count              = var.enable_application ? 1 : 0
  name               = substr("${local.name}-alb", 0, 32)
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.load_balancer[0].id]
  subnets            = var.public_subnet_ids

  enable_deletion_protection = var.environment == "prod"
  drop_invalid_header_fields = true

  lifecycle {
    precondition {
      condition     = length(var.origin_cidrs) > 0 && var.acm_certificate_arn != "" && var.application_image != "" && var.enable_nat
      error_message = "Before enabling the app, provide origin CIDRs, an ACM certificate, an image, and private task egress."
    }
  }
}

resource "aws_lb_target_group" "application" {
  count       = var.enable_application ? 1 : 0
  name        = substr("${local.name}-app", 0, 32)
  port        = var.application_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path                = var.health_check_path
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200-399"
  }
}

resource "aws_lb_listener" "https" {
  count             = var.enable_application ? 1 : 0
  load_balancer_arn = aws_lb.application[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.application[0].arn
  }
}

resource "aws_wafv2_web_acl" "application" {
  count = var.enable_application ? 1 : 0
  name  = "${local.name}-web"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-common-rules"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-common"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-web"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "application" {
  count        = var.enable_application ? 1 : 0
  resource_arn = aws_lb.application[0].arn
  web_acl_arn  = aws_wafv2_web_acl.application[0].arn
}

resource "aws_cloudwatch_log_group" "waf" {
  count             = var.enable_application ? 1 : 0
  name              = "aws-waf-logs-${local.name}"
  retention_in_days = 30
}

resource "aws_wafv2_web_acl_logging_configuration" "application" {
  count                   = var.enable_application ? 1 : 0
  resource_arn            = aws_wafv2_web_acl.application[0].arn
  log_destination_configs = [aws_cloudwatch_log_group.waf[0].arn]
}
