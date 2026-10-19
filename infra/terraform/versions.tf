terraform {
  required_version = ">= 1.7.0"

  backend "s3" {}

  required_providers {
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
    awscc = {
      source  = "hashicorp/awscc"
      version = "~> 1.100"
    }
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.expected_account_id]

  default_tags {
    tags = {
      Project            = "HID"
      Environment        = local.resource_environment
      ManagedBy          = "Terraform"
      Owner              = "HID"
      CostCenter         = "HID"
      DataClassification = "healthcare-restricted"
      aws-apn-id         = local.partner_apn_id
    }
  }
}

provider "awscc" {
  region = var.aws_region
}
