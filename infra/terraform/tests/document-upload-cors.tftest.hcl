# Browser uploads go straight to the documents bucket with a presigned PUT link,
# so the bucket needs a CORS rule for the approved upload hosts, and nothing more.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }

  mock_data "aws_region" {
    defaults = { region = "eu-west-1" }
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

run "no_upload_hosts_adds_no_rule" {
  command = plan

  module {
    source = "./modules/data"
  }

  assert {
    condition     = length(aws_s3_bucket_cors_configuration.documents) == 0
    error_message = "Without upload hosts the documents bucket must keep no CORS rule."
  }
}

run "upload_hosts_may_put_with_the_signed_headers_only" {
  command = plan

  module {
    source = "./modules/data"
  }

  variables {
    document_upload_origins = ["https://ehr.example.org", "https://lab.example.org"]
  }

  assert {
    condition = (
      length(aws_s3_bucket_cors_configuration.documents) == 1 &&
      length(aws_s3_bucket_cors_configuration.documents[0].cors_rule) == 1
    )
    error_message = "Upload hosts must get exactly one CORS rule on the documents bucket."
  }

  assert {
    condition = alltrue([for rule in aws_s3_bucket_cors_configuration.documents[0].cors_rule :
      jsonencode(sort(rule.allowed_methods)) == jsonencode(["PUT"]) &&
      jsonencode(sort(rule.allowed_origins)) == jsonencode(["https://ehr.example.org", "https://lab.example.org"]) &&
      jsonencode(sort(rule.allowed_headers)) == jsonencode([
        "content-type",
        "x-amz-checksum-sha256",
        "x-amz-meta-declared-sha256",
        "x-amz-server-side-encryption",
        "x-amz-server-side-encryption-aws-kms-key-id",
      ]) &&
      (rule.expose_headers == null ? true : length(rule.expose_headers) == 0)
    ])
    error_message = "The rule must allow only PUT, only the listed hosts, and only the headers the presigned upload sends."
  }
}

run "wildcard_upload_origin_is_refused" {
  command = plan

  module {
    source = "./modules/data"
  }

  variables {
    document_upload_origins = ["https://*.example.org"]
  }

  expect_failures = [var.document_upload_origins]
}

run "plain_http_or_path_upload_origin_is_refused" {
  command = plan

  module {
    source = "./modules/data"
  }

  variables {
    document_upload_origins = ["http://ehr.example.org", "https://ehr.example.org/provider"]
  }

  expect_failures = [var.document_upload_origins]
}
