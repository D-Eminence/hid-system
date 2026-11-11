output "ai_services_opt_out_policy_id" {
  value       = aws_organizations_policy.ai_services_opt_out.id
  description = "The AI services opt-out policy; check it with describe-effective-policy (README.md)."
}

output "organization_root_id" {
  value       = local.root.id
  description = "The organization root the policy is attached to."
}
