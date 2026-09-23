locals {
  deployment_profile = var.environment == "staging" ? var.staging_mode : var.environment
  name_prefix        = "hid-${var.environment}"

  profiles = {
    development = {
      vpc_cidr                    = "10.20.0.0/16", nat_gateway_count = 1
      interface_endpoint_services = ["ecr.api", "ecr.dkr", "logs", "secretsmanager", "kms", "events", "sqs", "textract"]
      interface_endpoint_az_count = 2, enable_autoscaling = true
      database_instance_class     = "db.t4g.small", database_allocated_storage = 50, database_max_storage = 100
      database_multi_az           = false, database_deletion_protection = false, database_backup_retention = 7
      database_connection_budget  = 120, emergency_connection_budget = 180
      log_retention_days          = 30, repository_image_count = 25
    }
    sleep = {
      vpc_cidr                    = "10.30.0.0/16", nat_gateway_count = 0
      interface_endpoint_services = [], interface_endpoint_az_count = 0, enable_autoscaling = false
      database_instance_class     = "db.t4g.small", database_allocated_storage = 100, database_max_storage = 300
      database_multi_az           = false, database_deletion_protection = true, database_backup_retention = 14
      database_connection_budget  = 0, emergency_connection_budget = 0
      log_retention_days          = 30, repository_image_count = 25
    }
    economy = {
      vpc_cidr                    = "10.30.0.0/16", nat_gateway_count = 1
      interface_endpoint_services = ["ecr.api", "ecr.dkr", "logs", "secretsmanager", "events", "sqs", "textract"]
      interface_endpoint_az_count = 1, enable_autoscaling = true
      database_instance_class     = "db.t4g.small", database_allocated_storage = 100, database_max_storage = 300
      database_multi_az           = false, database_deletion_protection = true, database_backup_retention = 14
      database_connection_budget  = 120, emergency_connection_budget = 180
      log_retention_days          = 30, repository_image_count = 25
    }
    fidelity = {
      vpc_cidr                    = "10.30.0.0/16", nat_gateway_count = 2
      interface_endpoint_services = ["ecr.api", "ecr.dkr", "logs", "secretsmanager", "kms", "events", "sqs", "textract"]
      interface_endpoint_az_count = 2, enable_autoscaling = true
      database_instance_class     = "db.t4g.medium", database_allocated_storage = 100, database_max_storage = 300
      database_multi_az           = true, database_deletion_protection = true, database_backup_retention = 14
      database_connection_budget  = 200, emergency_connection_budget = 400
      log_retention_days          = 90, repository_image_count = 50
    }
    production = {
      vpc_cidr                    = "10.40.0.0/16", nat_gateway_count = 2
      interface_endpoint_services = ["ecr.api", "ecr.dkr", "logs", "secretsmanager", "kms", "events", "sqs", "textract"]
      interface_endpoint_az_count = 3, enable_autoscaling = true
      database_instance_class     = "db.r6g.large", database_allocated_storage = 200, database_max_storage = 1000
      database_multi_az           = true, database_deletion_protection = true, database_backup_retention = 35
      database_connection_budget  = 400, emergency_connection_budget = 650
      log_retention_days          = 365, repository_image_count = 100
    }
  }

  profile = local.profiles[local.deployment_profile]

  browser_subdomains = var.environment == "production" ? ["www", "ehr", "lab", "pharmacy", "ocr", "outreach", "admin"] : [
    var.environment, "ehr.${var.environment}", "lab.${var.environment}", "pharmacy.${var.environment}",
    "ocr.${var.environment}", "outreach.${var.environment}", "admin.${var.environment}"
  ]

  workloads = {
    identity-api        = { port = 3001, cpu = 512, memory = 1024, database_connections = 6, browser_routed = true, scaling_kind = "request", request_target = 600 }
    ehr-api             = { port = 3002, cpu = 1024, memory = 2048, database_connections = 11, browser_routed = true, scaling_kind = "request", request_target = 400 }
    lab-api             = { port = 3003, cpu = 512, memory = 1024, database_connections = 5, browser_routed = true, scaling_kind = "request", request_target = 300 }
    pharmacy-api        = { port = 3004, cpu = 512, memory = 1024, database_connections = 5, browser_routed = true, scaling_kind = "request", request_target = 300 }
    ocr-api             = { port = 3005, cpu = 512, memory = 1024, database_connections = 5, browser_routed = true, scaling_kind = "request", request_target = 240 }
    ocr-worker          = { port = 0, cpu = 1024, memory = 2048, database_connections = 4, browser_routed = false, scaling_kind = "ocr-backlog", request_target = 0 }
    outreach-api        = { port = 3006, cpu = 512, memory = 1024, database_connections = 5, browser_routed = true, scaling_kind = "request", request_target = 300 }
    notification-api    = { port = 3007, cpu = 512, memory = 1024, database_connections = 0, browser_routed = false, scaling_kind = "request", request_target = 300 }
    notification-worker = { port = 3008, cpu = 512, memory = 1024, database_connections = 4, browser_routed = false, scaling_kind = "notification-queue", request_target = 0 }
    event-dispatcher    = { port = 3010, cpu = 512, memory = 1024, database_connections = 4, browser_routed = false, scaling_kind = "outbox-backlog", request_target = 0 }
    gateway             = { port = 3000, cpu = 512, memory = 1024, database_connections = 0, browser_routed = true, scaling_kind = "request", request_target = 1000 }
  }

  database_workload_names = [for name, workload in local.workloads : name if workload.database_connections > 0]
  worker_names            = [for name, workload in local.workloads : name if workload.scaling_kind != "request"]

  desired_counts = {
    for name, workload in local.workloads : name => (
      local.deployment_profile == "sleep" ? 0 :
      contains(["development", "economy"], local.deployment_profile) ? (contains(local.worker_names, name) ? 0 : 1) :
      local.deployment_profile == "fidelity" ? (contains(local.worker_names, name) ? 1 : 2) : 2
    )
  }

  scaling_ceilings = {
    for name, workload in local.workloads : name => (
      local.deployment_profile == "sleep" ? 0 :
      contains(["development", "economy"], local.deployment_profile) ? 2 :
      local.deployment_profile == "fidelity" ? (contains(local.worker_names, name) ? 3 : 4) :
      lookup({ identity-api = 8, ehr-api = 8, lab-api = 6, pharmacy-api = 6, ocr-api = 6, ocr-worker = 4, outreach-api = 6, notification-api = 6, notification-worker = 4, event-dispatcher = 6, gateway = 12 }, name)
    )
  }

  normal_database_connection_demand = sum([
    for name, workload in local.workloads : workload.database_connections * local.scaling_ceilings[name]
  ])
}

check "environment_profile" {
  assert {
    condition     = var.environment == "staging" || var.staging_mode == "sleep"
    error_message = "staging_mode is only meaningful for staging; leave it at sleep elsewhere."
  }
}

check "subnet_shape" {
  assert {
    condition = (
      length(var.availability_zones) == length(var.public_subnet_cidrs) &&
      length(var.availability_zones) == length(var.application_subnet_cidrs) &&
      length(var.availability_zones) == length(var.database_subnet_cidrs) &&
      (var.environment == "production" ? length(var.availability_zones) == 3 : length(var.availability_zones) == 2)
    )
    error_message = "Subnet lists must match the AZ count: two for development/staging and three for production."
  }
}

check "runtime_inputs" {
  assert {
    condition = !var.enable_runtime || (
      length(setsubtract(toset(keys(local.workloads)), toset(keys(var.image_uris)))) == 0 &&
      var.migration_image_uri != "" && var.rds_ca_bundle_base64 != "" &&
      (var.environment == "staging" || (
        var.workload_issuer_url != "" && var.workload_jwks_url != "" &&
        length(setsubtract(toset(["identity", "ehr", "lab", "pharmacy", "ocr", "outreach"]), toset(keys(var.workload_subjects)))) == 0
      ))
    )
    error_message = "Runtime requires every workload image, the migration image, the RDS CA bundle, and non-staging workload identity settings."
  }
}

check "ingress_inputs" {
  assert {
    condition = !var.enable_ingress || (
      var.enable_runtime && var.regional_certificate_arn != "" &&
      var.internal_certificate_arn != "" && length(var.cloudflare_origin_secret) >= 32
    )
    error_message = "Ingress requires runtime, both ACM certificates, and the Cloudflare origin secret."
  }
}

check "activation_order" {
  assert {
    condition = (
      (!var.enable_runtime || (var.enable_database && var.enable_ingress)) &&
      (!var.enable_backup_plan || var.enable_database) &&
      (local.deployment_profile != "sleep" || (!var.enable_runtime && !var.enable_ingress))
    )
    error_message = "Runtime requires the database and ingress together; backup requires the database; the staging sleep profile cannot run services or load balancers."
  }
}

check "database_connection_budget" {
  assert {
    condition     = local.deployment_profile == "sleep" || local.normal_database_connection_demand <= local.profile.database_connection_budget
    error_message = "Workload scaling ceilings exceed the selected profile's database connection budget."
  }
}

check "cost_governance_inputs" {
  assert {
    condition     = !var.enable_cost_governance || can(regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", var.cost_notification_email))
    error_message = "Cost governance requires a valid notification email address."
  }
}
