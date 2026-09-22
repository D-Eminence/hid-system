# Cloudflare cutover template

This separate Terraform root only prepares the proxied DNS CNAME that points the application hostname at the AWS load balancer. It is not part of the AWS foundation apply. Set `CLOUDFLARE_API_TOKEN` through a secure environment and configure separate encrypted remote state.

Copy `terraform.tfvars.example` to an ignored `terraform.tfvars` file only after the AWS load balancer exists and the public hostname and Cloudflare zone are approved.

Review existing DNS records, Cloudflare WAF rules, SSL/TLS mode, origin certificates, and caching behavior before planning. Import an existing DNS record into state rather than creating a duplicate. Apply the DNS change only after staging parity, origin TLS, health checks, backups, and rollback have been tested.

Cloudflare provider v5.25.0 is locked and `terraform validate` passes. The current Cloudflare account and zone are unavailable, so no live plan or apply has run. Cloudflare WAF and zone settings are deliberately not changed by this root until the existing configuration is reviewed.
