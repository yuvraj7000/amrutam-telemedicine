# Security Checklist

Status reflects repository implementation only. Items marked **Operational** require production configuration or evidence and are not satisfied by source code alone.

## Authentication and authorization

- [x] Password hashing, password policy checks, account lockout, and generic login errors.
- [x] Per-IP and per-account authentication limits plus a global request limit.
- [x] TOTP MFA, one-time backup codes, and required enrollment for doctor/admin roles.
- [x] Short-lived JWTs with a `kid`, pinned algorithm, token-family refresh rotation, and revocation timestamps.
- [x] Deny-by-default route metadata and role/ownership enforcement in service methods.
- [x] Step-up MFA on sensitive administrator operations.
- [ ] **Operational:** run the complete role-by-route access matrix against a migrated PostgreSQL instance and review its results.

## Data protection and privacy

- [x] AES-256-GCM field encryption with versioned keys and row/field-bound associated data.
- [x] KMS envelope-encryption support and environment-key migration compatibility.
- [x] Secret and encryption-key validation at startup; no secret values are documented as production defaults.
- [x] Request validation, body-size limits, security headers, CORS allow-list, and parameterized repository queries.
- [x] Production error responses avoid stack traces; structured logs avoid deliberate PHI fields.
- [ ] **Operational:** configure TLS for ingress, database, Redis, telemetry, and provider connections.
- [ ] **Operational:** verify log/trace redaction and confirm PHI is absent from metrics, URLs, and dashboards.
- [ ] **Operational:** configure KMS policy, key rotation, backups, and access logging; rehearse re-encryption before key retirement.

## Integrity and resilience

- [x] Idempotency for booking/payment-related writes, atomic slot holds, consultation state transitions, and signed/deduplicated payment webhooks.
- [x] Transactional outbox, background queues, retry/backoff, and dead-letter queues.
- [x] Append-only/hash-chained audit implementation and verification path.
- [x] Payment webhook signature failures return 401 and increment a metric.
- [ ] **Operational:** run PostgreSQL concurrency, migration, audit-integrity, and webhook replay tests in CI with a working container runtime.
- [ ] **Operational:** configure dashboards and alerts for authentication abuse, signature failures, 5xx/latency, queue depth, and outbox lag.
- [ ] **Operational:** complete a backup restore and regional failover drill and record measured RPO/RTO.

## Supply chain and runtime

- [x] Lockfile and CI workflow definitions for lint, typecheck, unit/integration tests, dependency audit, secret scanning, and image scanning.
- [x] CodeQL and weekly dependency update workflow definitions.
- [x] Kubernetes manifests use non-root identities, restricted capabilities, read-only roots, resource bounds, and network policies.
- [x] Third-party GitHub Actions are pinned to immutable commit SHAs.
- [ ] **Operational:** configure protected branches and required review checks in repository settings.
- [ ] **Operational:** configure cloud OIDC role trust, registry permissions, environment approvals, secret-manager values, and production cluster access.
- [ ] **Operational:** build, scan, sign, and publish the release image and its SBOM in the target registry.

## Incident readiness

- [x] Restore, failover, key-rotation, and threat-model documentation exists in `docs/runbooks` and `docs/threat-model.md`.
- [ ] **Operational:** assign on-call owners, contact channels, breach-notification responsibilities, and recovery decision authority.
- [ ] **Operational:** practice incident containment, credential/key revocation, audit evidence preservation, and post-incident review.