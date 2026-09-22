terraform {
  required_version = ">= 1.6.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  backend "s3" {}
}

provider "cloudflare" {}

variable "zone_id" {
  type        = string
  description = "Existing Cloudflare zone ID."
}

variable "hostname" {
  type        = string
  description = "Public application hostname."
}

variable "origin_alb_dns_name" {
  type        = string
  description = "DNS name output from the AWS application load balancer."
}

resource "cloudflare_dns_record" "application" {
  zone_id = var.zone_id
  name    = var.hostname
  type    = "CNAME"
  content = var.origin_alb_dns_name
  proxied = true
  ttl     = 1
  comment = "Health Identity AWS origin; apply only during an approved cutover"
}
