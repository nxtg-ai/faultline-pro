data "faultline_scan" "release_notes" {
  text     = file("${path.module}/release-notes.md")
  provider = "gemini"
}

output "release_notes_risk" {
  value = data.faultline_scan.release_notes.overall_risk
}

# Fail the Terraform plan if the scanned content is classified as critical risk.
# This prevents deploying infrastructure alongside release notes that contain
# unverified or high-risk AI-generated claims.
check "release_notes_safety" {
  assert {
    condition     = data.faultline_scan.release_notes.overall_risk != "critical"
    error_message = "Release notes contain critical-risk AI-generated content. Review and remediate before deploying."
  }
}
