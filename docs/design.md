# Design Docs

This document summarizes the major implementation choices and links to the
accepted architecture decision records. It describes the intended design;
deployment-dependent guarantees still require validation in the target
environment.

## Service and module boundaries

The backend is a modular monolith. The API and background worker are separate
processes from the same Node.js application, while domain code is organized
under `src/modules/`. Each module follows route, controller, service, and
repository boundaries:

- Routes apply authentication, authorization, and request validation.
- Controllers translate HTTP input and output without owning business rules.
- Services enforce business policies and coordinate operations.
- Repositories perform parameterized PostgreSQL access.

Shared services and infrastructure are injected through the application
container. Cross-domain operations should use service interfaces rather than
reaching into another module's repository. This structure provides clear
ownership without introducing network calls for operations that must commit
atomically.

See [ADR 0001: Modular Monolith with a Separate Worker](adr/0001-modular-monolith.md).

## PostgreSQL as the consistency boundary

PostgreSQL is the source of truth for bookings, payments, clinical records,
audit events, idempotency records, and pending outbox work. The schema and
migrations enforce business invariants such as uniqueness, valid state
relationships, and slot allocation. Redis is used for queues, rate limits, and
ephemeral cache behavior; it is not authoritative for whether a booking exists
or a slot is available.

Critical writes use a database transaction for all coupled changes. A booking
operation, for example, coordinates the slot hold, consultation, payment
record, audit event, idempotent response, and outbox event. If any required
write fails, the transaction is rolled back. Long-running provider requests
must not be made while holding these transactions open.

## Booking and consultation lifecycle

Booking is protected against concurrent requests by conditional database
updates, row locks, unique constraints, idempotency, and consultation state
transitions. The client supplies an idempotency key on critical writes so a
retry can return the original result rather than creating duplicate work.

The typical lifecycle is:

1. A patient requests a future availability slot.
2. The API validates ownership and business constraints, then reserves the
   slot and persists the pending consultation and payment state.
3. The outbox records the intent to request payment processing.
4. A worker calls the configured payment adapter outside the request
   transaction.
5. A timestamped, signed payment webhook is verified and deduplicated.
6. A valid result updates payment and consultation state transactionally.
7. Expiry, refund, and notification work runs asynchronously where applicable.

The consultation state machine is the authority for legal transitions;
handlers must not bypass it with direct status updates. Unpaid holds expire
according to the configured business rule. Payment outcomes that arrive late
must follow the compensation/refund path instead of reviving an invalid
booking.

## Transactional outbox and workers

The transactional outbox solves the dual-write problem between PostgreSQL and
Redis or external providers. A business transaction writes an outbox event at
the same time as its domain changes. A relay claims pending events in bounded
batches and enqueues stable job identifiers. Workers retry transient failures
with bounded backoff; consumers and external calls must be idempotent because
delivery is at least once.

Redis outages may delay processing but do not erase the durable event. Relay
age, retry counts, queue depth, and dead-letter work need monitoring and
operational response. Unknown event types and persistent processor failures
must remain visible for investigation, not be silently discarded.

See [ADR 0002: Transactional Outbox for Asynchronous Work](adr/0002-outbox.md).

## Data protection and audit

Sensitive fields are encrypted before persistence using versioned AES-256-GCM
keys and associated data bound to the owning row and field. KMS-backed
envelope encryption is intended for cloud deployments; local development can
use environment-provided keys. Old key versions must remain available until
records and recoverable backups have been migrated and verified. Follow the
[key-rotation runbook](runbooks/key-rotation.md).

Audit events are written in the same transaction as the business change when
possible. The audit table is partitioned by month, database triggers reject
updates and deletes, and entries are linked into per-shard SHA-256 hash chains.
The admin verification endpoint checks chain continuity. Database
administrators can bypass application-level controls, so production operation
also depends on restricted database privileges, monitoring, and protected
backups. Review the [security checklist](security-checklist.md) and [threat
model](threat-model.md) for the corresponding control assumptions.

## API contract and compatibility

Routes are versioned beneath `/api/v1`. Request validation is performed at the
route boundary using Zod schemas. The OpenAPI document is generated from the
route registry. It includes reusable request-body schemas plus validated path,
query, and required idempotency-header parameters. Update it with
`npm run openapi:generate` whenever route or schema behavior changes. The
runtime response descriptions are documented per operation; response payload
models should be added alongside route schemas as they are defined. Database
migrations must support rolling deployment:
prefer expand, migrate, and contract steps so old and new application versions
can safely overlap during a release.

The full product and implementation reference remains
[IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md). This document is a short
decision-oriented overview, not a replacement for detailed API, data model, or
operational specifications.
