mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      id   = "mock-policy"
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  aws_region          = "eu-west-1"
  expected_account_id = "123456789012"
  alert_email         = "security@example.com"
}

run "account_management_trail" {
  command = plan

  module {
    source = "./modules/cloudtrail"
  }

  assert {
    condition = (
      aws_cloudtrail.audit.is_multi_region_trail &&
      aws_cloudtrail.audit.include_global_service_events &&
      aws_cloudtrail.audit.enable_log_file_validation &&
      aws_cloudtrail.audit.enable_logging &&
      aws_cloudtrail.audit.event_selector[0].include_management_events
    )
    error_message = "The account trail must continuously retain validated management events across Regions."
  }

  assert {
    condition     = length(aws_cloudtrail.audit.event_selector[0].data_resource) == 0
    error_message = "The initial trail must not capture every S3 object's data events."
  }

  assert {
    condition = contains(
      jsondecode(aws_cloudwatch_event_rule.trail_change.event_pattern).detail.eventName,
      "StopLogging"
    )
    error_message = "The account alert must detect a stopped trail."
  }

  assert {
    condition = (
      aws_s3_bucket_lifecycle_configuration.audit.rule[0].expiration[0].days == 1096 &&
      aws_s3_bucket_lifecycle_configuration.audit.rule[0].noncurrent_version_expiration[0].noncurrent_days == 1096
    )
    error_message = "Current and noncurrent audit objects must use the provisional three-year baseline."
  }
}

run "clinical_object_events" {
  command = plan

  module {
    source = "./modules/cloudtrail"
  }

  variables {
    clinical_bucket_names = ["hid-development-documents-example"]
  }

  assert {
    condition = (
      aws_cloudtrail.audit.event_selector[0].data_resource[0].type == "AWS::S3::Object" &&
      length(aws_cloudtrail.audit.event_selector[0].data_resource[0].values) == 1 &&
      contains(aws_cloudtrail.audit.event_selector[0].data_resource[0].values, "arn:aws:s3:::hid-development-documents-example/")
    )
    error_message = "Object events must be scoped to the named clinical bucket."
  }
}

run "audit_retention_override" {
  command = plan

  module {
    source = "./modules/cloudtrail"
  }

  variables {
    audit_log_retention_days = 1827
  }

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.audit.rule[0].expiration[0].days == 1827
    error_message = "The audit retention lifecycle must follow the configured override."
  }
}
