output "trail_arn" {
  value       = module.cloudtrail.trail_arn
  description = "Account audit trail to check with get-trail-status."
}

output "audit_bucket_name" {
  value       = module.cloudtrail.audit_bucket_name
  description = "Restricted S3 bucket holding CloudTrail logs and validation digests."
}
