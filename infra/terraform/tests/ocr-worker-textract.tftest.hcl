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


# The ocr-worker reads paper records with Textract text detection only.
variables {
  expected_account_id      = "123456789012"
  environment              = "staging"
  availability_zones       = ["eu-west-1a", "eu-west-1b"]
  public_subnet_cidrs      = ["10.30.0.0/24", "10.30.1.0/24"]
  application_subnet_cidrs = ["10.30.10.0/24", "10.30.11.0/24"]
  database_subnet_cidrs    = ["10.30.20.0/24", "10.30.21.0/24"]
  enable_database          = true
}

run "ocr_worker_may_detect_text_and_no_other_new_textract_action" {
  command = plan

  assert {
    condition = jsonencode(module.application.ocr_textract_actions) == jsonencode([
      "textract:AnalyzeDocument",
      "textract:DetectDocumentText",
      "textract:GetDocumentTextDetection",
      "textract:StartDocumentTextDetection",
    ])
    error_message = "ocr-worker must be able to detect text (one image, or a multi-page PDF asynchronously) and gets no other Textract action."
  }
}
