# Auth0 Terraform provider credentials
# Create an M2M app in Auth0 with Management API access, or use
# AUTH0_DOMAIN / AUTH0_API_TOKEN environment variables instead.

variable "auth0_domain" {
  description = "Auth0 tenant domain (e.g., your-tenant.us.auth0.com)"
  type        = string
}

variable "auth0_tf_client_id" {
  description = "Auth0 M2M client ID for Terraform (needs Management API access)"
  type        = string
}

variable "auth0_tf_client_secret" {
  description = "Auth0 M2M client secret for Terraform"
  type        = string
  sensitive   = true
}

# GitHub OAuth App — create at https://github.com/settings/developers

variable "github_oauth_client_id" {
  description = "GitHub OAuth App client ID"
  type        = string
}

variable "github_oauth_client_secret" {
  description = "GitHub OAuth App client secret"
  type        = string
  sensitive   = true
}

variable "enable_dpop" {
  description = "Enforce DPoP proof-of-possession on the proxy API (requires paid Auth0 plan)"
  type        = bool
  default     = false
}
