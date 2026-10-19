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

run "staging_prelaunch_exact_sizes" {
  command = plan
  variables {
    expected_account_id         = "123456789012"
    environment                 = "staging"
    staging_mode                = "economy"
    availability_zones          = ["eu-west-1a", "eu-west-1b"]
    public_subnet_cidrs         = ["10.30.0.0/24", "10.30.1.0/24"]
    application_subnet_cidrs    = ["10.30.10.0/24", "10.30.11.0/24"]
    database_subnet_cidrs       = ["10.30.20.0/24", "10.30.21.0/24"]
    staging_prelaunch_sizing    = true
    staging_worker_min_capacity = 1
  }
  assert {
    condition = length(output.runtime_capacity_configuration) == 11 && alltrue([
      for name, c in output.runtime_capacity_configuration :
      c.cpu == (contains(["ehr-api", "ocr-worker", "event-dispatcher"], name) ? 512 : 256) &&
      c.memory == (contains(["ehr-api", "ocr-worker", "event-dispatcher"], name) ? 1024 : 512) &&
      c.desired_count == 1 && c.max_capacity == 2
    ])
    error_message = "The core services must match approved prelaunch sizes and one-task baselines."
  }
  assert {
    condition     = sum([for c in values(output.runtime_capacity_configuration) : c.cpu]) == 3584 && sum([for c in values(output.runtime_capacity_configuration) : c.memory]) == 7168
    error_message = "Core services must total 3.5 vCPU / 7 GiB; the separately gated support API adds 0.25 vCPU / 0.5 GiB."
  }
}
run "standard_staging_sizes_preserved" {
  command = plan
  variables {
    expected_account_id      = "123456789012"
    environment              = "staging"
    staging_mode             = "economy"
    availability_zones       = ["eu-west-1a", "eu-west-1b"]
    public_subnet_cidrs      = ["10.30.0.0/24", "10.30.1.0/24"]
    application_subnet_cidrs = ["10.30.10.0/24", "10.30.11.0/24"]
    database_subnet_cidrs    = ["10.30.20.0/24", "10.30.21.0/24"]
    staging_prelaunch_sizing = false
  }
  assert {
    condition     = alltrue([for name, c in output.runtime_capacity_configuration : c.cpu == (contains(["ehr-api", "ocr-worker"], name) ? 1024 : 512) && c.memory == (contains(["ehr-api", "ocr-worker"], name) ? 2048 : 1024)])
    error_message = "Opt-out must preserve the original task sizes."
  }
}
run "reject_fidelity_prelaunch" {
  command = plan
  variables {
    expected_account_id      = "123456789012"
    environment              = "staging"
    staging_mode             = "fidelity"
    availability_zones       = ["eu-west-1a", "eu-west-1b"]
    public_subnet_cidrs      = ["10.30.0.0/24", "10.30.1.0/24"]
    application_subnet_cidrs = ["10.30.10.0/24", "10.30.11.0/24"]
    database_subnet_cidrs    = ["10.30.20.0/24", "10.30.21.0/24"]
    staging_prelaunch_sizing = true
  }
  expect_failures = [terraform_data.deployment_guard]
}
run "production_sizes_preserved" {
  command = plan
  variables {
    expected_account_id      = "123456789012"
    environment              = "production"
    staging_mode             = "sleep"
    availability_zones       = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
    public_subnet_cidrs      = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
    application_subnet_cidrs = ["10.40.10.0/24", "10.40.11.0/24", "10.40.12.0/24"]
    database_subnet_cidrs    = ["10.40.20.0/24", "10.40.21.0/24", "10.40.22.0/24"]
  }
  assert {
    condition     = alltrue([for name, c in output.runtime_capacity_configuration : c.cpu == (contains(["ehr-api", "ocr-worker"], name) ? 1024 : 512) && c.memory == (contains(["ehr-api", "ocr-worker"], name) ? 2048 : 1024) && c.desired_count == 2])
    error_message = "Production sizes and availability baselines must remain unchanged."
  }
}
