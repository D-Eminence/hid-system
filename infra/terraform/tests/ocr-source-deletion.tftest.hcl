mock_provider "aws" {
  mock_resource "aws_sns_topic" {
    override_during = plan
    defaults = {
      arn = "arn:aws:sns:eu-west-1:123456789012:hid-staging-operations-alerts"
    }
  }

  mock_resource "aws_s3_bucket" {
    override_during = plan
    defaults = {
      arn = "arn:aws:s3:::hid-test-documents"
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


# 7-day deletion of OCR sources (owner condition before the first real
# patient): the OCR worker may list and delete the versions of uploaded
# documents (clinical/objects/) and nothing else; an alarm on the shared alerts
# topic fires when a source is overdue or the sweeper has stopped reporting.
variables {
  expected_account_id      = "123456789012"
  environment              = "staging"
  availability_zones       = ["eu-west-1a", "eu-west-1b"]
  public_subnet_cidrs      = ["10.30.0.0/24", "10.30.1.0/24"]
  application_subnet_cidrs = ["10.30.10.0/24", "10.30.11.0/24"]
  database_subnet_cidrs    = ["10.30.20.0/24", "10.30.21.0/24"]
  enable_database          = true
}

run "ocr_worker_may_delete_only_upload_versions" {
  command = plan

  assert {
    condition = jsonencode(module.application.ocr_source_deletion_permissions) == jsonencode([
      {
        sid        = "OcrSourceVersionsList"
        actions    = ["s3:ListBucketVersions"]
        resources  = ["arn:aws:s3:::hid-test-documents"]
        conditions = [{ test = "StringLike", variable = "s3:prefix", values = ["clinical/objects/*"] }]
      },
      {
        sid        = "OcrSourceVersionsDelete"
        actions    = ["s3:DeleteObjectVersion"]
        resources  = ["arn:aws:s3:::hid-test-documents/clinical/objects/*"]
        conditions = []
      },
    ])
    error_message = "The OCR worker may list versions only under clinical/objects/ and delete object versions only there."
  }
}

run "deletion_overdue_alarm_on_the_alerts_topic" {
  command = plan

  module {
    source = "./modules/operations"
  }

  variables {
    name_prefix                = "hid-staging"
    environment                = "staging"
    enable_database            = false
    database_arn               = ""
    database_identifier        = ""
    database_kms_key_arn       = ""
    database_connection_budget = 120
    backup_retention_days      = 30
    enable_backup_plan         = false
    alert_email                = ""
    aws_account_id             = "123456789012"
    aws_region                 = "eu-west-1"
    ecs_cluster_name           = "hid-staging"
    ocr_worker_log_group       = "/hid/staging/ocr-worker"
  }

  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.ocr_source_deletion_overdue[0].log_group_name == "/hid/staging/ocr-worker" &&
      aws_cloudwatch_log_metric_filter.ocr_source_deletion_overdue[0].pattern == "{ $.event = \"ocr.source_deletion.overdue\" }" &&
      aws_cloudwatch_log_metric_filter.ocr_source_deletion_overdue[0].metric_transformation[0].value == "$.overdue"
    )
    error_message = "The metric is the overdue count of the sweeper's round line in the OCR worker's log group."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.ocr_source_deletion_overdue[0].alarm_name == "hid-staging-ocr-source-deletion-overdue" &&
      aws_cloudwatch_metric_alarm.ocr_source_deletion_overdue[0].threshold == 0 &&
      aws_cloudwatch_metric_alarm.ocr_source_deletion_overdue[0].comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.ocr_source_deletion_overdue[0].treat_missing_data == "breaching" &&
      contains(aws_cloudwatch_metric_alarm.ocr_source_deletion_overdue[0].alarm_actions, "arn:aws:sns:eu-west-1:123456789012:hid-staging-operations-alerts")
    )
    error_message = "Any overdue source, or no round reported, alarms on the shared alerts topic (its name is under the topic's publish prefix)."
  }
}

run "no_deletion_alarm_without_the_worker" {
  command = plan

  module {
    source = "./modules/operations"
  }

  variables {
    name_prefix                = "hid-staging"
    environment                = "staging"
    enable_database            = false
    database_arn               = ""
    database_identifier        = ""
    database_kms_key_arn       = ""
    database_connection_budget = 120
    backup_retention_days      = 30
    enable_backup_plan         = false
    alert_email                = ""
    aws_account_id             = "123456789012"
    aws_region                 = "eu-west-1"
    ecs_cluster_name           = "hid-staging"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.ocr_source_deletion_overdue) == 0 && length(aws_cloudwatch_log_metric_filter.ocr_source_deletion_overdue) == 0
    error_message = "Without the OCR worker's log group there is nothing to watch."
  }
}
