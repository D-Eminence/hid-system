locals {
  runtime_environment  = var.runtime_environment != "" ? var.runtime_environment : var.environment
  browser_origins      = var.browser_origins != null ? var.browser_origins : [for subdomain in var.browser_subdomains : "https://${subdomain}.${var.root_domain_name}"]
  notification_profile = var.notification_delivery_profile != "" ? var.notification_delivery_profile : (local.runtime_environment == "staging" ? "email-only" : "full")
  # Token files are shared between the application container and the
  # workload-token sidecar through an ephemeral task volume.
  token_root = "/var/run/hid/workload-tokens"

  workload_token_files = {
    identity-api = {
      NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE = "${local.token_root}/notification.jwt"
    }
    ehr-api = {
      IDENTITY_EHR_WORKLOAD_TOKEN_FILE = "${local.token_root}/identity.jwt"
      LAB_EHR_WORKLOAD_TOKEN_FILE      = "${local.token_root}/lab.jwt"
      PHARMACY_EHR_WORKLOAD_TOKEN_FILE = "${local.token_root}/pharmacy.jwt"
    }
    lab-api = {
      IDENTITY_LAB_WORKLOAD_TOKEN_FILE = "${local.token_root}/identity.jwt"
    }
    pharmacy-api = {
      IDENTITY_PHARMACY_WORKLOAD_TOKEN_FILE = "${local.token_root}/identity.jwt"
    }
    ocr-api = {
      IDENTITY_OCR_WORKLOAD_TOKEN_FILE = "${local.token_root}/identity.jwt"
      EHR_OCR_WORKLOAD_TOKEN_FILE      = "${local.token_root}/ehr.jwt"
      LAB_OCR_WORKLOAD_TOKEN_FILE      = "${local.token_root}/lab.jwt"
      PHARMACY_OCR_WORKLOAD_TOKEN_FILE = "${local.token_root}/pharmacy.jwt"
    }
    outreach-api = {
      OUTREACH_IDENTITY_WORKLOAD_TOKEN_FILE = "${local.token_root}/identity.jwt"
    }
  }

  workload_token_requests = {
    for name, files in local.workload_token_files : name => [
      for path in values(files) : {
        file     = basename(path)
        audience = "hid-${trimsuffix(basename(path), ".jwt")}-api"
      }
    ]
  }
  service_urls = {
    for name, label in local.service_host_labels :
    name => "https://${label}.${local.private_zone_name}"
  }

  identity_subjects = local.managed_identity_enabled ? {
    identity = "hid:${local.workload_identity_environment}:identity-api"
    ehr      = "hid:${local.workload_identity_environment}:ehr-api"
    lab      = "hid:${local.workload_identity_environment}:lab-api"
    pharmacy = "hid:${local.workload_identity_environment}:pharmacy-api"
    ocr      = "hid:${local.workload_identity_environment}:ocr-api"
    outreach = "hid:${local.workload_identity_environment}:outreach-api"
  } : var.workload_subjects

  common_api_environment = {
    NODE_ENV                      = "production"
    HID_DEPLOYMENT_ENV            = local.runtime_environment == "staging" ? "staging" : "production"
    DATABASE_SSL                  = "true"
    DATABASE_SSL_ROOT_CERT_BASE64 = var.rds_ca_bundle_base64
    CORS_ORIGINS                  = join(",", local.browser_origins)
    TRUST_PROXY_CIDRS             = var.vpc_cidr
  }

  database_secret_environment = {
    identity-api        = "DATABASE_URL"
    ehr-api             = "DATABASE_URL"
    lab-api             = "LAB_DATABASE_URL"
    pharmacy-api        = "PHARMACY_DATABASE_URL"
    ocr-api             = "OCR_DATABASE_URL"
    ocr-worker          = "OCR_WORKER_DATABASE_URL"
    outreach-api        = "OUTREACH_DATABASE_URL"
    notification-worker = "NOTIFICATION_WORKER_DATABASE_URL"
    event-dispatcher    = "EVENT_DISPATCHER_DATABASE_URL"
  }

  fixed_secret_specs = {
    ehr-api = var.enable_ai && var.ai_generation_provider == "anthropic" ? [
      { name = "ANTHROPIC_API_KEY", arn = var.anthropic_secret_arn, key = var.anthropic_secret_json_key }
    ] : []
    identity-api = concat([
      {
        name = "AUTH_SIGNING_SECRET"
        arn  = var.runtime_secret_arns["auth"]
        key  = "authSigningSecret"
      },
      {
        name = "AUTH_LOGIN_PEPPER"
        arn  = var.runtime_secret_arns["auth"]
        key  = "authLoginPepper"
      },
      {
        name = "OTP_HMAC_KEY_B64"
        arn  = var.runtime_secret_arns["identity-sensitive"]
        key  = "otpHmacKeyB64"
      },
      {
        name = "CONTACT_LOOKUP_HMAC_KEY_B64"
        arn  = var.runtime_secret_arns["identity-sensitive"]
        key  = "contactLookupHmacKeyB64"
      },
      {
        name = "TURNSTILE_SECRET_KEY"
        arn  = var.runtime_secret_arns["identity-sensitive"]
        key  = "turnstileSecretKey"
      }
      ], local.runtime_environment == "staging" && !var.qoreid_enabled ? [] : [
      {
        name = "NIN_LOOKUP_HMAC_KEY_B64"
        arn  = var.runtime_secret_arns["identity-sensitive"]
        key  = "ninLookupHmacKeyB64"
      },
      {
        name = "NIN_ENCRYPTION_KEY_B64"
        arn  = var.runtime_secret_arns["identity-sensitive"]
        key  = "ninEncryptionKeyB64"
      }
      ], var.qoreid_enabled ? [
      { name = "QOREID_CLIENT_ID", arn = var.qoreid_secret_arn, key = "clientId" },
      { name = "QOREID_CLIENT_SECRET", arn = var.qoreid_secret_arn, key = "secret" },
    ] : [])

    notification-api = concat(local.notification_profile != "full" ? concat([
      {
        name = "SES_FROM_ADDRESS"
        arn  = var.runtime_secret_arns["notification-provider"]
        key  = "sesFromAddress"
      }
      ], contains(["email-brevo", "email-sms-brevo"], local.notification_profile) ? [
      { name = "BREVO_API_KEY", arn = var.runtime_secret_arns["notification-provider"], key = "brevoApiKey" },
      { name = "BREVO_EMAIL_FROM", arn = var.runtime_secret_arns["notification-provider"], key = "brevoEmailFrom" },
      ] : [], local.notification_profile == "email-sms-brevo" ? [
      { name = "TERMII_BASE_URL", arn = var.runtime_secret_arns["notification-provider"], key = "termiiBaseUrl" },
      { name = "TERMII_API_KEY", arn = var.runtime_secret_arns["notification-provider"], key = "termiiApiKey" },
      { name = "TERMII_SENDER_ID", arn = var.runtime_secret_arns["notification-provider"], key = "termiiSenderId" },
      { name = "BREVO_SMS_SENDER", arn = var.runtime_secret_arns["notification-provider"], key = "brevoSmsSender" },
      ] : []) : [
      for pair in [
        ["SES_FROM_ADDRESS", "sesFromAddress"],
        ["TERMII_BASE_URL", "termiiBaseUrl"],
        ["TERMII_API_KEY", "termiiApiKey"],
        ["TERMII_SENDER_ID", "termiiSenderId"],
        ["META_PHONE_NUMBER_ID", "metaPhoneNumberId"],
        ["META_ACCESS_TOKEN", "metaAccessToken"],
        ["META_OTP_TEMPLATE_NAME", "metaOtpTemplateName"],
        ["BREVO_API_KEY", "brevoApiKey"],
        ["BREVO_EMAIL_FROM", "brevoEmailFrom"],
        ["BREVO_SMS_SENDER", "brevoSmsSender"],
        ] : {
        name = pair[0]
        arn  = var.runtime_secret_arns["notification-provider"]
        key  = pair[1]
      }
    ], local.web_push_secret_specs)

    notification-worker = [
      {
        name = "NOVU_API_KEY"
        arn  = var.runtime_secret_arns["notification-provider"]
        key  = "novuApiKey"
      }
    ]
  }

  database_secret_specs = {
    for name, environment_name in local.database_secret_environment : name => concat(
      [{
        name = environment_name
        arn  = var.database_secret_arns[name]
        key  = "url"
      }],
      name == "ehr-api" ? [{
        name = "WORKLOAD_DATABASE_URL"
        arn  = var.database_secret_arns[name]
        key  = "scannerUrl"
      }] : []
    )
  }

  workload_secret_specs = {
    for name, workload in local.runtime_workloads : name => concat(
      lookup(local.database_secret_specs, name, []),
      lookup(local.fixed_secret_specs, name, []),
      name == "ehr-api" ? local.offline_escrow_secret_specs : []
    )
  }

  # EHR offline escrow (D6). Off adds nothing, so no task definition changes.
  # Only ehr-api reads the dedicated secret; no other workload is granted it.
  offline_escrow_environment = var.offline_escrow_enabled ? {
    OFFLINE_ESCROW_ENABLED = "true"
  } : {}
  offline_escrow_secret_specs = var.offline_escrow_enabled ? [
    { name = "OFFLINE_ESCROW_KEYS", arn = var.offline_escrow_secret_arn, key = "offlineEscrowKeys" }
  ] : []

  # Since hid-system staging-novu-ci-20261005 #112/#113, both services default
  # emergency-contact delivery to on when the key is absent (owner approval of
  # 2026-10-24). The flag is therefore always written explicitly: a switch set
  # to false writes "false", which is the only value that turns a service off.
  emergency_contact_channels = contains(["email-sms-brevo", "full"], local.notification_profile) ? "email,sms" : "email"
  emergency_contact_identity_environment = var.emergency_contact_delivery_enabled ? merge({
    EMERGENCY_CONTACT_DELIVERY_ENABLED = "true"
    PATIENT_LIFECYCLE_SWEEP_SECONDS    = tostring(var.emergency_contact_dispatch_seconds)
    EMERGENCY_CONTACT_CHANNELS         = local.emergency_contact_channels
    }, length(var.emergency_contact_pilot_account_ids) > 0 ? {
    EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS = join(",", [for id in var.emergency_contact_pilot_account_ids : lower(id)])
    } : {}) : {
    EMERGENCY_CONTACT_DELIVERY_ENABLED = "false"
  }
  emergency_contact_notification_environment = {
    EMERGENCY_CONTACT_DELIVERY_ENABLED = tostring(var.emergency_contact_notification_enabled)
  }

  # Patient web push (B6). Off adds nothing, so no task definition changes.
  # Identity never receives the private key; notification-api reads it from
  # its provider secret, which its execution role may already read.
  web_push_environment = var.web_push_enabled ? {
    WEB_PUSH_VAPID_PUBLIC_KEY = var.web_push_vapid_public_key
    WEB_PUSH_SUBJECT          = var.web_push_subject
  } : {}
  web_push_secret_specs = var.web_push_enabled ? [
    { name = "WEB_PUSH_VAPID_PRIVATE_KEY", arn = var.runtime_secret_arns["notification-provider"], key = "webPushVapidPrivateKey" }
  ] : []

  workload_environment = {
    identity-api = merge(local.common_api_environment, local.workload_token_files.identity-api, {
      # The separate staging public website calls only Identity's public APIs.
      # Keep other service origins and production configuration unchanged.
      CORS_ORIGINS = join(",", concat(
        local.browser_origins,
        local.runtime_environment == "staging" ? ["https://www.staging.${var.root_domain_name}"] : []
      ))
      PORT                               = "3001"
      DATABASE_POOL_MAX                  = "6"
      AUTH_MODE                          = "local"
      GOOGLE_OIDC_CLIENT_IDS             = join(",", var.google_oidc_client_ids)
      QOREID_ENABLED                     = tostring(var.qoreid_enabled)
      QOREID_NIN_ONLY_ENROLLMENT_ENABLED = tostring(var.qoreid_nin_only_enrollment_enabled)
      QOREID_BASE_URL                    = "https://api.qoreid.com"
      AUTH_COOKIE_SECURE                 = "true"
      AUTH_ISSUER                        = "hid-identity"
      AUTH_AUDIENCE                      = "hid-api"
      TURNSTILE_MODE                     = "required"
      OTP_HMAC_KEY_VERSION               = "aws-v1"
      NIN_PROVIDER_MODE                  = local.runtime_environment == "staging" ? "deferred" : "unavailable"
      NIN_KEY_VERSION                    = "aws-v1"
      NOTIFICATION_API_URL               = local.service_urls.notification-api
      NOTIFICATION_SERVICE_IDENTITY_MODE = "jwt"
      IDENTITY_SERVICE_IDENTITY_MODE     = "jwt"
      WORKLOAD_ISSUER_URL                = local.managed_issuer_url
      WORKLOAD_JWKS_URL                  = local.managed_jwks_url
      WORKLOAD_AUDIENCE                  = "hid-identity-api"
      IDENTITY_EHR_CALLER_SUBJECT        = lookup(local.identity_subjects, "ehr", "")
      IDENTITY_LAB_CALLER_SUBJECT        = lookup(local.identity_subjects, "lab", "")
      IDENTITY_PHARMACY_CALLER_SUBJECT   = lookup(local.identity_subjects, "pharmacy", "")
      IDENTITY_OCR_CALLER_SUBJECT        = lookup(local.identity_subjects, "ocr", "")
      OUTREACH_CALLER_SUBJECT            = lookup(local.identity_subjects, "outreach", "")
      ADMIN_IDENTITY_STATUS_URL          = local.service_urls.identity-api
      ADMIN_EHR_STATUS_URL               = local.service_urls.ehr-api
      ADMIN_LAB_STATUS_URL               = local.service_urls.lab-api
      ADMIN_PHARMACY_STATUS_URL          = local.service_urls.pharmacy-api
      ADMIN_OCR_STATUS_URL               = local.service_urls.ocr-api
      ADMIN_OUTREACH_STATUS_URL          = local.service_urls.outreach-api
      ADMIN_EVENT_DISPATCHER_STATUS_URL  = local.service_urls.event-dispatcher
    }, local.emergency_contact_identity_environment, local.web_push_environment)

    ehr-api = merge(local.common_api_environment, local.workload_token_files.ehr-api, {
      PORT                                    = "3002"
      DATABASE_POOL_MAX                       = "8"
      WORKLOAD_DATABASE_POOL_MAX              = "3"
      IDENTITY_API_URL                        = local.service_urls.identity-api
      LAB_API_URL                             = local.service_urls.lab-api
      PHARMACY_API_URL                        = local.service_urls.pharmacy-api
      IDENTITY_SERVICE_IDENTITY_MODE          = "jwt"
      LAB_SERVICE_IDENTITY_MODE               = "jwt"
      PHARMACY_SERVICE_IDENTITY_MODE          = "jwt"
      EHR_SERVICE_IDENTITY_MODE               = "jwt"
      EHR_WORKLOAD_ISSUER_URL                 = local.managed_issuer_url
      EHR_WORKLOAD_JWKS_URL                   = local.managed_jwks_url
      EHR_WORKLOAD_AUDIENCE                   = "hid-ehr-api"
      EHR_OCR_CALLER_SUBJECT                  = lookup(local.identity_subjects, "ocr", "")
      OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE = "jwt"
      OUTREACH_CALLER_SUBJECT                 = lookup(local.identity_subjects, "outreach", "")
      STORAGE_MODE                            = "s3"
      S3_REGION                               = var.aws_region
      S3_BUCKET                               = trimprefix(var.document_bucket_arn, "arn:aws:s3:::")
      S3_FORCE_PATH_STYLE                     = "false"
      S3_KMS_KEY_ID                           = var.document_kms_key_arn
      AI_ENABLED                              = tostring(var.enable_ai)
      AI_ALLOW_EU_PROCESSING                  = tostring(var.ai_allow_eu_processing)
      AI_GENERATION_MODEL_ID                  = var.ai_generation_provider == "anthropic" ? var.anthropic_model_id : "eu.anthropic.claude-sonnet-4-6"
      ANTHROPIC_PROCESSING_APPROVED           = tostring(var.ai_allow_anthropic_us_processing)
      AI_EMBEDDING_MODEL_ID                   = "amazon.titan-embed-text-v2:0"
    }, local.offline_escrow_environment)
    lab-api = merge(local.common_api_environment, local.workload_token_files.lab-api, {
      PORT                           = "3003"
      DATABASE_POOL_MAX              = "5"
      IDENTITY_API_URL               = local.service_urls.identity-api
      IDENTITY_SERVICE_IDENTITY_MODE = "jwt"
      LAB_SERVICE_IDENTITY_MODE      = "jwt"
      LAB_WORKLOAD_ISSUER_URL        = local.managed_issuer_url
      LAB_WORKLOAD_JWKS_URL          = local.managed_jwks_url
      LAB_WORKLOAD_AUDIENCE          = "hid-lab-api"
      LAB_EHR_CALLER_SUBJECT         = lookup(local.identity_subjects, "ehr", "")
      LAB_OCR_CALLER_SUBJECT         = lookup(local.identity_subjects, "ocr", "")
    })

    pharmacy-api = merge(local.common_api_environment, local.workload_token_files.pharmacy-api, {
      PORT                           = "3004"
      DATABASE_POOL_MAX              = "5"
      IDENTITY_API_URL               = local.service_urls.identity-api
      IDENTITY_SERVICE_IDENTITY_MODE = "jwt"
      PHARMACY_SERVICE_IDENTITY_MODE = "jwt"
      PHARMACY_WORKLOAD_ISSUER_URL   = local.managed_issuer_url
      PHARMACY_WORKLOAD_JWKS_URL     = local.managed_jwks_url
      PHARMACY_WORKLOAD_AUDIENCE     = "hid-pharmacy-api"
      PHARMACY_EHR_CALLER_SUBJECT    = lookup(local.identity_subjects, "ehr", "")
      PHARMACY_OCR_CALLER_SUBJECT    = lookup(local.identity_subjects, "ocr", "")
    })

    ocr-api = merge(local.common_api_environment, local.workload_token_files.ocr-api, {
      PORT                           = "3005"
      DATABASE_POOL_MAX              = "5"
      IDENTITY_API_URL               = local.service_urls.identity-api
      EHR_API_URL                    = local.service_urls.ehr-api
      LAB_API_URL                    = local.service_urls.lab-api
      PHARMACY_API_URL               = local.service_urls.pharmacy-api
      IDENTITY_SERVICE_IDENTITY_MODE = "jwt"
      EHR_SERVICE_IDENTITY_MODE      = "jwt"
      LAB_SERVICE_IDENTITY_MODE      = "jwt"
      PHARMACY_SERVICE_IDENTITY_MODE = "jwt"
    })

    outreach-api = merge(local.common_api_environment, local.workload_token_files.outreach-api, {
      PORT                                    = "3006"
      DATABASE_POOL_MAX                       = "5"
      IDENTITY_API_URL                        = local.service_urls.identity-api
      OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE = "jwt"
    })
    notification-api = merge({
      NODE_ENV                            = "production"
      HID_DEPLOYMENT_ENV                  = local.runtime_environment
      PORT                                = "3007"
      NOTIFICATION_PROVIDER_MODE          = "live"
      NOTIFICATION_WORKLOAD_IDENTITY_MODE = "jwt"
      WORKLOAD_ISSUER_URL                 = local.managed_issuer_url
      WORKLOAD_JWKS_URL                   = local.managed_jwks_url
      WORKLOAD_AUDIENCE                   = "hid-notification-api"
      IDENTITY_CALLER_SUBJECT             = lookup(local.identity_subjects, "identity", "")
      AWS_REGION                          = var.aws_region
    }, { NOTIFICATION_DELIVERY_PROFILE = local.notification_profile }, local.emergency_contact_notification_environment, local.web_push_environment)

    notification-worker = merge({
      NODE_ENV                                          = "production"
      NOTIFICATION_WORKER_ENABLED                       = "true"
      NOTIFICATION_WORKER_ID                            = "notification-worker-${var.environment}"
      NOTIFICATION_WORKER_STATUS_HOST                   = "0.0.0.0"
      NOTIFICATION_WORKER_STATUS_PORT                   = "3008"
      NOTIFICATION_WORKER_DATABASE_SSL                  = "true"
      NOTIFICATION_WORKER_DATABASE_SSL_ROOT_CERT_BASE64 = var.rds_ca_bundle_base64
      NOTIFICATION_WORKER_DATABASE_POOL_MAX             = "4"
      NOTIFICATION_WORKER_QUEUE_URL                     = var.notification_queue_url
      NOVU_MODE                                         = "live"
      AWS_REGION                                        = var.aws_region
      }, var.staging_novu_api_url != "" ? {
      NOVU_API_URL = var.staging_novu_api_url
    } : {})

    ocr-worker = {
      NODE_ENV                                 = "production"
      OCR_PROVIDER                             = "textract"
      OCR_WORKER_SUBJECT                       = lookup(local.identity_subjects, "ocr", "")
      OCR_WORKER_DATABASE_SSL                  = "true"
      OCR_WORKER_DATABASE_SSL_ROOT_CERT_BASE64 = var.rds_ca_bundle_base64
      OCR_WORKER_POOL_MAX                      = "4"
      OCR_WORKER_CONCURRENCY                   = "2"
      AWS_REGION                               = var.aws_region
      S3_FORCE_PATH_STYLE                      = "false"
    }

    event-dispatcher = {
      NODE_ENV                                       = "production"
      EVENT_DISPATCHER_ENABLED                       = "true"
      EVENT_DISPATCHER_TRANSPORT                     = "eventbridge"
      EVENT_DISPATCHER_DATABASE_SSL                  = "true"
      EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64 = var.rds_ca_bundle_base64
      EVENT_DISPATCHER_POOL_MAX                      = "4"
      EVENT_DISPATCHER_STATUS_HOST                   = "0.0.0.0"
      EVENT_DISPATCHER_STATUS_PORT                   = "3010"
      EVENTBRIDGE_EVENT_BUS_NAME                     = var.event_bus_arn
      AWS_REGION                                     = var.aws_region
    }
    gateway = {
      GATEWAY_TRUSTED_PROXY_CIDR = var.vpc_cidr
      GATEWAY_DNS_RESOLVER       = "169.254.169.253"
      IDENTITY_API_UPSTREAM      = "http://identity-api.services.${var.environment}.hid:3001"
      EHR_API_UPSTREAM           = "http://ehr-api.services.${var.environment}.hid:3002"
      LAB_API_UPSTREAM           = "http://lab-api.services.${var.environment}.hid:3003"
      PHARMACY_API_UPSTREAM      = "http://pharmacy-api.services.${var.environment}.hid:3004"
      OCR_API_UPSTREAM           = "http://ocr-api.services.${var.environment}.hid:3005"
      OUTREACH_API_UPSTREAM      = "http://outreach-api.services.${var.environment}.hid:3006"
      SUPPORT_API_UPSTREAM       = var.enable_support_bot ? "http://support-api.services.${var.environment}.hid:3011" : "http://127.0.0.1:9"
    }
    support-api = {
      SUPPORT_CONTACT  = var.support_contact
      NODE_ENV         = "production"
      PORT             = "3011"
      AWS_REGION       = var.aws_region
      LEX_BOT_ID       = var.support_bot_id
      LEX_BOT_ALIAS_ID = var.support_bot_alias_id
      LEX_LOCALE_ID    = "en_GB"
    }
  }
}

# ECS task and execution roles
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  for_each = local.runtime_workloads

  name               = "${var.name_prefix}-${each.key}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  for_each = local.runtime_workloads

  role       = aws_iam_role.execution[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  for_each = {
    for name, specs in local.workload_secret_specs : name => specs
    if length(specs) > 0
  }

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = distinct([for spec in each.value : spec.arn])
  }
  statement {
    actions = ["kms:Decrypt"]
    resources = concat([var.database_kms_key_arn, var.document_kms_key_arn],
      each.key == "ehr-api" && var.enable_ai && var.ai_generation_provider == "anthropic" && var.anthropic_secret_kms_key_arn != "" ?
      [var.anthropic_secret_kms_key_arn] : [],
    each.key == "identity-api" && var.qoreid_enabled && var.qoreid_secret_kms_key_arn != "" ? [var.qoreid_secret_kms_key_arn] : [])
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  for_each = data.aws_iam_policy_document.execution_secrets

  name   = "runtime-secrets"
  role   = aws_iam_role.execution[each.key].id
  policy = each.value.json
}

resource "aws_iam_role" "task" {
  for_each = local.runtime_workloads

  name               = "${var.name_prefix}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_cloudwatch_log_group" "workload" {
  for_each = local.runtime_workloads

  name              = "/hid/${var.environment}/${each.key}"
  retention_in_days = each.key == "identity-api" ? var.security_log_retention_days : var.application_log_retention_days
}

# One task definition is generated for each workload in the catalogue.
resource "aws_ecs_task_definition" "workload" {
  lifecycle {
    precondition {
      condition     = var.deployment_release_valid
      error_message = "Release inventory or lease changed; regenerate the infrastructure plan."
    }
  }
  for_each = local.runtime_workloads

  family = "${var.name_prefix}-${each.key}"
  # Preserve every staging revision so sizing and application changes can roll
  # back to their exact prior definitions. Existing retention elsewhere remains.
  skip_destroy             = var.environment == "staging" || contains(["identity-api", "ehr-api", "lab-api"], each.key)
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  dynamic "volume" {
    for_each = local.managed_identity_enabled && contains(keys(local.workload_token_files), each.key) ? [1] : []
    content {
      name                = "workload-tokens"
      configure_at_launch = false
    }
  }

  container_definitions = jsonencode(concat([
    merge({
      name                   = each.key
      image                  = var.image_uris[each.key]
      essential              = true
      readonlyRootFilesystem = each.key != "gateway"
      environment = [
        for key, value in local.workload_environment[each.key] : {
          name  = key
          value = value
        }
      ]
      secrets = [for spec in local.workload_secret_specs[each.key] : {
        name      = spec.name
        valueFrom = "${spec.arn}:${spec.key}::"
      }]
      portMappings = each.value.port == 0 ? [] : [{
        containerPort = each.value.port
        hostPort      = each.value.port
        protocol      = "tcp"
      }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.workload[each.key].name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = each.key
        }
      }
      }, each.value.port == 0 ? {} : {
      healthCheck = {
        command = each.key == "gateway" ? [
          "CMD", "wget", "-q", "-O", "/dev/null",
          "http://127.0.0.1:${each.value.port}/gateway-health/ready"
          ] : [
          "CMD", "/nodejs/bin/node", "-e",
          "fetch('http://127.0.0.1:${each.value.port}/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        ]
        interval    = 30
        timeout     = 10
        retries     = 3
        startPeriod = 20
      }
      }, {
      # Separate typed comprehensions prevent Terraform from converting the
      # mixed mountPoints/dependsOn object into lists of string-valued maps.
      mountPoints = [for enabled in(local.managed_identity_enabled && contains(keys(local.workload_token_files), each.key) ? [true] : []) : {
        containerPath = local.token_root
        sourceVolume  = "workload-tokens"
        readOnly      = true
      }]
      dependsOn = [for enabled in(local.managed_identity_enabled && contains(keys(local.workload_token_files), each.key) ? [true] : []) : {
        containerName = "workload-token-agent"
        condition     = "HEALTHY"
      }]
    })
    ], local.managed_identity_enabled && contains(keys(local.workload_token_files), each.key) ? [{
      name                   = "workload-token-agent"
      image                  = var.workload_token_agent_image_uri != "" ? var.workload_token_agent_image_uri : var.image_uris["identity-api"]
      command                = ["/app/services/workload-token-agent/src/main.mjs"]
      user                   = "65532:65532"
      readonlyRootFilesystem = true
      essential              = true
      memoryReservation      = 64
      environment = [for key, value in {
        HID_DEPLOYMENT_ENV        = local.workload_identity_environment
        AWS_REGION                = var.aws_region
        WORKLOAD_ISSUER_URL       = local.managed_issuer_url
        WORKLOAD_JWKS_URL         = local.managed_jwks_url
        WORKLOAD_SUBJECT          = "hid:${local.workload_identity_environment}:${each.key}"
        WORKLOAD_TOKEN_DIRECTORY  = local.token_root
        WORKLOAD_TOKEN_FILES_JSON = jsonencode(local.workload_token_requests[each.key])
        } : {
        name  = key
        value = value
      }]
      mountPoints = [{
        containerPath = local.token_root
        sourceVolume  = "workload-tokens"
        readOnly      = false
      }]
      healthCheck = {
        command     = ["CMD", "/nodejs/bin/node", "/app/services/workload-token-agent/src/health.mjs"]
        interval    = 10
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.workload[each.key].name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "workload-token-agent"
        }
      }
  }] : []))

  depends_on = [aws_iam_role_policy_attachment.execution]
}

# Long-running Fargate services
resource "aws_ecs_service" "workload" {
  lifecycle {
    precondition {
      condition     = var.deployment_release_valid
      error_message = "Release inventory or lease changed; refusing a stale service update."
    }
  }
  for_each = local.legacy_ecs_workloads

  name                               = "${var.name_prefix}-${each.key}"
  cluster                            = aws_ecs_cluster.main[0].id
  task_definition                    = aws_ecs_task_definition.workload[each.key].arn
  desired_count                      = contains(["drain", "active"], var.ecs_migration_phase) && contains(local.background_workers, each.key) ? 0 : var.desired_counts[each.key]
  launch_type                        = "FARGATE"
  enable_execute_command             = false
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"
  health_check_grace_period_seconds  = each.value.port == 0 ? null : 90
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = var.application_subnet_ids
    security_groups  = [aws_security_group.workload[each.key].id]
    assign_public_ip = false
  }

  dynamic "service_registries" {
    for_each = contains(keys(aws_service_discovery_service.workload), each.key) ? [1] : []
    content { registry_arn = aws_service_discovery_service.workload[each.key].arn }
  }

  dynamic "load_balancer" {
    for_each = var.enable_ingress && each.key == "gateway" ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.gateway[0].arn
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  dynamic "load_balancer" {
    for_each = var.enable_ingress && contains(keys(local.internal_workloads), each.key) ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.internal[each.key].arn
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.public_https, aws_lb_listener.internal_https]
}

# One-shot database migration task. It is launched by the release process and
# is deliberately not attached to a long-running ECS service.
resource "aws_cloudwatch_log_group" "migration" {
  count             = var.enable_runtime || var.enable_migration_task ? 1 : 0
  name              = "/hid/${var.environment}/database-migration"
  retention_in_days = var.application_log_retention_days
}

resource "aws_iam_role" "migration_execution" {
  count              = var.enable_runtime || var.enable_migration_task ? 1 : 0
  name_prefix        = "${var.name_prefix}-migration-exec-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "migration_execution" {
  count      = var.enable_runtime || var.enable_migration_task ? 1 : 0
  role       = aws_iam_role.migration_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "migration_secret" {
  count = var.enable_runtime || var.enable_migration_task ? 1 : 0
  name  = "migration-secret"
  role  = aws_iam_role.migration_execution[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.database_master_secret_arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = var.database_kms_key_arn
      }
    ]
  })
}

resource "aws_iam_role" "migration_task" {
  count              = var.enable_runtime || var.enable_migration_task ? 1 : 0
  name_prefix        = "${var.name_prefix}-migration-task-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# The one-shot staging task may read only exact-version migration fixtures
# stored under this prefix in the separate preserved-source bucket.
resource "aws_iam_role_policy" "migration_fixture" {
  count = (var.enable_runtime || var.enable_migration_task) && var.migration_source_bucket_arn != "" && var.migration_source_kms_key_arn != "" ? 1 : 0
  name  = "migration-source-fixture-read"
  role  = aws_iam_role.migration_task[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObjectVersion"]
        Resource = "${var.migration_source_bucket_arn}/migration-fixtures/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = var.migration_source_kms_key_arn
        Condition = {
          StringEquals = { "kms:ViaService" = "s3.${var.aws_region}.amazonaws.com" }
          StringLike   = { "kms:EncryptionContext:aws:s3:arn" = [var.migration_source_bucket_arn, "${var.migration_source_bucket_arn}/migration-fixtures/*"] }
        }
      }
    ]
  })
}

resource "aws_ecs_task_definition" "migration" {
  skip_destroy = true
  lifecycle {
    precondition {
      condition     = var.deployment_release_valid
      error_message = "Release inventory or lease changed; refusing a stale schema image."
    }
  }
  count                    = var.enable_runtime || var.enable_migration_task ? 1 : 0
  family                   = "${var.name_prefix}-database-migration"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.migration_execution[0].arn
  task_role_arn            = aws_iam_role.migration_task[0].arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name                   = "database-migration"
    image                  = var.migration_image_uri
    essential              = true
    command                = ["scripts/apply-migrations.mjs", "--plan"]
    readonlyRootFilesystem = true
    environment = [
      {
        name  = "NODE_ENV"
        value = "production"
      },
      {
        name  = "AWS_REGION"
        value = var.aws_region
      },
      {
        name  = "MIGRATION_TARGET"
        value = "rds"
      },
      {
        name  = "DATABASE_SSL"
        value = "true"
      },
      {
        name  = "DATABASE_SSL_ROOT_CERT_BASE64"
        value = var.rds_ca_bundle_base64
      },
      {
        name  = "DATABASE_HOST"
        value = var.database_endpoint
      },
      {
        name  = "DATABASE_NAME"
        value = "hid"
      }
    ]
    secrets = [
      {
        name      = "DATABASE_USERNAME"
        valueFrom = "${var.database_master_secret_arn}:username::"
      },
      {
        name      = "DATABASE_PASSWORD"
        valueFrom = "${var.database_master_secret_arn}:password::"
      }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.migration[0].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "migration"
      }
    }
  }])
}

resource "aws_security_group" "migration" {
  count       = var.enable_runtime || var.enable_migration_task ? 1 : 0
  name_prefix = "${var.name_prefix}-migration-"
  description = "One-shot migration: PostgreSQL and operational AWS endpoints only"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "migration_database" {
  count                        = (var.enable_runtime || var.enable_migration_task) && var.database_enabled ? 1 : 0
  security_group_id            = aws_security_group.migration[0].id
  referenced_security_group_id = var.database_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "database_from_migration" {
  count                        = (var.enable_runtime || var.enable_migration_task) && var.database_enabled ? 1 : 0
  security_group_id            = var.database_security_group_id
  referenced_security_group_id = aws_security_group.migration[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "migration_to_endpoint" {
  count                        = var.enable_runtime || var.enable_migration_task ? 1 : 0
  security_group_id            = aws_security_group.migration[0].id
  referenced_security_group_id = var.endpoint_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_ingress_rule" "endpoint_from_migration" {
  count                        = var.enable_runtime || var.enable_migration_task ? 1 : 0
  security_group_id            = var.endpoint_security_group_id
  referenced_security_group_id = aws_security_group.migration[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "migration_to_s3" {
  count             = var.enable_runtime || var.enable_migration_task ? 1 : 0
  security_group_id = aws_security_group.migration[0].id
  prefix_list_id    = var.s3_prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
