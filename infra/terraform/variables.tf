variable "aws_region" {
  description = "Primary AWS region."
  type        = string
}

variable "failover_region" {
  description = "Separate AWS region for S3 and AWS Backup copies."
  type        = string
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "production"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "name_prefix" {
  description = "Lowercase resource-name prefix, for example amrutam-prod."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.name_prefix))
    error_message = "name_prefix must be 3-21 lowercase letters, digits, or hyphens and start with a letter."
  }
}

variable "availability_zones" {
  description = "Exactly three availability zones in the primary region."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) == 3
    error_message = "Supply exactly three availability zones."
  }
}

variable "public_subnet_cidrs" {
  description = "Three non-overlapping public subnet CIDRs."
  type        = list(string)

  validation {
    condition     = length(var.public_subnet_cidrs) == 3
    error_message = "Supply exactly three public subnet CIDRs."
  }
}

variable "private_subnet_cidrs" {
  description = "Three non-overlapping private subnet CIDRs for compute and data."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_cidrs) == 3
    error_message = "Supply exactly three private subnet CIDRs."
  }
}

variable "allowed_ingress_cidrs" {
  description = "CIDRs allowed to reach the HTTPS load balancer. Prefer approved WAF-protected edge ranges."
  type        = list(string)

  validation {
    condition     = length(var.allowed_ingress_cidrs) > 0
    error_message = "At least one HTTPS ingress CIDR is required."
  }
}

variable "certificate_arn" {
  description = "ACM certificate ARN in aws_region for the public ALB."
  type        = string
}

variable "cors_origins" {
  description = "Comma-separated HTTPS frontend origins allowed by the API."
  type        = string

  validation {
    condition     = alltrue([for origin in split(",", var.cors_origins) : can(regex("^https://", trimspace(origin)))])
    error_message = "cors_origins must contain only HTTPS origins."
  }
}

variable "db_name" {
  description = "PostgreSQL database name."
  type        = string
  default     = "amrutam"

  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9_]{0,62}$", var.db_name))
    error_message = "db_name must be a valid PostgreSQL identifier."
  }
}

variable "db_username" {
  description = "PostgreSQL master username. Supply through a protected tfvars file or TF_VAR_db_username."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9_]{0,62}$", var.db_username)) && lower(var.db_username) != "postgres"
    error_message = "db_username must be a valid non-reserved PostgreSQL username."
  }
}

variable "db_password" {
  description = "PostgreSQL master password. Do not commit this value."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.db_password) >= 16 && !can(regex("[/@\" ]", var.db_password))
    error_message = "db_password must contain at least 16 characters and must not contain slash, quote, at sign, or space."
  }
}

variable "redis_auth_token" {
  description = "ElastiCache Redis AUTH token, supplied outside source control."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.redis_auth_token) >= 16 && !can(regex("[@\"/]", var.redis_auth_token))
    error_message = "redis_auth_token must be at least 16 characters and must not contain @, double quote, or slash."
  }
}

variable "runtime_secrets" {
  description = "Application secrets consumed as JSON keys by ECS tasks."
  type = object({
    jwt_keys_json          = string
    jwt_active_kid         = string
    enc_keys_json          = string
    payment_webhook_secret = string
    payment_api_key        = string
    metrics_token          = string
  })
  sensitive = true

  validation {
    condition = (
      can(keys(jsondecode(var.runtime_secrets.jwt_keys_json))) &&
      can(keys(jsondecode(var.runtime_secrets.enc_keys_json))) &&
      length(var.runtime_secrets.payment_webhook_secret) >= 16 &&
      length(var.runtime_secrets.metrics_token) >= 24
    )
    error_message = "JWT_KEYS and ENC_KEYS must be JSON; webhook secret must be at least 16 characters and metrics token at least 24."
  }
}

variable "payment_provider" {
  description = "Configured payment provider. The worker's provider adapter must be integrated before processing live payments."
  type        = string
  default     = "razorpay"

  validation {
    condition     = contains(["mock", "razorpay", "stripe"], var.payment_provider)
    error_message = "payment_provider must be mock, razorpay, or stripe."
  }
}

variable "otel_exporter_otlp_endpoint" {
  description = "Reachable OTLP/HTTP collector endpoint, including scheme."
  type        = string

  validation {
    condition     = can(regex("^https?://", var.otel_exporter_otlp_endpoint))
    error_message = "otel_exporter_otlp_endpoint must be an HTTP or HTTPS URL."
  }
}

variable "image_tag" {
  description = "Immutable application image tag already pushed to the configured ECR repository."
  type        = string
  default     = "0.1.0"
}

variable "db_instance_class" {
  description = "RDS PostgreSQL primary and read-replica instance class."
  type        = string
  default     = "db.r6g.large"
}

variable "db_engine_version" {
  description = "Available PostgreSQL 16 minor engine version in aws_region."
  type        = string
  default     = "16.4"
}

variable "db_allocated_storage_gib" {
  description = "Initial encrypted RDS storage in GiB."
  type        = number
  default     = 100

  validation {
    condition     = var.db_allocated_storage_gib >= 100
    error_message = "Production RDS storage must be at least 100 GiB."
  }
}

variable "redis_node_type" {
  description = "ElastiCache node class."
  type        = string
  default     = "cache.r6g.large"
}

variable "api_desired_count" {
  description = "Initial ECS API task count."
  type        = number
  default     = 3

  validation {
    condition     = var.api_desired_count >= 3
    error_message = "The API must start with at least three tasks."
  }
}

variable "worker_desired_count" {
  description = "Initial ECS worker task count."
  type        = number
  default     = 2

  validation {
    condition     = var.worker_desired_count >= 2
    error_message = "The worker must start with at least two tasks."
  }
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub Actions OIDC provider in this AWS account."
  type        = bool
  default     = true
}

variable "github_oidc_provider_arn" {
  description = "Existing GitHub OIDC provider ARN when create_github_oidc_provider is false."
  type        = string
  default     = ""
}

variable "github_oidc_thumbprint" {
  description = "Current SHA-1 thumbprint for token.actions.githubusercontent.com."
  type        = string
  default     = "6938fd4d98bab03faadb97b34396831e3780aea1"
}

variable "github_repository" {
  description = "GitHub repository in owner/name form allowed to deploy."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be in owner/name form."
  }
}

variable "github_deploy_branch" {
  description = "Protected branch allowed to assume the deployment role."
  type        = string
  default     = "main"
}
