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

# AWS Organizations is a global service; the region only selects the API endpoint.
provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.management_account_id]

  default_tags {
    tags = {
      Project            = "HID"
      Environment        = "organization"
      ManagedBy          = "Terraform"
      Owner              = "HID"
      CostCenter         = "HID"
      DataClassification = "healthcare-restricted"
      aws-apn-id         = "pc:elrusap42k3opao8syw9gd5s1"
    }
  }
}
