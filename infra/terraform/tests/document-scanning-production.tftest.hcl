# The production shape: the promoted staging stack keeps staging names, so the
# bridge, its subject, its queue and its alarms are hid-staging-* and the
# issuer path is /staging, exactly as the runbook (DEVOPS_HANDOVER.md) names
# them. Inputs are the cutover run of production-promotion.tftest.hcl, with
# GuardDuty and the bridge on. All values are synthetic.
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

  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
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

  mock_resource "aws_iam_role" {
    override_during = plan
    defaults = {
      arn = "arn:aws:iam::123456789012:role/hid-staging-mock-role"
    }
  }

  mock_resource "aws_s3_bucket" {
    override_during = plan
    defaults = {
      id  = "hid-staging-documents-mock"
      arn = "arn:aws:s3:::hid-staging-documents-mock"
    }
  }

  mock_resource "aws_kms_key" {
    override_during = plan
    defaults = {
      arn    = "arn:aws:kms:eu-west-1:123456789012:key/12345678-1234-4234-8234-123456789abc"
      key_id = "12345678-1234-4234-8234-123456789abc"
    }
  }

  mock_resource "aws_guardduty_malware_protection_plan" {
    override_during = plan
    defaults = {
      arn = "arn:aws:guardduty:eu-west-1:123456789012:malware-protection-plan/mockplan"
    }
  }

  mock_resource "aws_sqs_queue" {
    override_during = plan
    defaults = {
      arn = "arn:aws:sqs:eu-west-1:123456789012:hid-staging-document-scan-results"
      url = "https://sqs.eu-west-1.amazonaws.com/123456789012/hid-staging-document-scan-results"
    }
  }

  mock_resource "aws_cloudwatch_event_rule" {
    override_during = plan
    defaults = {
      arn = "arn:aws:events:eu-west-1:123456789012:rule/mock"
    }
  }

  mock_resource "aws_sns_topic" {
    override_during = plan
    defaults = {
      arn = "arn:aws:sns:eu-west-1:123456789012:hid-staging-operations-alerts"
    }
  }

  mock_resource "aws_lambda_function" {
    override_during = plan
    defaults = {
      arn = "arn:aws:lambda:eu-west-1:123456789012:function:mock"
    }
  }
}

mock_provider "awscc" {}

mock_provider "external" {
  mock_data "external" {
    defaults = { result = { valid = "true" } }
  }
}

run "production_stage_3_uses_the_retained_staging_names" {
  command = plan
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
    production_api_certificate_arn     = "arn:aws:acm:eu-west-1:123456789012:certificate/33333333-3333-3333-3333-333333333333"
    enable_document_malware_protection = true
    enable_document_scanning           = true
  }

  assert {
    condition = (
      output.document_scanning.bridge.function_name == "hid-staging-document-scan-bridge" &&
      output.document_scanning.bridge.results_queue == "hid-staging-document-scan-results" &&
      output.document_scanning.bridge.dead_letter_queue == "hid-staging-document-scan-results-dlq" &&
      output.document_scanning.bridge.log_group == "/hid/staging/document-scan-bridge" &&
      output.document_scanning.bridge.subject == "hid:staging:document-scanner" &&
      output.document_scanning.bridge.mode == "observe" &&
      !output.document_scanning.bridge.reconcile_enabled
    )
    error_message = "Production keeps the retained staging names the runbook uses."
  }

  assert {
    condition = (
      module.application.document_scan_review.function.environment.HID_DEPLOYMENT_ENV == "staging" &&
      module.application.document_scan_review.function.environment.EHR_API_URL == "https://ehr.internal.staging.healthidentitydirectory.com" &&
      module.application.document_scan_review.function.environment.WORKLOAD_ISSUER_URL == "https://abc123.execute-api.eu-west-1.amazonaws.com/staging" &&
      module.application.document_scan_review.role_policy.Statement[0].Resource == "arn:aws:execute-api:eu-west-1:123456789012:abc123/staging/POST/token"
    )
    error_message = "The bridge uses the retained /staging issuer and the internal ehr-api name."
  }

  assert {
    condition = (
      length(module.application.workload_caller_policy) == 7 &&
      alltrue([for subject in keys(module.application.workload_caller_policy) : startswith(subject, "hid:staging:")]) &&
      jsonencode(module.application.workload_caller_policy["hid:staging:document-scanner"]) == jsonencode(["hid-identity-api"])
    )
    error_message = "The seventh caller is hid:staging:document-scanner, for hid-identity-api only."
  }

  assert {
    condition     = alltrue([for name in module.application.document_scan_review.alarm_names : startswith(name, "hid-staging-document-scan-")])
    error_message = "Alarm names start with hid-staging-, which the operations topic and its key admit."
  }
}
