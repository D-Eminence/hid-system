locals {
  generation_model_id = "anthropic.claude-sonnet-4-6"
  generation_profile  = "eu.${local.generation_model_id}"
  embedding_model_id  = "amazon.titan-embed-text-v2:0"

  # Bedrock's EU Sonnet 4.6 profile can route Ireland requests to these regions.
  generation_regions = ["eu-central-1", "eu-north-1", "eu-south-1", "eu-south-2", "eu-west-1", "eu-west-3"]
  generation_arn     = "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/${local.generation_profile}"
  generation_model_arns = [
    for region in local.generation_regions : "arn:aws:bedrock:${region}::foundation-model/${local.generation_model_id}"
  ]
  embedding_arn = "arn:aws:bedrock:${var.aws_region}::foundation-model/${local.embedding_model_id}"
  inference_statements = concat([
    { Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = [local.embedding_arn] }
    ], [for statement in [
      { Effect = "Allow", Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      Resource = [local.generation_arn] },
      { Effect   = "Allow", Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        Resource = local.generation_model_arns,
      Condition = { StringEquals = { "bedrock:InferenceProfileArn" = local.generation_arn } } }
  ] : statement if var.enable_bedrock_generation])
}

data "aws_caller_identity" "current" {}

resource "aws_security_group" "bedrock_endpoint" {
  name_prefix = "${var.name_prefix}-bedrock-"
  description = "Bedrock runtime endpoint HTTPS from the EHR task only"
  vpc_id      = var.vpc_id
  egress      = []
}

resource "aws_vpc_security_group_ingress_rule" "bedrock_from_ehr" {
  count                        = var.enable_runtime ? 1 : 0
  security_group_id            = aws_security_group.bedrock_endpoint.id
  referenced_security_group_id = var.ehr_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "ehr_to_bedrock" {
  count                        = var.enable_runtime ? 1 : 0
  security_group_id            = var.ehr_security_group_id
  referenced_security_group_id = aws_security_group.bedrock_endpoint.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_endpoint" "bedrock_runtime" {
  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.bedrock-runtime"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = var.application_subnet_ids
  security_group_ids  = [aws_security_group.bedrock_endpoint.id]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [for statement in local.inference_statements : merge(statement,
    { Principal = { AWS = var.enable_runtime ? var.ehr_task_role_arn : "*" } })]
  })

  tags = { Name = "${var.name_prefix}-bedrock-runtime" }

  lifecycle {
    precondition {
      condition     = !var.enable_bedrock_generation || var.allow_eu_processing
      error_message = "Sonnet 4.6 may process requests outside Ireland. Approve EU processing before enabling AI."
    }
  }
}

resource "aws_iam_role_policy" "runtime" {
  count = var.enable_runtime ? 1 : 0
  name  = "ai-inference"
  role  = var.ehr_task_role_name

  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.inference_statements
  })
}
