mock_provider "aws" {
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

# Patient web push (B6). The public key is a synthetic 87-character
# base64url string; no key pair is generated or stored here.
variables {
  expected_account_id      = "123456789012"
  environment              = "production"
  availability_zones       = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
  public_subnet_cidrs      = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
  application_subnet_cidrs = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
  database_subnet_cidrs    = ["10.40.20.0/24", "10.40.21.0/24", "10.40.22.0/24"]
  enable_database          = true
  enable_runtime           = true
  enable_ingress           = true
  rds_ca_bundle_base64     = "dGVzdC1jYS1idW5kbGU="
  regional_certificate_arn = "arn:aws:acm:eu-west-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
  internal_certificate_arn = "arn:aws:acm:eu-west-1:123456789012:certificate/22222222-2222-2222-2222-222222222222"
  cloudflare_origin_secret = "0123456789abcdef0123456789abcdef"
  migration_image_uri      = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/ehr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  image_uris = {
    identity-api        = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/identity-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ehr-api             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/ehr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    lab-api             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/lab-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    pharmacy-api        = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/pharmacy-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ocr-api             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/ocr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ocr-worker          = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/ocr-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    outreach-api        = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/outreach-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    notification-api    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/notification-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    notification-worker = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/notification-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    event-dispatcher    = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/event-dispatcher@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    gateway             = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/production/hid/gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}

run "web_push_off_by_default" {
  command = plan

  assert {
    condition = alltrue([for name, bindings in module.application.web_push_bindings :
      length(bindings.environment) == 0 && length(bindings.secrets) == 0
    ])
    error_message = "With web push off no container may receive a WEB_PUSH_ environment key or secret, so the default plan changes no task definition."
  }

  assert {
    condition     = !contains(output.notification_delivery_configuration.secret_fields, "WEB_PUSH_VAPID_PRIVATE_KEY")
    error_message = "notification-api must not reference webPushVapidPrivateKey while web push is off."
  }
}

run "web_push_on_with_public_key" {
  command = plan

  variables {
    web_push_enabled          = true
    web_push_vapid_public_key = "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  }

  assert {
    condition = (
      join(",", module.application.web_push_bindings["identity-api"].environment) == "WEB_PUSH_SUBJECT,WEB_PUSH_VAPID_PUBLIC_KEY" &&
      length(module.application.web_push_bindings["identity-api"].secrets) == 0
    )
    error_message = "identity-api must receive the public key and subject, never the private key."
  }

  assert {
    condition = (
      join(",", module.application.web_push_bindings["notification-api"].environment) == "WEB_PUSH_SUBJECT,WEB_PUSH_VAPID_PUBLIC_KEY" &&
      join(",", module.application.web_push_bindings["notification-api"].secrets) == "WEB_PUSH_VAPID_PRIVATE_KEY" &&
      contains(output.notification_delivery_configuration.secret_fields, "WEB_PUSH_VAPID_PRIVATE_KEY")
    )
    error_message = "notification-api must receive the public key, subject and the private key secret."
  }

  assert {
    condition = alltrue([for name, bindings in module.application.web_push_bindings :
      length(bindings.environment) == 0 && length(bindings.secrets) == 0
      if !contains(["identity-api", "notification-api"], name)
    ])
    error_message = "No other container may receive a WEB_PUSH_ key."
  }
}

run "reject_web_push_without_public_key" {
  command = plan
  variables { web_push_enabled = true }
  expect_failures = [terraform_data.deployment_guard]
}

run "reject_malformed_public_key" {
  command = plan
  variables { web_push_vapid_public_key = "not-a-vapid-key" }
  expect_failures = [var.web_push_vapid_public_key]
}

run "reject_plain_http_subject" {
  command = plan
  variables { web_push_subject = "http://healthidentitydirectory.com" }
  expect_failures = [var.web_push_subject]
}
