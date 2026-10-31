# Terraform check blocks only warn. These preconditions reject unsafe plans.
resource "terraform_data" "deployment_guard" {
  input = var.environment

  lifecycle {
    precondition {
      condition     = !var.staging_prelaunch_sizing || (var.environment == "staging" && var.staging_mode == "economy")
      error_message = "Pre-launch sizing is permitted only for staging economy."
    }
    precondition {
      condition = !var.enable_ai || var.ai_generation_provider != "anthropic" || (
        var.ai_allow_anthropic_us_processing &&
        startswith(var.anthropic_secret_arn, "arn:aws:secretsmanager:${var.aws_region}:${var.expected_account_id}:secret:")
      )
      error_message = "Direct Claude requires approved US processing and an existing secret in this deployment account/region."
    }
    precondition {
      condition = var.anthropic_secret_arn == "" || startswith(var.anthropic_secret_arn,
      "arn:aws:secretsmanager:${var.aws_region}:${var.expected_account_id}:secret:")
      error_message = "Anthropic credential secret must belong to this deployment account and region."
    }
    precondition {
      condition = var.anthropic_secret_kms_key_arn == "" || (
        var.anthropic_secret_arn != "" && startswith(var.anthropic_secret_kms_key_arn,
        "arn:aws:kms:${var.aws_region}:${var.expected_account_id}:key/")
      )
      error_message = "Anthropic customer managed key requires a credential secret and the same account/region."
    }
    precondition {
      condition     = !var.qoreid_enabled || startswith(var.qoreid_secret_arn, "arn:aws:secretsmanager:${var.aws_region}:${var.expected_account_id}:secret:")
      error_message = "QoreID secret must belong to this deployment account and region."
    }
    precondition {
      condition     = var.qoreid_secret_kms_key_arn == "" || (var.qoreid_enabled && startswith(var.qoreid_secret_kms_key_arn, "arn:aws:kms:${var.aws_region}:${var.expected_account_id}:key/"))
      error_message = "A QoreID customer managed key requires enabled QoreID in the same account and region."
    }
    precondition {
      condition     = !var.qoreid_enabled || var.qoreid_secret_arn != ""
      error_message = "QoreID enablement requires an existing entitled credential secret ARN."
    }
    precondition {
      condition     = !var.qoreid_nin_only_enrollment_enabled || var.qoreid_enabled
      error_message = "NIN-only enrollment requires QoreID enablement and accepted source readiness."
    }
    precondition {
      condition     = !var.emergency_contact_delivery_enabled || var.emergency_contact_notification_enabled
      error_message = "Identity emergency-contact delivery requires notification-api delivery; switch emergency_contact_notification_enabled on first and off last."
    }
    precondition {
      condition     = !var.web_push_enabled || var.web_push_vapid_public_key != ""
      error_message = "Web push requires web_push_vapid_public_key, and webPushVapidPrivateKey already stored in the notification-provider secret."
    }
    precondition {
      condition     = var.environment == "staging" || var.staging_mode == "sleep"
      error_message = "staging_mode is only meaningful for staging; leave it at sleep elsewhere."
    }

    precondition {
      condition = (
        length(var.availability_zones) == length(var.public_subnet_cidrs) &&
        length(var.availability_zones) == length(var.application_subnet_cidrs) &&
        length(var.availability_zones) == length(var.database_subnet_cidrs) &&
        (var.environment == "production" && !var.promote_existing_staging ? length(var.availability_zones) == 3 : length(var.availability_zones) == 2)
      )
      error_message = "Subnet lists must match the AZ count: two for development/staging and three for production."
    }

    precondition {
      condition = !var.enable_runtime || (
        length(setsubtract(toset(keys(local.workloads)), toset(keys(var.image_uris)))) == 0 &&
        var.migration_image_uri != "" &&
        var.rds_ca_bundle_base64 != "" &&
        (
          var.environment != "development" || (
            var.workload_issuer_url != "" &&
            var.workload_jwks_url != "" &&
            length(setsubtract(
              toset(["identity", "ehr", "lab", "pharmacy", "ocr", "outreach"]),
              toset(keys(var.workload_subjects))
            )) == 0
          )
        )
      )
      error_message = "Runtime requires every workload image, the migration image, the RDS CA bundle, and development workload identity settings."
    }

    precondition {
      condition = !var.enable_migration_task || (
        var.enable_database &&
        var.migration_image_uri != "" &&
        var.rds_ca_bundle_base64 != ""
      )
      error_message = "The one-shot migration task requires the database, a digest-qualified migration image, and the RDS CA bundle."
    }

    precondition {
      condition = (
        (var.migration_source_bucket_arn == "" && var.migration_source_kms_key_arn == "") ||
        (var.migration_source_bucket_arn != "" && var.migration_source_kms_key_arn != "")
      )
      error_message = "The protected migration-source bucket and KMS key ARNs must be set together."
    }

    precondition {
      condition = !var.enable_ingress || (
        var.enable_runtime &&
        var.regional_certificate_arn != "" &&
        var.internal_certificate_arn != "" &&
        length(var.cloudflare_origin_secret) >= 32
      )
      error_message = "Ingress requires runtime, both ACM certificates, and the Cloudflare origin secret."
    }

    precondition {
      condition = (
        (!var.enable_runtime || (var.enable_database && var.enable_ingress)) &&
        (!var.enable_backup_plan || var.enable_database) &&
        (!var.enable_ai || var.enable_database) &&
        (local.deployment_profile != "sleep" || (!var.enable_runtime && !var.enable_ingress))
      )
      error_message = join(" ", [
        "Runtime requires the database and ingress together; backup and AI require the database;",
        "the staging sleep profile cannot run services or load balancers."
      ])
    }

    precondition {
      condition     = !var.enable_support_bot || (length(var.support_faqs) > 0 && var.support_contact != "")
      error_message = "The support bot requires approved support_faqs and a public support_contact before it can be created."
    }

    precondition {
      condition     = !var.use_existing_secrets || local.resource_environment == "staging"
      error_message = "Existing secret lookup must retain the verified staging resource namespace."
    }

    precondition {
      condition     = !var.enable_runtime || local.resource_environment != "staging" || var.staging_novu_api_url != ""
      error_message = "Staging runtime requires the API endpoint for HID's existing Novu environment."
    }

    precondition {
      condition     = local.deployment_profile == "sleep" || local.normal_database_connection_demand <= local.profile.database_connection_budget
      error_message = "Workload scaling ceilings exceed the selected profile's database connection budget."
    }

    precondition {
      condition     = !var.enable_cost_governance || can(regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", var.cost_notification_email))
      error_message = "Cost governance requires a valid notification email address."
    }

    precondition {
      condition     = !var.offline_escrow_enabled || startswith(var.offline_escrow_secret_arn, "arn:aws:secretsmanager:${var.aws_region}:${var.expected_account_id}:secret:")
      error_message = "Offline escrow requires offline_escrow_secret_arn: an existing secret in this deployment account and region that already holds offlineEscrowKeys."
    }
  }
}
