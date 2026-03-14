terraform {
  required_providers {
    auth0 = {
      source  = "auth0/auth0"
      version = "~> 1.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "auth0" {
  domain        = var.auth0_domain
  client_id     = var.auth0_tf_client_id
  client_secret = var.auth0_tf_client_secret
}

# =============================================================================
# 1. API (Resource Server) — represents the proxy
# =============================================================================

resource "auth0_resource_server" "proxy" {
  name       = "Wormhole Proxy"
  identifier = "https://wormhole-proxy"

  signing_alg          = "RS256"
  allow_offline_access = true # MRRT — agent can exchange refresh token for My Account API tokens

  skip_consent_for_verifiable_first_party_clients = true

  # Enforce DPoP — tokens for this API must be proof-of-possession bound
  # Requires a paid Auth0 plan; set enable_dpop = true in tfvars to enable
  dynamic "proof_of_possession" {
    for_each = var.enable_dpop ? [1] : []
    content {
      mechanism = "dpop"
      required  = true
    }
  }
}

# =============================================================================
# 2. Resource Client — linked to the proxy API, calls Token Vault
#
#    This is the key relationship: app_type = "resource_server" with
#    resource_server_identifier pointing to the proxy API. Auth0 validates
#    that this client is authorized to exchange tokens for this audience.
# =============================================================================

resource "auth0_client" "resource_client" {
  name     = "Wormhole Resource Client"
  app_type = "resource_server"

  # Links this client to the proxy API — cannot be changed after creation
  resource_server_identifier = auth0_resource_server.proxy.identifier

  grant_types = [
    "urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token",
  ]
}

resource "auth0_client_credentials" "resource_client" {
  client_id             = auth0_client.resource_client.id
  authentication_method = "client_secret_post"
}

# =============================================================================
# 3. Agent Application (Native) — device code flow with DPoP
# =============================================================================

resource "auth0_client" "agent" {
  name            = "Wormhole Agent"
  app_type        = "native"
  oidc_conformant = true

  grant_types = [
    "urn:ietf:params:oauth:grant-type:device_code",
    "refresh_token",
  ]

  # MRRT — allow the agent's refresh token to be exchanged for My Account API tokens
  refresh_token {
    rotation_type   = "non-rotating"
    expiration_type = "expiring"

    policies {
      audience = "https://${var.auth0_domain}/me/"
      scope    = ["read:me:connected_accounts"]
    }
  }
}

# =============================================================================
# 4. Connected Accounts companion app (Regular Web) — Authorization Code flow
# =============================================================================

resource "auth0_client" "connect_app" {
  name     = "Wormhole Connect"
  app_type = "regular_web"

  grant_types = ["authorization_code", "refresh_token"]

  callbacks           = ["http://localhost:3001/auth/callback", "http://localhost:3001/connect/callback"]
  allowed_logout_urls = ["http://localhost:3001"]

  refresh_token {
    rotation_type   = "non-rotating"
    expiration_type = "expiring"

    policies {
      audience = "https://${var.auth0_domain}/me/"
      scope = [
        "read:me:connected_accounts",
        "create:me:connected_accounts",
        "delete:me:connected_accounts",
      ]
    }
  }
}

resource "auth0_client_credentials" "connect_app" {
  client_id             = auth0_client.connect_app.id
  authentication_method = "client_secret_post"
}

# Session secret for the connect app's cookie encryption
resource "random_password" "session_secret" {
  length  = 32
  special = false
}

# =============================================================================
# 5. My Account API — client grants for Connected Accounts access
# =============================================================================

# Agent: read-only access to check if GitHub is connected
resource "auth0_client_grant" "agent_my_account" {
  client_id = auth0_client.agent.id
  subject_type                = "user"
  audience  = "https://${var.auth0_domain}/me/"
  scopes    = ["read:me:connected_accounts"]
}

# Connect app: full connected accounts management (connect, disconnect)
resource "auth0_client_grant" "connect_my_account" {
  client_id = auth0_client.connect_app.id
  subject_type = "user"
  audience  = "https://${var.auth0_domain}/me/"
  scopes = [
    "read:me:connected_accounts",
    "create:me:connected_accounts",
    "delete:me:connected_accounts",
  ]
}

# =============================================================================
# 7. GitHub Social Connection — Token Vault must be enabled in the dashboard
#
#    Prerequisite: Create a GitHub OAuth App at
#    https://github.com/settings/developers with:
#      Homepage URL:  https://<AUTH0_DOMAIN>
#      Callback URL:  https://<AUTH0_DOMAIN>/login/callback
# =============================================================================

resource "auth0_connection" "github" {
  name     = "github"
  strategy = "github"
  
  authentication { 
    active = false
  }

  connected_accounts {
    active = true
  }

  options {
    client_id     = var.github_oauth_client_id
    client_secret = var.github_oauth_client_secret
    scopes        = ["user", "repo"]
  }
}

# Enable this connection for all apps
resource "auth0_connection_clients" "github_clients" {
  connection_id = auth0_connection.github.id
  enabled_clients = [
    auth0_client.resource_client.id,
    auth0_client.agent.id,
    auth0_client.connect_app.id,
  ]
}

# =============================================================================
# 8. Write .env for docker compose
# =============================================================================

resource "local_file" "env" {
  filename = "${path.module}/../.env"
  content  = <<-EOT
  # Generated by terraform — do not edit
  AUTH0_DOMAIN=${var.auth0_domain}
  AUTH0_CLIENT_ID=${auth0_client.agent.client_id}
  AUTH0_AUDIENCE=${auth0_resource_server.proxy.identifier}
  AUTH0_RESOURCE_CLIENT_ID=${auth0_client.resource_client.client_id}
  AUTH0_RESOURCE_CLIENT_SECRET=${auth0_client_credentials.resource_client.client_secret}
  AUTH0_CONNECTION=${auth0_connection.github.name}
  CONNECT_CLIENT_ID=${auth0_client.connect_app.client_id}
  CONNECT_CLIENT_SECRET=${auth0_client_credentials.connect_app.client_secret}
  SESSION_SECRET=${random_password.session_secret.result}
  EOT

  file_permission = "0600"
}
