aws_region          = "eu-west-1"
expected_account_id = "659225405023"
environment         = "development"

availability_zones       = ["eu-west-1a", "eu-west-1b"]
public_subnet_cidrs      = ["10.20.0.0/24", "10.20.1.0/24"]
application_subnet_cidrs = ["10.20.10.0/24", "10.20.11.0/24"]
database_subnet_cidrs    = ["10.20.20.0/24", "10.20.21.0/24"]

enable_database        = false
enable_runtime         = false
enable_ingress         = false
enable_backup_plan     = false
enable_cost_governance = false
enable_ai              = false
ai_allow_eu_processing = false
