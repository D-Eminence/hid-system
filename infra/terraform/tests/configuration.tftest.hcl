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

run "development_foundation" {
  command = plan

  variables {
    expected_account_id      = "123456789012"
    environment              = "development"
    availability_zones       = ["eu-west-1a", "eu-west-1b"]
    public_subnet_cidrs      = ["10.20.0.0/24", "10.20.1.0/24"]
    application_subnet_cidrs = ["10.20.10.0/24", "10.20.11.0/24"]
    database_subnet_cidrs    = ["10.20.20.0/24", "10.20.21.0/24"]
  }

  assert {
    condition     = output.database_endpoint == null
    error_message = "The gated foundation plan must not create PostgreSQL."
  }

  assert {
    condition     = length(module.ai) == 0
    error_message = "The foundation plan must leave AI infrastructure disabled."
  }

  assert {
    condition     = contains(keys(output.ecr_repository_urls), "support-api") && length(module.support_bot) == 0
    error_message = "The support image registry must exist before publishing while the bot remains disabled."
  }

  assert {
    condition = (
      var.application_log_retention_days == 90 &&
      var.security_log_retention_days == 365 &&
      var.backup_retention_days == 30
    )
    error_message = "The provisional application, security, and backup retention baselines must be explicit."
  }
}

run "development_ai" {
  command = plan

  variables {
    expected_account_id      = "123456789012"
    environment              = "development"
    availability_zones       = ["eu-west-1a", "eu-west-1b"]
    public_subnet_cidrs      = ["10.20.0.0/24", "10.20.1.0/24"]
    application_subnet_cidrs = ["10.20.10.0/24", "10.20.11.0/24"]
    database_subnet_cidrs    = ["10.20.20.0/24", "10.20.21.0/24"]
    enable_database          = true
    enable_ai                = true
    ai_allow_eu_processing   = true
  }

  assert {
    condition     = length(module.ai) == 1
    error_message = "The AI plan must activate the gated module."
  }
}

run "staging_schema_migration_without_runtime" {
  command = plan

  variables {
    expected_account_id      = "123456789012"
    environment              = "staging"
    staging_mode             = "economy"
    availability_zones       = ["eu-west-1a", "eu-west-1b"]
    public_subnet_cidrs      = ["10.30.0.0/24", "10.30.1.0/24"]
    application_subnet_cidrs = ["10.30.10.0/24", "10.30.11.0/24"]
    database_subnet_cidrs    = ["10.30.20.0/24", "10.30.21.0/24"]
    enable_database          = true
    enable_migration_task    = true
    rds_ca_bundle_base64     = "dGVzdC1jYS1idW5kbGU="
    migration_image_uri      = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ehr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  assert {
    condition = (
      var.enable_migration_task &&
      !var.enable_runtime &&
      output.api_load_balancer_dns_name == null
    )
    error_message = "The schema migration task must be available before public ingress and services."
  }
}

run "development_support_bot" {
  command = plan

  variables {
    expected_account_id      = "123456789012"
    environment              = "development"
    availability_zones       = ["eu-west-1a", "eu-west-1b"]
    public_subnet_cidrs      = ["10.20.0.0/24", "10.20.1.0/24"]
    application_subnet_cidrs = ["10.20.10.0/24", "10.20.11.0/24"]
    database_subnet_cidrs    = ["10.20.20.0/24", "10.20.21.0/24"]
    enable_support_bot       = true
    support_contact          = "mailto:support@example.invalid"
    support_faqs = {
      Help = {
        utterances = ["I need help", "How do I get help"]
        answer     = "Please contact the support team for help."
      }
    }
  }

  assert {
    condition     = length(module.support_bot) == 1 && length(output.ecr_repository_urls) == 12
    error_message = "The support bot plan must include Lex and the support API repository."
  }
}

run "staging_customer_input_version_permissions" {
  command = plan
  variables {
    expected_account_id          = "123456789012"
    environment                  = "staging"
    staging_mode                 = "economy"
    availability_zones           = ["eu-west-1a", "eu-west-1b"]
    public_subnet_cidrs          = ["10.30.0.0/24", "10.30.1.0/24"]
    application_subnet_cidrs     = ["10.30.10.0/24", "10.30.11.0/24"]
    database_subnet_cidrs        = ["10.30.20.0/24", "10.30.21.0/24"]
    enable_database              = true
    enable_migration_task        = true
    rds_ca_bundle_base64         = "dGVzdC1jYS1idW5kbGU="
    migration_image_uri          = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ehr-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    migration_source_bucket_arn  = "arn:aws:s3:::hid-migration-source-synthetic"
    migration_source_kms_key_arn = "arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111"
  }
  override_resource {
    target          = module.data.aws_s3_bucket.documents
    override_during = plan
    values = {
      arn = "arn:aws:s3:::hid-staging-documents-synthetic"
    }
  }
  override_resource {
    target          = module.data.aws_kms_key.documents
    override_during = plan
    values = {
      arn = "arn:aws:kms:eu-west-1:123456789012:key/22222222-2222-4222-8222-222222222222"
    }
  }
  assert {
    condition = (
      length(module.application.migration_customer_input_access.Statement) == 3 &&
      module.application.migration_customer_input_access.Statement[0].Action == ["s3:GetObjectVersion"] &&
      module.application.migration_customer_input_access.Statement[0].Resource == [
        "arn:aws:s3:::hid-migration-source-synthetic/migration-inputs/*",
        "arn:aws:s3:::hid-staging-documents-synthetic/migration-quarantine/*/medical-files/*",
      ]
    )
    error_message = "Customer imports must read only pinned versions from the accepted input/file prefixes, with no list/write/latest-object permission."
  }
  assert {
    condition = (
      module.application.migration_customer_input_access.Statement[1].Action == ["kms:Decrypt"] &&
      module.application.migration_customer_input_access.Statement[2].Action == ["kms:Decrypt"] &&
      module.application.migration_customer_input_access.Statement[1].Condition.StringEquals["kms:ViaService"] == "s3.eu-west-1.amazonaws.com" &&
      module.application.migration_customer_input_access.Statement[2].Condition.StringEquals["kms:ViaService"] == "s3.eu-west-1.amazonaws.com" &&
      contains(module.application.migration_customer_input_access.Statement[1].Condition.StringLike["kms:EncryptionContext:aws:s3:arn"], "arn:aws:s3:::hid-migration-source-synthetic") &&
      contains(module.application.migration_customer_input_access.Statement[2].Condition.StringLike["kms:EncryptionContext:aws:s3:arn"], "arn:aws:s3:::hid-staging-documents-synthetic")
    )
    error_message = "Decrypt must be restricted to S3 and support the accepted bucket-key encryption contexts."
  }
}

run "reject_ai_without_database" {
  command = plan

  variables {
    expected_account_id      = "123456789012"
    environment              = "development"
    availability_zones       = ["eu-west-1a", "eu-west-1b"]
    public_subnet_cidrs      = ["10.20.0.0/24", "10.20.1.0/24"]
    application_subnet_cidrs = ["10.20.10.0/24", "10.20.11.0/24"]
    database_subnet_cidrs    = ["10.20.20.0/24", "10.20.21.0/24"]
    enable_ai                = true
    ai_allow_eu_processing   = true
  }

  expect_failures = [terraform_data.deployment_guard]
}

run "reject_invalid_profile" {
  command = plan

  variables {
    expected_account_id      = "123456789012"
    environment              = "development"
    staging_mode             = "economy"
    availability_zones       = ["eu-west-1a", "eu-west-1b"]
    public_subnet_cidrs      = ["10.20.0.0/24", "10.20.1.0/24"]
    application_subnet_cidrs = ["10.20.10.0/24", "10.20.11.0/24"]
    database_subnet_cidrs    = ["10.20.20.0/24", "10.20.21.0/24"]
  }

  expect_failures = [terraform_data.deployment_guard]
}

run "staging_economy_runtime" {
  command = plan

  variables {
    expected_account_id           = "123456789012"
    environment                   = "staging"
    staging_mode                  = "economy"
    staging_worker_min_capacity   = 1
    availability_zones            = ["eu-west-1a", "eu-west-1b"]
    public_subnet_cidrs           = ["10.30.0.0/24", "10.30.1.0/24"]
    application_subnet_cidrs      = ["10.30.10.0/24", "10.30.11.0/24"]
    database_subnet_cidrs         = ["10.30.20.0/24", "10.30.21.0/24"]
    enable_database               = true
    enable_runtime                = true
    enable_ingress                = true
    enable_backup_plan            = true
    staging_novu_api_url          = "https://eu.api.novu.co"
    notification_delivery_profile = "email-sms-brevo"
    enable_ai                     = true
    ai_allow_eu_processing        = true
    enable_support_bot            = true
    support_contact               = "mailto:support@example.invalid"
    support_faqs = {
      Help = {
        utterances = ["I need help", "How do I get help"]
        answer     = "Please contact the support team for help."
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
  }

  assert {
    condition = (
      local.desired_counts["ocr-worker"] == 1 &&
      local.desired_counts["notification-worker"] == 1 &&
      local.desired_counts["event-dispatcher"] == 1 &&
      local.desired_counts["identity-api"] == 1
    )
    error_message = "Connected economy staging must run its workers while retaining one API instance."
  }

  assert {
    condition = (
      length(output.ecr_repository_urls) == 12 &&
      length(module.ai) == 1 &&
      length(module.support_bot) == 1
    )
    error_message = "The staging runtime plan must include both chatbot paths and all twelve repositories."
  }

  assert {
    condition = (
      output.notification_delivery_configuration.profile == "email-sms-brevo" &&
      toset(output.notification_delivery_configuration.secret_fields) == toset([
        "SES_FROM_ADDRESS", "BREVO_API_KEY", "BREVO_EMAIL_FROM", "BREVO_SMS_SENDER",
        "TERMII_BASE_URL", "TERMII_API_KEY", "TERMII_SENDER_ID"
      ])
    )
    error_message = "Email/SMS fallback must inject its seven provider fields without requiring Meta secrets."
  }

  assert {
    condition = (
      module.operations.monitoring_coverage.services == 12 &&
      module.operations.monitoring_coverage.target_groups == 11 &&
      module.operations.monitoring_coverage.dead_letter == 1 &&
      module.operations.monitoring_coverage.backlog == 1 &&
      module.operations.monitoring_coverage.providers == 2
    )
    error_message = "Connected staging must monitor every service, target group, notification queue and provider workload."
  }

}

run "production_runtime_issues_own_workload_tokens" {
  command = plan

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
    enable_backup_plan       = true
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

  assert {
    condition     = endswith(output.workload_issuer_url, "/production")
    error_message = "Production must create its own workload issuer and token agents."
  }

  assert {
    condition = (
      output.notification_delivery_configuration.profile == "full" &&
      alltrue([for field in ["BREVO_API_KEY", "BREVO_EMAIL_FROM", "BREVO_SMS_SENDER"] :
        contains(output.notification_delivery_configuration.secret_fields, field)
      ])
    )
    error_message = "Full delivery must include Brevo email and SMS sender bindings in the container secret specification."
  }
}

run "emergency_contact_keys_explicitly_off_by_default" {
  command = plan

  variables {
    expected_account_id      = "123456789012"
    environment              = "production"
    availability_zones       = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
    public_subnet_cidrs      = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
    application_subnet_cidrs = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
    database_subnet_cidrs    = ["10.40.20.0/24", "10.40.21.0/24", "10.40.22.0/24"]
  }

  assert {
    condition = (
      module.application.emergency_contact_environment["identity-api"] == { EMERGENCY_CONTACT_DELIVERY_ENABLED = "false" } &&
      module.application.emergency_contact_environment["notification-api"] == { EMERGENCY_CONTACT_DELIVERY_ENABLED = "false" } &&
      alltrue([for name, environment in module.application.emergency_contact_environment : length(environment) == 0 if !contains(["identity-api", "notification-api"], name)])
    )
    error_message = "With both switches off both services must receive EMERGENCY_CONTACT_DELIVERY_ENABLED=false explicitly (the services default to on), and no other container any key."
  }

  assert {
    condition = (
      !output.emergency_contacts.notification_enabled &&
      !output.emergency_contacts.delivery_enabled &&
      output.emergency_contacts.dispatch_seconds == null &&
      length(output.emergency_contacts.channels) == 0 &&
      output.emergency_contacts.pilot_account_count == 0
    )
    error_message = "The reviewed plan must show both emergency-contact switches off by default."
  }
}

run "emergency_contact_notification_switch_only" {
  command = plan

  variables {
    expected_account_id                    = "123456789012"
    environment                            = "production"
    availability_zones                     = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
    public_subnet_cidrs                    = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
    application_subnet_cidrs               = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
    database_subnet_cidrs                  = ["10.40.20.0/24", "10.40.21.0/24", "10.40.22.0/24"]
    notification_delivery_profile          = "email-brevo"
    emergency_contact_notification_enabled = true
  }

  assert {
    condition = (
      module.application.emergency_contact_environment["notification-api"] == { EMERGENCY_CONTACT_DELIVERY_ENABLED = "true" } &&
      module.application.emergency_contact_environment["identity-api"] == { EMERGENCY_CONTACT_DELIVERY_ENABLED = "false" } &&
      alltrue([for name, environment in module.application.emergency_contact_environment : length(environment) == 0 if !contains(["identity-api", "notification-api"], name)])
    )
    error_message = "The notification switch alone must set notification-api to true and keep identity-api explicitly false."
  }

  assert {
    condition     = output.emergency_contacts.notification_enabled && !output.emergency_contacts.delivery_enabled && output.emergency_contacts.dispatch_seconds == null
    error_message = "The reviewed plan must show notification delivery on and identity delivery still off."
  }
}

run "emergency_contact_delivery_email_brevo" {
  command = plan

  variables {
    expected_account_id                    = "123456789012"
    environment                            = "production"
    availability_zones                     = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
    public_subnet_cidrs                    = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
    application_subnet_cidrs               = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
    database_subnet_cidrs                  = ["10.40.20.0/24", "10.40.21.0/24", "10.40.22.0/24"]
    notification_delivery_profile          = "email-brevo"
    emergency_contact_notification_enabled = true
    emergency_contact_delivery_enabled     = true
  }

  assert {
    condition = (
      length(module.application.emergency_contact_environment["identity-api"]) == 3 &&
      module.application.emergency_contact_environment["identity-api"]["EMERGENCY_CONTACT_DELIVERY_ENABLED"] == "true" &&
      module.application.emergency_contact_environment["identity-api"]["PATIENT_LIFECYCLE_SWEEP_SECONDS"] == "60" &&
      module.application.emergency_contact_environment["identity-api"]["EMERGENCY_CONTACT_CHANNELS"] == "email" &&
      length(module.application.emergency_contact_environment["notification-api"]) == 1 &&
      alltrue([for name, environment in module.application.emergency_contact_environment : length(environment) == 0 if !contains(["identity-api", "notification-api"], name)])
    )
    error_message = "Identity delivery on email-brevo must add delivery, a 60-second dispatch and email only, with no pilot list for every patient."
  }

  assert {
    condition = (
      output.emergency_contacts.notification_enabled &&
      output.emergency_contacts.delivery_enabled &&
      output.emergency_contacts.dispatch_seconds == 60 &&
      join(",", output.emergency_contacts.channels) == "email" &&
      output.emergency_contacts.pilot_account_count == 0
    )
    error_message = "The reviewed plan must show both switches on, a 60-second dispatch, email and every patient."
  }
}

run "emergency_contact_sms_profile_and_pilot_accounts" {
  command = plan

  variables {
    expected_account_id                    = "123456789012"
    environment                            = "production"
    availability_zones                     = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
    public_subnet_cidrs                    = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
    application_subnet_cidrs               = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
    database_subnet_cidrs                  = ["10.40.20.0/24", "10.40.21.0/24", "10.40.22.0/24"]
    notification_delivery_profile          = "email-sms-brevo"
    emergency_contact_notification_enabled = true
    emergency_contact_delivery_enabled     = true
    emergency_contact_dispatch_seconds     = 120
    emergency_contact_pilot_account_ids    = ["AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "11111111-2222-4333-9444-55555555aaaa"]
  }

  assert {
    condition = (
      module.application.emergency_contact_environment["identity-api"]["EMERGENCY_CONTACT_CHANNELS"] == "email,sms" &&
      module.application.emergency_contact_environment["identity-api"]["PATIENT_LIFECYCLE_SWEEP_SECONDS"] == "120" &&
      module.application.emergency_contact_environment["identity-api"]["EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS"] == "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee,11111111-2222-4333-9444-55555555aaaa"
    )
    error_message = "The SMS profile must offer email and SMS, and pilot account IDs must be joined in lowercase."
  }

  assert {
    condition     = join(",", output.emergency_contacts.channels) == "email,sms" && output.emergency_contacts.pilot_account_count == 2 && output.emergency_contacts.dispatch_seconds == 120
    error_message = "The reviewed plan must show the pilot account count, never the IDs, with both channels."
  }
}

run "emergency_contact_channels_follow_full_profile" {
  command = plan

  variables {
    expected_account_id                    = "123456789012"
    environment                            = "production"
    availability_zones                     = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
    public_subnet_cidrs                    = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
    application_subnet_cidrs               = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
    database_subnet_cidrs                  = ["10.40.20.0/24", "10.40.21.0/24", "10.40.22.0/24"]
    emergency_contact_notification_enabled = true
    emergency_contact_delivery_enabled     = true
  }

  assert {
    condition     = module.application.emergency_contact_environment["identity-api"]["EMERGENCY_CONTACT_CHANNELS"] == "email,sms"
    error_message = "The default full production profile sends SMS, so contacts may use email and SMS."
  }
}

run "emergency_contact_channels_follow_email_only_profile" {
  command = plan

  variables {
    expected_account_id                    = "123456789012"
    environment                            = "production"
    availability_zones                     = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
    public_subnet_cidrs                    = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
    application_subnet_cidrs               = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
    database_subnet_cidrs                  = ["10.40.20.0/24", "10.40.21.0/24", "10.40.22.0/24"]
    notification_delivery_profile          = "email-only"
    emergency_contact_notification_enabled = true
    emergency_contact_delivery_enabled     = true
  }

  assert {
    condition     = module.application.emergency_contact_environment["identity-api"]["EMERGENCY_CONTACT_CHANNELS"] == "email"
    error_message = "A profile without SMS must offer email only."
  }
}

run "reject_identity_delivery_without_notification" {
  command = plan

  variables {
    expected_account_id                = "123456789012"
    environment                        = "production"
    availability_zones                 = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
    public_subnet_cidrs                = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
    application_subnet_cidrs           = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
    database_subnet_cidrs              = ["10.40.20.0/24", "10.40.21.0/24", "10.40.22.0/24"]
    emergency_contact_delivery_enabled = true
  }

  expect_failures = [terraform_data.deployment_guard]
}

run "reject_malformed_pilot_account_id" {
  command = plan

  variables {
    expected_account_id                 = "123456789012"
    environment                         = "production"
    availability_zones                  = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
    public_subnet_cidrs                 = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
    application_subnet_cidrs            = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
    database_subnet_cidrs               = ["10.40.20.0/24", "10.40.21.0/24", "10.40.22.0/24"]
    emergency_contact_pilot_account_ids = ["patient-1"]
  }

  expect_failures = [var.emergency_contact_pilot_account_ids]
}

run "reject_duplicate_pilot_account_ids" {
  command = plan

  variables {
    expected_account_id                 = "123456789012"
    environment                         = "production"
    availability_zones                  = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
    public_subnet_cidrs                 = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
    application_subnet_cidrs            = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
    database_subnet_cidrs               = ["10.40.20.0/24", "10.40.21.0/24", "10.40.22.0/24"]
    emergency_contact_pilot_account_ids = ["AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]
  }

  expect_failures = [var.emergency_contact_pilot_account_ids]
}

run "reject_more_than_twenty_pilot_accounts" {
  command = plan

  variables {
    expected_account_id      = "123456789012"
    environment              = "production"
    availability_zones       = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
    public_subnet_cidrs      = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
    application_subnet_cidrs = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
    database_subnet_cidrs    = ["10.40.20.0/24", "10.40.21.0/24", "10.40.22.0/24"]
    emergency_contact_pilot_account_ids = [
      "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000005", "00000000-0000-4000-8000-000000000006",
      "00000000-0000-4000-8000-000000000007", "00000000-0000-4000-8000-000000000008", "00000000-0000-4000-8000-000000000009",
      "00000000-0000-4000-8000-000000000010", "00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012",
      "00000000-0000-4000-8000-000000000013", "00000000-0000-4000-8000-000000000014", "00000000-0000-4000-8000-000000000015",
      "00000000-0000-4000-8000-000000000016", "00000000-0000-4000-8000-000000000017", "00000000-0000-4000-8000-000000000018",
      "00000000-0000-4000-8000-000000000019", "00000000-0000-4000-8000-000000000020", "00000000-0000-4000-8000-000000000021",
    ]
  }

  expect_failures = [var.emergency_contact_pilot_account_ids]
}

run "reject_zero_dispatch_interval" {
  command = plan

  variables {
    expected_account_id                = "123456789012"
    environment                        = "production"
    availability_zones                 = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
    public_subnet_cidrs                = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
    application_subnet_cidrs           = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
    database_subnet_cidrs              = ["10.40.20.0/24", "10.40.21.0/24", "10.40.22.0/24"]
    emergency_contact_dispatch_seconds = 0
  }

  expect_failures = [var.emergency_contact_dispatch_seconds]
}
