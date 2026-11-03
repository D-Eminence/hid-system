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

# Backend error reporting (Sentry) is off unless a workload is given a DSN.
# The DSNs here are fake.
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

run "error_reporting_off_by_default" {
  command = plan

  assert {
    condition     = alltrue([for name, keys in module.application.error_reporting_environment_names : length(keys) == 0])
    error_message = "Without DSNs no container may receive a SENTRY_ variable, so the default plan changes no task definition."
  }
}

run "only_listed_workloads_report_errors" {
  command = plan

  variables {
    sentry_dsns = {
      ehr-api    = "https://0123456789abcdef@o1.ingest.us.sentry.io/11"
      ocr-worker = "https://fedcba9876543210@o1.ingest.de.sentry.io/12"
    }
  }

  assert {
    condition = alltrue([for name, keys in module.application.error_reporting_environment_names :
      contains(["ehr-api", "ocr-worker"], name) ? jsonencode(keys) == jsonencode(["SENTRY_DSN", "SENTRY_ENVIRONMENT"]) : length(keys) == 0
    ])
    error_message = "Only the workloads given a DSN get SENTRY_DSN and SENTRY_ENVIRONMENT."
  }

  assert {
    condition     = alltrue(values(module.application.error_reporting_settings_match))
    error_message = "Each listed workload must get exactly its configured DSN, and SENTRY_ENVIRONMENT must be the release environment."
  }
}

run "unknown_workload_is_refused" {
  command = plan

  variables {
    sentry_dsns = {
      not-a-service = "https://0123456789abcdef@o1.ingest.us.sentry.io/11"
    }
  }

  expect_failures = [terraform_data.deployment_guard]
}

run "dsn_with_secret_is_refused" {
  command = plan

  variables {
    sentry_dsns = {
      ehr-api = "https://public:secret@o1.ingest.us.sentry.io/11"
    }
  }

  expect_failures = [var.sentry_dsns]
}

run "dsn_with_port_is_refused" {
  command = plan

  variables {
    sentry_dsns = {
      ehr-api = "https://public@o1.ingest.us.sentry.io:443/11"
    }
  }

  expect_failures = [var.sentry_dsns]
}

run "dsn_with_path_is_refused" {
  command = plan

  variables {
    sentry_dsns = {
      ehr-api = "https://public@o1.ingest.us.sentry.io/extra/11"
    }
  }

  expect_failures = [var.sentry_dsns]
}

run "dsn_with_trailing_slash_is_refused" {
  command = plan

  variables {
    sentry_dsns = {
      ehr-api = "https://public@o1.ingest.us.sentry.io/11/"
    }
  }

  expect_failures = [var.sentry_dsns]
}

run "dsn_with_non_sentry_host_is_refused" {
  command = plan

  variables {
    sentry_dsns = {
      ehr-api = "https://public@errors.example.com/11"
    }
  }

  expect_failures = [var.sentry_dsns]
}

run "dsn_with_plain_http_is_refused" {
  command = plan

  variables {
    sentry_dsns = {
      ehr-api = "http://public@o1.ingest.us.sentry.io/11"
    }
  }

  expect_failures = [var.sentry_dsns]
}

run "gateway_is_refused" {
  command = plan

  variables {
    sentry_dsns = {
      gateway = "https://0123456789abcdef@o1.ingest.us.sentry.io/11"
    }
  }

  expect_failures = [terraform_data.deployment_guard]
}
