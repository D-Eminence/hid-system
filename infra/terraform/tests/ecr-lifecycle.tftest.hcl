# ECR clean-up (owner approved 1 November 2026). Production keeps lifecycle
# rule 1 exactly as the release helpers require (every retain- image, that is
# the image each service runs, the previous release and every earlier release,
# never expires), expires untagged residue 14 days after push and other images
# 90 days after push, so no image younger than 90 days expires. Environments
# that do not set the two inputs keep today's rules.
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

run "production_keeps_releases_and_expires_only_old_images" {
  command = plan

  variables {
    ecr_untagged_image_expiry_days = tonumber(regex("(?m)^ecr_untagged_image_expiry_days\\s*=\\s*([0-9]+)\\s*$", file("environments/production.tfvars"))[0])
    ecr_tagged_image_expiry_days   = tonumber(regex("(?m)^ecr_tagged_image_expiry_days\\s*=\\s*([0-9]+)\\s*$", file("environments/production.tfvars"))[0])
  }

  assert {
    condition = (
      length(regexall("(?m)^ecr_untagged_image_expiry_days\\s*=", file("environments/production.tfvars"))) == 1 &&
      length(regexall("(?m)^ecr_tagged_image_expiry_days\\s*=", file("environments/production.tfvars"))) == 1 &&
      var.ecr_untagged_image_expiry_days == 14 && var.ecr_tagged_image_expiry_days == 90
    )
    error_message = "environments/production.tfvars must set ecr_untagged_image_expiry_days = 14 and ecr_tagged_image_expiry_days = 90, once each."
  }

  assert {
    condition     = length(module.application.ecr_lifecycle_policies) == 12
    error_message = "Every one of the twelve workload repositories must keep a lifecycle policy."
  }

  assert {
    condition = alltrue([for name, policy in module.application.ecr_lifecycle_policies : policy == {
      rules = [
        {
          rulePriority = 1
          description  = "Protect named live and rollback digests from lower priority cleanup"
          selection    = { tagStatus = "tagged", tagPrefixList = ["retain-"], countType = "imageCountMoreThan", countNumber = 1000000 }
          action       = { type = "expire" }
        },
        {
          rulePriority = 2
          description  = "Expire untagged build residue"
          selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 14 }
          action       = { type = "expire" }
        },
        {
          rulePriority = 3
          description  = "Expire images older than 90 days that carry no retain- tag"
          selection    = { tagStatus = "any", countType = "sinceImagePushed", countUnit = "days", countNumber = 90 }
          action       = { type = "expire" }
        },
      ]
    }])
    error_message = "Production repositories must keep every retain- image, expire untagged images after 14 days and other images only after 90 days."
  }

  # The release helpers (production_deployment_core.retain_image and the
  # inventory's retain) refuse to deploy unless exactly this rule exists.
  assert {
    condition = alltrue([for name, policy in module.application.ecr_lifecycle_policies :
      length([for rule in policy.rules : rule if try(rule.selection.tagPrefixList, null) == ["retain-"]]) == 1 &&
      alltrue([for rule in policy.rules : rule.rulePriority == 1 && rule.selection.countType == "imageCountMoreThan" && rule.selection.countNumber >= 1000000
      if try(rule.selection.tagPrefixList, null) == ["retain-"]])
    ])
    error_message = "Rule 1 must keep every retain- image, or the release helpers refuse every deployment."
  }

  assert {
    condition = alltrue([for name, policy in module.application.ecr_lifecycle_policies :
      alltrue([for rule in policy.rules : rule.selection.countType == "sinceImagePushed" if rule.rulePriority > 1])
    ])
    error_message = "No rule but the retain- rule may count images: a count rule would expire images younger than 90 days."
  }

  # The handover's dry run previews these rules before the apply; it must preview exactly what Terraform applies.
  assert {
    condition = jsondecode(regex("(?s)@'\\n(\\{\"rules\".*?)\\n'@ \\| Set-Content -Encoding ascii ecr-new-rules\\.json",
    file("../DEVOPS_HANDOVER.md"))[0]) == module.application.ecr_lifecycle_policies["gateway"]
    error_message = "The ECR dry run in DEVOPS_HANDOVER.md must preview exactly the rules production applies."
  }
}

run "other_environments_keep_todays_rules" {
  command = plan

  assert {
    condition = alltrue([for name, policy in module.application.ecr_lifecycle_policies : policy == {
      rules = [
        {
          rulePriority = 1
          description  = "Protect named live and rollback digests from lower priority cleanup"
          selection    = { tagStatus = "tagged", tagPrefixList = ["retain-"], countType = "imageCountMoreThan", countNumber = 1000000 }
          action       = { type = "expire" }
        },
        {
          rulePriority = 2
          description  = "Expire untagged build residue"
          selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 7 }
          action       = { type = "expire" }
        },
        {
          rulePriority = 3
          description  = "Bound retained immutable releases"
          selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 25 }
          action       = { type = "expire" }
        },
      ]
    }]) && length(module.application.ecr_lifecycle_policies) == 12
    error_message = "Without the two inputs, repositories must keep today's rules (untagged after 7 days, newest 25 images)."
  }
}

run "refuse_tagged_expiry_under_30_days" {
  command = plan

  variables {
    ecr_tagged_image_expiry_days = 14
  }

  expect_failures = [var.ecr_tagged_image_expiry_days]
}

run "refuse_untagged_expiry_of_zero_days" {
  command = plan

  variables {
    ecr_untagged_image_expiry_days = 0
  }

  expect_failures = [var.ecr_untagged_image_expiry_days]
}

run "refuse_age_expiry_without_the_retain_rule" {
  command = plan

  variables {
    environment                  = "development"
    promote_existing_staging     = false
    activate_production_runtime  = false
    enable_runtime               = false
    enable_ingress               = false
    enable_database              = false
    enable_ai                    = false
    enable_support_bot           = false
    ecs_migration_phase          = "legacy"
    ecr_tagged_image_expiry_days = 90
  }

  expect_failures = [terraform_data.deployment_guard]
}
