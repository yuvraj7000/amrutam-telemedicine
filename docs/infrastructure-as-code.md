# Infrastructure as Code

This repository contains three infrastructure layers: a Docker Compose stack
for local development, Kubernetes manifests for cluster deployments, and an
AWS Terraform reference configuration using ECS. These options are alternatives
for different environments; the Terraform configuration does not provision an
EKS cluster.

No infrastructure is deployed by documenting or validating these files.
Account setup, secrets, environment approvals, network choices, and an
operator-reviewed plan are required before any cloud resources are created.

## Local development: Docker Compose

`infra/docker/docker-compose.yml` runs PostgreSQL 16, Redis 7, a migration
container, the backend API and worker, an OpenTelemetry collector, Jaeger,
Prometheus, and Grafana. Persistent local volumes are used for database and
observability data. See the [root README](../README.md) for setup and local
service URLs.

Use the Compose stack only with local development credentials. Do not copy
production secrets into `.env`; keep the file untracked. Removing Compose
volumes destroys local database, Redis, and observability data.

## Kubernetes: `infra/k8s/`

`infra/k8s/base/` defines API and worker deployments, services, ingress,
configuration, resource and availability controls, network policies, and
scheduled jobs. `infra/k8s/overlays/staging/` and
`infra/k8s/overlays/prod/` provide environment-specific Kustomize overlays.

Before deploying, review the rendered manifests for the target cluster and
confirm:

- Secrets are supplied through the approved secret-management integration.
- Ingress TLS, hostnames, CORS origins, and network policies match the
  environment.
- Resource requests, limits, replicas, autoscaling bounds, and disruption
  budgets are appropriate for measured workloads.
- Database and Redis endpoints are private, authenticated, and reachable only
  from intended workloads.
- Migrations are ordered safely with the application rollout and can be
  reversed or forward-fixed under the release procedure.

## AWS reference: `infra/terraform/`

The Terraform root configuration describes an AWS ECS Fargate deployment:

- A three-availability-zone VPC with public load-balancer subnets, private
  application/data subnets, NAT gateways, and separate security groups.
- An encrypted Multi-AZ PostgreSQL 16 primary and read replica, with TLS
  settings, point-in-time recovery, and backup copies.
- A TLS/AUTH-enabled, Multi-AZ ElastiCache Redis replication group.
- ECS API and worker services, ECR image storage/scanning, HTTPS ALB, AWS WAF,
  logging, and autoscaling.
- KMS and Secrets Manager integration, cross-region S3 audit archival with
  Object Lock, backup storage, managed metrics workspaces, and a GitHub Actions
  OIDC deployment role.

The Terraform files expect an immutable application image to exist in ECR.
The external OpenTelemetry collector and production payment adapter are
separate prerequisites and are not installed by this configuration.

### Inputs and secret handling

Required deployment inputs include primary and failover regions, a resource
prefix, three availability zones, non-overlapping subnet CIDRs, approved HTTPS
ingress CIDRs, an ACM certificate ARN, frontend CORS origins, PostgreSQL and
Redis credentials, application runtime secrets, a reachable OTLP/HTTP
endpoint, and the GitHub repository permitted to deploy.

Supply values through protected variables or an approved secret store. Do not
commit `terraform.tfvars`, state files, saved plans, credentials, or
environment files. Terraform state can contain credentials and application
secrets even when variables and outputs are marked sensitive; use encrypted
remote state with locking and strictly limited read access before running a
plan or apply. The configuration has no remote backend block by default.

If the AWS account already has the GitHub OIDC provider, configure the
existing provider ARN and disable creation of a new provider. Review the
deployment role's repository and branch trust restrictions before enabling
CI/CD.

### Validation and deployment

These commands format and validate configuration without provisioning AWS
resources:

```powershell
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate
```

An authenticated `terraform plan` is a separate, reviewed operational step.
Before applying, configure remote state, verify account and region, inspect
network ranges and ingress scope, provide secrets through an approved channel,
and review the plan for cost, data exposure, and access-policy changes. Apply
only through the approved protected release workflow.

## Operational references

- [Security checklist](security-checklist.md)
- [Threat model](threat-model.md)
- [Restore runbook](runbooks/restore.md)
- [Regional failover runbook](runbooks/failover.md)
- [Key-rotation runbook](runbooks/key-rotation.md)
