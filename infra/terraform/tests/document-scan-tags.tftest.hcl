# The stage 5 bucket-policy statements, tested on the data module alone so the
# exempt roles are distinct: GuardDuty's plan role and the ehr-api task role.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }

  mock_data "aws_region" {
    defaults = { region = "eu-west-1" }
  }

  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      id   = "mock-policy"
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_data "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:existing" }
  }

  mock_resource "aws_iam_role" {
    override_during = plan
    defaults        = { arn = "arn:aws:iam::123456789012:role/hid-development-gd-malware-mock" }
  }

  mock_resource "aws_s3_bucket" {
    override_during = plan
    defaults = {
      id  = "hid-development-documents-mock"
      arn = "arn:aws:s3:::hid-development-documents-mock"
    }
  }

  mock_resource "aws_kms_key" {
    override_during = plan
    defaults        = { arn = "arn:aws:kms:eu-west-1:123456789012:key/12345678-1234-4234-8234-123456789abc" }
  }
}

mock_provider "awscc" {}

variables {
  name_prefix                  = "hid-development"
  environment                  = "development"
  vpc_id                       = "vpc-12345678"
  database_subnet_ids          = ["subnet-12345678", "subnet-87654321"]
  database_instance_class      = "db.t4g.small"
  database_allocated_storage   = 50
  database_max_storage         = 100
  database_multi_az            = false
  database_deletion_protection = false
  database_backup_retention    = 30
  security_log_retention_days  = 365
  enable_database              = true
  database_workload_names      = ["identity-api"]
}

run "enforcement_denies_unscanned_and_infected_reads_and_tag_writes" {
  command = plan

  module {
    source = "./modules/data"
  }

  variables {
    enable_document_malware_protection  = true
    document_scan_enforce_tags          = true
    document_scan_read_exempt_role_arns = ["arn:aws:iam::123456789012:role/hid-development-ehr-api-task"]
  }

  assert {
    condition = output.document_scan_review.bucket_policy_statements[1].sid == "DenyReadUnlessScanClean" && jsonencode(output.document_scan_review.bucket_policy_statements[1].conditions) == jsonencode({
      "ArnNotEquals:aws:PrincipalArn" = [
        "arn:aws:iam::123456789012:role/hid-development-ehr-api-task",
        "arn:aws:iam::123456789012:role/hid-development-gd-malware-mock",
      ]
      "StringNotEquals:s3:ExistingObjectTag/GuardDutyMalwareScanStatus" = ["NO_THREATS_FOUND"]
    })
    error_message = "Reads of objects not tagged clean (including untagged ones) are denied to all but GuardDuty and ehr-api."
  }

  assert {
    condition = output.document_scan_review.bucket_policy_statements[2].sid == "DenyReadOfInfected" && jsonencode(output.document_scan_review.bucket_policy_statements[2].conditions) == jsonencode({
      "ArnNotEquals:aws:PrincipalArn"                                = ["arn:aws:iam::123456789012:role/hid-development-gd-malware-mock"]
      "StringEquals:s3:ExistingObjectTag/GuardDutyMalwareScanStatus" = ["THREATS_FOUND"]
    })
    error_message = "Infected objects are readable by GuardDuty alone."
  }

  assert {
    condition = (
      output.document_scan_review.bucket_policy_statements[3].sid == "DenyScanTagWrites" &&
      jsonencode(output.document_scan_review.bucket_policy_statements[3].actions) == jsonencode(["s3:DeleteObjectTagging", "s3:DeleteObjectVersionTagging", "s3:PutObjectTagging", "s3:PutObjectVersionTagging"]) &&
      jsonencode(output.document_scan_review.bucket_policy_statements[3].conditions) == jsonencode({ "ArnNotEquals:aws:PrincipalArn" = ["arn:aws:iam::123456789012:role/hid-development-gd-malware-mock"] })
    )
    error_message = "Only GuardDuty may write or delete scan tags."
  }

  assert {
    condition = (
      output.document_scan_review.bucket_policy_statements[4].sid == "DenyTaggingOnUpload" &&
      jsonencode(output.document_scan_review.bucket_policy_statements[4].actions) == jsonencode(["s3:PutObject"]) &&
      jsonencode(output.document_scan_review.bucket_policy_statements[4].conditions) == jsonencode({ "Null:s3:RequestObjectTagKeys" = ["false"] })
    )
    error_message = "Uploads may not carry tags, so a scan tag cannot be forged at upload."
  }

  assert {
    condition     = alltrue([for statement in output.document_scan_review.bucket_policy_statements : statement.effect == "Deny"])
    error_message = "The bucket policy only ever denies."
  }
}

run "enforcement_without_guardduty_is_refused" {
  command = plan

  module {
    source = "./modules/data"
  }

  variables {
    document_scan_enforce_tags          = true
    document_scan_read_exempt_role_arns = ["arn:aws:iam::123456789012:role/hid-development-ehr-api-task"]
  }

  expect_failures = [aws_s3_bucket_policy.documents]
}

run "enforcement_without_the_ehr_api_exemption_is_refused" {
  command = plan

  module {
    source = "./modules/data"
  }

  variables {
    enable_document_malware_protection = true
    document_scan_enforce_tags         = true
  }

  expect_failures = [aws_s3_bucket_policy.documents]
}

run "protection_alone_leaves_the_bucket_policy_unchanged" {
  command = plan

  module {
    source = "./modules/data"
  }

  variables {
    enable_document_malware_protection = true
  }

  assert {
    condition     = length(output.document_scan_review.bucket_policy_statements) == 1 && output.document_scan_review.plan.count == 1
    error_message = "Protection on with enforcement off adds the plan and changes no bucket policy statement."
  }
}
