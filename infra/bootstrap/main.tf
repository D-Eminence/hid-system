terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {}
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.expected_account_id]
}

variable "aws_region" {
  type        = string
  description = "Approved home region for the state bucket."
}

variable "expected_account_id" {
  type        = string
  description = "AWS account that owns the Terraform state bucket."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "expected_account_id must be a 12-digit AWS account ID."
  }
}

resource "aws_s3_bucket" "state" {
  bucket_prefix = "health-identity-tfstate-"
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Project   = "health-identity"
    Purpose   = "terraform-state"
    ManagedBy = "terraform"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "state" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state.json
}

data "aws_iam_policy_document" "state_access" {
  statement {
    sid       = "ListStatePrefix"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["health-identity/*"]
    }
  }

  statement {
    sid       = "ReadWriteState"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.state.arn}/health-identity/*"]
  }

  statement {
    sid       = "ReleaseStateLock"
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.state.arn}/health-identity/*.tflock"]
  }
}

resource "aws_iam_policy" "state_access" {
  name   = "health-identity-terraform-state-access"
  policy = data.aws_iam_policy_document.state_access.json
}

output "state_bucket_name" {
  value = aws_s3_bucket.state.id
}

output "state_access_policy_arn" {
  value = aws_iam_policy.state_access.arn
}
