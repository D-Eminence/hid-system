output "trail_arn" {
  value       = aws_cloudtrail.audit.arn
  description = "Account audit trail to check with get-trail-status."
}

output "audit_bucket_name" {
  value       = aws_s3_bucket.audit.id
  description = "Restricted S3 bucket holding CloudTrail logs and validation digests."
}
