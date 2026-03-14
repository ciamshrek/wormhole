output "agent_client_id" {
  description = "Agent app client ID (for device code flow)"
  value       = auth0_client.agent.client_id
}

output "resource_client_id" {
  description = "Resource Client ID (for Token Vault exchange)"
  value       = auth0_client.resource_client.client_id
}

output "proxy_api_identifier" {
  description = "Proxy API audience"
  value       = auth0_resource_server.proxy.identifier
}

output "connect_client_id" {
  description = "Connect companion app client ID"
  value       = auth0_client.connect_app.client_id
}

output "next_steps" {
  description = "Steps after terraform apply"
  value       = <<-EOT

    .env written to ../.

    Run the demo:
      cd ..
      docker compose up --build

  EOT
}
