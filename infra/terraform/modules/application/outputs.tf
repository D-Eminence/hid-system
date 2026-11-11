output "autoscaling_policies" {
  description = "Scaling policies of each scaled service; every one reads a metric AWS publishes."
  value = { for name, target in aws_appautoscaling_target.workload : name => concat(
    [for policy in [aws_appautoscaling_policy.cpu[name], aws_appautoscaling_policy.memory[name]] : policy.name],
    contains(keys(aws_appautoscaling_policy.request), name) ? [aws_appautoscaling_policy.request[name].name] : [],
    contains(keys(aws_appautoscaling_policy.notification_backlog), name) ? [aws_appautoscaling_policy.notification_backlog[name].name] : [],
  ) }
}

output "ecr_lifecycle_policies" {
  description = "Lifecycle rules of each workload repository."
  value       = { for name, policy in aws_ecr_lifecycle_policy.workload : name => jsondecode(policy.policy) }
}

output "ecr_repository_urls" {
  value = {
    for name, repository in aws_ecr_repository.workload :
    name => repository.repository_url
  }
}
output "ai_generation_configuration" {
  description = "Generation transport and EHR and OCR worker secret binding names only; no credential values."
  value = {
    provider            = var.ai_generation_provider
    model_id            = local.workload_environment["ehr-api"].AI_GENERATION_MODEL_ID
    ehr_secret_fields   = [for spec in local.fixed_secret_specs["ehr-api"] : spec.name]
    ocr_secret_fields   = [for spec in local.fixed_secret_specs["ocr-worker"] : spec.name]
    other_secret_fields = flatten([for name, specs in local.fixed_secret_specs : [for spec in specs : spec.name] if !contains(local.anthropic_key_workloads, name)])
  }
}

output "anthropic_runtime_access" {
  description = "Which workloads can reach and unlock the Claude key at runtime; names and key ARNs only, no credential values."
  value = {
    https_egress_workloads  = sort(keys(aws_vpc_security_group_egress_rule.ocr_worker_anthropic_https))
    general_https_workloads = sort(keys(aws_vpc_security_group_egress_rule.provider_https))
    execution_kms_keys = {
      for name, document in data.aws_iam_policy_document.execution_secrets : name => sort(flatten([
        for statement in document.statement : statement.resources if contains(statement.actions, "kms:Decrypt")
      ])) if contains(["ehr-api", "ocr-worker"], name)
    }
    ocr_worker_ai_environment = {
      for key, value in local.workload_environment["ocr-worker"] : key => value
      if contains(["OCR_AI_MODE", "OCR_AI_US_PROCESSING_APPROVED", "OCR_TEXTRACT_FEATURES"], key)
    }
  }
}

output "ocr_worker_subject" {
  description = "The workload subject ocr-worker sets as its database actor; for tests."
  value       = lookup(lookup(local.workload_environment, "ocr-worker", {}), "OCR_WORKER_SUBJECT", "")
}

output "notification_delivery_configuration" {
  description = "Selected delivery profile and secret binding names only; no credential values."
  value = var.enable_runtime ? {
    profile = local.notification_profile
    # This is the same specification used to generate the container secrets.
    # Names remain plan-readable even when secret ARNs are not known yet.
    secret_fields = [for spec in local.workload_secret_specs["notification-api"] : spec.name]
  } : null
}

output "emergency_contact_configuration" {
  description = "Emergency-contact switch state read from the container environments; never the pilot account IDs."
  value = {
    notification_enabled = try(local.workload_environment["notification-api"].EMERGENCY_CONTACT_DELIVERY_ENABLED == "true", false)
    delivery_enabled     = try(local.workload_environment["identity-api"].EMERGENCY_CONTACT_DELIVERY_ENABLED == "true", false)
    dispatch_seconds     = try(tonumber(local.workload_environment["identity-api"].PATIENT_LIFECYCLE_SWEEP_SECONDS), null)
    channels             = try(split(",", local.workload_environment["identity-api"].EMERGENCY_CONTACT_CHANNELS), [])
    # Zero means every patient.
    pilot_account_count = try(length(split(",", local.workload_environment["identity-api"].EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS)), 0)
  }
}

output "emergency_contact_environment" {
  description = "Emergency-contact keys in each workload's container environment, for tests; not exported by the root module."
  value = {
    for name, environment in local.workload_environment : name => {
      for key, value in environment : key => value
      if startswith(key, "EMERGENCY_CONTACT_") || key == "PATIENT_LIFECYCLE_SWEEP_SECONDS"
    }
  }
}

output "web_push_bindings" {
  description = "WEB_PUSH_ environment and secret names in each workload's container definition, for tests; names only, not exported by the root module."
  value = {
    for name, environment in local.workload_environment : name => {
      environment = sort([for key, value in environment : key if startswith(key, "WEB_PUSH_")])
      secrets     = sort([for spec in lookup(local.workload_secret_specs, name, []) : spec.name if startswith(spec.name, "WEB_PUSH_")])
    }
  }
}

output "operational_target_dimensions" {
  value = var.enable_ingress ? merge({
    for name, group in local.active_internal_groups : name => {
      load_balancer = aws_lb.internal[0].arn_suffix
      target_group  = group.arn_suffix
    }
    }, { gateway = {
      load_balancer = aws_lb.public[0].arn_suffix
      target_group  = local.active_gateway_group.arn_suffix
  } }) : {}
}

output "ocr_worker_log_group" {
  description = "The OCR worker's log group (the 7-day deletion sweeper logs ocr.source_deletion.overdue there); empty without the runtime."
  value       = var.enable_runtime && contains(keys(local.runtime_workloads), "ocr-worker") ? aws_cloudwatch_log_group.workload["ocr-worker"].name : ""
}

output "provider_log_groups" {
  value = var.enable_runtime ? {
    for name in ["notification-api", "notification-worker"] : name => aws_cloudwatch_log_group.workload[name].name
  } : {}
}

output "ocr_worker_log_group" {
  value = try(aws_cloudwatch_log_group.workload["ocr-worker"].name, null)
}

output "api_load_balancer_dns_name" {
  value = try(aws_lb.public[0].dns_name, null)
}

output "workload_issuer_url" {
  value = var.enable_runtime ? local.managed_issuer_url : null
}

output "migration_task_definition_arn" {
  value = try(aws_ecs_task_definition.migration[0].arn, null)
}

output "migration_promotion_task_definition_arn" {
  value = try(aws_ecs_task_definition.migration_promotion[0].arn, null)
}

output "migration_security_group_id" {
  value = try(aws_security_group.migration[0].id, null)
}

output "ehr_task_role_arn" {
  value = try(aws_iam_role.task["ehr-api"].arn, null)
}

output "ehr_task_role_name" {
  value = try(aws_iam_role.task["ehr-api"].name, null)
}

output "ehr_security_group_id" {
  value = try(aws_security_group.workload["ehr-api"].id, null)
}
output "migration_customer_input_access" {
  description = "Rendered version-read policy for migration review; contains no input values or secrets."
  value       = try(jsondecode(aws_iam_role_policy.migration_customer_inputs[0].policy), null)
}

output "runtime_environment_configuration" {
  description = "Public/non-secret runtime identity, origin and provider endpoint settings for release review."
  value = {
    resource_environment = var.environment
    runtime_environment  = local.runtime_environment
    browser_origins      = local.browser_origins
    identity_origins     = local.workload_environment["identity-api"].CORS_ORIGINS
    nin_provider_mode    = local.workload_environment["identity-api"].NIN_PROVIDER_MODE
    novu_api_url         = try(local.workload_environment["notification-worker"].NOVU_API_URL, null)
    subjects             = local.identity_subjects
    issuer_path          = local.workload_identity_environment

    repositories = { for name, repository in aws_ecr_repository.workload : name => repository.name }
  }
}

output "error_reporting_settings_match" {
  description = "Per workload: true when its container gets exactly the configured DSN and the release environment name (no values exposed)."
  value = {
    for name, environment in local.container_environment : name => (
      lookup(environment, "SENTRY_DSN", "") == lookup(var.sentry_dsns, name, "") &&
      lookup(environment, "SENTRY_ENVIRONMENT", "") == (lookup(var.sentry_dsns, name, "") == "" ? "" : var.deployment_release_environment)
    )
  }
}

output "error_reporting_environment_names" {
  description = "Sentry environment variable names per workload container; names only, never the DSN."
  value = {
    for name, environment in local.container_environment : name => sort([for key in keys(environment) : key if startswith(key, "SENTRY_")])
  }
}

output "production_task_error_reporting_names" {
  description = "Sentry environment variable names in each production task definition's service container; names only, never the DSN."
  value = {
    for name, environment in local.production_task_environment : name => sort([for key in keys(environment) : key if startswith(key, "SENTRY_")])
  }
}

output "workload_caller_policy" {
  description = "Issuer caller rules as subject => audiences, for tests; no role ARNs, not exported by the root module. The issuer refuses more than eight rules at load."
  value       = { for name, caller in local.managed_callers : caller.subject => caller.audiences }
}

output "document_scanning" {
  description = "Names an operator needs for the document scanning runbook; no secrets."
  value = local.document_scanner_enabled ? {
    function_name     = aws_lambda_function.document_scan_bridge[0].function_name
    mode              = var.document_scan_bridge_mode
    reconcile_rule    = aws_cloudwatch_event_rule.document_scan_reconcile[0].name
    reconcile_enabled = var.document_scan_reconcile_enabled
    results_queue     = aws_sqs_queue.document_scan_results[0].name
    dead_letter_queue = aws_sqs_queue.document_scan_results_dlq[0].name
    log_group         = aws_cloudwatch_log_group.document_scan_bridge[0].name
    subject           = local.document_scan_subject
  } : null
}

output "document_scan_review" {
  description = "Rendered bridge settings for tests; names and policies only, not exported by the root module."
  value = local.document_scanner_enabled ? {
    function = {
      runtime              = aws_lambda_function.document_scan_bridge[0].runtime
      architectures        = aws_lambda_function.document_scan_bridge[0].architectures
      memory_size          = aws_lambda_function.document_scan_bridge[0].memory_size
      timeout              = aws_lambda_function.document_scan_bridge[0].timeout
      reserved_concurrency = aws_lambda_function.document_scan_bridge[0].reserved_concurrent_executions
      in_vpc               = length(aws_lambda_function.document_scan_bridge[0].vpc_config) == 1
      environment          = aws_lambda_function.document_scan_bridge[0].environment[0].variables
      log_group            = aws_lambda_function.document_scan_bridge[0].logging_config[0].log_group
    }
    role_policy           = jsondecode(aws_iam_role_policy.document_scan_bridge[0].policy)
    role_managed_policies = [aws_iam_role_policy_attachment.document_scan_bridge_vpc[0].policy_arn]
    event_source = {
      batch_size          = aws_lambda_event_source_mapping.document_scan_results[0].batch_size
      response_types      = aws_lambda_event_source_mapping.document_scan_results[0].function_response_types
      maximum_concurrency = aws_lambda_event_source_mapping.document_scan_results[0].scaling_config[0].maximum_concurrency
    }
    queue = {
      visibility = aws_sqs_queue.document_scan_results[0].visibility_timeout_seconds
      retention  = aws_sqs_queue.document_scan_results[0].message_retention_seconds
      encrypted  = aws_sqs_queue.document_scan_results[0].sqs_managed_sse_enabled
      redrive    = jsondecode(aws_sqs_queue.document_scan_results[0].redrive_policy).maxReceiveCount
      policy     = jsondecode(aws_sqs_queue_policy.document_scan_results[0].policy)
    }
    results_pattern = jsondecode(aws_cloudwatch_event_rule.document_scan_results[0].event_pattern)
    status_pattern  = jsondecode(aws_cloudwatch_event_rule.malware_plan_status[0].event_pattern)
    reconcile_state = aws_cloudwatch_event_rule.document_scan_reconcile[0].state
    reconcile_rate  = aws_cloudwatch_event_rule.document_scan_reconcile[0].schedule_expression
    reconcile_input = jsondecode(aws_cloudwatch_event_target.document_scan_reconcile[0].input)
    alarm_names     = sort(concat([aws_cloudwatch_metric_alarm.document_scan_dlq[0].alarm_name, aws_cloudwatch_metric_alarm.document_scan_errors[0].alarm_name], [for alarm in aws_cloudwatch_metric_alarm.document_scan_metric : alarm.alarm_name]))
    alarm_actions   = distinct(flatten(concat([aws_cloudwatch_metric_alarm.document_scan_dlq[0].alarm_actions], [for alarm in aws_cloudwatch_metric_alarm.document_scan_metric : alarm.alarm_actions])))
    security_group_egress = [for rule in [
      aws_vpc_security_group_egress_rule.document_scan_bridge_to_internal_lb[0],
      aws_vpc_security_group_egress_rule.document_scan_bridge_to_endpoint[0],
      aws_vpc_security_group_egress_rule.document_scan_bridge_https[0],
    ] : "${rule.ip_protocol}/${rule.from_port}-${rule.to_port}"]
    metric_alarms = { for key, alarm in aws_cloudwatch_metric_alarm.document_scan_metric : key => {
      metric = alarm.metric_name, statistic = alarm.statistic, threshold = alarm.threshold, period = alarm.period
    } }
  } : null
}

output "support_identity_check" {
  description = "support-api's Health ID check wiring for tests: environment names and non-secret values, the support-api task containers, the token request policy and port rules; no role ARNs, not exported by the root module."
  value = {
    identity_caller_subjects = { for key, value in local.workload_environment["identity-api"] : key => value if endswith(key, "_CALLER_SUBJECT") }
    support_environment      = local.workload_environment["support-api"]
    token_requests           = lookup(local.workload_token_requests, "support-api", [])
    task_containers = {
      for family, definitions in { legacy = aws_ecs_task_definition.workload, production = aws_ecs_task_definition.production } : family => {
        for container in jsondecode(definitions["support-api"].container_definitions) : container.name => {
          environment = { for pair in try(container.environment, []) : pair.name => pair.value }
          mounts      = [for mount in try(container.mountPoints, []) : "${mount.sourceVolume}:${mount.containerPath}:${mount.readOnly ? "ro" : "rw"}"]
          depends_on  = [for dependency in try(container.dependsOn, []) : "${dependency.containerName}:${dependency.condition}"]
          secrets     = [for secret in try(container.secrets, []) : secret.name]
        }
      } if contains(keys(definitions), "support-api")
    }
    task_volumes = {
      for family, definitions in { legacy = aws_ecs_task_definition.workload, production = aws_ecs_task_definition.production } :
      family => [for volume in definitions["support-api"].volume : volume.name] if contains(keys(definitions), "support-api")
    }
    token_invoke_resources = try(flatten([for statement in jsondecode(aws_iam_role_policy.workload_token_invoke["support-api"].policy).Statement : statement.Resource]), [])
    network = {
      to_internal_lb        = try("${aws_vpc_security_group_egress_rule.workload_to_internal_lb["support-api"].ip_protocol}/${aws_vpc_security_group_egress_rule.workload_to_internal_lb["support-api"].from_port}", null)
      internal_lb_admits    = try("${aws_vpc_security_group_ingress_rule.internal_lb_from_workload["support-api"].ip_protocol}/${aws_vpc_security_group_ingress_rule.internal_lb_from_workload["support-api"].from_port}", null)
      identity_behind_lb    = try("${aws_vpc_security_group_ingress_rule.workload_from_internal_lb["identity-api"].ip_protocol}/${aws_vpc_security_group_ingress_rule.workload_from_internal_lb["identity-api"].from_port}", null)
      provider_https        = try("${aws_vpc_security_group_egress_rule.provider_https["support-api"].ip_protocol}/${aws_vpc_security_group_egress_rule.provider_https["support-api"].from_port}", null)
      database              = contains(keys(aws_vpc_security_group_egress_rule.workload_to_database), "support-api")
      identity_host_routing = try(flatten([for condition in aws_lb_listener_rule.internal["identity-api"].condition : [for header in condition.host_header : header.values]]), [])
    }
  }
}
