terraform {
  required_providers {
    faultline = {
      source  = "nxtg-ai/faultline"
      version = "~> 0.1"
    }
  }
}

provider "faultline" {
  api_key  = var.faultline_api_key
  base_url = "https://api.faultline.nxtg.ai"
}

variable "faultline_api_key" {
  description = "Faultline API key"
  type        = string
  sensitive   = true
}
