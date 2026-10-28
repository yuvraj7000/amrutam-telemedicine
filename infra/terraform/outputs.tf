output "api_load_balancer_dns_name" {
  description = "Public DNS name of the WAF-protected HTTPS application load balancer."
  value       = aws_lb.api.dns_name
}

output "api_load_balancer_zone_id" {
  description = "Hosted zone ID for creating an application DNS alias."
  value       = aws_lb.api.zone_id
}

output "ecr_repository_url" {
  description = "Immutable-tag ECR repository for API and worker images."
  value       = aws_ecr_repository.application.repository_url
}

output "github_deploy_role_arn" {
  description = "OIDC role ARN for the protected GitHub deployment workflow."
  value       = aws_iam_role.github_deploy.arn
}

output "postgres_primary_endpoint" {
  description = "Private PostgreSQL primary endpoint (TLS required)."
  value       = aws_db_instance.primary.address
}

output "postgres_reader_endpoint" {
  description = "Private PostgreSQL read-replica endpoint."
  value       = aws_db_instance.reader.address
}

output "redis_primary_endpoint" {
  description = "Private TLS Redis primary endpoint."
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "runtime_secret_arn" {
  description = "Secrets Manager secret ARN containing runtime environment values."
  value       = aws_secretsmanager_secret.runtime.arn
}

output "prometheus_workspace_endpoint" {
  description = "Amazon Managed Prometheus remote-write/query endpoint."
  value       = aws_prometheus_workspace.main.prometheus_endpoint
}

output "grafana_workspace_url" {
  description = "Amazon Managed Grafana workspace URL."
  value       = aws_grafana_workspace.main.endpoint
}
