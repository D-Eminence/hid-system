# timestamp() is unknown during plan: this external read runs at saved-plan apply,
# so an old plan cannot rely on a cached release index or expired lease assertion.
data "external" "release_state" {
  count   = var.enforce_release_index ? 1 : 0
  program = ["python", "${path.module}/scripts/read-release-state.py"]
  query = {
    nonce       = timestamp()
    bucket      = "hid-staging-releases-${var.expected_account_id}-${var.aws_region}"
    environment = var.promote_existing_staging ? "production" : "staging"
    account     = var.expected_account_id
    region      = var.aws_region
    holder      = var.release_lease_holder
    generation  = var.release_lease_generation
    version_id  = var.release_index_version_id
    sha256      = var.release_index_sha256
  }
}

resource "terraform_data" "release_guard" {
  input = "staging-release-input-guard-v1"
  lifecycle {
    precondition {
      condition     = !var.enable_deployment_automation || ((var.environment == "staging" || var.promote_existing_staging) && var.enable_runtime && var.enable_migration_task && var.enable_support_bot && var.expected_account_id == "659225405023" && var.aws_region == "eu-west-1")
      error_message = "Deployment automation requires the complete retained HID runtime, schema runner and support API in the exact account/region."
    }
    precondition {
      condition     = !var.enable_deployment_automation || var.enforce_release_index || var.deployment_automation_bootstrap
      error_message = "Automation-managed staging requires the release resolver and lease. Use bootstrap only for first installation."
    }
    precondition {
      condition     = !var.enforce_release_index || (var.enable_deployment_automation && !var.deployment_automation_bootstrap && var.release_index_version_id != "" && var.release_index_sha256 != "" && var.release_lease_holder != "" && var.release_lease_generation != "")
      error_message = "Verified index version/hash and a current shared lease are required."
    }
    precondition {
      condition     = !var.enforce_release_index || try(data.external.release_state[0].result.valid == "true", false)
      error_message = "Release index changed or the shared deployment lease was lost; regenerate the plan."
    }
    precondition {
      condition     = !var.enforce_release_index || try(jsondecode(data.external.release_state[0].result.image_uris) == var.image_uris && data.external.release_state[0].result.migration_image_uri == var.migration_image_uri, false)
      error_message = "Terraform image inputs differ from the verified live release; refusing an old-image rollback."
    }
  }
}
