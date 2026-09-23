locals {
  token_root = "/var/run/hid/workload-tokens"
  workload_token_files = {
    identity-api = { NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE = "${local.token_root}/notification.jwt" }
    ehr-api = {
      IDENTITY_EHR_WORKLOAD_TOKEN_FILE = "${local.token_root}/identity.jwt"
      LAB_EHR_WORKLOAD_TOKEN_FILE      = "${local.token_root}/lab.jwt"
      PHARMACY_EHR_WORKLOAD_TOKEN_FILE = "${local.token_root}/pharmacy.jwt"
    }
    lab-api      = { IDENTITY_LAB_WORKLOAD_TOKEN_FILE = "${local.token_root}/identity.jwt" }
    pharmacy-api = { IDENTITY_PHARMACY_WORKLOAD_TOKEN_FILE = "${local.token_root}/identity.jwt" }
    ocr-api = {
      IDENTITY_OCR_WORKLOAD_TOKEN_FILE = "${local.token_root}/identity.jwt"
      EHR_OCR_WORKLOAD_TOKEN_FILE      = "${local.token_root}/ehr.jwt"
      LAB_OCR_WORKLOAD_TOKEN_FILE      = "${local.token_root}/lab.jwt"
      PHARMACY_OCR_WORKLOAD_TOKEN_FILE = "${local.token_root}/pharmacy.jwt"
    }
    outreach-api = { OUTREACH_IDENTITY_WORKLOAD_TOKEN_FILE = "${local.token_root}/identity.jwt" }
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
    identity-api        = "https://identity.${local.private_zone_name}"
    ehr-api             = "https://ehr.${local.private_zone_name}"
    lab-api             = "https://lab.${local.private_zone_name}"
    pharmacy-api        = "https://pharmacy.${local.private_zone_name}"
    ocr-api             = "https://ocr.${local.private_zone_name}"
    outreach-api        = "https://outreach.${local.private_zone_name}"
    notification-api    = "https://notification.${local.private_zone_name}"
    notification-worker = "https://notification-worker.${local.private_zone_name}"
    event-dispatcher    = "https://dispatcher.${local.private_zone_name}"
  }
  identity_subjects = var.environment == "staging" ? {
    identity = "hid:staging:identity-api", ehr = "hid:staging:ehr-api", lab = "hid:staging:lab-api"
    pharmacy = "hid:staging:pharmacy-api", ocr = "hid:staging:ocr-api", outreach = "hid:staging:outreach-api"
  } : var.workload_subjects
  common_api_environment = {
    NODE_ENV                      = "production"
    HID_DEPLOYMENT_ENV            = var.environment == "staging" ? "staging" : "production"
    DATABASE_SSL                  = "true"
    DATABASE_SSL_ROOT_CERT_BASE64 = var.rds_ca_bundle_base64
    CORS_ORIGINS                  = join(",", [for subdomain in var.browser_subdomains : "https://${subdomain}.${var.root_domain_name}"])
    TRUST_PROXY_CIDRS             = var.vpc_cidr
  }

  database_secret_environment = {
    identity-api        = "DATABASE_URL", ehr-api = "DATABASE_URL", lab-api = "LAB_DATABASE_URL"
    pharmacy-api        = "PHARMACY_DATABASE_URL", ocr-api = "OCR_DATABASE_URL"
    ocr-worker          = "OCR_WORKER_DATABASE_URL", outreach-api = "OUTREACH_DATABASE_URL"
    notification-worker = "NOTIFICATION_WORKER_DATABASE_URL", event-dispatcher = "EVENT_DISPATCHER_DATABASE_URL"
  }

  fixed_secret_specs = {
    identity-api = concat([
      { name = "AUTH_SIGNING_SECRET", arn = var.runtime_secret_arns["auth"], key = "authSigningSecret" },
      { name = "AUTH_LOGIN_PEPPER", arn = var.runtime_secret_arns["auth"], key = "authLoginPepper" },
      { name = "OTP_HMAC_KEY_B64", arn = var.runtime_secret_arns["identity-sensitive"], key = "otpHmacKeyB64" },
      { name = "TURNSTILE_SECRET_KEY", arn = var.runtime_secret_arns["identity-sensitive"], key = "turnstileSecretKey" }
      ], var.environment == "staging" ? [] : [
      { name = "NIN_LOOKUP_HMAC_KEY_B64", arn = var.runtime_secret_arns["identity-sensitive"], key = "ninLookupHmacKeyB64" },
      { name = "NIN_ENCRYPTION_KEY_B64", arn = var.runtime_secret_arns["identity-sensitive"], key = "ninEncryptionKeyB64" }
    ])
    notification-api = var.environment == "staging" ? [
      { name = "SES_FROM_ADDRESS", arn = var.runtime_secret_arns["notification-provider"], key = "sesFromAddress" }
      ] : [for pair in [
        ["SES_FROM_ADDRESS", "sesFromAddress"], ["TERMII_BASE_URL", "termiiBaseUrl"], ["TERMII_API_KEY", "termiiApiKey"],
        ["TERMII_SENDER_ID", "termiiSenderId"], ["META_PHONE_NUMBER_ID", "metaPhoneNumberId"], ["META_ACCESS_TOKEN", "metaAccessToken"],
        ["META_OTP_TEMPLATE_NAME", "metaOtpTemplateName"], ["INFOBIP_BASE_URL", "infobipBaseUrl"], ["INFOBIP_API_KEY", "infobipApiKey"],
        ["INFOBIP_EMAIL_FROM", "infobipEmailFrom"], ["INFOBIP_WHATSAPP_OTP_TEMPLATE_ID", "infobipWhatsAppOtpTemplateId"]
    ] : { name = pair[0], arn = var.runtime_secret_arns["notification-provider"], key = pair[1] }]
    notification-worker = [
      { name = "NOVU_API_KEY", arn = var.runtime_secret_arns["notification-provider"], key = "novuApiKey" }
    ]
  }

  database_secret_specs = {
    for name, environment_name in local.database_secret_environment : name => concat(
      [{ name = environment_name, arn = var.database_secret_arns[name], key = "url" }],
      name == "ehr-api" ? [{ name = "WORKLOAD_DATABASE_URL", arn = var.database_secret_arns[name], key = "scannerUrl" }] : []
    )
  }

  workload_secret_specs = {
    for name, workload in local.runtime_workloads : name => concat(
      lookup(local.database_secret_specs, name, []),
      lookup(local.fixed_secret_specs, name, [])
    )
  }

  workload_environment = {
    identity-api = merge(local.common_api_environment, local.workload_token_files.identity-api, {
      PORT                             = "3001", DATABASE_POOL_MAX = "6", AUTH_MODE = "local", AUTH_COOKIE_SECURE = "true"
      AUTH_ISSUER                      = "hid-identity", AUTH_AUDIENCE = "hid-api", TURNSTILE_MODE = "required", OTP_HMAC_KEY_VERSION = "aws-v1"
      NIN_PROVIDER_MODE                = var.environment == "staging" ? "deferred" : "unavailable", NIN_KEY_VERSION = "aws-v1"
      NOTIFICATION_API_URL             = local.service_urls.notification-api, NOTIFICATION_SERVICE_IDENTITY_MODE = "jwt"
      IDENTITY_SERVICE_IDENTITY_MODE   = "jwt", WORKLOAD_ISSUER_URL = local.staging_issuer_url
      WORKLOAD_JWKS_URL                = local.staging_jwks_url, WORKLOAD_AUDIENCE = "hid-identity-api"
      IDENTITY_EHR_CALLER_SUBJECT      = lookup(local.identity_subjects, "ehr", ""), IDENTITY_LAB_CALLER_SUBJECT = lookup(local.identity_subjects, "lab", "")
      IDENTITY_PHARMACY_CALLER_SUBJECT = lookup(local.identity_subjects, "pharmacy", ""), IDENTITY_OCR_CALLER_SUBJECT = lookup(local.identity_subjects, "ocr", "")
      OUTREACH_CALLER_SUBJECT          = lookup(local.identity_subjects, "outreach", ""), ADMIN_IDENTITY_STATUS_URL = local.service_urls.identity-api
      ADMIN_EHR_STATUS_URL             = local.service_urls.ehr-api, ADMIN_LAB_STATUS_URL = local.service_urls.lab-api
      ADMIN_PHARMACY_STATUS_URL        = local.service_urls.pharmacy-api, ADMIN_OCR_STATUS_URL = local.service_urls.ocr-api
      ADMIN_OUTREACH_STATUS_URL        = local.service_urls.outreach-api, ADMIN_EVENT_DISPATCHER_STATUS_URL = local.service_urls.event-dispatcher
    })
    ehr-api = merge(local.common_api_environment, local.workload_token_files.ehr-api, {
      PORT                                    = "3002", DATABASE_POOL_MAX = "8", WORKLOAD_DATABASE_POOL_MAX = "3"
      IDENTITY_API_URL                        = local.service_urls.identity-api, LAB_API_URL = local.service_urls.lab-api
      PHARMACY_API_URL                        = local.service_urls.pharmacy-api, IDENTITY_SERVICE_IDENTITY_MODE = "jwt"
      LAB_SERVICE_IDENTITY_MODE               = "jwt", PHARMACY_SERVICE_IDENTITY_MODE = "jwt", EHR_SERVICE_IDENTITY_MODE = "jwt"
      EHR_WORKLOAD_ISSUER_URL                 = local.staging_issuer_url, EHR_WORKLOAD_JWKS_URL = local.staging_jwks_url
      EHR_WORKLOAD_AUDIENCE                   = "hid-ehr-api", EHR_OCR_CALLER_SUBJECT = lookup(local.identity_subjects, "ocr", "")
      OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE = "jwt", OUTREACH_CALLER_SUBJECT = lookup(local.identity_subjects, "outreach", "")
      STORAGE_MODE                            = "s3", S3_REGION = var.aws_region, S3_BUCKET = trimprefix(var.document_bucket_arn, "arn:aws:s3:::")
      S3_FORCE_PATH_STYLE                     = "false", S3_KMS_KEY_ID = var.document_kms_key_arn
    })
    lab-api = merge(local.common_api_environment, local.workload_token_files.lab-api, {
      PORT                           = "3003", DATABASE_POOL_MAX = "5", IDENTITY_API_URL = local.service_urls.identity-api
      IDENTITY_SERVICE_IDENTITY_MODE = "jwt", LAB_SERVICE_IDENTITY_MODE = "jwt"
      LAB_WORKLOAD_ISSUER_URL        = local.staging_issuer_url, LAB_WORKLOAD_JWKS_URL = local.staging_jwks_url
      LAB_WORKLOAD_AUDIENCE          = "hid-lab-api", LAB_EHR_CALLER_SUBJECT = lookup(local.identity_subjects, "ehr", "")
      LAB_OCR_CALLER_SUBJECT         = lookup(local.identity_subjects, "ocr", "")
    })
    pharmacy-api = merge(local.common_api_environment, local.workload_token_files.pharmacy-api, {
      PORT                           = "3004", DATABASE_POOL_MAX = "5", IDENTITY_API_URL = local.service_urls.identity-api
      IDENTITY_SERVICE_IDENTITY_MODE = "jwt", PHARMACY_SERVICE_IDENTITY_MODE = "jwt"
      PHARMACY_WORKLOAD_ISSUER_URL   = local.staging_issuer_url, PHARMACY_WORKLOAD_JWKS_URL = local.staging_jwks_url
      PHARMACY_WORKLOAD_AUDIENCE     = "hid-pharmacy-api", PHARMACY_EHR_CALLER_SUBJECT = lookup(local.identity_subjects, "ehr", "")
      PHARMACY_OCR_CALLER_SUBJECT    = lookup(local.identity_subjects, "ocr", "")
    })
    ocr-api = merge(local.common_api_environment, local.workload_token_files.ocr-api, {
      PORT                      = "3005", DATABASE_POOL_MAX = "5", IDENTITY_API_URL = local.service_urls.identity-api
      EHR_API_URL               = local.service_urls.ehr-api, LAB_API_URL = local.service_urls.lab-api
      PHARMACY_API_URL          = local.service_urls.pharmacy-api, IDENTITY_SERVICE_IDENTITY_MODE = "jwt"
      EHR_SERVICE_IDENTITY_MODE = "jwt", LAB_SERVICE_IDENTITY_MODE = "jwt", PHARMACY_SERVICE_IDENTITY_MODE = "jwt"
    })
    outreach-api = merge(local.common_api_environment, local.workload_token_files.outreach-api, {
      PORT                                    = "3006", DATABASE_POOL_MAX = "5", IDENTITY_API_URL = local.service_urls.identity-api
      OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE = "jwt"
    })
    notification-api = merge({
      NODE_ENV                            = "production", PORT = "3007", NOTIFICATION_PROVIDER_MODE = "live"
      NOTIFICATION_WORKLOAD_IDENTITY_MODE = "jwt", WORKLOAD_ISSUER_URL = local.staging_issuer_url
      WORKLOAD_JWKS_URL                   = local.staging_jwks_url, WORKLOAD_AUDIENCE = "hid-notification-api"
      IDENTITY_CALLER_SUBJECT             = lookup(local.identity_subjects, "identity", ""), AWS_REGION = var.aws_region
    }, var.environment == "staging" ? { HID_DEPLOYMENT_ENV = "staging", NOTIFICATION_DELIVERY_PROFILE = "email-only" } : {})
    notification-worker = merge({
      NODE_ENV                              = "production", NOTIFICATION_WORKER_ENABLED = "true", NOTIFICATION_WORKER_ID = "notification-worker-${var.environment}"
      NOTIFICATION_WORKER_STATUS_HOST       = "0.0.0.0", NOTIFICATION_WORKER_STATUS_PORT = "3008"
      NOTIFICATION_WORKER_DATABASE_SSL      = "true", NOTIFICATION_WORKER_DATABASE_SSL_ROOT_CERT_BASE64 = var.rds_ca_bundle_base64
      NOTIFICATION_WORKER_DATABASE_POOL_MAX = "4", NOTIFICATION_WORKER_QUEUE_URL = var.notification_queue_url
      NOVU_MODE                             = "live", AWS_REGION = var.aws_region
    }, var.environment == "staging" ? { NOVU_API_URL = var.staging_novu_api_url } : {})
    ocr-worker = {
      NODE_ENV                = "production", OCR_PROVIDER = "textract", OCR_WORKER_SUBJECT = lookup(local.identity_subjects, "ocr", "")
      OCR_WORKER_DATABASE_SSL = "true", OCR_WORKER_DATABASE_SSL_ROOT_CERT_BASE64 = var.rds_ca_bundle_base64
      OCR_WORKER_POOL_MAX     = "4", OCR_WORKER_CONCURRENCY = "2", AWS_REGION = var.aws_region, S3_FORCE_PATH_STYLE = "false"
    }
    event-dispatcher = {
      NODE_ENV                      = "production", EVENT_DISPATCHER_ENABLED = "true", EVENT_DISPATCHER_TRANSPORT = "eventbridge"
      EVENT_DISPATCHER_DATABASE_SSL = "true", EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64 = var.rds_ca_bundle_base64
      EVENT_DISPATCHER_POOL_MAX     = "4", EVENT_DISPATCHER_STATUS_HOST = "0.0.0.0", EVENT_DISPATCHER_STATUS_PORT = "3010"
      EVENTBRIDGE_EVENT_BUS_NAME    = element(reverse(split(":", var.event_bus_arn)), 0), AWS_REGION = var.aws_region
    }
    gateway = {
      IDENTITY_API_UPSTREAM = "http://identity-api.services.${var.environment}.hid:3001"
      EHR_API_UPSTREAM      = "http://ehr-api.services.${var.environment}.hid:3002"
      LAB_API_UPSTREAM      = "http://lab-api.services.${var.environment}.hid:3003"
      PHARMACY_API_UPSTREAM = "http://pharmacy-api.services.${var.environment}.hid:3004"
      OCR_API_UPSTREAM      = "http://ocr-api.services.${var.environment}.hid:3005"
      OUTREACH_API_UPSTREAM = "http://outreach-api.services.${var.environment}.hid:3006"
    }
  }
}

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

  name_prefix        = "${var.name_prefix}-${each.key}-exec-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  for_each = local.runtime_workloads

  role       = aws_iam_role.execution[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  for_each = { for name, specs in local.workload_secret_specs : name => specs if length(specs) > 0 }

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = distinct([for spec in each.value : spec.arn])
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [var.database_kms_key_arn, var.document_kms_key_arn]
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

  name_prefix        = "${var.name_prefix}-${each.key}-task-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_cloudwatch_log_group" "workload" {
  for_each = local.runtime_workloads

  name              = "/hid/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "workload" {
  for_each = local.runtime_workloads

  family                   = "${var.name_prefix}-${each.key}"
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
    for_each = local.staging_identity_enabled && contains(keys(local.workload_token_files), each.key) ? [1] : []
    content {
      name = "workload-tokens"
    }
  }

  container_definitions = jsonencode(concat([
    merge({
      name                   = each.key
      image                  = var.image_uris[each.key]
      essential              = true
      readonlyRootFilesystem = each.key != "gateway"
      environment            = [for key, value in local.workload_environment[each.key] : { name = key, value = value }]
      secrets = [for spec in local.workload_secret_specs[each.key] : {
        name = spec.name, valueFrom = "${spec.arn}:${spec.key}::"
      }]
      portMappings = each.value.port == 0 ? [] : [{ containerPort = each.value.port, hostPort = each.value.port, protocol = "tcp" }]
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
        command  = ["CMD-SHELL", each.key == "gateway" ? "wget -q -O /dev/null http://127.0.0.1:${each.value.port}/gateway-health/ready || exit 1" : "node -e \"fetch('http://127.0.0.1:${each.value.port}/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval = 30, timeout = 10, retries = 3, startPeriod = 20
      }
      }, local.staging_identity_enabled && contains(keys(local.workload_token_files), each.key) ? {
      mountPoints = [{ containerPath = local.token_root, sourceVolume = "workload-tokens", readOnly = true }]
      dependsOn   = [{ containerName = "workload-token-agent", condition = "HEALTHY" }]
    } : {})
    ], local.staging_identity_enabled && contains(keys(local.workload_token_files), each.key) ? [{
      name                   = "workload-token-agent"
      image                  = var.image_uris["identity-api"]
      command                = ["/app/services/workload-token-agent/src/main.mjs"]
      user                   = "65532:65532"
      readonlyRootFilesystem = true
      essential              = true
      memoryReservation      = 64
      environment = [for key, value in {
        HID_DEPLOYMENT_ENV        = "staging"
        AWS_REGION                = var.aws_region
        WORKLOAD_ISSUER_URL       = local.staging_issuer_url
        WORKLOAD_JWKS_URL         = local.staging_jwks_url
        WORKLOAD_SUBJECT          = "hid:staging:${each.key}"
        WORKLOAD_TOKEN_DIRECTORY  = local.token_root
        WORKLOAD_TOKEN_FILES_JSON = jsonencode(local.workload_token_requests[each.key])
      } : { name = key, value = value }]
      mountPoints = [{ containerPath = local.token_root, sourceVolume = "workload-tokens", readOnly = false }]
      healthCheck = {
        command  = ["CMD", "/nodejs/bin/node", "/app/services/workload-token-agent/src/health.mjs"]
        interval = 10, timeout = 5, retries = 3, startPeriod = 30
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

resource "aws_ecs_service" "workload" {
  for_each = local.runtime_workloads

  name                               = "${var.name_prefix}-${each.key}"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.workload[each.key].arn
  desired_count                      = var.desired_counts[each.key]
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

resource "aws_cloudwatch_log_group" "migration" {
  count             = var.enable_runtime ? 1 : 0
  name              = "/hid/${var.environment}/database-migration"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "migration_execution" {
  count              = var.enable_runtime ? 1 : 0
  name_prefix        = "${var.name_prefix}-migration-exec-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "migration_execution" {
  count      = var.enable_runtime ? 1 : 0
  role       = aws_iam_role.migration_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "migration_secret" {
  count = var.enable_runtime ? 1 : 0
  name  = "migration-secret"
  role  = aws_iam_role.migration_execution[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.migration_database_secret_arn },
    { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.database_kms_key_arn }
  ] })
}

resource "aws_iam_role" "migration_task" {
  count              = var.enable_runtime ? 1 : 0
  name_prefix        = "${var.name_prefix}-migration-task-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_ecs_task_definition" "migration" {
  count                    = var.enable_runtime ? 1 : 0
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
    name    = "database-migration", image = var.migration_image_uri, essential = true
    command = ["--plan"], readonlyRootFilesystem = true
    environment = [
      { name = "NODE_ENV", value = "production" }, { name = "DATABASE_SSL", value = "true" },
      { name = "DATABASE_SSL_ROOT_CERT_BASE64", value = var.rds_ca_bundle_base64 }
    ]
    secrets = [{ name = "DATABASE_URL", valueFrom = "${var.migration_database_secret_arn}:url::" }]
    logConfiguration = { logDriver = "awslogs", options = {
      awslogs-group = aws_cloudwatch_log_group.migration[0].name, awslogs-region = var.aws_region, awslogs-stream-prefix = "migration"
    } }
  }])
}

resource "aws_security_group" "migration" {
  count       = var.enable_runtime ? 1 : 0
  name_prefix = "${var.name_prefix}-migration-"
  description = "One-shot migration: PostgreSQL and operational AWS endpoints only"
  vpc_id      = var.vpc_id
  egress      = []
}

resource "aws_vpc_security_group_egress_rule" "migration_database" {
  count                        = var.enable_runtime && var.database_enabled ? 1 : 0
  security_group_id            = aws_security_group.migration[0].id
  referenced_security_group_id = var.database_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "database_from_migration" {
  count                        = var.enable_runtime && var.database_enabled ? 1 : 0
  security_group_id            = var.database_security_group_id
  referenced_security_group_id = aws_security_group.migration[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
