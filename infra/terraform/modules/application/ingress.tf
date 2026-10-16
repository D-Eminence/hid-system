resource "aws_route53_zone" "internal" {
  count = var.enable_ingress ? 1 : 0
  name  = local.private_zone_name

  vpc {
    vpc_id = var.vpc_id
  }
}

resource "aws_security_group" "internal_lb" {
  count       = var.enable_ingress ? 1 : 0
  name_prefix = "${var.name_prefix}-internal-lb-"
  description = "Internal HTTPS boundary for service-to-service calls"
  vpc_id      = var.vpc_id
  egress      = []
}

resource "aws_lb" "internal" {
  count                      = var.enable_ingress ? 1 : 0
  name                       = substr("${var.name_prefix}-internal", 0, 32)
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.internal_lb[0].id]
  subnets                    = var.application_subnet_ids
  enable_deletion_protection = var.environment == "production"
  drop_invalid_header_fields = true
}

resource "aws_lb_listener" "internal_https" {
  count             = var.enable_ingress ? 1 : 0
  load_balancer_arn = aws_lb.internal[0].arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.internal_certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "application/json"
      message_body = jsonencode({ title = "Not found", status = 404 })
      status_code  = "404"
    }
  }
}

resource "aws_lb_target_group" "internal" {
  for_each = var.enable_ingress ? local.internal_workloads : {}

  name_prefix          = substr(replace(each.key, "-", ""), 0, 6)
  port                 = each.value.port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = each.key == "event-dispatcher" ? 60 : 30

  health_check {
    enabled             = true
    path                = "/api/v1/health/ready"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    matcher             = "200"
  }
}

resource "aws_lb_listener_rule" "internal" {
  for_each = var.enable_ingress ? local.internal_workloads : {}

  listener_arn = aws_lb_listener.internal_https[0].arn
  priority     = 10 + index(sort(keys(local.internal_workloads)), each.key)

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.internal[each.key].arn
  }

  condition {
    host_header {
      values = ["${local.service_host_labels[each.key]}.${local.private_zone_name}"]
    }
  }
}

resource "aws_route53_record" "internal" {
  for_each = var.enable_ingress ? local.internal_workloads : {}

  zone_id = aws_route53_zone.internal[0].zone_id
  name    = local.service_host_labels[each.key]
  type    = "A"

  alias {
    name                   = aws_lb.internal[0].dns_name
    zone_id                = aws_lb.internal[0].zone_id
    evaluate_target_health = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "workload_from_internal_lb" {
  for_each = var.enable_ingress ? local.internal_workloads : {}

  security_group_id            = aws_security_group.workload[each.key].id
  referenced_security_group_id = aws_security_group.internal_lb[0].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}

resource "aws_vpc_security_group_egress_rule" "internal_lb_to_workload" {
  for_each = var.enable_ingress ? local.internal_workloads : {}

  security_group_id            = aws_security_group.internal_lb[0].id
  referenced_security_group_id = aws_security_group.workload[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}

resource "aws_vpc_security_group_egress_rule" "workload_to_internal_lb" {
  for_each = var.enable_ingress ? { for name, workload in local.runtime_workloads : name => workload if !contains(["gateway", "ocr-worker", "event-dispatcher"], name) } : {}

  security_group_id            = aws_security_group.workload[each.key].id
  referenced_security_group_id = aws_security_group.internal_lb[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_ingress_rule" "internal_lb_from_workload" {
  for_each = var.enable_ingress ? { for name, workload in local.runtime_workloads : name => workload if !contains(["gateway", "ocr-worker", "event-dispatcher"], name) } : {}

  security_group_id            = aws_security_group.internal_lb[0].id
  referenced_security_group_id = aws_security_group.workload[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_security_group" "public_lb" {
  count       = var.enable_ingress ? 1 : 0
  name_prefix = "${var.name_prefix}-public-lb-"
  description = "Cloudflare API origin over HTTPS; WAF authenticates the origin header"
  vpc_id      = var.vpc_id
  egress      = []
}

resource "aws_vpc_security_group_ingress_rule" "public_https_ipv4" {
  count             = var.enable_ingress ? 1 : 0
  security_group_id = aws_security_group.public_lb[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "public_https_ipv6" {
  count             = var.enable_ingress ? 1 : 0
  security_group_id = aws_security_group.public_lb[0].id
  cidr_ipv6         = "::/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "public_lb_to_gateway" {
  count                        = var.enable_ingress ? 1 : 0
  security_group_id            = aws_security_group.public_lb[0].id
  referenced_security_group_id = aws_security_group.workload["gateway"].id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_vpc_security_group_ingress_rule" "gateway_from_public_lb" {
  count                        = var.enable_ingress ? 1 : 0
  security_group_id            = aws_security_group.workload["gateway"].id
  referenced_security_group_id = aws_security_group.public_lb[0].id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_lb" "public" {
  count                      = var.enable_ingress ? 1 : 0
  name                       = substr("${var.name_prefix}-public", 0, 32)
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.public_lb[0].id]
  subnets                    = var.public_subnet_ids
  ip_address_type            = "dualstack"
  enable_deletion_protection = var.environment == "production"
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "gateway" {
  count                = var.enable_ingress ? 1 : 0
  name_prefix          = "gate-"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/gateway-health/ready"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    matcher             = "200"
  }
}

resource "aws_lb_listener" "public_https" {
  count             = var.enable_ingress ? 1 : 0
  load_balancer_arn = aws_lb.public[0].arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.regional_certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "application/json"
      message_body = jsonencode({ title = "Service unavailable", status = 503 })
      status_code  = "503"
    }
  }
}

resource "aws_lb_listener_rule" "gateway" {
  count        = var.enable_ingress ? 1 : 0
  listener_arn = aws_lb_listener.public_https[0].arn
  priority     = 1

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway[0].arn
  }

  condition {
    path_pattern {
      values = ["/*"]
    }
  }
}

resource "aws_wafv2_web_acl" "origin" {
  count = var.enable_ingress ? 1 : 0
  name  = "${var.name_prefix}-api-origin"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name_prefix}-api-origin"
    sampled_requests_enabled   = false
  }

  rule {
    name     = "RequireCloudflareOriginSecret"
    priority = 0

    action {
      block {}
    }

    statement {
      not_statement {
        statement {
          byte_match_statement {
            positional_constraint = "EXACTLY"
            search_string         = var.cloudflare_origin_secret

            field_to_match {
              single_header {
                name = "x-hid-origin-authorization"
              }
            }

            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-origin-auth"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "AwsCommonRules"
    priority = 10

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
      metric_name                = "AwsCommonRules"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "AwsKnownBadInputs"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AwsKnownBadInputs"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "ApiOriginRateLimit"
    priority = 30

    action {
      block {}
    }

    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 2000
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-origin-rate"
      sampled_requests_enabled   = false
    }
  }
}

resource "aws_wafv2_web_acl_association" "origin" {
  count        = var.enable_ingress ? 1 : 0
  resource_arn = aws_lb.public[0].arn
  web_acl_arn  = aws_wafv2_web_acl.origin[0].arn
}
