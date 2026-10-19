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

  default_tags {
    tags = {
      Project            = "HID"
      Environment        = "account"
      ManagedBy          = "Terraform"
      Owner              = "HID"
      CostCenter         = "HID"
      DataClassification = "healthcare-restricted"
      aws-apn-id         = "pc:elrusap42k3opao8syw9gd5s1"
    }
  }
}
