# Amrutam Telemedicine System

Amrutam is a telemedicine application with a TypeScript/Express API, PostgreSQL
database, Redis-backed background processing, and an optional React web client.
This README covers local setup and common development commands. Architecture,
security, design decisions, and infrastructure references are in the
[documentation directory](docs/README.md).

## Prerequisites

- Node.js 20.x and npm 10 or newer
- Docker Desktop with Docker Compose v2 (recommended local setup)
- Git

Optional: Terraform for validating the AWS reference infrastructure, and
Postman for running the provided API collection.

## Start the backend locally with Docker

From the repository root, in PowerShell:

```powershell
npm ci
Copy-Item .env.example .env
```

Review `.env` before starting. Its values are for local development only.
Replace the example JWT, webhook, and metrics credentials with random values
for your environment; never put production secrets in this file. Keep `.env`
local and untracked.

Start PostgreSQL, Redis, run migrations, and launch the API, worker, and local
observability services:

```powershell
npm run docker:up
```

In another terminal, seed disposable demo users, doctors, and sample slots:

```powershell
npm run seed
```

The seed command generates temporary passwords and prints them to that
terminal. Use those credentials only in your local environment. The local
payment provider is a development mock and must not be used for real payments.

Local services:

| Service | Address |
|---|---|
| Backend API | `http://localhost:3000/api/v1` |
| Swagger UI | `http://localhost:3000/docs` |
| OpenAPI JSON | `http://localhost:3000/openapi.json` |
| Frontend (when started below) | `http://localhost:5173` |
| Grafana | `http://localhost:3001` |
| Prometheus | `http://localhost:9090` |
| Jaeger | `http://localhost:16686` |

Stop the stack with:

```powershell
docker compose -f infra/docker/docker-compose.yml down
```

Add `-v` only when you intend to delete local database and observability
volumes.

## Start the frontend

With the backend running, use a second terminal:

```powershell
Set-Location FRONTEND
npm ci
npm run dev
```

Open `http://localhost:5173`. The development API URL defaults to
`http://localhost:3000`. If you change the frontend origin, add it to
`CORS_ORIGINS` in `.env` and restart the backend. Build and type-check the
frontend with `npm run build` or `npm run typecheck` from `FRONTEND`.

The frontend includes patient, doctor, and admin workflows. Use only local
accounts and credentials in the UI; do not enter production secrets into the
development payment-webhook tester.

## Run without Docker Compose

You can run the API and worker on the host if PostgreSQL 16 and Redis 7 are
available locally. First install backend dependencies and configure `.env`:

```powershell
npm ci
Copy-Item .env.example .env
```

Start PostgreSQL and Redis separately, then run migrations and the seed script:

```powershell
npm run migrate:up
npm run seed
```

Run the API and worker in separate terminals:

```powershell
npm run dev
npm run dev:worker
```

Create an administrator account with `npm run admin:create`; administrators
cannot self-register. The command prompts for credentials without echoing the
password.

## Tests and development commands

Run these commands from the repository root:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

Integration tests use Testcontainers and require a working Docker daemon:

```powershell
npm run test:integration
```

Regenerate the API specification after changing route schemas or endpoints:

```powershell
npm run openapi:generate
```

The generated contract is in [`docs/openapi.yaml`](docs/openapi.yaml). A
Postman collection and local environment are available in `postman/`; import
both JSON files, select the local environment, and provide local test
credentials. Regenerate the collection with `npm run postman:generate`.

## Repository layout

| Path | Contents |
|---|---|
| `src/` | Backend API, modules, shared services, and worker |
| `migrations/` | PostgreSQL schema migrations |
| `tests/` | Unit and integration tests |
| `FRONTEND/` | React/Vite web client |
| `postman/` | API collection and local environment |
| `infra/docker/` | Local development services |
| `infra/k8s/` | Kubernetes manifests and overlays |
| `infra/terraform/` | AWS ECS reference infrastructure |
| `docs/` | Architecture, design, security, API, and operational material |

## Documentation

- [Architecture overview](docs/README.md)
- [Design Docs](docs/design.md)
- [Infrastructure as Code](docs/infrastructure-as-code.md)
- [Security checklist](docs/security-checklist.md)
- [Threat model](docs/threat-model.md)
- [Detailed implementation guide](docs/IMPLEMENTATION_GUIDE.md)
- [Runbooks](docs/runbooks/)
- [Architecture decision records](docs/adr/)
