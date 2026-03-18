resource "faultline_api_key" "ci_scanner" {
  name        = "CI Pipeline Scanner"
  permissions = ["scan"]
}

output "ci_api_key" {
  value     = faultline_api_key.ci_scanner.key
  sensitive = true
}
