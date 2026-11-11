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
    defaults = {
      region = "eu-west-1"
    }
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

override_resource {
  target          = module.application.aws_lb_target_group.gateway[0]
  override_during = plan
  values = {
    arn_suffix = "targetgroup/legacy-gateway/id"
    arn        = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/legacy-gateway/id"
  }
}
override_resource {
  target          = module.application.aws_lb_target_group.production_gateway[0]
  override_during = plan
  values = {
    arn_suffix = "targetgroup/production-gateway/id"
    arn        = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/production-gateway/id"
  }
}

# The Lex bot and alias IDs come from the support bot's CloudFormation stack.
# Known synthetic values let the plan render the support-api containers.
override_resource {
  target          = module.support_bot[0].aws_cloudformation_stack.support
  override_during = plan
  values = {
    outputs = {
      BotId    = "SUPPORTBOT"
      AliasId  = "SUPPORTALS"
      AliasArn = "arn:aws:lex:eu-west-1:123456789012:bot-alias/SUPPORTBOT/SUPPORTALS"
    }
  }
}

mock_provider "external" {
  mock_data "external" {
    defaults = { result = { valid = "true" } }
  }
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
}

# support-api checks every support chat message against issued Health IDs
# through identity-api's internal service route before any text reaches Lex
# (owner decision of 2026-10-31). It becomes a workload caller exactly like
# outreach-api: an identity.jwt from the workload-token-agent sidecar and the
# internal identity URL. Everything stays behind enable_support_bot, which is
# on in production, so the variables above mirror production.tfvars (the
# promoted stack, the retained hid:staging: issuer namespace, legacy ECS
# retired). Names only: no role ARNs, tokens or secrets are read.

run "support_bot_off_adds_no_caller" {
  command = plan
  variables {
    enable_support_bot  = false
    ecs_migration_phase = "retired"
  }

  assert {
    condition = jsonencode(sort(keys(module.application.workload_caller_policy))) == jsonencode([
      "hid:staging:ehr-api",
      "hid:staging:identity-api",
      "hid:staging:lab-api",
      "hid:staging:ocr-api",
      "hid:staging:outreach-api",
      "hid:staging:pharmacy-api",
    ])
    error_message = "With the support bot off the issuer keeps exactly the six ECS callers."
  }

  assert {
    condition = jsonencode(sort(keys(module.application.support_identity_check.identity_caller_subjects))) == jsonencode([
      "IDENTITY_EHR_CALLER_SUBJECT",
      "IDENTITY_LAB_CALLER_SUBJECT",
      "IDENTITY_OCR_CALLER_SUBJECT",
      "IDENTITY_PHARMACY_CALLER_SUBJECT",
      "OUTREACH_CALLER_SUBJECT",
    ])
    error_message = "With the support bot off identity-api must not gain IDENTITY_SUPPORT_CALLER_SUBJECT, so its task definition does not change."
  }

  assert {
    condition = (
      !contains(keys(module.application.support_identity_check.support_environment), "IDENTITY_API_URL") &&
      !contains(keys(module.application.support_identity_check.support_environment), "IDENTITY_SUPPORT_WORKLOAD_TOKEN_FILE") &&
      !contains(keys(module.application.support_identity_check.support_environment), "IDENTITY_SERVICE_IDENTITY_MODE") &&
      length(module.application.support_identity_check.token_requests) == 0 &&
      length(module.application.support_identity_check.task_containers) == 0 &&
      length(module.application.support_identity_check.token_invoke_resources) == 0 &&
      module.application.support_identity_check.network.to_internal_lb == null
    )
    error_message = "With the support bot off there is no support-api task, token request, token policy or network rule."
  }
}

run "support_api_calls_identity_with_a_workload_token" {
  command = plan
  variables { ecs_migration_phase = "retired" }

  assert {
    condition = (
      length(module.application.workload_caller_policy) == 7 &&
      length(module.application.workload_caller_policy) <= 8 &&
      jsonencode(module.application.workload_caller_policy["hid:staging:support-api"]) == jsonencode(["hid-identity-api"])
    )
    error_message = "support-api must be one more issuer caller (seven with the six ECS callers), for identity-api only, within the eight-caller limit."
  }

  assert {
    condition = jsonencode(module.application.support_identity_check.identity_caller_subjects) == jsonencode({
      IDENTITY_EHR_CALLER_SUBJECT      = "hid:staging:ehr-api"
      IDENTITY_LAB_CALLER_SUBJECT      = "hid:staging:lab-api"
      IDENTITY_OCR_CALLER_SUBJECT      = "hid:staging:ocr-api"
      IDENTITY_PHARMACY_CALLER_SUBJECT = "hid:staging:pharmacy-api"
      IDENTITY_SUPPORT_CALLER_SUBJECT  = "hid:staging:support-api"
      OUTREACH_CALLER_SUBJECT          = "hid:staging:outreach-api"
    })
    error_message = "identity-api must accept caller support-api by its issuer subject and leave every other caller unchanged."
  }

  assert {
    condition = (
      module.application.support_identity_check.support_environment["IDENTITY_API_URL"] == "https://identity.internal.staging.healthidentitydirectory.com" &&
      module.application.support_identity_check.support_environment["IDENTITY_SUPPORT_WORKLOAD_TOKEN_FILE"] == "/var/run/hid/workload-tokens/identity.jwt" &&
      module.application.support_identity_check.support_environment["IDENTITY_SERVICE_IDENTITY_MODE"] == "jwt" &&
      module.application.support_identity_check.support_environment["LEX_LOCALE_ID"] == "en_GB" &&
      module.application.support_identity_check.support_environment["PORT"] == "3011"
    )
    error_message = "support-api must receive identity-api's internal URL, jwt mode and its identity.jwt path, and keep its Lex settings."
  }

  assert {
    condition     = jsonencode(module.application.support_identity_check.token_requests) == jsonencode([{ audience = "hid-identity-api", file = "identity.jwt" }])
    error_message = "support-api requests one token, for identity-api, written as identity.jwt."
  }

  assert {
    condition = alltrue([for family in ["legacy", "production"] :
      jsonencode(sort(keys(module.application.support_identity_check.task_containers[family]))) == jsonencode(["support-api", "workload-token-agent"]) &&
      jsonencode(module.application.support_identity_check.task_volumes[family]) == jsonencode(["workload-tokens"])
    ])
    error_message = "Both support-api task definitions must carry the workload-token-agent sidecar and the token volume, exactly as outreach-api's do."
  }

  assert {
    condition = alltrue([for family in ["legacy", "production"] :
      jsonencode(module.application.support_identity_check.task_containers[family]["support-api"].mounts) == jsonencode(["workload-tokens:/var/run/hid/workload-tokens:ro"]) &&
      jsonencode(module.application.support_identity_check.task_containers[family]["support-api"].depends_on) == jsonencode(["workload-token-agent:HEALTHY"]) &&
      length(module.application.support_identity_check.task_containers[family]["support-api"].secrets) == 0 &&
      module.application.support_identity_check.task_containers[family]["support-api"].environment["IDENTITY_API_URL"] == "https://identity.internal.staging.healthidentitydirectory.com" &&
      module.application.support_identity_check.task_containers[family]["support-api"].environment["IDENTITY_SUPPORT_WORKLOAD_TOKEN_FILE"] == "/var/run/hid/workload-tokens/identity.jwt"
    ])
    error_message = "support-api must read the token volume read-only, start only after a healthy sidecar, and get no new secret."
  }

  assert {
    condition = alltrue([for family in ["legacy", "production"] :
      module.application.support_identity_check.task_containers[family]["workload-token-agent"].environment["WORKLOAD_SUBJECT"] == "hid:staging:support-api" &&
      module.application.support_identity_check.task_containers[family]["workload-token-agent"].environment["WORKLOAD_SUBJECT"] == module.application.support_identity_check.identity_caller_subjects["IDENTITY_SUPPORT_CALLER_SUBJECT"] &&
      module.application.support_identity_check.task_containers[family]["workload-token-agent"].environment["WORKLOAD_TOKEN_FILES_JSON"] == jsonencode([{ audience = "hid-identity-api", file = "identity.jwt" }]) &&
      module.application.support_identity_check.task_containers[family]["workload-token-agent"].environment["WORKLOAD_TOKEN_DIRECTORY"] == "/var/run/hid/workload-tokens" &&
      startswith(module.application.support_identity_check.task_containers[family]["workload-token-agent"].environment["WORKLOAD_ISSUER_URL"], "https://abc123.execute-api.eu-west-1.amazonaws.com/staging") &&
      jsonencode(module.application.support_identity_check.task_containers[family]["workload-token-agent"].mounts) == jsonencode(["workload-tokens:/var/run/hid/workload-tokens:rw"])
    ])
    error_message = "The sidecar must mint hid-identity-api tokens as the same subject identity-api accepts."
  }

  assert {
    condition     = jsonencode(module.application.support_identity_check.token_invoke_resources) == jsonencode(["arn:aws:execute-api:eu-west-1:123456789012:abc123/staging/POST/token"])
    error_message = "support-api's task role may call only the issuer's token endpoint."
  }

  assert {
    condition = (
      module.application.support_identity_check.network.to_internal_lb == "tcp/443" &&
      module.application.support_identity_check.network.internal_lb_admits == "tcp/443" &&
      module.application.support_identity_check.network.identity_behind_lb == "tcp/3001" &&
      module.application.support_identity_check.network.provider_https == "tcp/443" &&
      !module.application.support_identity_check.network.database &&
      jsonencode(module.application.support_identity_check.network.identity_host_routing) == jsonencode(["identity.internal.staging.healthidentitydirectory.com"])
    )
    error_message = "support-api must reach identity-api through the internal load balancer on 443 (the issuer and Lex over 443) and must never reach the database."
  }
}
