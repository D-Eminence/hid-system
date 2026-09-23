terraform {
  required_version = ">= 1.6.0"

  backend "s3" {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.expected_account_id]

  default_tags {
    tags = {
      Project            = "HID"
      Environment        = var.environment
      ManagedBy          = "Terraform"
      Owner              = "HID"
      CostCenter         = "HID"
      DataClassification = "healthcare-restricted"
    }
  }
}
