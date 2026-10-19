locals {
  # Select the capacity profile used by this environment.
  deployment_profile = var.promote_existing_staging ? "economy" : (var.environment == "staging" ? var.staging_mode : var.environment)
  name_prefix        = "hid-${local.resource_environment}"
  partner_apn_id     = "pc:elrusap42k3opao8syw9gd5s1"

  # Capacity profiles are independent of the configurable retention baselines.
  profiles = {
    development = {
      vpc_cidr                     = "10.20.0.0/16"
      nat_gateway_count            = 1
      interface_endpoint_services  = ["ecr.api", "ecr.dkr", "logs", "secretsmanager", "kms", "events", "sqs", "textract"]
      interface_endpoint_az_count  = 2
      enable_autoscaling           = true
      database_instance_class      = "db.t4g.small"
      database_allocated_storage   = 50
      database_max_storage         = 100
      database_multi_az            = false
      database_deletion_protection = false
      database_connection_budget   = 120
      emergency_connection_budget  = 180
      repository_image_count       = 25
    }

    sleep = {
      vpc_cidr                     = "10.30.0.0/16"
      nat_gateway_count            = 0
      interface_endpoint_services  = []
      interface_endpoint_az_count  = 0
      enable_autoscaling           = false
      database_instance_class      = "db.t4g.small"
      database_allocated_storage   = 100
      database_max_storage         = 300
      database_multi_az            = false
      database_deletion_protection = true
      database_connection_budget   = 0
      emergency_connection_budget  = 0
      repository_image_count       = 25
    }

    economy = {
      vpc_cidr                     = "10.30.0.0/16"
      nat_gateway_count            = 1
      interface_endpoint_services  = ["ecr.api", "ecr.dkr", "logs", "secretsmanager", "events", "sqs", "textract"]
      interface_endpoint_az_count  = 1
      enable_autoscaling           = true
      database_instance_class      = "db.t4g.small"
      database_allocated_storage   = 100
      database_max_storage         = 300
      database_multi_az            = false
      database_deletion_protection = true
      database_connection_budget   = 120
      emergency_connection_budget  = 180
      repository_image_count       = 25
    }

    fidelity = {
      vpc_cidr                     = "10.30.0.0/16"
      nat_gateway_count            = 2
      interface_endpoint_services  = ["ecr.api", "ecr.dkr", "logs", "secretsmanager", "kms", "events", "sqs", "textract"]
      interface_endpoint_az_count  = 2
      enable_autoscaling           = true
      database_instance_class      = "db.t4g.medium"
      database_allocated_storage   = 100
      database_max_storage         = 300
      database_multi_az            = true
      database_deletion_protection = true
      database_connection_budget   = 200
      emergency_connection_budget  = 400
      repository_image_count       = 50
    }

    production = {
      vpc_cidr                     = "10.40.0.0/16"
      nat_gateway_count            = 2
      interface_endpoint_services  = ["ecr.api", "ecr.dkr", "logs", "secretsmanager", "kms", "events", "sqs", "textract"]
      interface_endpoint_az_count  = 3
      enable_autoscaling           = true
      database_instance_class      = "db.r6g.large"
      database_allocated_storage   = 200
      database_max_storage         = 1000
      database_multi_az            = true
      database_deletion_protection = true
      database_connection_budget   = 400
      emergency_connection_budget  = 650
      repository_image_count       = 100
    }
  }

  profile = local.profiles[local.deployment_profile]

  browser_subdomains = local.runtime_environment == "production" ? [
    "www",
    "ehr",
    "lab",
    "pharmacy",
    "ocr",
    "migrate",
    "outreach",
    "admin"
    ] : [
    local.runtime_environment,
    "ehr.${local.runtime_environment}",
    "lab.${local.runtime_environment}",
    "pharmacy.${local.runtime_environment}",
    "ocr.${local.runtime_environment}",
    "migrate.${local.runtime_environment}",
    "outreach.${local.runtime_environment}",
    "admin.${local.runtime_environment}"
  ]

  # This catalogue is the single source for container sizing, ports, database
  # connection limits, and scaling behaviour for application workloads.
  baseline_workloads = merge({
    identity-api = {
      port                 = 3001
      cpu                  = 512
      memory               = 1024
      database_connections = 6
      browser_routed       = true
      scaling_kind         = "request"
      request_target       = 600
    }
    ehr-api = {
      port                 = 3002
      cpu                  = 1024
      memory               = 2048
      database_connections = 11
      browser_routed       = true
      scaling_kind         = "request"
      request_target       = 400
    }
    lab-api = {
      port                 = 3003
      cpu                  = 512
      memory               = 1024
      database_connections = 5
      browser_routed       = true
      scaling_kind         = "request"
      request_target       = 300
    }
    pharmacy-api = {
      port                 = 3004
      cpu                  = 512
      memory               = 1024
      database_connections = 5
      browser_routed       = true
      scaling_kind         = "request"
      request_target       = 300
    }
    ocr-api = {
      port                 = 3005
      cpu                  = 512
      memory               = 1024
      database_connections = 5
      browser_routed       = true
      scaling_kind         = "request"
      request_target       = 240
    }
    ocr-worker = {
      port                 = 0
      cpu                  = 1024
      memory               = 2048
      database_connections = 4
      browser_routed       = false
      scaling_kind         = "ocr-backlog"
      request_target       = 0
    }
    outreach-api = {
      port                 = 3006
      cpu                  = 512
      memory               = 1024
      database_connections = 5
      browser_routed       = true
      scaling_kind         = "request"
      request_target       = 300
    }
    notification-api = {
      port                 = 3007
      cpu                  = 512
      memory               = 1024
      database_connections = 0
      browser_routed       = false
      scaling_kind         = "request"
      request_target       = 300
    }
    notification-worker = {
      port                 = 3008
      cpu                  = 512
      memory               = 1024
      database_connections = 4
      browser_routed       = false
      scaling_kind         = "notification-queue"
      request_target       = 0
    }
    event-dispatcher = {
      port                 = 3010
      cpu                  = 512
      memory               = 1024
      database_connections = 4
      browser_routed       = false
      scaling_kind         = "outbox-backlog"
      request_target       = 0
    }
    gateway = {
      port                 = 3000
      cpu                  = 512
      memory               = 1024
      database_connections = 0
      browser_routed       = true
      scaling_kind         = "request"
      request_target       = 1000
    }
    }, var.enable_support_bot ? {
    support-api = {
      port                 = 3011
      cpu                  = 512
      memory               = 1024
      database_connections = 0
      browser_routed       = true
      scaling_kind         = "request"
      request_target       = 300
    }
  } : {})

  # Pre-launch sizing is an explicit staging economy opt-in. Production and
  # fidelity continue using the original capacity catalogue.
  workloads = {
    for name, workload in local.baseline_workloads : name => merge(workload,
      (var.staging_prelaunch_sizing && var.environment == "staging" && var.staging_mode == "economy" || var.promote_existing_staging) && name != "event-dispatcher" ? {
        cpu    = contains(["ehr-api", "ocr-worker"], name) ? 512 : 256
        memory = contains(["ehr-api", "ocr-worker"], name) ? 1024 : 512
      } : {}
    )
  }

  database_workload_names = [
    for name, workload in local.workloads : name
    if workload.database_connections > 0
  ]

  worker_names = [
    for name, workload in local.workloads : name
    if workload.scaling_kind != "request"
  ]

  desired_counts = {
    for name, workload in local.workloads : name => (
      local.deployment_profile == "sleep" ? 0 :
      contains(["development", "economy"], local.deployment_profile) ?
      (contains(local.worker_names, name) ? (local.resource_environment == "staging" ? var.staging_worker_min_capacity : 0) : 1) :
      local.deployment_profile == "fidelity" ?
      (contains(local.worker_names, name) ? 1 : 2) :
      2
    )
  }

  production_scaling_ceilings = {
    identity-api        = 8
    ehr-api             = 8
    lab-api             = 6
    pharmacy-api        = 6
    ocr-api             = 6
    ocr-worker          = 4
    outreach-api        = 6
    notification-api    = 6
    notification-worker = 4
    event-dispatcher    = 6
    gateway             = 12
    support-api         = 4
  }

  scaling_ceilings = {
    for name, workload in local.workloads : name => (
      local.deployment_profile == "sleep" ? 0 :
      contains(["development", "economy"], local.deployment_profile) ? 2 :
      local.deployment_profile == "fidelity" ?
      (contains(local.worker_names, name) ? 3 : 4) :
      local.production_scaling_ceilings[name]
    )
  }

  normal_database_connection_demand = sum([
    for name, workload in local.workloads :
    workload.database_connections * local.scaling_ceilings[name]
  ])
}
