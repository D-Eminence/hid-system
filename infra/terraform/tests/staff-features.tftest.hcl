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

# Staff features built behind service settings (hid-system
# staging-novu-ci-20261005: identity-api at 4c843270, ehr-api, lab-api and
# pharmacy-api at 06f98040). Each service parses its own setting and is off
# by default:
#   identity-api  STAFF_FACILITY_SELECTION_MODE            off | keep | ask (0129)
#   lab-api       OWN_WORK_PATIENT_CARD_ENABLED           true | false (0124, 0133 D4)
#   pharmacy-api  OWN_WORK_PATIENT_CARD_ENABLED           true | false (0124, 0133 D4)
#   ehr-api       PRESCRIPTION_DISPENSING_DETAILS_ENABLED true | false (0125)
#   pharmacy-api  PRESCRIPTION_DISPENSING_DETAILS_ENABLED true | false (0125)
# Off writes nothing, so the default plan changes no task definition.
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

run "staff_features_off_by_default" {
  command = plan

  assert {
    condition = alltrue([for name, environment in module.application.staff_feature_environment :
      length(environment) == 0
    ])
    error_message = "With every staff feature off no container may receive STAFF_FACILITY_SELECTION_MODE, OWN_WORK_PATIENT_CARD_ENABLED or PRESCRIPTION_DISPENSING_DETAILS_ENABLED."
  }
}

run "staff_features_production_values" {
  command = plan

  # The values production.tfvars sets, read from the file itself.
  variables {
    staff_facility_selection_mode           = regex("(?m)^staff_facility_selection_mode\\s*=\\s*\"([a-z]+)\"\\s*$", file("environments/production.tfvars"))[0]
    own_work_patient_card_enabled           = regex("(?m)^own_work_patient_card_enabled\\s*=\\s*(true|false)\\s*$", file("environments/production.tfvars"))[0] == "true"
    prescription_dispensing_details_enabled = regex("(?m)^prescription_dispensing_details_enabled\\s*=\\s*(true|false)\\s*$", file("environments/production.tfvars"))[0] == "true"
  }

  assert {
    condition = alltrue([for key in ["staff_facility_selection_mode", "own_work_patient_card_enabled", "prescription_dispensing_details_enabled"] :
      length(regexall("(?m)^${key}\\s*=", file("environments/production.tfvars"))) == 1
    ]) && var.staff_facility_selection_mode == "keep" && var.own_work_patient_card_enabled && var.prescription_dispensing_details_enabled
    error_message = "environments/production.tfvars must set each staff feature exactly once: staff_facility_selection_mode = \"keep\", own_work_patient_card_enabled = true, prescription_dispensing_details_enabled = true."
  }

  assert {
    condition     = module.application.staff_feature_environment["identity-api"] == { STAFF_FACILITY_SELECTION_MODE = "keep" }
    error_message = "identity-api must receive STAFF_FACILITY_SELECTION_MODE=keep and no other staff feature."
  }

  assert {
    condition     = module.application.staff_feature_environment["lab-api"] == { OWN_WORK_PATIENT_CARD_ENABLED = "true" }
    error_message = "lab-api must receive OWN_WORK_PATIENT_CARD_ENABLED=true only."
  }

  assert {
    condition = module.application.staff_feature_environment["pharmacy-api"] == {
      OWN_WORK_PATIENT_CARD_ENABLED           = "true"
      PRESCRIPTION_DISPENSING_DETAILS_ENABLED = "true"
    }
    error_message = "pharmacy-api must receive OWN_WORK_PATIENT_CARD_ENABLED=true and PRESCRIPTION_DISPENSING_DETAILS_ENABLED=true."
  }

  assert {
    condition     = module.application.staff_feature_environment["ehr-api"] == { PRESCRIPTION_DISPENSING_DETAILS_ENABLED = "true" }
    error_message = "ehr-api must receive PRESCRIPTION_DISPENSING_DETAILS_ENABLED=true only."
  }

  assert {
    condition = alltrue([for name, environment in module.application.staff_feature_environment :
      length(environment) == 0 if !contains(["identity-api", "ehr-api", "lab-api", "pharmacy-api"], name)
    ])
    error_message = "No other container may receive a staff feature setting."
  }
}

run "staff_facility_selection_ask" {
  command = plan

  variables { staff_facility_selection_mode = "ask" }

  assert {
    condition     = module.application.staff_feature_environment["identity-api"] == { STAFF_FACILITY_SELECTION_MODE = "ask" }
    error_message = "identity-api must receive the mode exactly as set."
  }
}

run "reject_unknown_facility_selection_mode" {
  command = plan
  variables { staff_facility_selection_mode = "on" }
  expect_failures = [var.staff_facility_selection_mode]
}

run "other_environments_keep_staff_features_off" {
  command = plan

  assert {
    condition = var.staff_facility_selection_mode == "off" && !var.own_work_patient_card_enabled && !var.prescription_dispensing_details_enabled && length(fileset("environments", "*.tfvars")) >= 3 && alltrue(flatten([
      for name in fileset("environments", "*.tfvars") : [
        for key in ["staff_facility_selection_mode", "own_work_patient_card_enabled", "prescription_dispensing_details_enabled"] :
        length(regexall("(?m)^\\s*${key}\\s*=", file("environments/${name}"))) == 0
      ] if name != "production.tfvars"
    ]))
    error_message = "Only production turns these staff features on; no other environment's inputs may set them, and their defaults are off."
  }
}
