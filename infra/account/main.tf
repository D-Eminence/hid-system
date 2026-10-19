module "cloudtrail" {
  source = "./modules/cloudtrail"

  aws_region               = var.aws_region
  expected_account_id      = var.expected_account_id
  alert_email              = var.alert_email
  clinical_bucket_names    = var.clinical_bucket_names
  audit_log_retention_days = var.audit_log_retention_days
}
