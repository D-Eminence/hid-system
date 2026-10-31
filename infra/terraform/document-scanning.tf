# Document virus scanning switches must be turned on in order (DEVOPS_HANDOVER.md
# "Document virus scanning"). Terraform refuses the unsafe combinations in the
# modules (bucket policy and bridge preconditions); these checks warn about
# switches that would silently do nothing.
check "document_scanning_switch_order" {
  assert {
    condition     = !var.enable_document_scanning || var.enable_document_malware_protection
    error_message = "enable_document_scanning needs enable_document_malware_protection; the bridge refuses to plan without the GuardDuty plan."
  }
  assert {
    condition     = var.enable_document_scanning || (var.document_scan_bridge_mode == "observe" && !var.document_scan_reconcile_enabled)
    error_message = "document_scan_bridge_mode and document_scan_reconcile_enabled do nothing while enable_document_scanning is off."
  }
  assert {
    condition     = !var.document_scan_enforce_tags || var.enable_document_malware_protection
    error_message = "document_scan_enforce_tags needs enable_document_malware_protection; the bucket policy refuses to plan without it."
  }
}
