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


# The adopted production stack runs the economy profile (one database, no
# standby). database_multi_az adds the standby copy without changing the profile.
variables {
  expected_account_id      = "123456789012"
  environment              = "staging"
  availability_zones       = ["eu-west-1a", "eu-west-1b"]
  public_subnet_cidrs      = ["10.30.0.0/24", "10.30.1.0/24"]
  application_subnet_cidrs = ["10.30.10.0/24", "10.30.11.0/24"]
  database_subnet_cidrs    = ["10.30.20.0/24", "10.30.21.0/24"]
  enable_database          = true
  staging_mode             = "economy"
}

run "profile_choice_kept_when_unset" {
  command = plan

  assert {
    condition     = local.deployment_profile == "economy" && !local.database_multi_az
    error_message = "Without an explicit setting the economy profile keeps a single database."
  }
}

run "explicit_standby_wins_over_the_profile" {
  command = plan

  variables {
    database_multi_az = true
  }

  assert {
    condition     = local.database_multi_az && !local.profile.database_multi_az && module.data.database_multi_az_requested
    error_message = "database_multi_az = true must give the database a standby copy without changing the capacity profile."
  }
}

run "explicit_false_wins_over_a_profile_with_standby" {
  command = plan

  variables {
    staging_mode      = "fidelity"
    database_multi_az = false
  }

  assert {
    condition     = local.profile.database_multi_az && !local.database_multi_az && !module.data.database_multi_az_requested
    error_message = "database_multi_az = false must turn the standby off even when the capacity profile has one."
  }
}
