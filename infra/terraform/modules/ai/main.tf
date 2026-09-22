locals {
  name = "health-identity-${var.environment}"
}

data "aws_partition" "current" {}

resource "aws_security_group" "opensearch" {
  count       = var.enable_opensearch ? 1 : 0
  name_prefix = "${local.name}-search-"
  description = "Private OpenSearch access from application tasks"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "search_from_app" {
  count                        = var.enable_opensearch ? 1 : 0
  security_group_id            = aws_security_group.opensearch[0].id
  referenced_security_group_id = var.application_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "app_to_search" {
  count                        = var.enable_application && var.enable_opensearch ? 1 : 0
  security_group_id            = var.application_security_group_id
  referenced_security_group_id = aws_security_group.opensearch[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

data "aws_iam_policy_document" "opensearch_access" {
  count = var.enable_opensearch ? 1 : 0

  statement {
    actions   = ["es:ESHttpGet", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpDelete"]
    resources = ["arn:${data.aws_partition.current.partition}:es:${var.aws_region}:${var.expected_account_id}:domain/${local.name}/*"]

    principals {
      type        = "AWS"
      identifiers = [var.application_role_arn]
    }
  }
}

resource "aws_opensearch_domain" "records" {
  count           = var.enable_opensearch ? 1 : 0
  domain_name     = local.name
  engine_version  = var.opensearch_engine_version
  access_policies = data.aws_iam_policy_document.opensearch_access[0].json

  cluster_config {
    instance_type          = var.opensearch_instance_type
    instance_count         = var.environment == "prod" ? 2 : 1
    zone_awareness_enabled = var.environment == "prod"

    dynamic "zone_awareness_config" {
      for_each = var.environment == "prod" ? [1] : []
      content {
        availability_zone_count = 2
      }
    }
  }

  ebs_options {
    ebs_enabled = true
    volume_size = 20
    volume_type = "gp2"
  }

  vpc_options {
    subnet_ids         = var.environment == "prod" ? var.app_subnet_ids : [var.app_subnet_ids[0]]
    security_group_ids = [aws_security_group.opensearch[0].id]
  }

  encrypt_at_rest {
    enabled    = true
    kms_key_id = var.kms_key_arn
  }

  node_to_node_encryption {
    enabled = true
  }

  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-2019-07"
  }
}

data "aws_iam_policy_document" "application_ai" {
  count = var.enable_opensearch || length(var.bedrock_model_arns) > 0 ? 1 : 0

  dynamic "statement" {
    for_each = length(var.bedrock_model_arns) > 0 ? [1] : []
    content {
      sid       = "BedrockInference"
      actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
      resources = var.bedrock_model_arns
    }
  }

  dynamic "statement" {
    for_each = var.enable_opensearch ? [1] : []
    content {
      sid       = "OpenSearchHttp"
      actions   = ["es:ESHttpGet", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpDelete"]
      resources = ["arn:${data.aws_partition.current.partition}:es:${var.aws_region}:${var.expected_account_id}:domain/${local.name}/*"]
    }
  }
}

resource "aws_iam_role_policy" "application_ai" {
  count  = var.enable_opensearch || length(var.bedrock_model_arns) > 0 ? 1 : 0
  name   = "${local.name}-ai"
  role   = var.application_role_name
  policy = data.aws_iam_policy_document.application_ai[0].json
}
