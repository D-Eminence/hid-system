terraform {
  required_version = ">= 1.7.0"
  backend "s3" {}
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

provider "aws" {
  region              = "eu-west-1"
  allowed_account_ids = ["659225405023"]
  default_tags {
    tags = {
      Project = "HID", Environment = "staging", ManagedBy = "Terraform",
      Owner   = "HID", CostCenter = "HID", aws-apn-id = "pc:elrusap42k3opao8syw9gd5s1"
    }
  }
}

locals {
  components = toset(["identity-api", "ehr-api", "lab-api", "pharmacy-api", "ocr-api", "ocr-worker",
  "outreach-api", "notification-api", "notification-worker", "event-dispatcher", "gateway", "support-api"])
  repositories = [for component in sort(tolist(local.components)) :
  "arn:aws:ecr:eu-west-1:659225405023:repository/staging/hid/${component}"]
  # Confirmed from GitHub's repository OIDC API, including immutable IDs.
  oidc_prefix = "repo:D-Eminence@182018869/hid-system@1317340803"
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = ["arn:aws:iam::659225405023:oidc-provider/token.actions.githubusercontent.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = ["${local.oidc_prefix}:ref:refs/heads/staging-novu-ci-20261005",
      "${local.oidc_prefix}:ref:refs/heads/staging"]
    }
  }
}

resource "aws_iam_role" "build" {
  depends_on           = [aws_iam_openid_connect_provider.github]
  name                 = "hid-staging-github-ecr-build"
  description          = "GitHub staging backend image publication only; no runtime or production access"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "ecr" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
    "ecr:DescribeRepositories", "ecr:DescribeImages"]
    resources = local.repositories
  }
}

resource "aws_iam_role_policy" "build" {
  name   = "existing-staging-ecr-only"
  role   = aws_iam_role.build.id
  policy = data.aws_iam_policy_document.ecr.json
}

output "build_role_arn" {
  value = aws_iam_role.build.arn
}
