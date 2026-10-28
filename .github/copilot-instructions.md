## Repository guidance

- Treat `IMPLEMENTATION_GUIDE.md` as the product and architecture reference; keep `docs/IMPLEMENTATION_GUIDE.md` synchronized when changing it.
- Keep HTTP handlers thin. Put validation at the route boundary, authorization and business rules in services, and parameterized persistence in repositories.
- Preserve PostgreSQL as the source of truth for bookings and outbox work. Keep booking, payment, audit, and idempotency changes transactionally consistent.
- Never log credentials, access tokens, payment secrets, or protected health information. Use the existing encryption, error, logging, metrics, and tracing helpers.
- Add or update focused tests for behavior changes. For database behavior, use the existing integration-test setup and migrations.
- Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` for application changes. Run `npm run openapi:generate` when routes or schemas change.
- Do not commit generated secrets, environment files, deployment credentials, or unverified production measurements.
