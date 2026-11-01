# Bedrock runtime endpoint in one zone (owner approved 1 November 2026, about
# USD 8 a month). Production's economy profile keeps the endpoint in the first
# application subnet, where its other interface endpoints already are; every
# other profile keeps every application subnet. The endpoint policy is unchanged.
mock_provider "aws" {
  mock_resource "aws_lb" {
    override_during = plan
    defaults = {
      arn_suffix = "app/fixture/id"
      arn        = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:loadbalancer/app/fixture/id"
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:root"
      user_id    = "123456789012"
    }
  }

  mock_data "aws_region" {
    defaults = { region = "eu-west-1" }
  }

  mock_data "aws_ec2_managed_prefix_list" {
    defaults = {
      id   = "pl-12345678"
      name = "com.amazonaws.eu-west-1.s3"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      id   = "mock-policy"
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_resource "aws_api_gateway_rest_api" {
    override_during = plan
    defaults = {
      id            = "abc123"
      execution_arn = "arn:aws:execute-api:eu-west-1:123456789012:abc123"
    }
  }
}

mock_provider "awscc" {}

mock_provider "external" {
  mock_data "external" {
    defaults = { result = { valid = "true" } }
  }
}

# Distinct application subnets, known at plan, so the endpoint's subnet can be checked.
override_resource {
  target          = module.network.aws_subnet.application["0"]
  override_during = plan
  values          = { id = "subnet-0aaaaaaaaaaaaaaa1" }
}

override_resource {
  target          = module.network.aws_subnet.application["1"]
  override_during = plan
  values          = { id = "subnet-0bbbbbbbbbbbbbbb2" }
}


variables {
  expected_account_id           = "123456789012"
  environment                   = "production"
  staging_mode                  = "sleep"
  staging_worker_min_capacity   = 1
  availability_zones            = ["eu-west-1a", "eu-west-1b"]
  public_subnet_cidrs           = ["10.30.0.0/24", "10.30.1.0/24"]
  application_subnet_cidrs      = ["10.30.10.0/24", "10.30.11.0/24"]
  database_subnet_cidrs         = ["10.30.20.0/24", "10.30.21.0/24"]
  enable_database               = true
  enable_runtime                = true
  enable_ingress                = true
  enable_backup_plan            = false
  staging_novu_api_url          = "https://eu.api.novu.co"
  notification_delivery_profile = "email-sms-brevo"
  enable_ai                     = true
  ai_allow_eu_processing        = true
  enable_support_bot            = true
  support_contact               = "mailto:support@example.invalid"
  support_faqs = {
    Help = {
      utterances = ["I need help", "How do I get help"]
      answer     = "Public: https://www.staging.healthidentitydirectory.com/about Patient: https://staging.healthidentitydirectory.com/sign-in"
    }
  }
  rds_ca_bundle_base64     = "dGVzdC1jYS1idW5kbGU="
  regional_certificate_arn = "arn:aws:acm:eu-west-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
  internal_certificate_arn = "arn:aws:acm:eu-west-1:123456789012:certificate/22222222-2222-2222-2222-222222222222"
  cloudflare_origin_secret = "0123456789abcdef0123456789abcdef"
  migration_image_uri      = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ehr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  image_uris = {
    identity-api        = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/identity-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ehr-api             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ehr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    lab-api             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/lab-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    pharmacy-api        = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/pharmacy-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ocr-api             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ocr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ocr-worker          = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ocr-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    outreach-api        = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/outreach-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    notification-api    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/notification-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    notification-worker = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/notification-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    event-dispatcher    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/event-dispatcher@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    support-api         = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/support-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    gateway             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  promote_existing_staging                  = true
  use_existing_secrets                      = true
  production_workload_token_agent_image_uri = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/identity-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  activate_production_runtime               = true
  production_hosts = {
    admin    = "admin.healthidentitydirectory.com"
    web      = "healthidentitydirectory.com"
    ehr      = "ehr.healthidentitydirectory.com"
    lab      = "lab.healthidentitydirectory.com"
    pharmacy = "pharmacy.healthidentitydirectory.com"
    ocr      = "migrate.healthidentitydirectory.com"
    outreach = "outreach.healthidentitydirectory.com"
    public   = "www.healthidentitydirectory.com"
    api      = "api.healthidentitydirectory.com"
  }
  production_api_certificate_arn = "arn:aws:acm:eu-west-1:123456789012:certificate/33333333-3333-3333-3333-333333333333"
  ecs_migration_phase            = "retired"
}

run "production_endpoint_uses_one_zone" {
  command = plan

  assert {
    condition     = local.deployment_profile == "economy" && local.profile.bedrock_endpoint_az_count == 1
    error_message = "Production uses the economy profile, which keeps the Bedrock endpoint in one zone."
  }

  assert {
    condition     = module.ai[0].bedrock_endpoint_subnet_ids == toset(["subnet-0aaaaaaaaaaaaaaa1"])
    error_message = "The Bedrock endpoint must keep only the first application subnet (eu-west-1a)."
  }

  assert {
    condition     = module.ai[0].bedrock_endpoint_subnet_ids == toset(slice(module.network.application_subnet_ids, 0, local.profile.interface_endpoint_az_count))
    error_message = "The Bedrock endpoint must sit in the same subnet as production's other interface endpoints."
  }

  assert {
    condition = alltrue([for name, profile in local.profiles :
      name == "economy" ? profile.bedrock_endpoint_az_count == 1 : profile.bedrock_endpoint_az_count == null
    ])
    error_message = "Only the economy profile may narrow the Bedrock endpoint; the others keep every application subnet."
  }
}

run "endpoint_follows_the_given_subnets_and_keeps_its_policy" {
  command = plan

  module {
    source = "./modules/ai"
  }

  variables {
    name_prefix               = "hid-staging"
    aws_region                = "eu-west-1"
    vpc_id                    = "vpc-12345678"
    endpoint_subnet_ids       = ["subnet-0aaaaaaaaaaaaaaa1", "subnet-0bbbbbbbbbbbbbbb2"]
    enable_runtime            = true
    ehr_security_group_id     = "sg-0123456789abcdef0"
    ehr_task_role_arn         = "arn:aws:iam::123456789012:role/hid-staging-ehr-api-task"
    ehr_task_role_name        = "hid-staging-ehr-api-task"
    allow_eu_processing       = true
    enable_bedrock_generation = true
  }

  assert {
    condition     = aws_vpc_endpoint.bedrock_runtime.subnet_ids == toset(["subnet-0aaaaaaaaaaaaaaa1", "subnet-0bbbbbbbbbbbbbbb2"])
    error_message = "Profiles that keep every application subnet must keep the endpoint in both zones."
  }

  assert {
    condition = jsondecode(aws_vpc_endpoint.bedrock_runtime.policy) == {
      Version = "2012-10-17"
      Statement = [for statement in local.inference_statements : merge(statement,
      { Principal = { AWS = "arn:aws:iam::123456789012:role/hid-staging-ehr-api-task" } })]
    }
    error_message = "The endpoint policy must still admit only the EHR task role, for the approved models only."
  }

  assert {
    condition = jsonencode(sort(flatten([for statement in jsondecode(aws_vpc_endpoint.bedrock_runtime.policy).Statement : statement.Resource]))) == jsonencode(sort(concat(
      ["arn:aws:bedrock:eu-west-1::foundation-model/amazon.titan-embed-text-v2:0",
      "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-sonnet-4-6"],
      [for region in ["eu-central-1", "eu-north-1", "eu-south-1", "eu-south-2", "eu-west-1", "eu-west-3"] :
      "arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-4-6"]
    )))
    error_message = "The endpoint may reach only Titan embeddings and the EU Sonnet 4.6 profile and its models."
  }
}

run "endpoint_needs_a_subnet" {
  command = plan

  module {
    source = "./modules/ai"
  }

  variables {
    name_prefix               = "hid-staging"
    aws_region                = "eu-west-1"
    vpc_id                    = "vpc-12345678"
    endpoint_subnet_ids       = []
    enable_runtime            = true
    ehr_security_group_id     = "sg-0123456789abcdef0"
    ehr_task_role_arn         = "arn:aws:iam::123456789012:role/hid-staging-ehr-api-task"
    ehr_task_role_name        = "hid-staging-ehr-api-task"
    allow_eu_processing       = true
    enable_bedrock_generation = true
  }

  expect_failures = [var.endpoint_subnet_ids]
}
