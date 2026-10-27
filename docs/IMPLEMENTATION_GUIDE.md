# Amrutam Telemedicine Backend — Implementation Guide

> **Single source of truth for building the system.** Written so it can be handed to GitHub Copilot (or any engineer) and implemented section by section.
> Stack: **Node.js 20 · Express · TypeScript · PostgreSQL 16 · Redis 7 · REST + OpenAPI 3.1**

## Table of contents

0. [How to use this document with Copilot](#0-how-to-use-this-document-with-copilot)
1. [Scope, requirements & capacity math](#1-scope-requirements--capacity-math)
2. [Tech stack & key decisions](#2-tech-stack--key-decisions)
3. [High-level architecture & data flow](#3-high-level-architecture--data-flow)
4. [Project structure](#4-project-structure)
5. [Configuration (env vars)](#5-configuration-env-vars)
6. [Database design](#6-database-design)
7. [Auth, users, roles, RBAC](#7-auth-users-roles-rbac)
8. [REST API specification](#8-rest-api-specification)
9. [Core flows: booking, sagas, state machines](#9-core-flows-booking-sagas-state-machines)
10. [Idempotency](#10-idempotency)
11. [Concurrency, caching, transactions](#11-concurrency-caching-transactions)
12. [Retry, backoff, circuit breakers](#12-retry-backoff-circuit-breakers)
13. [Async jobs & scheduler](#13-async-jobs--scheduler)
14. [Security: OWASP, encryption, threat model, checklist](#14-security)
15. [Compliance & audit trail](#15-compliance--audit-trail)
16. [Observability](#16-observability)
17. [Testing strategy](#17-testing-strategy)
18. [Docker, CI/CD, infrastructure as code](#18-docker-cicd-infrastructure-as-code)
19. [Backup, DR & availability](#19-backup-dr--availability)
20. [Implementation roadmap & Copilot prompts](#20-implementation-roadmap--copilot-prompts)
21. [Demo video script & submission checklist](#21-demo-video-script--submission-checklist)
22. [Appendices](#22-appendices)

---

## 0. How to use this document with Copilot

1. Create the repo, then copy **Appendix A** into `.github/copilot-instructions.md`. Copilot reads that file automatically on every request, so it keeps conventions consistent.
2. Put this guide at `docs/IMPLEMENTATION_GUIDE.md` and keep it open or `#file`-referenced in Copilot Chat.
3. Work **phase by phase** using the prompts in [Section 20](#20-implementation-roadmap--copilot-prompts). Do not ask Copilot to build everything at once. One module per prompt, tests in the same prompt.
4. After each phase run `npm run lint && npm run typecheck && npm test`. Commit only when green.

> **Assignment fail-conditions:** missing critical security or missing idempotency fails the whole submission. Sections 10 and 14 are therefore non-negotiable.

---

## 1. Scope, requirements & capacity math

### 1.1 Functional scope (from the assignment)

| # | Capability | Where |
|---|---|---|
| 1 | User lifecycle: register, login, MFA, roles, status | §7, §8.1–8.2 |
| 2 | Doctor availability and booking | §8.4–8.5, §9 |
| 3 | Consultation lifecycle and prescriptions | §8.5–8.6, §9 |
| 4 | Search and filtering | §8.3 |
| 5 | Compliance and audit trails | §15 |
| 6 | Admin analytics | §8.8 |

### 1.2 Non-functional requirements

| Requirement | Target | Primary mechanism |
|---|---|---|
| Scale | 100k consultations/day | Stateless API pods, partitioning, caching, async workers |
| Read latency | p95 < 200 ms | Redis cache-aside, covering indexes, keyset pagination, read replica |
| Write latency | p95 < 500 ms | Short DB transactions; **no third-party calls on the request path** (outbox + worker) |
| Availability | 99.95 % (≈ 21.6 min downtime / 30 days) | Multi-AZ, ≥3 pods, HPA, PDB, health probes, graceful shutdown, circuit breakers |
| Security | Encryption, MFA, RBAC | §14 |
| Observability | Metrics, logs, traces | §16 |
| Delivery | CI/CD, containerised | §18 |

### 1.3 Capacity estimate (use this in the architecture doc)

```
Consultations/day                     100,000
Average                               100,000 / 86,400 ≈ 1.2 bookings/s
Peak factor (evening spike)           ×10  → ~12 bookings/s
DB writes per booking lifecycle       ≈ 8  (slot hold, consultation, payment, webhook, 3 status changes, audit)
Peak DB writes                        ~100 writes/s     → trivial for one PG primary
Reads per consultation                ≈ 30 (search, profile, availability, polling)
Peak reads                            ~350 req/s        → 3–4 API pods + cache; ≥80 % cache hit target
Rows/year                             consultations 36.5 M; audit_logs ≈ 400 M → PARTITION audit_logs
Storage/year (rough)                  consultations ~40 GB, audit ~250 GB
```

Design headroom: **3× peak** (≈ 1,000 read rps, 300 write rps). The k6 load test in §17 verifies this.

---

## 2. Tech stack & key decisions

| Concern | Choice | Why |
|---|---|---|
| Runtime / framework | Node 20, Express 4, TypeScript (strict) | Required by the team |
| DB access | `pg` + **Kysely** (type-safe query builder) | Raw-SQL control for `FOR UPDATE`, exclusion constraints, partitions, no ORM magic |
| Migrations | `node-pg-migrate` (plain SQL up/down) | Partitioning and exclusion constraints need hand-written SQL |
| Cache / queues | Redis 7, `ioredis`, **BullMQ** | Cache, rate limit, job queue in one dependency |
| Validation | **zod** | One schema → runtime validation, TS types, **and** OpenAPI |
| OpenAPI | `@asteasolutions/zod-to-openapi` + `swagger-ui-express` | Spec generated from code, cannot drift |
| DI | **awilix** (explicit container, request scope) | No decorators; easy to mock in tests |
| Auth | `jsonwebtoken` (HS256 key ring), **argon2id** (`argon2`), TOTP via `otplib` | See §7 |
| Security middleware | `helmet`, `cors`, `hpp`, `express-rate-limit` + `rate-limit-redis` | OWASP baseline |
| Logging | `pino` + `pino-http` | Fast JSON logs, redaction |
| Metrics / traces | `prom-client`, OpenTelemetry SDK (OTLP) | Standard, vendor neutral |
| Resilience | `opossum` (circuit breaker), custom `retry()` helper | §12 |
| Tests | Jest, ts-jest, Supertest, Testcontainers, k6 | §17 |
| Quality | ESLint (typescript-eslint, security plugin), Prettier, Husky + lint-staged | |
| Process types | `api` and `worker` (same image, different command) | Independent scaling |

**Architecture style:** *modular monolith.* One deployable, strict module boundaries (each module exposes only a `service` interface; no cross-module repository access). This hits "modular services with DI" without microservice overhead. Modules can be split later because they communicate via service interfaces plus outbox events.

---

## 3. High-level architecture & data flow

```mermaid
flowchart LR
  subgraph Clients
    WEB[Web / Mobile apps]
    PSP[Payment provider webhooks]
  end
  WEB --> WAF[WAF + TLS termination + Load balancer]
  PSP --> WAF
  WAF --> API1[API pod 1]
  WAF --> API2[API pod 2]
  WAF --> APIN[API pod N]

  subgraph Data
    PGW[(PostgreSQL primary)]
    PGR[(Read replica)]
    RDS[(Redis: cache, rate-limit, BullMQ)]
  end

  API1 & API2 & APIN -->|writes + outbox, same txn| PGW
  API1 & API2 & APIN -->|search / reads| PGR
  API1 & API2 & APIN --> RDS
  PGW -. streaming replication .-> PGR

  subgraph Workers
    WRK[Worker pods: outbox relay, payment, notifications, expiry, analytics, re-encrypt]
    SCH[Scheduler: BullMQ repeatable jobs]
  end
  WRK --> PGW
  WRK --> RDS
  WRK --> GW[Payment gateway]
  WRK --> MAIL[Email / SMS provider]

  subgraph Observability
    OTEL[OTel collector] --> PROM[Prometheus] --> GRAF[Grafana]
    OTEL --> JAEG[Jaeger / Tempo]
    LOGS[pino JSON logs] --> LOKI[Loki]
  end
  API1 & WRK -.-> OTEL
```

### Data flow summary

1. **Request** → WAF → API pod. Middleware order: `requestId` → `helmet/cors` → `rate-limit` → `body-parser (100kb)` → `auth (JWT)` → `rbac` → `zod validation` → `idempotency (writes)` → controller → service → repository.
2. **Reads** hit Redis first (cache-aside); on miss they go to the **read replica** (search, listings) or primary (read-your-writes, e.g. `GET /consultations/:id` right after booking).
3. **Writes** run in **one short DB transaction** that includes: business rows + `audit_logs` row + `outbox_events` row. Nothing external is called inside the request.
4. **Workers** drain the outbox (`SELECT … FOR UPDATE SKIP LOCKED`), call the payment gateway / email, and write results back. This keeps write latency < 500 ms and survives gateway outages.
5. **Webhooks** from the payment provider are verified (HMAC), deduplicated via `payment_events.provider_event_id`, then advance the booking saga.

### Module boundaries

| Module | Owns tables | Exposes (service) |
|---|---|---|
| `auth` | refresh_tokens, mfa_backup_codes | register, login, mfa, refresh, logout |
| `users` | users, profiles | getMe, updateProfile, admin user mgmt |
| `doctors` | doctors | upsertProfile, search, getById, verify |
| `availability` | availability_slots | createSlots, listSlots, holdSlot, releaseSlot, confirmSlot |
| `consultations` | consultations | book, cancel, start, complete, list, get |
| `prescriptions` | prescriptions | issue, listByConsultation, get |
| `payments` | payments, payment_events | createIntent, handleWebhook, refund |
| `audit` | audit_logs | record(tx, entry), verifyChain, query |
| `analytics` | analytics_daily | overview, timeseries, topDoctors, rollup |
| `idempotency` | idempotency_keys | withIdempotency |
| `outbox` | outbox_events | enqueue(tx, event), relay |
| `notifications` | — | send (worker side) |

Rule: a module may call **another module's service**, never its repository or tables.

---

## 4. Project structure

```
amrutam-backend/
├── .github/
│   ├── copilot-instructions.md          # Appendix A
│   ├── dependabot.yml
│   └── workflows/
│       ├── ci.yml                       # lint, typecheck, test, build, scan
│       ├── codeql.yml
│       └── deploy.yml                   # staging auto, prod manual approval
├── docs/
│   ├── IMPLEMENTATION_GUIDE.md          # this file
│   ├── architecture.md                  # 2–4 page deliverable (derive from §3, §6, §9, §11, §19)
│   ├── threat-model.md                  # derive from §14.5–14.7
│   ├── security-checklist.md            # §14.8
│   ├── openapi.yaml                     # generated, committed, CI-checked
│   ├── runbooks/                        # restore.md, failover.md, key-rotation.md
│   └── adr/                             # 0001-modular-monolith.md, 0002-outbox.md, ...
├── infra/
│   ├── docker/
│   │   ├── Dockerfile
│   │   └── docker-compose.yml
│   ├── observability/
│   │   ├── prometheus.yml
│   │   ├── alerts.yml
│   │   ├── otel-collector.yaml
│   │   └── grafana/{provisioning,dashboards}/
│   ├── k8s/                             # kustomize: base + overlays/{staging,prod}
│   │   └── base/{deployment-api,deployment-worker,service,ingress,hpa,pdb,configmap,networkpolicy,cronjob-backup}.yaml
│   └── terraform/                       # AWS: vpc, rds, elasticache, ecs/eks, alb, secrets, s3, kms
├── migrations/                          # node-pg-migrate SQL files (numbered)
│   ├── 001_extensions_and_enums.sql
│   ├── 002_users_profiles.sql
│   ├── 003_doctors_slots.sql
│   ├── 004_consultations_payments.sql
│   ├── 005_prescriptions.sql
│   ├── 006_audit_logs_partitioned.sql
│   ├── 007_idempotency_outbox_tokens.sql
│   └── 008_analytics_indexes.sql
├── scripts/
│   ├── seed.ts                          # demo data
│   ├── create-admin.ts                  # admins are never self-registered
│   ├── generate-openapi.ts
│   └── k6/{search.js, booking.js}
├── src/
│   ├── server.ts                        # api entrypoint (listen, graceful shutdown)
│   ├── worker.ts                        # worker entrypoint (BullMQ processors + scheduler)
│   ├── app.ts                           # express app factory (testable, no listen)
│   ├── container.ts                     # awilix registrations
│   ├── config/
│   │   ├── env.ts                       # zod-validated env, fail fast
│   │   └── constants.ts
│   ├── common/
│   │   ├── errors/                      # AppError, error codes, problem+json mapper
│   │   ├── middleware/                  # requestId, auth, rbac, validate, rateLimit, idempotency, errorHandler, notFound
│   │   ├── crypto/                      # encryption.service.ts, key-provider.ts, hash.ts
│   │   ├── db/                          # kysely.ts, transaction.ts (withTx + retry), types.ts
│   │   ├── cache/                       # redis.ts, cache.service.ts (cache-aside + single-flight)
│   │   ├── resilience/                  # retry.ts, circuit-breaker.ts
│   │   ├── observability/               # logger.ts, metrics.ts, tracing.ts
│   │   └── utils/                       # pagination.ts (keyset), time.ts, clock.ts
│   ├── modules/
│   │   ├── auth/            {auth.routes.ts, auth.controller.ts, auth.service.ts, auth.repository.ts, auth.schemas.ts, token.service.ts, mfa.service.ts}
│   │   ├── users/           {…same shape…}
│   │   ├── doctors/
│   │   ├── availability/
│   │   ├── consultations/   {…, consultation.state-machine.ts, booking.saga.ts}
│   │   ├── prescriptions/
│   │   ├── payments/        {…, gateway/{payment-gateway.ts, mock-gateway.ts}, webhook.controller.ts}
│   │   ├── audit/           {audit.service.ts, audit.repository.ts, audit.routes.ts, hash-chain.ts}
│   │   ├── analytics/
│   │   ├── idempotency/
│   │   ├── outbox/          {outbox.service.ts, outbox.relay.ts}
│   │   ├── notifications/
│   │   └── health/          {health.routes.ts}
│   ├── jobs/
│   │   ├── queues.ts
│   │   ├── processors/      {payment-intent, refund, notification, slot-expiry, consultation-expiry, analytics-rollup, reencrypt, audit-partition, idempotency-cleanup, outbox-relay}.processor.ts
│   │   └── scheduler.ts     # repeatable job registration
│   └── openapi/             {registry.ts, build-document.ts}
├── tests/
│   ├── unit/                # pure logic: state machine, crypto, hash chain, retry, pagination
│   ├── integration/         # supertest + testcontainers (real PG + Redis)
│   ├── e2e/                 # full journey
│   ├── security/            # RBAC matrix, authz, injection, rate limits
│   ├── concurrency/         # double-booking race, idempotency race
│   └── helpers/             # factories, test containers, auth helpers
├── .env.example
├── .eslintrc.cjs  .prettierrc  .nvmrc  .dockerignore  .gitignore  .gitleaks.toml
├── jest.config.ts  tsconfig.json  tsconfig.build.json
├── package.json
└── README.md
```

**Per-module file contract** (every module follows it, so Copilot generates uniform code):

| File | Responsibility | Must not |
|---|---|---|
| `*.routes.ts` | Express router: path → middleware chain → controller; registers OpenAPI path | contain logic |
| `*.controller.ts` | Parse validated input, call service, shape HTTP response | touch DB |
| `*.service.ts` | Business rules, transactions, audit + outbox writes | import `express` |
| `*.repository.ts` | Kysely queries only, accepts an optional `trx` | contain business rules |
| `*.schemas.ts` | zod schemas (request/response) + inferred types + OpenAPI metadata | |

---

## 5. Configuration (env vars)

All config is read **once** in `src/config/env.ts`, validated with zod; the process **exits on invalid config**. Secrets come only from env vars (dev: `.env`; prod: AWS Secrets Manager / K8s Secrets injected as env). `.env` is git-ignored; `.env.example` is committed with fake values.

```dotenv
# --- app ---
NODE_ENV=development                 # development | test | production
PORT=3000
LOG_LEVEL=info
CORS_ORIGINS=http://localhost:5173   # comma separated allow-list, never "*" in prod
TRUST_PROXY=1

# --- database ---
DATABASE_URL=postgres://amrutam:amrutam@localhost:5432/amrutam
DATABASE_READ_URL=                   # optional replica; falls back to DATABASE_URL
DB_POOL_MAX=20
DB_STATEMENT_TIMEOUT_MS=5000
DB_IDLE_IN_TX_TIMEOUT_MS=10000

# --- redis ---
REDIS_URL=redis://localhost:6379

# --- auth ---
JWT_KEYS={"k1":"<base64-32-bytes>"}  # key ring: kid -> secret
JWT_ACTIVE_KID=k1
JWT_ACCESS_TTL_SEC=900               # 15 min
REFRESH_TTL_DAYS=14
MFA_TOKEN_TTL_SEC=300
MFA_ISSUER=Amrutam
LOGIN_MAX_FAILURES=5
LOGIN_LOCK_MINUTES=15

# --- field encryption (envelope) ---
ENC_KEYS={"1":"<base64-32-bytes>"}   # version -> AES-256 key (dev). Prod: KMS_KEY_ID instead
ENC_ACTIVE_VERSION=1
KMS_KEY_ID=                          # prod only; when set, KmsKeyProvider is used

# --- rate limiting ---
RL_GLOBAL_PER_MIN=120
RL_AUTH_PER_MIN=10
RL_BOOKING_PER_MIN=20

# --- business rules ---
SLOT_HOLD_MINUTES=10
MIN_BOOKING_LEAD_MINUTES=15
CANCEL_FULL_REFUND_HOURS=24
IDEMPOTENCY_TTL_HOURS=24

# --- payments ---
PAYMENT_PROVIDER=mock                # mock | razorpay | stripe
PAYMENT_WEBHOOK_SECRET=<random-32-bytes-hex>
PAYMENT_API_KEY=
PAYMENT_TIMEOUT_MS=3000

# --- observability ---
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=amrutam-api
METRICS_TOKEN=<random>               # bearer required for /metrics if exposed beyond the cluster
```

`.gitleaks.toml` + a pre-commit hook must block committing anything matching these secret names.

---
## 6. Database design

### 6.1 ER diagram

```mermaid
erDiagram
  users ||--o| profiles : "1:1"
  users ||--o| doctors : "1:1 (role=DOCTOR)"
  users ||--o{ refresh_tokens : owns
  users ||--o{ mfa_backup_codes : owns
  users ||--o{ consultations : "books (patient_id)"
  doctors ||--o{ availability_slots : offers
  doctors ||--o{ consultations : "serves (doctor_id)"
  availability_slots ||--o| consultations : "reserved by"
  consultations ||--o{ prescriptions : "versions"
  consultations ||--o{ payments : "paid by"
  payments ||--o{ payment_events : "provider events"
  users ||--o{ audit_logs : "actor"
  users ||--o{ idempotency_keys : scopes

  users {
    uuid id PK
    citext email UK
    user_role role
    user_status status
    bool mfa_enabled
  }
  doctors {
    uuid id PK
    uuid user_id FK
    verification_status verification_status
    text_array specializations
    int fee_minor
  }
  availability_slots {
    uuid id PK
    uuid doctor_id FK
    timestamptz start_time
    slot_status status
  }
  consultations {
    uuid id PK
    uuid patient_id FK
    uuid doctor_id FK
    uuid slot_id FK
    consultation_status status
  }
  prescriptions {
    uuid id PK
    uuid consultation_id FK
    int version
    text payload_enc
  }
  payments {
    uuid id PK
    uuid consultation_id FK
    payment_status status
    int amount_minor
  }
  audit_logs {
    uuid id
    timestamptz created_at
    text action
    text hash
  }
```

### 6.2 Conventions

* PKs: `uuid` (`gen_random_uuid()`); never expose sequential ids.
* All timestamps `timestamptz`, stored in **UTC**; clients convert. Money: **integer minor units** (paise) plus `currency` (`INR`).
* Every mutable table: `created_at`, `updated_at` (trigger `set_updated_at()`), and `version int` for optimistic locking where concurrent edits are possible.
* Soft delete only for `users` (`deleted_at`) for retention/legal reasons; clinical records are never hard-deleted.
* PHI/PII columns that are encrypted are suffixed `_enc` and hold `v{keyVersion}:{iv}:{tag}:{ciphertext}` (see §14.3).
* App DB role `app_rw` has no `DDL`, no `DELETE` on `audit_logs`/`prescriptions`; migrations run with a separate `app_migrator` role.

### 6.3 DDL (put in `migrations/`, split as listed in §4)

```sql
-- 001_extensions_and_enums.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- exclusion constraint on slots
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy doctor-name search

CREATE TYPE user_role            AS ENUM ('PATIENT','DOCTOR','ADMIN');
CREATE TYPE user_status          AS ENUM ('PENDING_VERIFICATION','ACTIVE','SUSPENDED','DELETED');
CREATE TYPE verification_status  AS ENUM ('PENDING','VERIFIED','REJECTED');
CREATE TYPE slot_status          AS ENUM ('AVAILABLE','HELD','BOOKED','CANCELLED');
CREATE TYPE consultation_mode    AS ENUM ('VIDEO','AUDIO','CHAT');
CREATE TYPE consultation_status  AS ENUM ('PENDING_PAYMENT','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED','NO_SHOW');
CREATE TYPE payment_status       AS ENUM ('INITIATED','PENDING','SUCCEEDED','FAILED','REFUNDED','PARTIALLY_REFUNDED');

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;
```

```sql
-- 002_users_profiles.sql
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  phone              text,
  password_hash      text NOT NULL,                       -- argon2id
  role               user_role NOT NULL DEFAULT 'PATIENT',
  status             user_status NOT NULL DEFAULT 'ACTIVE',
  mfa_enabled        boolean NOT NULL DEFAULT false,
  mfa_secret_enc     text,                                -- TOTP secret, encrypted
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  tokens_valid_after timestamptz NOT NULL DEFAULT now(),  -- bump to revoke all access tokens
  version            int NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX idx_users_role_status ON users(role, status) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE profiles (
  user_id               uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name             text NOT NULL,
  gender                text CHECK (gender IN ('MALE','FEMALE','OTHER','UNDISCLOSED')),
  date_of_birth_enc     text,                              -- PII, encrypted
  address_enc           text,                              -- PII, encrypted
  emergency_contact_enc text,                              -- PII, encrypted
  locale                text NOT NULL DEFAULT 'en-IN',
  timezone              text NOT NULL DEFAULT 'Asia/Kolkata',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

```sql
-- 003_doctors_slots.sql
CREATE TABLE doctors (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL UNIQUE REFERENCES users(id),
  display_name          text NOT NULL,                      -- denormalised for search
  license_number        text NOT NULL UNIQUE,
  verification_status   verification_status NOT NULL DEFAULT 'PENDING',
  verified_by           uuid REFERENCES users(id),
  verified_at           timestamptz,
  specializations       text[] NOT NULL DEFAULT '{}',       -- slugs e.g. {'ayurveda','general-medicine'}
  languages             text[] NOT NULL DEFAULT '{}',       -- ISO codes {'en','hi'}
  bio                   text,
  years_experience      int CHECK (years_experience BETWEEN 0 AND 70),
  consultation_fee_minor int NOT NULL CHECK (consultation_fee_minor >= 0),
  currency              char(3) NOT NULL DEFAULT 'INR',
  modes                 consultation_mode[] NOT NULL DEFAULT '{VIDEO}',
  rating_avg            numeric(3,2) NOT NULL DEFAULT 0,
  rating_count          int NOT NULL DEFAULT 0,
  is_accepting          boolean NOT NULL DEFAULT true,
  search_vector         tsvector,                           -- maintained by trigger below
  version               int NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_doctors_search    ON doctors USING gin (search_vector);
CREATE INDEX idx_doctors_name_trgm ON doctors USING gin (display_name gin_trgm_ops);
CREATE INDEX idx_doctors_spec      ON doctors USING gin (specializations);
CREATE INDEX idx_doctors_lang      ON doctors USING gin (languages);
CREATE INDEX idx_doctors_listing   ON doctors (rating_avg DESC, id) WHERE verification_status='VERIFIED' AND is_accepting;
CREATE INDEX idx_doctors_fee       ON doctors (consultation_fee_minor, id) WHERE verification_status='VERIFIED' AND is_accepting;
CREATE TRIGGER trg_doctors_updated BEFORE UPDATE ON doctors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION doctors_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.display_name,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(NEW.specializations,' '),'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.bio,'')), 'C');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_doctors_sv BEFORE INSERT OR UPDATE OF display_name, specializations, bio
  ON doctors FOR EACH ROW EXECUTE FUNCTION doctors_search_vector_update();

CREATE TABLE availability_slots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id   uuid NOT NULL REFERENCES doctors(id),
  start_time  timestamptz NOT NULL,
  end_time    timestamptz NOT NULL,
  status      slot_status NOT NULL DEFAULT 'AVAILABLE',
  held_by     uuid REFERENCES users(id),
  held_until  timestamptz,
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slot_time_valid CHECK (end_time > start_time AND end_time - start_time <= interval '4 hours'),
  -- DB-level guarantee: a doctor can never have overlapping live slots
  CONSTRAINT slot_no_overlap EXCLUDE USING gist
    (doctor_id WITH =, tstzrange(start_time, end_time, '[)') WITH &&) WHERE (status <> 'CANCELLED')
);
CREATE INDEX idx_slots_doctor_time  ON availability_slots (doctor_id, start_time) WHERE status = 'AVAILABLE';
CREATE INDEX idx_slots_held_expiry  ON availability_slots (held_until) WHERE status = 'HELD';
CREATE TRIGGER trg_slots_updated BEFORE UPDATE ON availability_slots FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

```sql
-- 004_consultations_payments.sql
CREATE TABLE consultations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id         uuid NOT NULL REFERENCES users(id),
  doctor_id          uuid NOT NULL REFERENCES doctors(id),
  slot_id            uuid NOT NULL REFERENCES availability_slots(id),
  status             consultation_status NOT NULL DEFAULT 'PENDING_PAYMENT',
  mode               consultation_mode NOT NULL DEFAULT 'VIDEO',
  scheduled_start    timestamptz NOT NULL,              -- copied from slot (immutable snapshot)
  scheduled_end      timestamptz NOT NULL,
  fee_minor          int NOT NULL,
  currency           char(3) NOT NULL DEFAULT 'INR',
  reason_enc         text,                              -- PHI, patient-supplied complaint
  doctor_notes_enc   text,                              -- PHI
  meeting_url        text,
  expires_at         timestamptz,                       -- payment deadline while PENDING_PAYMENT
  started_at         timestamptz,
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  cancelled_by       uuid REFERENCES users(id),
  cancel_reason      text,
  version            int NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- Second line of defence against double booking: one live consultation per slot
CREATE UNIQUE INDEX uq_consultation_live_slot ON consultations (slot_id)
  WHERE status IN ('PENDING_PAYMENT','CONFIRMED','IN_PROGRESS','COMPLETED');
CREATE INDEX idx_consult_patient ON consultations (patient_id, scheduled_start DESC);
CREATE INDEX idx_consult_doctor  ON consultations (doctor_id, scheduled_start DESC);
CREATE INDEX idx_consult_expiry  ON consultations (expires_at) WHERE status = 'PENDING_PAYMENT';
CREATE INDEX idx_consult_status_time ON consultations (status, scheduled_start);
CREATE TRIGGER trg_consult_updated BEFORE UPDATE ON consultations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id      uuid NOT NULL REFERENCES consultations(id),
  patient_id           uuid NOT NULL REFERENCES users(id),
  amount_minor         int NOT NULL CHECK (amount_minor >= 0),
  refunded_minor       int NOT NULL DEFAULT 0 CHECK (refunded_minor <= amount_minor),
  currency             char(3) NOT NULL DEFAULT 'INR',
  status               payment_status NOT NULL DEFAULT 'INITIATED',
  provider             text NOT NULL,
  provider_payment_id  text UNIQUE,                     -- set when intent created
  client_secret        text,                            -- returned to client once; short-lived
  failure_reason       text,
  version              int NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_consult ON payments (consultation_id);
CREATE INDEX idx_payments_status  ON payments (status, created_at) WHERE status IN ('INITIATED','PENDING');
CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Inbox table: dedupes provider webhooks
CREATE TABLE payment_events (
  id                 bigserial PRIMARY KEY,
  provider_event_id  text NOT NULL UNIQUE,
  event_type         text NOT NULL,
  payload            jsonb NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz
);
```

```sql
-- 005_prescriptions.sql
-- Immutable, versioned. A correction = new version (old one marked REVOKED), never UPDATE of content.
CREATE TABLE prescriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id  uuid NOT NULL REFERENCES consultations(id),
  doctor_id        uuid NOT NULL REFERENCES doctors(id),
  patient_id       uuid NOT NULL REFERENCES users(id),
  version          int  NOT NULL DEFAULT 1,
  status           text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','REVOKED')),
  payload_enc      text NOT NULL,        -- encrypted JSON: {diagnosis, medications[], advice, followUpDate}
  issued_at        timestamptz NOT NULL DEFAULT now(),
  valid_until      timestamptz,
  pdf_object_key   text,                 -- generated asynchronously
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (consultation_id, version)
);
CREATE INDEX idx_rx_patient ON prescriptions (patient_id, issued_at DESC);
CREATE INDEX idx_rx_doctor  ON prescriptions (doctor_id, issued_at DESC);
```

```sql
-- 006_audit_logs_partitioned.sql
-- Append-only, hash-chained, partitioned monthly by created_at.
CREATE TABLE audit_logs (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  chain_shard   smallint NOT NULL,           -- hash(resource_id) % 16 → 16 independent chains (avoids a global lock)
  seq           bigint NOT NULL,             -- per-shard sequence
  actor_id      uuid,                        -- null for system/anonymous
  actor_role    text,
  action        text NOT NULL,               -- e.g. 'consultation.book', 'prescription.read'
  resource_type text NOT NULL,
  resource_id   text,
  outcome       text NOT NULL CHECK (outcome IN ('SUCCESS','DENIED','FAILURE')),
  ip            inet,
  user_agent    text,
  request_id    text,
  metadata      jsonb NOT NULL DEFAULT '{}', -- NO PHI values: ids and field names only
  prev_hash     text NOT NULL,
  hash          text NOT NULL,               -- sha256(prev_hash || canonical_json(row without hash))
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_audit_actor    ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX idx_audit_action   ON audit_logs (action, created_at DESC);
CREATE UNIQUE INDEX uq_audit_shard_seq ON audit_logs (chain_shard, seq, created_at);

-- Tamper resistance: block UPDATE/DELETE/TRUNCATE for everyone, including the app role
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER trg_audit_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

-- Partition management: a function creates next 3 months' partitions; the `audit-partition` job calls it daily.
CREATE OR REPLACE FUNCTION audit_create_partition(month_start date) RETURNS void AS $$
DECLARE part text := 'audit_logs_' || to_char(month_start,'YYYY_MM');
BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
                 part, month_start, (month_start + interval '1 month')::date);
END $$ LANGUAGE plpgsql;
SELECT audit_create_partition(date_trunc('month', now())::date + (i || ' month')::interval) FROM generate_series(0,3) i;

-- Per-shard chain head, locked with SELECT ... FOR UPDATE inside the business txn
CREATE TABLE audit_chain_heads (
  chain_shard smallint PRIMARY KEY,
  last_seq    bigint NOT NULL DEFAULT 0,
  last_hash   text   NOT NULL DEFAULT repeat('0',64)
);
INSERT INTO audit_chain_heads (chain_shard) SELECT generate_series(0,15);
```

```sql
-- 007_idempotency_outbox_tokens.sql
CREATE TABLE idempotency_keys (
  user_id          uuid NOT NULL,
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  request_hash     text NOT NULL,                -- sha256(method|path|canonical body)
  method           text NOT NULL,
  path             text NOT NULL,
  response_status  int,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idx_idem_expiry ON idempotency_keys (expires_at);

CREATE TABLE outbox_events (
  id              bigserial PRIMARY KEY,
  aggregate_type  text NOT NULL,                 -- 'consultation','payment',...
  aggregate_id    text NOT NULL,
  event_type      text NOT NULL,                 -- 'payment.intent.requested','consultation.confirmed',...
  payload         jsonb NOT NULL,
  traceparent     text,                          -- propagate trace context to workers
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_pending ON outbox_events (next_attempt_at, id) WHERE published_at IS NULL;

CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id    uuid NOT NULL,                    -- rotation family; reuse of a rotated token kills the family
  token_hash   text NOT NULL UNIQUE,             -- sha256 of opaque 256-bit token
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  replaced_by  uuid,
  user_agent   text,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_rt_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_rt_family ON refresh_tokens (family_id);

CREATE TABLE mfa_backup_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,                      -- argon2id; shown once at generation
  used_at    timestamptz
);
CREATE INDEX idx_backup_user ON mfa_backup_codes (user_id) WHERE used_at IS NULL;
```

```sql
-- 008_analytics_indexes.sql
CREATE TABLE analytics_daily (
  day                date NOT NULL,
  doctor_id          uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',  -- sentinel = platform-wide totals
  consultations_total int NOT NULL DEFAULT 0,
  completed          int NOT NULL DEFAULT 0,
  cancelled          int NOT NULL DEFAULT 0,
  no_show            int NOT NULL DEFAULT 0,
  revenue_minor      bigint NOT NULL DEFAULT 0,
  refunds_minor      bigint NOT NULL DEFAULT 0,
  new_patients       int NOT NULL DEFAULT 0,
  avg_lead_hours     numeric(8,2),
  PRIMARY KEY (day, doctor_id)
);
```

### 6.4 Data partitioning strategy

| Table | Strategy | Status |
|---|---|---|
| `audit_logs` | **Range by `created_at`, monthly.** Old partitions detached → archived to S3 (Parquet) after 13 months; retained 7 years. | **Implemented** (migration 006 + `audit-partition` job) |
| `consultations` | Range by `scheduled_start`, monthly (composite PK `(id, scheduled_start)`). Hot partitions = current ± 1 month. Child FKs become app-enforced. | Documented, SQL ready, enable at > 50 M rows |
| `availability_slots` | Range by `start_time`, monthly. Partition drop = instant cleanup of past slots. | Documented, enable with consultations |
| `outbox_events`, `idempotency_keys`, `payment_events` | Not partitioned; **pruned** by scheduled jobs (published > 7 d, expired keys, processed events > 30 d). | Implemented |
| Horizontal (future) | Shard key `doctor_id` hash (Citus / app-level routing) once a single primary is the bottleneck. Not needed at 100k/day (≈100 writes/s peak). | Documented |

Why not partition consultations on day 1: partitioning forces composite PKs and weakens FKs; at 36.5 M rows/year with correct indexes a single table is fine for >1 year. Say this explicitly in the architecture doc; graders reward justified trade-offs.

### 6.5 Sample rows (for `scripts/seed.ts` and the docs)

**users**

| id | email | role | status | mfa_enabled |
|---|---|---|---|---|
| `11111111-…-0001` | admin@amrutam.test | ADMIN | ACTIVE | true |
| `11111111-…-0002` | dr.sharma@amrutam.test | DOCTOR | ACTIVE | true |
| `11111111-…-0003` | dr.iyer@amrutam.test | DOCTOR | ACTIVE | true |
| `11111111-…-0004` | asha@example.com | PATIENT | ACTIVE | false |
| `11111111-…-0005` | ravi@example.com | PATIENT | ACTIVE | false |

**doctors**

| id | user_id | display_name | verification | specializations | languages | fee_minor | rating |
|---|---|---|---|---|---|---|---|
| `22222222-…-0001` | …0002 | Dr. Meera Sharma | VERIFIED | {ayurveda,general-medicine} | {en,hi} | 50000 | 4.80 |
| `22222222-…-0002` | …0003 | Dr. Kiran Iyer | VERIFIED | {panchakarma} | {en,ta} | 80000 | 4.60 |

**availability_slots** (doctor 1, tomorrow)

| id | doctor_id | start_time (UTC) | end_time | status |
|---|---|---|---|---|
| `33333333-…-0001` | …0001 | 04:30 | 05:00 | AVAILABLE |
| `33333333-…-0002` | …0001 | 05:00 | 05:30 | HELD |
| `33333333-…-0003` | …0001 | 05:30 | 06:00 | BOOKED |

**consultations**

| id | patient | doctor | slot | status | fee_minor | expires_at |
|---|---|---|---|---|---|---|
| `44444444-…-0001` | …0004 | …0001 | …0002 | PENDING_PAYMENT | 50000 | now()+10m |
| `44444444-…-0002` | …0005 | …0001 | …0003 | CONFIRMED | 50000 | null |

**payments**

| id | consultation_id | amount_minor | status | provider | provider_payment_id |
|---|---|---|---|---|---|
| `55555555-…-0001` | …0001 | 50000 | PENDING | mock | `mock_pi_001` |
| `55555555-…-0002` | …0002 | 50000 | SUCCEEDED | mock | `mock_pi_002` |

**audit_logs** (illustrative)

| seq | actor | action | resource | outcome | prev_hash → hash |
|---|---|---|---|---|---|
| 41 | patient …0005 | `consultation.book` | consultation …0002 | SUCCESS | `a1f…` → `9c2…` |
| 42 | doctor …0002 | `prescription.issue` | prescription …0001 | SUCCESS | `9c2…` → `e07…` |
| 43 | admin …0001 | `audit.query` | audit_logs | SUCCESS | `e07…` → `4bd…` |

### 6.6 Query patterns the indexes are designed for

| Query | Index used |
|---|---|
| Doctor list sorted by rating (keyset on `(rating_avg, id)`) | `idx_doctors_listing` |
| Filter by specialization / language | GIN `idx_doctors_spec`, `idx_doctors_lang` |
| Free-text doctor search | GIN `search_vector` + trigram on name |
| "Open slots for doctor X on date D" | `idx_slots_doctor_time` (partial, AVAILABLE only) |
| "My consultations, newest first" | `idx_consult_patient` |
| Expire unpaid holds | `idx_consult_expiry`, `idx_slots_held_expiry` |
| Audit by user / by resource / by action | `idx_audit_*` (prune by partition) |

Always run `EXPLAIN (ANALYZE, BUFFERS)` on search and listing queries during development and paste one plan into the architecture doc.

---
## 7. Auth, users, roles, RBAC

### 7.1 Roles

| Role | Created by | Notes |
|---|---|---|
| `PATIENT` | self-registration | MFA optional |
| `DOCTOR` | self-registration (`role: DOCTOR` + licence) | **MFA mandatory**; invisible in search until an admin sets `VERIFIED` |
| `ADMIN` | `npm run admin:create` CLI only | **MFA mandatory**; admin endpoints additionally require `amr` to contain `otp` (step-up) |

### 7.2 User lifecycle

```
REGISTER → ACTIVE (patient) | ACTIVE+doctor.PENDING (doctor) → [admin verifies doctor]
ACTIVE ⇄ SUSPENDED (admin)            ACTIVE → DELETED (erasure request: PII anonymised, clinical records retained per law)
```

### 7.3 Credentials & tokens

| Item | Design |
|---|---|
| Password hashing | **argon2id** (m=19 MiB, t=2, p=1 — OWASP minimum). Min 12 chars, check against a small deny-list; no composition rules theatre. |
| Lockout | `LOGIN_MAX_FAILURES` (5) consecutive failures → `locked_until = now()+15m`. Generic error message; constant-time compare; same response for unknown email (user-enumeration safe). |
| Access token | JWT **HS256 with key ring** (`kid` header, `JWT_KEYS`). 15-minute TTL. Claims: `sub, role, sid (session family), amr (["pwd"] or ["pwd","otp"]), jti, iat, exp, iss, aud`. Verification accepts any key in the ring; signing uses `JWT_ACTIVE_KID` → **zero-downtime rotation**. Algorithm pinned (reject `none`/other algs). |
| Refresh token | Opaque 256-bit random, only **sha256 hash stored**. Rotated on every use. **Reuse detection:** presenting an already-rotated token revokes the entire `family_id` (stolen-token defence). 14-day TTL. |
| Global revoke | `users.tokens_valid_after`: access tokens with `iat` older than this are rejected (logout-all, password change, suspension). Value cached in Redis for 60 s (`user:{id}:tva`), invalidated on change. |
| MFA | TOTP (RFC 6238, 30 s, 6 digits, ±1 window) via `otplib`; secret **encrypted** (`mfa_secret_enc`); 10 single-use backup codes (argon2id hashed). TOTP replay prevented by remembering last accepted time-step per user in Redis (`mfa:last:{userId}`, TTL 90 s). |
| Login with MFA | `POST /auth/login` → `{mfaRequired, mfaToken}` (5 min, scope `mfa`) → `POST /auth/mfa/verify`. |
| Forced enrolment | DOCTOR/ADMIN without MFA get `{mfaEnrollmentRequired, setupToken}` (scope `mfa_setup`, accepted **only** by `/auth/mfa/setup` and `/auth/mfa/enable`). |

### 7.4 RBAC + ownership matrix

RBAC decides *which endpoint class*; **ownership checks** (ABAC) decide *which record*. Both are mandatory. Implement as middleware `requireRole(...roles)` plus service-level `assertOwnership()`. Return **404** (not 403) when a record exists but belongs to someone else, to avoid existence leaks.

| Resource / action | PATIENT | DOCTOR | ADMIN |
|---|---|---|---|
| Own user/profile read/update | ✅ | ✅ | ✅ |
| List / suspend users, change roles | ❌ | ❌ | ✅ (+MFA step-up) |
| Doctor search / view profile (VERIFIED only) | ✅ | ✅ | ✅ (also non-verified) |
| Edit own doctor profile | ❌ | ✅ (own) | ✅ |
| Verify doctor | ❌ | ❌ | ✅ |
| Create / delete availability slots | ❌ | ✅ (own) | ❌ |
| Book consultation | ✅ | ❌ | ❌ |
| View consultation | ✅ (own as patient) | ✅ (own as doctor) | ✅ metadata only (no PHI fields) |
| Cancel consultation | ✅ (own) | ✅ (own) | ✅ |
| Start / complete consultation | ❌ | ✅ (own) | ❌ |
| Issue prescription | ❌ | ✅ (own consultation, status IN_PROGRESS/COMPLETED) | ❌ |
| Read prescription | ✅ (own) | ✅ (issued by them) | ❌ |
| Refund payment | ❌ | ❌ | ✅ |
| Analytics, audit logs | ❌ | ❌ | ✅ (+MFA step-up) |

> Admins deliberately **cannot** read prescription content or consultation notes (least privilege). Break-glass access, if ever added, must be a separate audited flow.

---

## 8. REST API specification

### 8.1 Conventions (apply to every endpoint)

* **Base URL:** `/api/v1`. Docs: `GET /docs` (Swagger UI), `GET /openapi.json`.
* **Auth:** `Authorization: Bearer <accessToken>` unless marked 🔓 public.
* **Content type:** `application/json`; max body 100 KB; unknown fields **rejected** (`zod .strict()`).
* **Headers in:** `Idempotency-Key` (required on 🔁 endpoints), `X-Request-Id` (optional, generated if absent).
* **Headers out:** `X-Request-Id`, `RateLimit-Limit/Remaining/Reset`, `Idempotent-Replayed: true` on replays.
* **IDs:** UUID. **Times:** ISO-8601 UTC. **Money:** integer minor units + `currency`.
* **Pagination:** keyset. Request `?limit=20&cursor=<opaque>` (limit 1–100). Response `{ "data": [...], "meta": { "limit": 20, "nextCursor": "..." | null } }`.
* **Errors:** `application/problem+json` (RFC 9457):

```json
{
  "type": "https://api.amrutam.example/errors/slot-unavailable",
  "title": "Slot unavailable",
  "status": 409,
  "code": "SLOT_UNAVAILABLE",
  "detail": "The selected slot was just booked by someone else.",
  "requestId": "3f1d…",
  "errors": [{ "path": "slotId", "message": "…" }]   // only for 422 validation
}
```

Status map: `400` malformed · `401` unauthenticated · `403` forbidden · `404` not found/not yours · `409` conflict · `422` validation / idempotency misuse · `423` locked · `429` rate limited (`Retry-After`) · `500/503` server (never leak internals).

### 8.2 Auth & users

#### `POST /auth/register` 🔓 (rate-limit: auth tier)
```jsonc
// request
{ "email": "asha@example.com", "password": "S3cure-passphrase!", "fullName": "Asha Verma",
  "phone": "+919800000000", "role": "PATIENT",              // PATIENT | DOCTOR
  "doctor": {                                               // required iff role = DOCTOR
    "licenseNumber": "MP-12345", "specializations": ["ayurveda"], "languages": ["en","hi"],
    "consultationFeeMinor": 50000, "yearsExperience": 8, "bio": "…" } }
// 201
{ "id": "uuid", "email": "asha@example.com", "role": "PATIENT", "status": "ACTIVE",
  "mfaEnrollmentRequired": false }
```
Errors: `409 EMAIL_TAKEN` (return generic 201-style message if you want enumeration-proofing; document the choice), `422 VALIDATION_ERROR`, `422 WEAK_PASSWORD`.

#### `POST /auth/login` 🔓
```jsonc
// request
{ "email": "asha@example.com", "password": "…" }
// 200 – no MFA
{ "accessToken": "jwt", "refreshToken": "opaque", "tokenType": "Bearer", "expiresIn": 900,
  "user": { "id": "uuid", "role": "PATIENT", "email": "…" } }
// 200 – MFA enabled
{ "mfaRequired": true, "mfaToken": "jwt-5min" }
// 200 – DOCTOR/ADMIN without MFA
{ "mfaEnrollmentRequired": true, "setupToken": "jwt-limited" }
```
Errors: `401 INVALID_CREDENTIALS` (identical for unknown email / wrong password), `423 ACCOUNT_LOCKED` (`Retry-After`), `403 ACCOUNT_SUSPENDED`.

#### `POST /auth/mfa/verify` 🔓
`{ "mfaToken": "…", "code": "123456" }` (or `"backupCode": "abcd-efgh"`) → same payload as successful login (with `amr: ["pwd","otp"]`). Errors: `401 INVALID_MFA_CODE`, `401 MFA_TOKEN_EXPIRED`.

#### `POST /auth/mfa/setup` (access or setup token)
→ `200 { "otpauthUrl": "otpauth://totp/Amrutam:asha@…?secret=…&issuer=Amrutam", "secret": "BASE32", "qrDataUrl": "data:image/png;base64,…" }` (secret stored encrypted but **not yet active**).

#### `POST /auth/mfa/enable`
`{ "code": "123456" }` → `200 { "backupCodes": ["abcd-efgh", … 10 items] }` (**shown once**) and, for setup-token callers, a full token pair.

#### `POST /auth/mfa/disable` (needs password + current TOTP; blocked for DOCTOR/ADMIN)
`{ "password": "…", "code": "123456" }` → `204`.

#### `POST /auth/refresh` 🔓
`{ "refreshToken": "opaque" }` → `200 { accessToken, refreshToken, expiresIn }`. Errors: `401 INVALID_REFRESH_TOKEN` (also on detected reuse; the family is revoked and an audit event `auth.refresh_reuse_detected` + metric fire).

#### `POST /auth/logout` → `{ "refreshToken": "…" }` → `204`. `POST /auth/logout-all` → bumps `tokens_valid_after`, revokes all refresh tokens → `204`.

#### `POST /auth/password/change`
`{ "currentPassword": "…", "newPassword": "…" }` → `204`; revokes all sessions.

#### `POST /auth/password/forgot` 🔓 / `POST /auth/password/reset` 🔓
`forgot`: `{ "email" }` → always `202`. Emits one-time token (sha256-hashed in Redis, 15 min) via notification job. `reset`: `{ "token", "newPassword" }` → `204`.

#### `GET /users/me`
```json
{ "id": "uuid", "email": "…", "phone": "…", "role": "PATIENT", "status": "ACTIVE", "mfaEnabled": false,
  "profile": { "fullName": "Asha Verma", "gender": "FEMALE", "dateOfBirth": "1992-04-03",
               "address": "…", "locale": "en-IN", "timezone": "Asia/Kolkata" } }
```
(PII decrypted server-side only for the owner.)

#### `PATCH /users/me` → `{ "phone"? }` · `PUT /users/me/profile` → `{ "fullName", "gender"?, "dateOfBirth"?, "address"?, "emergencyContact"?, "locale"?, "timezone"? }` → `200` updated profile. Both audited.

#### `DELETE /users/me` 🔁 → requests erasure: status `DELETED`, PII anonymised, sessions revoked → `202`.

#### Admin: `GET /users?role=&status=&q=&limit=&cursor=` · `PATCH /users/{id}/status` `{ "status": "SUSPENDED", "reason": "…" }` · `PATCH /users/{id}/role` `{ "role": "..." }` (cannot create ADMIN via API; only demote/promote among PATIENT/DOCTOR) → `200`. All require admin + step-up MFA, all audited.

### 8.3 Doctors & search

#### `PUT /doctors/me` (DOCTOR) – create/update own doctor profile
```jsonc
{ "specializations": ["ayurveda","general-medicine"], "languages": ["en","hi"], "bio": "…",
  "yearsExperience": 10, "consultationFeeMinor": 50000, "modes": ["VIDEO","CHAT"], "isAccepting": true }
// 200 → doctor object (below). Invalidates cache doctor:{id}.
```

#### `GET /doctors` — **search & filter** (cached 60 s, served from replica)

| Query param | Type | Meaning |
|---|---|---|
| `q` | string (≤100) | Full-text over name/specialization/bio (`websearch_to_tsquery`) + trigram fallback on name |
| `specialization` | string, repeatable | `ANY` match against `specializations` |
| `language` | string, repeatable | match against `languages` |
| `mode` | `VIDEO\|AUDIO\|CHAT` | doctor supports mode |
| `minFee`, `maxFee` | int (minor units) | fee range |
| `minRating` | 0–5 | |
| `availableFrom`, `availableTo` | ISO datetime | only doctors with ≥1 AVAILABLE slot in the window (`EXISTS` on partial index) |
| `sort` | `rating` (default) `fee_asc` `fee_desc` `experience` `next_available` | keyset-stable (tie-break `id`) |
| `limit`, `cursor` | | keyset pagination |

```json
{ "data": [ { "id": "uuid", "displayName": "Dr. Meera Sharma", "specializations": ["ayurveda"],
              "languages": ["en","hi"], "yearsExperience": 10, "consultationFeeMinor": 50000,
              "currency": "INR", "ratingAvg": 4.8, "ratingCount": 312, "modes": ["VIDEO"],
              "nextAvailableAt": "2026-11-02T04:30:00Z" } ],
  "meta": { "limit": 20, "nextCursor": "eyJyIjo0LjgsImlkIjoi…" } }
```
Only `VERIFIED` + `is_accepting` doctors appear (admins can pass `includeUnverified=true`).

#### `GET /doctors/{id}` → full profile incl. `bio`, `verificationStatus` (admin only). Cache-aside `doctor:{id}` TTL 300 s.

#### `PATCH /admin/doctors/{id}/verification` (ADMIN) `{ "status": "VERIFIED" | "REJECTED", "note"? }` → `200`; audited; busts caches.

### 8.4 Availability

#### `POST /doctors/me/slots` 🔁 (DOCTOR) — bulk create
```jsonc
{ "slots": [ { "start": "2026-11-02T04:30:00Z", "end": "2026-11-02T05:00:00Z" } ] }
// or recurrence helper (max 31 days, max 200 slots per request):
{ "recurrence": { "from": "2026-11-02", "to": "2026-11-15", "daysOfWeek": [1,2,3,4,5],
                  "dailyWindows": [{ "start": "10:00", "end": "13:00" }], "slotMinutes": 30,
                  "timezone": "Asia/Kolkata" } }
// 201
{ "created": 140, "skipped": [{ "start": "…", "reason": "OVERLAP" }] }
```
Overlaps are rejected by the exclusion constraint (`23P01` → mapped to `skipped: OVERLAP`). Slots must be in the future.

#### `GET /doctors/me/slots?from=&to=&status=` → `{ data: [ { id, start, end, status } ], meta }`
#### `GET /doctors/{id}/availability?from=2026-11-02&to=2026-11-09` (any authenticated user)
→ `{ "doctorId": "…", "timezone": "UTC", "slots": [ { "id": "uuid", "start": "…", "end": "…" } ] }` (AVAILABLE only, plus HELD slots whose hold expired). Cache `avail:{doctorId}:{date}` TTL 30 s — **display only, never used for the booking decision**.
#### `DELETE /doctors/me/slots/{id}` (DOCTOR) → `204`; only if `AVAILABLE` (sets `CANCELLED`). `409 SLOT_NOT_DELETABLE` otherwise.

### 8.5 Consultations

#### `POST /consultations` 🔁 (PATIENT) — **book** (Idempotency-Key **required**)
```jsonc
// request
{ "slotId": "uuid", "mode": "VIDEO", "reason": "Recurring acidity for 3 weeks" }
// 201  (target p95 < 500 ms: single txn, no external call)
{ "id": "uuid", "status": "PENDING_PAYMENT", "doctorId": "uuid", "slotId": "uuid",
  "scheduledStart": "2026-11-02T04:30:00Z", "scheduledEnd": "2026-11-02T05:00:00Z",
  "feeMinor": 50000, "currency": "INR", "expiresAt": "2026-11-02T03:50:00Z",
  "payment": { "id": "uuid", "status": "INITIATED", "pollUrl": "/api/v1/payments/uuid" } }
```
Errors: `409 SLOT_UNAVAILABLE`, `409 PATIENT_DOUBLE_BOOKED` (patient already has overlapping live consultation), `422 SLOT_TOO_SOON`, `422 IDEMPOTENCY_KEY_REQUIRED`, `422 IDEMPOTENCY_KEY_REUSED`, `404 SLOT_NOT_FOUND`, `403` role.
Flow: see §9.1.

#### `GET /consultations?status=&from=&to=&limit=&cursor=` → list **own** (patient or doctor). Item: `{ id, status, doctor{id,displayName}|patient{id,fullName}, scheduledStart, scheduledEnd, mode, feeMinor, currency }`.
#### `GET /consultations/{id}` → detail incl. `reason` (decrypted for participants only), `payment` summary, `prescriptions[] {id, version, issuedAt}`, `meetingUrl` (present only when `CONFIRMED`/`IN_PROGRESS` and within 15 min of start). Reading PHI writes audit action `consultation.read`.
#### `POST /consultations/{id}/cancel` 🔁 `{ "reason": "…" }` → `200` updated consultation `{ status: "CANCELLED", refund: { status: "PENDING", amountMinor: 50000 } }`. Rules §9.3. Errors: `409 INVALID_STATE`, `409 TOO_LATE_TO_CANCEL` (after start).
#### `POST /consultations/{id}/start` (DOCTOR) → `200 { status: "IN_PROGRESS", startedAt }`. Allowed from `CONFIRMED` within [start−10 min, end].
#### `POST /consultations/{id}/complete` (DOCTOR) `{ "notes": "…" }` → `200 { status: "COMPLETED", completedAt }`; notes encrypted.
#### `POST /consultations/{id}/no-show` (DOCTOR) → `200 { status: "NO_SHOW" }` allowed after start+10 min if not started; no refund.

### 8.6 Prescriptions

#### `POST /consultations/{id}/prescriptions` 🔁 (DOCTOR, own, status `IN_PROGRESS` or `COMPLETED` ≤ 24 h)
```jsonc
{ "diagnosis": "Hyperacidity (Amlapitta)",
  "medications": [ { "name": "Avipattikar Churna", "dosage": "3 g", "frequency": "twice daily",
                     "durationDays": 14, "instructions": "After meals with warm water" } ],
  "advice": "Avoid spicy food…", "followUpDate": "2026-11-16", "validUntil": "2026-12-02T00:00:00Z" }
// 201
{ "id": "uuid", "consultationId": "uuid", "version": 1, "status": "ISSUED", "issuedAt": "…" }
```
A second POST for the same consultation creates **version 2** and marks version 1 `REVOKED` (in one txn). Enqueues `prescription.pdf` job.
#### `GET /consultations/{id}/prescriptions` → list of versions (metadata only).
#### `GET /prescriptions/{id}` → decrypted payload to patient or issuing doctor. Always audited (`prescription.read`). `Cache-Control: no-store`.

### 8.7 Payments

#### `GET /payments/{id}` (consultation's patient or admin)
```json
{ "id": "uuid", "consultationId": "uuid", "status": "PENDING", "amountMinor": 50000, "currency": "INR",
  "clientSecret": "mock_secret_…", "expiresAt": "…" }
```
`clientSecret` is present only while `PENDING` and only for the owner. Client **polls** every 2 s (max 60 s) after booking until `PENDING` appears; then completes payment with the provider SDK.

#### `POST /payments/webhook` 🔓 (provider → us; **no JWT**, signature required)
Header `X-Signature: t=<unix>,v1=<hex-hmac-sha256(secret, t + "." + rawBody)>`. Reject if `|now − t| > 5 min` (replay), signature mismatch (**constant-time compare**), or malformed. Needs **raw body** (mount `express.raw()` on this route only).
Body (mock): `{ "id": "evt_123", "type": "payment.succeeded|payment.failed|refund.succeeded", "data": { "paymentId": "mock_pi_001", "amountMinor": 50000 } }` → `200 {}` quickly; duplicate `evt_` ids return `200` and are no-ops.

#### `POST /payments/{id}/refund` 🔁 (ADMIN, step-up MFA) `{ "amountMinor"?: 50000, "reason": "…" }` → `202 { status: "REFUND_PENDING" }`.

#### `POST /dev/payments/{id}/simulate` (non-production only; **404 when `NODE_ENV=production`**) `{ "outcome": "succeeded" | "failed" }` → sends a signed webhook to ourselves; used by the demo and e2e tests.

### 8.8 Admin: analytics & audit

#### `GET /admin/analytics/overview?from=2026-10-01&to=2026-10-31` (ADMIN, cached 60 s)
```json
{ "range": { "from": "2026-10-01", "to": "2026-10-31" },
  "totals": { "consultations": 2950000, "completed": 2610000, "cancelled": 280000, "noShow": 60000,
              "revenueMinor": 148000000000, "refundsMinor": 9000000000,
              "activeDoctors": 4200, "newPatients": 98000 },
  "rates": { "completionRate": 0.885, "cancellationRate": 0.095, "noShowRate": 0.02 },
  "avgBookingLeadHours": 31.4 }
```
(Sourced from `analytics_daily`; today's partial day is computed live and merged. Illustrative numbers.)

#### `GET /admin/analytics/timeseries?metric=consultations|revenue|cancellations&granularity=day|week&from=&to=` → `{ "metric": "…", "points": [ { "t": "2026-10-01", "v": 98123 } ] }`
#### `GET /admin/analytics/top-doctors?by=consultations|revenue|rating&limit=10&from=&to=` → `{ data: [ { doctorId, displayName, value } ] }`
#### `GET /admin/audit-logs?actorId=&action=&resourceType=&resourceId=&outcome=&from=&to=&limit=&cursor=` → paginated entries (`from` **required**, max 31-day window → partition pruning). Querying audit logs is itself audited.
#### `GET /admin/audit-logs/verify?shard=3&from=&to=` → `{ "shard": 3, "checked": 120043, "valid": true, "firstBrokenSeq": null }` (recomputes the hash chain).

### 8.9 Ops endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health/live` | none | process alive (no dependency checks) |
| `GET /health/ready` | none | PG `SELECT 1` + Redis `PING`; `503` while shutting down or dependency down |
| `GET /metrics` | network policy **and** `Bearer METRICS_TOKEN` | Prometheus exposition |
| `GET /docs`, `/openapi.json` | none in dev/staging; disabled or admin-only in prod | API docs |

### 8.10 OpenAPI generation

* Define every route via `registry.registerPath({...})` using the module's zod schemas, security schemes (`bearerAuth`), reusable `ProblemDetails`, `Idempotency-Key` header parameter, and examples from this section.
* `npm run openapi:generate` writes `docs/openapi.yaml`. CI runs it and fails on `git diff --exit-code docs/openapi.yaml`, then lints with **Spectral** (`spectral lint docs/openapi.yaml`).
* Contract test: Supertest responses are validated against the generated schema in integration tests (`jest-openapi`).

---
## 9. Core flows: booking, sagas, state machines

### 9.1 Booking flow (sequence)

```mermaid
sequenceDiagram
  autonumber
  participant P as Patient app
  participant A as API pod
  participant DB as PostgreSQL
  participant R as Redis
  participant W as Worker
  participant G as Payment gateway

  P->>A: POST /consultations (Idempotency-Key, slotId)
  A->>A: auth, RBAC, rate-limit, zod validate
  A->>DB: BEGIN
  A->>DB: INSERT idempotency_keys ON CONFLICT DO NOTHING
  alt key already COMPLETED (same hash)
    DB-->>A: stored response
    A-->>P: replay 201 + Idempotent-Replayed: true
  else new request
    A->>DB: UPDATE availability_slots SET status=HELD ... WHERE id=? AND (AVAILABLE or expired HELD)
    alt 0 rows updated
      A->>DB: ROLLBACK
      A-->>P: 409 SLOT_UNAVAILABLE
    else slot held
      A->>DB: INSERT consultations (PENDING_PAYMENT, expires_at)
      A->>DB: INSERT payments (INITIATED)
      A->>DB: INSERT audit_logs (hash chain)
      A->>DB: INSERT outbox_events (payment.intent.requested)
      A->>DB: UPDATE idempotency_keys SET response
      A->>DB: COMMIT
      A->>R: DEL avail:{doctor}:{date}
      A-->>P: 201 {consultation, payment: INITIATED}
    end
  end

  W->>DB: poll outbox FOR UPDATE SKIP LOCKED
  W->>G: create payment intent (timeout, retry+jitter, circuit breaker)
  G-->>W: providerPaymentId, clientSecret
  W->>DB: payments -> PENDING
  P->>A: GET /payments/{id} (poll)
  A-->>P: PENDING + clientSecret
  P->>G: pay (provider SDK)
  G->>A: POST /payments/webhook (signed)
  A->>A: verify HMAC + timestamp
  A->>DB: BEGIN; INSERT payment_events (dedupe by event id)
  A->>DB: payment SUCCEEDED, consultation CONFIRMED, slot BOOKED, audit, outbox(consultation.confirmed)
  A->>DB: COMMIT
  A-->>G: 200
  W->>P: email/SMS confirmation (via outbox)
```

**Booking transaction pseudo-code** (`ConsultationService.book`):

```ts
return db.withTx({ retries: 3 }, async (trx) => {
  const idem = await idempotency.begin(trx, userId, key, requestHash);      // §10
  if (idem.replay) return idem.response;

  const slot = await availabilityRepo.tryHold(trx, slotId, userId, holdMinutes);
  //   UPDATE availability_slots
  //      SET status='HELD', held_by=$u, held_until=now()+$m, version=version+1
  //    WHERE id=$id
  //      AND (status='AVAILABLE' OR (status='HELD' AND held_until < now()))
  //      AND start_time > now() + make_interval(mins => $lead)
  //  RETURNING *;
  if (!slot) throw new ConflictError('SLOT_UNAVAILABLE');

  await consultationRepo.assertNoPatientOverlap(trx, userId, slot.start, slot.end); // else PATIENT_DOUBLE_BOOKED
  const doctor = await doctorRepo.getFee(trx, slot.doctorId);
  const consult = await consultationRepo.insert(trx, { …, status: 'PENDING_PAYMENT',
                     expiresAt: now + holdMinutes, reasonEnc: enc.encrypt(reason) });
  const payment = await paymentRepo.insertInitiated(trx, consult);
  await audit.record(trx, { action: 'consultation.book', … });
  await outbox.enqueue(trx, { type: 'payment.intent.requested', aggregateId: payment.id });
  const response = toDto(consult, payment);
  await idempotency.complete(trx, userId, key, 201, response);
  return response;
});
// after commit: cache.del(...) best-effort; metrics.bookings.inc({result:'created'})
```

The atomic conditional `UPDATE` is the **primary** double-booking defence (no read-then-write race). `uq_consultation_live_slot` and the `EXCLUDE` constraint are defence in depth.

### 9.2 Consultation state machine

```mermaid
stateDiagram-v2
  [*] --> PENDING_PAYMENT: book (slot HELD)
  PENDING_PAYMENT --> CONFIRMED: payment.succeeded (slot BOOKED)
  PENDING_PAYMENT --> CANCELLED: payment.failed / patient cancels (slot AVAILABLE)
  PENDING_PAYMENT --> EXPIRED: hold timeout job (slot AVAILABLE)
  CONFIRMED --> IN_PROGRESS: doctor starts
  CONFIRMED --> CANCELLED: patient/doctor/admin cancels (refund policy)
  CONFIRMED --> NO_SHOW: doctor marks after start+10m
  IN_PROGRESS --> COMPLETED: doctor completes
  COMPLETED --> [*]
  CANCELLED --> [*]
  EXPIRED --> [*]
  NO_SHOW --> [*]
```

Implement `consultation.state-machine.ts` as a pure function `transition(current, event, actor, now) → next | throws INVALID_STATE` with a table-driven map; unit-test every legal **and** illegal transition. Every write uses optimistic locking: `UPDATE … SET status=$new, version=version+1 WHERE id=$id AND version=$expected AND status=$current` (0 rows → `409 CONCURRENT_MODIFICATION` or idempotent success if already in the target state).

### 9.3 Cancellation & refund policy

| Who cancels | When | Refund |
|---|---|---|
| Patient | ≥ `CANCEL_FULL_REFUND_HOURS` (24 h) before start | 100 % |
| Patient | < 24 h before start | 50 % |
| Doctor or Admin | any time before start | 100 % |
| System (payment timeout / failure) | — | n/a or auto-refund if money was captured |
| No-show (patient) | — | 0 % |

Cancel transaction: state → `CANCELLED`, slot → `AVAILABLE` (only if start is still in the future), audit, outbox `refund.requested {paymentId, amountMinor}`. The refund worker calls the gateway with **provider idempotency key = `refund:{paymentId}`**, updates `payments.refunded_minor/status`.

### 9.4 Booking saga (orchestrated, persisted state)

State is the consultation + payment rows themselves; steps are driven by outbox events, so a crash at any point resumes correctly.

| Step | Action | Trigger | Compensation if later step fails |
|---|---|---|---|
| 1 | Hold slot + create consultation(PENDING_PAYMENT) + payment(INITIATED) — **one local txn** | API call | n/a (txn rollback) |
| 2 | Create gateway payment intent | outbox `payment.intent.requested` | After N failed attempts → consultation `EXPIRED`, slot released, user notified |
| 3 | Confirm: payment SUCCEEDED → consultation CONFIRMED → slot BOOKED — **one local txn** | webhook `payment.succeeded` | n/a |
| 3′ | Failure path | webhook `payment.failed` | consultation CANCELLED(`PAYMENT_FAILED`), slot AVAILABLE |
| 4 | Timeout | `consultation-expiry` job every 30 s: `PENDING_PAYMENT AND expires_at < now()` | consultation EXPIRED, slot AVAILABLE, cancel gateway intent (best effort) |
| 5 | Late success (webhook arrives after EXPIRED) | webhook | If slot is still free: re-confirm. Otherwise **auto-refund** (outbox `refund.requested`) and alert metric `saga_late_payment_total`. |
| 6 | Notify | outbox `consultation.confirmed` | Notification failure never rolls back the booking; retried with backoff, then DLQ |

Rules: every step is **idempotent** (safe to re-run), every external call has a timeout, every compensating action is itself retried until success or DLQ + alert.

### 9.5 Consultation delivery & prescription flow

1. `CONFIRMED` → within 10 min of start, doctor `POST /start` → `IN_PROGRESS`; `meetingUrl` generated by `MeetingProvider` interface (mock returns `https://meet.amrutam.test/<uuid>`).
2. Doctor `POST /complete {notes}` → `COMPLETED`; notes encrypted; analytics event emitted.
3. Doctor `POST /prescriptions` (during or ≤ 24 h after) → encrypted payload, version 1, async PDF job.
4. Patient `GET /prescriptions/{id}` → decrypted, audited, `no-store`.

### 9.6 Search flow

`GET /doctors` → build cache key `search:{sha1(normalisedParams)}` → Redis hit? return. Miss → single-flight lock → read replica query (FTS + filters + keyset) → store 60 s (±10 % jitter) → return. Query uses `websearch_to_tsquery('simple', $q)` ranked with `ts_rank_cd` and falls back to `display_name % $q` (trigram) when FTS returns zero rows. `nextAvailableAt` is fetched via `LEFT JOIN LATERAL (SELECT min(start_time) …)` using `idx_slots_doctor_time`.

---

## 10. Idempotency

**Rule:** every state-changing endpoint marked 🔁 in §8 **requires** an `Idempotency-Key` header (8–128 chars, client-generated UUID recommended). Webhooks and workers have their own natural idempotency (below). A missing key on a 🔁 endpoint → `422 IDEMPOTENCY_KEY_REQUIRED`.

### 10.1 Algorithm (in the **same DB transaction** as the business write)

```
requestHash = sha256( METHOD + "\n" + path + "\n" + canonicalJson(body) )

BEGIN
  INSERT INTO idempotency_keys(user_id,key,request_hash,method,path,expires_at)
  VALUES ($u,$k,$h,$m,$p, now()+24h) ON CONFLICT (user_id,key) DO NOTHING RETURNING *;

  if inserted:      run handler → UPDATE idempotency_keys SET response_status,response_body → COMMIT
  else:             SELECT * FROM idempotency_keys WHERE user_id=$u AND key=$k
        hash differs                   → 422 IDEMPOTENCY_KEY_REUSED   (same key, different payload)
        response_status IS NOT NULL    → replay stored response, header Idempotent-Replayed: true
```

Why this is race-free: the unique index makes a concurrent duplicate **block on the first transaction**; when it commits, the duplicate's `INSERT` conflicts and it reads the completed row; if the first transaction rolls back, the duplicate proceeds as the first. No separate lock table, no "in-progress" state to get stuck.

* Scope is `(user_id, key)`, so one user can never replay another user's response.
* Only **successful** (2xx) outcomes are stored. Failures roll back, so the client can retry the same key.
* TTL 24 h; `idempotency-cleanup` job deletes expired rows hourly.

### 10.2 Other idempotency mechanisms

| Path | Mechanism |
|---|---|
| Payment webhooks | `payment_events.provider_event_id UNIQUE`; duplicate → `200` no-op |
| Outbox → worker jobs | BullMQ `jobId = outbox_event.id` (dedupes); handlers are re-entrant (state checks + conditional updates) |
| Refunds | gateway idempotency key `refund:{paymentId}:{n}`; `refunded_minor` updated with `WHERE refunded_minor = $old` |
| State transitions | conditional `UPDATE … WHERE status=$expected`; already-in-target-state returns success |
| Prescription issue | `UNIQUE (consultation_id, version)` + idempotency key |

### 10.3 Required tests
Same key twice → one consultation, identical response, `Idempotent-Replayed`. Same key + different body → 422. 20 parallel identical requests → exactly one row. Same key from another user → independent. Crash between handler and commit → no stored key.

---

## 11. Concurrency, caching, transactions

### 11.1 Concurrency control summary

| Hazard | Control |
|---|---|
| Two patients book the same slot | Atomic conditional `UPDATE` (rows affected = 0 → 409); `uq_consultation_live_slot`; `EXCLUDE` constraint |
| Doctor creates overlapping slots | `EXCLUDE USING gist` (DB-enforced) |
| Concurrent status changes | Optimistic locking `version` + conditional status in `WHERE` |
| Duplicate client retries | Idempotency (§10) |
| Duplicate webhooks | Inbox table unique key |
| Audit hash chain contention | 16 shards; `SELECT … FOR UPDATE` on `audit_chain_heads` row inside the txn (lock held only for the final statements) |
| Multiple workers on the outbox | `FOR UPDATE SKIP LOCKED` batches |
| Deadlocks | Consistent lock order: slot → consultation → payment → audit head → outbox; `withTx` retries on `40001`/`40P01` |

**Transaction isolation:** default `READ COMMITTED` plus targeted row locks/conditional updates (cheaper and sufficient). Use `SERIALIZABLE` only for the patient-overlap check if it proves racy (`withTx({isolation:'serializable', retries:3})`). Set per-session `statement_timeout` and `idle_in_transaction_session_timeout` (env values in §5).

### 11.2 `withTx` helper contract (`common/db/transaction.ts`)

```ts
withTx<T>(opts: { retries?: number; isolation?: 'read committed'|'repeatable read'|'serializable'; readOnly?: boolean },
          fn: (trx: Transaction<DB>) => Promise<T>): Promise<T>
```
* Retries only on `40001`, `40P01` (and `55P03` lock timeout) using §12 backoff; never retries business errors.
* Records `db_tx_retries_total`, `db_query_duration_seconds`; adds a tracing span.
* Hooks: `trx.afterCommit(fn)` collects cache invalidations/metrics to run **only after** commit.

### 11.3 Caching design

| Cache key | Content | TTL | Invalidation |
|---|---|---|---|
| `doctor:{id}` | doctor profile DTO | 300 s ±10 % | on `PUT /doctors/me`, verification change |
| `search:{sha1(params)}` | search page | 60 s ±10 % | TTL only (acceptable staleness) |
| `avail:{doctorId}:{yyyy-mm-dd}` | open slots for display | 30 s | on slot create/delete/hold/confirm/release |
| `user:{id}:tva` | `tokens_valid_after` | 60 s | on bump |
| `analytics:overview:{from}:{to}` | JSON | 60 s | TTL |
| `rl:*` | rate-limit counters | window | n/a |
| `mfa:last:{id}` | last TOTP step | 90 s | n/a |

* **Pattern:** cache-aside through `CacheService.getOrLoad(key, ttl, loader)`.
* **Stampede protection:** per-key single-flight in-process (`Map<string, Promise>`) + cross-pod `SET lock:{key} NX PX 5000`; losers wait ≤ 200 ms then read the cache or fall through to DB. TTL jitter avoids synchronized expiry.
* **Never cache PHI** (consultation, prescription, profile PII) in Redis.
* **Correctness boundary:** booking reads slot state from PostgreSQL only.
* **Failure mode:** if Redis is down, cache is bypassed (fail-open), rate limiting falls back to an in-memory limiter per pod, booking continues; `cache_errors_total` alerts.
* **Targets:** cache hit ratio ≥ 80 % for search/profile; verified in the load test.

### 11.4 Read scaling
`DATABASE_READ_URL` points to a replica; `db.read` is used for search, listings, analytics. Handlers that need read-your-writes (`GET /consultations/{id}` within 5 s of a write) use the primary. Replica lag is exported as `pg_replica_lag_seconds`; if > 5 s the read pool temporarily falls back to the primary.

### 11.5 Connection management
Pool `DB_POOL_MAX=20` per pod. With 10 API pods + 4 workers → 280 connections; place **PgBouncer** (transaction mode) in front in production. Do not hold a transaction open across network calls.

---

## 12. Retry, backoff, circuit breakers

### 12.1 Backoff formula (`common/resilience/retry.ts`)

**Full jitter exponential backoff:** `delay = random(0, min(capMs, baseMs × 2^attempt))`.

```ts
retry(fn, { retries: 3, baseMs: 100, capMs: 2000, retryOn: (e) => isTransient(e), signal })
```

### 12.2 Policy table

| Operation | Retries | Base / cap | Retry on | Notes |
|---|---|---|---|---|
| DB transaction | 3 | 50 ms / 500 ms | `40001`, `40P01`, `55P03`, connection reset | Whole txn re-run; handler must be pure within txn |
| Redis command | 2 | 20 ms / 200 ms | connection errors | then fail-open |
| Payment gateway create-intent | 5 (via BullMQ) | 1 s / 60 s | 5xx, timeout, network; **not** 4xx | per-call timeout 3 s; circuit breaker |
| Payment gateway refund | 8 (via BullMQ) | 2 s / 5 min | same | provider idempotency key |
| Notification (email/SMS) | 6 | 2 s / 10 min | 5xx, timeout | DLQ after final failure |
| Outbox relay | unlimited with backoff | 1 s / 60 s | any | `next_attempt_at` column; alert if lag > 60 s |
| Inbound webhook | none (provider retries us) | — | — | respond `2xx` fast; process in-txn |

### 12.3 Circuit breaker (`opossum`) around the payment gateway
`timeout 3000 ms · errorThresholdPercentage 50 · volumeThreshold 10 · resetTimeout 30 s`. While **open**: jobs fail fast and are rescheduled (not counted against attempts), booking itself still succeeds (payment intent is created later), gauge `circuit_breaker_state{name="payment"}` alerts.

### 12.4 Rules
Retry **only** idempotent operations; always cap total elapsed time; always add jitter; log each retry at `warn` with attempt number; metrics `retries_total{op}`.

---

## 13. Async jobs & scheduler

Same image, `node dist/worker.js`. BullMQ queues (Redis with `appendonly yes`; Redis loss is recoverable because the **outbox in PostgreSQL is the source of truth**).

| Queue / job | Trigger | Concurrency | Purpose |
|---|---|---|---|
| `outbox-relay` | repeatable, every 1 s | 1 per pod | `SELECT … FOR UPDATE SKIP LOCKED LIMIT 100` → enqueue to target queues → mark `published_at` |
| `payment-intent` | outbox `payment.intent.requested` | 10 | gateway call, update payment → PENDING |
| `payment-refund` | outbox `refund.requested` | 5 | gateway refund |
| `notification` | outbox `consultation.*` | 20 | email/SMS (MailHog in dev) |
| `consultation-expiry` | repeatable, every 30 s | 1 | expire unpaid PENDING_PAYMENT, release slots |
| `slot-hold-sweeper` | repeatable, every 60 s | 1 | release HELD slots whose `held_until` passed without a consultation |
| `prescription-pdf` | outbox `prescription.issued` | 3 | render PDF (pdfkit), store to object storage (local disk in dev) |
| `analytics-rollup` | repeatable, hourly (+ nightly full recompute for yesterday) | 1 | upsert `analytics_daily` |
| `audit-partition` | daily | 1 | `audit_create_partition()` for next 3 months |
| `idempotency-cleanup` | hourly | 1 | delete expired keys; prune outbox (>7 d), payment_events (>30 d) |
| `reencrypt` | manual / key-rotation | 2 | re-encrypt rows with old key versions in batches of 500 (§14.3) |

Job conventions: `jobId` for dedupe; `attempts` + exponential backoff (§12); `removeOnComplete: 1000`, failed jobs kept; **DLQ** queue per job type with alert on depth > 0; each job carries `traceparent` to continue the trace; graceful shutdown waits for active jobs (`worker.close()`).

---
## 14. Security

> Assignment rule: **missing critical security = fail.** Everything marked **[CRITICAL]** must be implemented *and* covered by an automated test.

### 14.1 OWASP Top 10 (2021) mitigations

| OWASP | Risk in this system | Mitigation (where) |
|---|---|---|
| **A01 Broken Access Control** | Patient reads another's consultation/prescription; doctor touches others' slots; admin reads PHI | RBAC middleware + **ownership check in every service method**; 404 on foreign records; admin has no PHI access; deny-by-default router (routes without an explicit `requireRole`/`public` marker fail at boot); `tests/security/rbac-matrix.test.ts` iterates every route × role **[CRITICAL]** |
| **A02 Cryptographic Failures** | PHI at rest/in transit, weak password hashing, token leakage | TLS 1.2+ (HSTS); AES-256-GCM field encryption with key versions; argon2id; refresh tokens stored as hashes; secrets only via env; no PHI in logs/URLs/cache **[CRITICAL]** |
| **A03 Injection** | SQL injection via search/filters; NoSQL/command injection; log injection | Kysely/parameterised queries only (**lint rule bans string-built SQL**); zod strict validation; `websearch_to_tsquery` (safe parser); JSON logs escape control chars |
| **A04 Insecure Design** | Double booking, replay of payments, abuse of retries | Idempotency, atomic slot hold, saga with compensation, state machine, threat model (§14.5) **[CRITICAL: idempotency]** |
| **A05 Security Misconfiguration** | Default creds, verbose errors, open docs/metrics | `helmet`, CORS allow-list, error handler never leaks stack traces in prod, `/metrics` protected, `/docs` off in prod, non-root container, read-only FS, config validated at boot |
| **A06 Vulnerable Components** | Dependency CVEs | `npm audit --omit=dev --audit-level=high` in CI (blocking), Dependabot weekly, Trivy image scan (blocking on HIGH/CRITICAL), lockfile committed, `npm ci` only, CodeQL |
| **A07 Identification & Auth Failures** | Credential stuffing, brute force, token theft | argon2id, lockout, rate limits per IP **and** per account, MFA (mandatory for DOCTOR/ADMIN), refresh rotation + reuse detection, short access TTL, generic error messages **[CRITICAL: MFA, RBAC]** |
| **A08 Software & Data Integrity** | Forged webhooks, tampered logs, malicious CI deps | HMAC-signed webhooks with timestamp, hash-chained audit log + immutability triggers, pinned GitHub Actions by SHA, image digest pinning, lockfile |
| **A09 Logging & Monitoring Failures** | Attacks go unnoticed | Audit log (security events), structured logs with `requestId`/`traceId`, alerts on auth failures spike / refresh reuse / webhook signature failures / 5xx |
| **A10 SSRF** | Server fetching user-controlled URLs | No endpoint fetches user URLs; gateway/meeting URLs are server-configured; egress network policy allow-list |

### 14.2 HTTP & application hardening

* `helmet()` (CSP `default-src 'none'` for API, HSTS 1 y, `noSniff`, `frameguard deny`, `referrerPolicy no-referrer`); `x-powered-by` disabled.
* CORS: explicit origin allow-list, credentials only if needed; `hpp` against parameter pollution.
* **Rate limiting** (Redis-backed sliding window, `rate-limit-redis`):

| Scope | Limit | Key |
|---|---|---|
| Global | 120 / min | IP (+ user id if authenticated) |
| `/auth/login`, `/auth/register`, `/auth/password/*`, `/auth/mfa/verify` | 10 / min | IP **and** separately per email (5 / 15 min) |
| `POST /consultations` | 20 / min | user id |
| `/payments/webhook` | allow-listed provider IPs + 600 / min | IP |

  Response `429` with `Retry-After` + problem+json; `rate_limited_total{route}` metric.
* **Input validation:** zod on params, query, body, headers; `.strict()`; max lengths on all strings; UUID format on ids; date-range caps; body size 100 KB; arrays capped (e.g. ≤ 200 slots).
* **Output:** explicit DTO mappers (never return DB rows); strip `password_hash`, `mfa_secret_enc`, `*_enc` fields.
* **Error handling:** central handler → problem+json; 5xx body is generic with `requestId`; stack traces only in logs.
* **Mass-assignment** prevented by strict schemas (a client can't send `role`, `status`, `fee` on consultation, etc.).
* **Timing/enumeration:** same response + comparable timing for unknown email vs wrong password (hash a dummy password when user is absent).
* **Webhook endpoint:** raw-body HMAC, 5-min timestamp tolerance, constant-time compare (`crypto.timingSafeEqual`), dedupe by event id.

### 14.3 Encryption & key management

**In transit:** TLS 1.2+ at the load balancer, TLS to PostgreSQL (`sslmode=verify-full`) and Redis (`rediss://`) in prod; mTLS optional between pods (service mesh).
**At rest:** encrypted volumes/RDS storage (KMS), encrypted backups, **plus application-level field encryption** for PHI/PII so a DB dump or a SQL-injection read does not expose clinical data.

**Field encryption (`EncryptionService`)**

* Algorithm **AES-256-GCM**, random 96-bit IV per value, 128-bit auth tag; Associated Data = `table.column:rowId` (binds ciphertext to its cell, so values can't be swapped between rows).
* Stored format: `v{keyVersion}:{base64(iv)}:{base64(tag)}:{base64(ciphertext)}`.
* `KeyProvider` interface: `EnvKeyProvider` (dev/test, `ENC_KEYS`) and `KmsKeyProvider` (prod: data keys wrapped by AWS KMS CMK, cached in memory 5 min). Switch via `KMS_KEY_ID`.
* Encrypted columns: `profiles.{date_of_birth_enc,address_enc,emergency_contact_enc}`, `users.mfa_secret_enc`, `consultations.{reason_enc,doctor_notes_enc}`, `prescriptions.payload_enc`.
* `encrypt(plain, aad) → string` · `decrypt(cipher, aad) → string` (picks key by embedded version).

**Key rotation (documented in `docs/runbooks/key-rotation.md`, automated via `reencrypt` job)**

| Key | Rotation | Procedure |
|---|---|---|
| Field-encryption keys (`ENC_KEYS`) | every 90 days or on suspicion | 1) add `"2": …` to `ENC_KEYS`; 2) set `ENC_ACTIVE_VERSION=2` and deploy (new writes use v2, old rows still decrypt with v1); 3) run `reencrypt` job (batches of 500, resumable, idempotent); 4) when `SELECT count(*) WHERE value LIKE 'v1:%'` = 0 retire v1 |
| JWT signing keys (`JWT_KEYS`) | every 90 days | add new `kid`, switch `JWT_ACTIVE_KID`, keep old key for ≥ access TTL (15 min) + margin, then remove |
| Payment webhook secret | on provider rotation | provider supports dual secrets during overlap; accept both for 24 h |
| DB / Redis credentials | every 90 days | Secrets Manager rotation + rolling restart |
| KMS CMK | automatic yearly rotation | AWS-managed |

**Hashing summary:** passwords/backup codes → argon2id; refresh & reset tokens → sha256 (high-entropy random, so a fast hash is fine); audit chain → sha256.

### 14.4 Data classification

| Class | Examples | Storage | Access | Logging |
|---|---|---|---|---|
| **P0 – Clinical (PHI)** | consultation reason, doctor notes, diagnosis, prescriptions | DB field-encrypted; backups encrypted; **never** in cache/logs/metrics/traces | Owner patient, treating doctor only; every read audited | Redacted; ids only |
| **P1 – Personal (PII)** | DOB, address, emergency contact, phone, email, full name | DOB/address/contact field-encrypted; email/phone TLS + disk-encrypted | Owner, admin (limited fields) | Email masked (`a***@example.com`) |
| **P2 – Security secrets** | password hashes, MFA secrets, refresh-token hashes, API keys | hashed / encrypted / env-only | Auth module only | Never logged |
| **P3 – Internal** | slots, analytics aggregates, audit metadata | DB | Role-based | Allowed |
| **P4 – Public** | doctor display profile, specializations, fee | DB + cache | Anyone authenticated | Allowed |

Retention: clinical records 7 years (configurable), audit logs 7 years (archived after 13 months), idempotency keys 24 h, outbox 7 days, refresh tokens until expiry + 30 days.

### 14.5 Threat model

**Method:** STRIDE per component over a data-flow diagram. Deliver as `docs/threat-model.md` (include the diagram from §3 with trust boundaries drawn).

**Trust boundaries:** (1) Internet ↔ WAF/LB; (2) LB ↔ API pods; (3) API/worker ↔ data stores (private subnet); (4) workers ↔ third parties (payment, email); (5) CI/CD ↔ registry/cluster.

**Assets:** PHI (prescriptions, notes), PII, credentials/tokens, payment integrity, slot inventory integrity, audit log integrity, availability.

**Actors:** anonymous attacker, malicious patient, malicious/compromised doctor, compromised admin, insider with DB access, compromised third-party/dependency.

| # | STRIDE | Threat | Component | Mitigation | Residual |
|---|---|---|---|---|---|
| T1 | **S**poofing | Credential stuffing / brute force | `/auth/login` | argon2id, lockout, per-IP+per-account rate limit, MFA, breached-password deny-list, alerts | Low |
| T2 | S | Stolen refresh token | `/auth/refresh` | rotation + reuse detection (family revoke), hashed storage, short TTL | Low |
| T3 | S | Forged payment webhook | `/payments/webhook` | HMAC + timestamp + dedupe + IP allow-list | Low |
| T4 | **T**ampering | IDOR: patient edits/reads another's consultation | consultations/prescriptions | ownership checks, 404 on foreign ids, RBAC matrix test | Low |
| T5 | T | Double booking via race / replay | booking | atomic hold, constraints, idempotency | Low |
| T6 | T | Tamper with audit log (insider) | `audit_logs` | append-only triggers, DB role without UPDATE/DELETE, hash chain + verify endpoint, WORM archive to S3 Object Lock | Med (DBA superuser) |
| T7 | T | Price tampering (client sends fee) | booking | fee read server-side from doctor row; strict schema | Low |
| T8 | **R**epudiation | Doctor denies issuing prescription / admin denies action | prescriptions, admin | immutable versioned prescriptions + audit with actor, ip, requestId | Low |
| T9 | **I**nformation disclosure | SQL injection dumps data | all queries | parameterised queries, lint ban, least-privilege DB role, field encryption makes dump useless | Low |
| T10 | I | PHI leaks via logs/traces/cache | observability | redaction config, `no PHI in Redis`, log review test (`tests/security/log-redaction.test.ts`) | Low |
| T11 | I | User enumeration | login/register/reset | generic responses, constant-ish timing | Low |
| T12 | I | Backup theft | backups | encrypted with KMS, restricted bucket policy, access logging | Low |
| T13 | I | Verbose errors / stack traces | error handler | generic 5xx, `requestId` only | Low |
| T14 | **D**oS | Request flood, slow-loris | API | WAF, rate limits, body-size limit, timeouts, HPA, connection limits | Med |
| T15 | D | Slot-hoarding (hold slots, never pay) | booking | hold TTL 10 min, per-user limit of 3 concurrent PENDING_PAYMENT, rate limit on booking, expiry job | Med |
| T16 | D | Expensive search queries | `/doctors` | limit ≤ 100, `q` ≤ 100 chars, statement timeout 5 s, cache, indexes | Low |
| T17 | D | Queue poisoning / retry storm | workers | attempts cap, backoff+jitter, DLQ, circuit breaker | Low |
| T18 | **E**levation | Role escalation via mass assignment / token forgery | users/auth | strict schemas, role not client-settable, pinned JWT alg, key ring, admin only via CLI + MFA step-up | Low |
| T19 | E | Compromised dependency / CI | supply chain | npm audit, Dependabot, CodeQL, Trivy, pinned Actions by SHA, lockfile, minimal base image, SBOM (`syft`) | Med |
| T20 | E | Container escape / lateral movement | runtime | non-root, read-only rootfs, dropped capabilities, NetworkPolicy, no secrets in image | Low |
| T21 | T | Replay of captured request | all writes | TLS, idempotency, short token TTL, webhook timestamp | Low |
| T22 | I | Admin over-reach to PHI | admin API | admins have no PHI endpoints; separate audited break-glass (future) | Low |

### 14.6 Attack-surface analysis

| Surface | Exposure | Controls |
|---|---|---|
| Public REST API (`/api/v1/*`) | Internet | WAF, TLS, authN/Z, rate limit, validation |
| Payment webhook | Internet (provider only) | HMAC, IP allow-list, timestamp, dedupe |
| Auth endpoints | Internet | strictest rate limits, MFA, lockout |
| `/docs`, `/openapi.json` | Dev/staging only | disabled/protected in prod |
| `/metrics`, `/health/*` | Cluster-internal | NetworkPolicy + bearer token |
| PostgreSQL / Redis | Private subnet | SG allow only API/worker, TLS, auth, no public IP |
| Worker egress (payment, email) | Outbound | egress allow-list, timeouts, breaker |
| CI/CD pipeline | GitHub | branch protection, required reviews, OIDC (no long-lived cloud keys), secret scanning |
| Container image | Registry | scanned, signed (cosign), non-root, pinned digests |
| Admin CLI (`create-admin`) | Operator shell | restricted to ops role; audited |

### 14.7 Dependency, secret & supply-chain scanning

* **CI (blocking):** `npm audit --omit=dev --audit-level=high`; `trivy image --severity HIGH,CRITICAL --exit-code 1`; `gitleaks detect`; CodeQL (JavaScript/TypeScript); ESLint with `eslint-plugin-security`.
* **Dependabot:** npm (weekly), GitHub Actions (weekly), Docker base image (weekly).
* **SBOM:** `syft` output attached to the release; **cosign** signs the image.
* **Policy:** no `latest` tags; pin Actions to commit SHAs; renovate/Dependabot PRs require green CI.

### 14.8 Security checklist (copy to `docs/security-checklist.md`; tick as implemented)

**Authentication & sessions**
- [ ] Passwords hashed with argon2id; min length 12; breached/common deny-list
- [ ] Account lockout + per-IP and per-account rate limits
- [ ] MFA (TOTP + backup codes); mandatory for DOCTOR and ADMIN
- [ ] Short-lived access JWT; pinned algorithm; key ring with `kid`
- [ ] Refresh-token rotation with reuse detection; hashed at rest
- [ ] Global session revoke (`tokens_valid_after`) on password change/suspension
- [ ] Generic auth errors (no user enumeration)

**Authorization**
- [ ] Deny-by-default routing; every route declares roles or `public`
- [ ] Ownership checks in services; 404 for foreign records
- [ ] Admin step-up MFA on sensitive endpoints
- [ ] Automated RBAC matrix test passes for every route × role

**Data protection**
- [ ] TLS everywhere (LB, DB, Redis); HSTS
- [ ] Field-level AES-256-GCM for P0/P1 data with AAD binding
- [ ] Key rotation procedure documented and rehearsed (`reencrypt` job tested)
- [ ] Backups encrypted; restore tested
- [ ] No PHI in logs, traces, metrics, cache, URLs, error messages
- [ ] Secrets only via env/secret manager; none in repo or image

**API hardening**
- [ ] `helmet`, CORS allow-list, `hpp`, body-size limit
- [ ] zod validation on all inputs; strict schemas; DTO outputs
- [ ] Parameterised SQL only; lint rule enforced
- [ ] Rate limiting (global + sensitive endpoints)
- [ ] Idempotency on all write endpoints marked 🔁
- [ ] Webhook HMAC + timestamp + dedupe
- [ ] Generic 5xx; no stack traces in prod

**Integrity & audit**
- [ ] Append-only, hash-chained audit logs; verification endpoint
- [ ] Every PHI read/write and admin action audited
- [ ] Prescriptions immutable + versioned
- [ ] DB constraints (exclusion, unique, check) back all business invariants

**Supply chain & runtime**
- [ ] `npm audit`, Trivy, gitleaks, CodeQL green in CI
- [ ] Dependabot enabled; Actions pinned
- [ ] Non-root container, read-only FS, dropped caps, resource limits
- [ ] NetworkPolicy default-deny; DB/Redis private
- [ ] Image signed + SBOM published

**Monitoring & response**
- [ ] Alerts: auth-failure spike, refresh-reuse, webhook-signature failures, 5xx, latency SLO burn
- [ ] Incident runbook + data-breach notification procedure

---

## 15. Compliance & audit trail

**Regulatory posture:** design to HIPAA-style safeguards and India's **DPDP Act 2023** principles (purpose limitation, consent, minimisation, erasure, breach notification). Not a certification claim; document the mapping.

### 15.1 What is audited

| Category | Actions (examples) |
|---|---|
| Auth | `auth.login.success/failure`, `auth.mfa.enabled`, `auth.refresh_reuse_detected`, `auth.password.changed`, `auth.logout_all` |
| PHI access | `consultation.read`, `prescription.read`, `prescription.issue`, `profile.read` (by non-owner) |
| Business | `consultation.book/cancel/start/complete`, `slot.create/delete`, `payment.succeeded/refunded` |
| Admin | `user.suspend`, `user.role_change`, `doctor.verify`, `audit.query`, `analytics.view` |
| Denials | every `403`/ownership failure → `outcome=DENIED` |

### 15.2 Design

* `audit.record(trx, entry)` is called **inside the business transaction** → no change without its audit row (atomic). Denials/auth failures are recorded in their own small transaction.
* **Hash chain:** `shard = crc32(resource_id || actor_id) % 16`; lock `audit_chain_heads[shard]` (`FOR UPDATE`), `seq = last_seq+1`, `hash = sha256(prev_hash || canonicalJson({id, created_at, seq, actor_id, action, resource_type, resource_id, outcome, metadata}))`, update head. Lock is taken as the **last** statement before commit to minimise contention.
* **Verification:** `GET /admin/audit-logs/verify` and a nightly job recompute chains; mismatch → page the on-call (`audit_chain_broken_total`).
* **Immutability:** triggers reject `UPDATE/DELETE/TRUNCATE`; `app_rw` role has `INSERT, SELECT` only; monthly partitions exported to S3 with **Object Lock (WORM)**.
* **Metadata rule:** only ids and field *names* — never PHI values.

### 15.3 Data-subject rights
Export (optional bonus endpoint): `GET /users/me/export` (owner only, async job, short-lived signed link). Erasure: `DELETE /users/me` anonymises PII, keeps clinical records for the legal retention period with pseudonymised identifiers. Consent captured at registration (`consent_version`, `consented_at` on `users`; add the two columns in migration 002 if implementing).

---
## 16. Observability

### 16.1 Three pillars

| Pillar | Implementation |
|---|---|
| **Metrics** | `prom-client` at `/metrics` (default + custom); Prometheus scrapes API and worker; Grafana dashboards provisioned from `infra/observability/grafana/` |
| **Logs** | `pino` JSON to stdout → Promtail → Loki (or CloudWatch). One access-log line per request via `pino-http` |
| **Traces** | OpenTelemetry Node SDK: auto-instrumentation for `http`, `express`, `pg`, `ioredis`; manual spans for `booking.saga.*`, `outbox.relay`, `payment.gateway.*`; OTLP → collector → Jaeger/Tempo. `traceparent` is stored in `outbox_events` and job data so a trace spans API → worker |

**Correlation:** every log line carries `requestId`, `traceId`, `spanId`, `userId` (uuid only), `role`, `route`. Response header `X-Request-Id` equals the log field; problem+json includes it.

**Log redaction (pino `redact`):** `req.headers.authorization`, `req.headers.cookie`, `*.password`, `*.token`, `*.refreshToken`, `*.code`, `*.secret`, `*.reason`, `*.notes`, `*.diagnosis`, `*.payload`. Never log request/response bodies for clinical routes. Test: `tests/security/log-redaction.test.ts` posts PHI and greps captured logs.

### 16.2 Custom metrics (names are contract; label cardinality kept low — use route templates, never raw URLs/ids)

| Metric | Type | Labels |
|---|---|---|
| `http_request_duration_seconds` | histogram (buckets 5ms…5s) | `method, route, status_class` |
| `http_requests_total` | counter | `method, route, status` |
| `db_query_duration_seconds` | histogram | `operation` |
| `db_pool_connections` | gauge | `state=total\|idle\|waiting` |
| `db_tx_retries_total` | counter | `reason` |
| `cache_requests_total` | counter | `cache, result=hit\|miss\|error` |
| `bookings_total` | counter | `result=created\|slot_conflict\|replayed\|error` |
| `consultations_by_status` | gauge (sampled by job) | `status` |
| `saga_compensations_total` | counter | `type=expired\|payment_failed\|late_payment_refund` |
| `payments_total` | counter | `status` |
| `idempotent_replays_total` | counter | `route` |
| `outbox_lag_seconds` | gauge | — (age of oldest unpublished event) |
| `queue_depth` / `queue_failed` | gauge | `queue` |
| `job_duration_seconds` | histogram | `job, result` |
| `auth_events_total` | counter | `event=login_ok\|login_fail\|mfa_fail\|refresh_reuse\|locked` |
| `rate_limited_total` | counter | `route` |
| `webhook_signature_failures_total` | counter | — |
| `audit_write_failures_total`, `audit_chain_broken_total` | counter | — |
| `circuit_breaker_state` | gauge (0 closed,1 half,2 open) | `name` |
| `pg_replica_lag_seconds` | gauge | — |
| Node defaults | — | event-loop lag, heap, GC |

### 16.3 SLOs & alerting (`infra/observability/alerts.yml`)

| SLO | Target | SLI |
|---|---|---|
| Availability | **99.95 %** / 30 d (error budget ≈ 21.6 min) | non-5xx ÷ total on API routes, excluding 4xx |
| Read latency | p95 < 200 ms | `histogram_quantile(0.95, http_request_duration_seconds{method="GET"})` |
| Write latency | p95 < 500 ms | same, `method=~"POST\|PATCH\|PUT\|DELETE"` |

| Alert | Condition | Severity |
|---|---|---|
| Error-budget fast burn | 5xx ratio > 14.4 × budget over 1 h **and** 5 m | page |
| Error-budget slow burn | > 6 × budget over 6 h **and** 30 m | page |
| Read p95 high | > 200 ms for 10 m | ticket → page if 30 m |
| Write p95 high | > 500 ms for 10 m | ticket → page if 30 m |
| Outbox lag | `outbox_lag_seconds > 60` for 5 m | page |
| DLQ not empty | `queue_failed{queue=~".*dlq"} > 0` | ticket |
| Payment breaker open | `circuit_breaker_state{name="payment"} == 2` 2 m | page |
| Auth attack | `rate(auth_events_total{event="login_fail"}[5m])` > 5× baseline | ticket |
| Refresh reuse / webhook sig failures | any in 5 m | ticket (security) |
| Audit chain broken | `increase(audit_chain_broken_total[1h]) > 0` | **page** |
| DB pool saturation | `db_pool_connections{state="waiting"} > 0` 5 m | ticket |
| Replica lag | > 10 s for 5 m | ticket |
| Pods not ready / crash loop | k8s rules | page |

### 16.4 Dashboards (Grafana JSON committed)
1. **API overview** — RPS, error %, p50/p95/p99 by route, SLO burn. 2. **Booking funnel** — bookings created/conflicts/replays, PENDING→CONFIRMED conversion, expirations, compensations. 3. **Dependencies** — DB pool, query latency, cache hit ratio, Redis latency, circuit breaker. 4. **Workers** — queue depth, job latency, failures, outbox lag. 5. **Security** — auth failures, lockouts, rate-limited, refresh-reuse, webhook failures.

---

## 17. Testing strategy

### 17.1 Pyramid & tooling

| Layer | Tooling | Scope | Runs in |
|---|---|---|---|
| Unit | Jest | state machine, retry/backoff, encryption round-trip + rotation, hash chain, pagination cursor, RBAC policy, token service, idempotency hashing | every commit |
| Integration | Jest + Supertest + **Testcontainers** (real PG 16 + Redis 7); migrations applied for real | each module's HTTP behaviour, DB constraints, outbox, workers | CI + local |
| Concurrency | Jest with `Promise.all` against real PG | race conditions | CI |
| Contract | `jest-openapi` | responses match `docs/openapi.yaml` | CI |
| Security | Jest | RBAC matrix, IDOR, injection payloads, rate limits, log redaction | CI |
| E2E | Jest sequence | register → verify doctor → slots → search → book → pay (simulate) → complete → prescribe → read → admin analytics | CI (nightly + PR) |
| Load | **k6** | read 350 rps / write 50 rps profile with thresholds | nightly / manual |

Targets: **≥ 80 % line coverage overall, ≥ 90 % on `consultations`, `payments`, `idempotency`, `auth`, `crypto`**; coverage gate enforced in `jest.config.ts`.

### 17.2 Mandatory test cases (checklist for Copilot)

**Auth & users**
- [ ] register patient/doctor; duplicate email; weak password (422)
- [ ] login success; wrong password and unknown email return identical response; lockout after 5 failures; `Retry-After`
- [ ] MFA: enrol, verify, replay of same TOTP rejected, backup code single-use, doctor forced enrolment limited token
- [ ] refresh rotation; **reuse of old refresh token revokes family**
- [ ] `tokens_valid_after` invalidates old access tokens after password change
- [ ] JWT: tampered signature, `alg: none`, expired, wrong `aud`, unknown `kid` → 401

**RBAC / authorization**
- [ ] matrix test enumerates all registered routes × roles against §7.4 expectations
- [ ] patient A → patient B's consultation/prescription → **404**
- [ ] doctor A → doctor B's consultation/slots → 404
- [ ] admin cannot read prescription/notes

**Availability & booking**
- [ ] overlapping slots rejected (exclusion constraint); past slots rejected
- [ ] **race: 50 concurrent bookings of one slot → exactly 1 × 201, 49 × 409, exactly 1 consultation row**
- [ ] hold expiry: expired hold can be re-booked by someone else
- [ ] patient cannot hold overlapping consultations; max 3 pending payments
- [ ] booking returns < 500 ms (assert in integration test with generous CI bound)

**Idempotency**
- [ ] same key + same body → same response + `Idempotent-Replayed`, one row
- [ ] same key + different body → 422
- [ ] 20 parallel identical requests → one row
- [ ] missing key on 🔁 route → 422
- [ ] same key, different user → independent
- [ ] webhook duplicate event id → no double confirmation

**Payments & saga**
- [ ] valid webhook confirms: consultation CONFIRMED, slot BOOKED
- [ ] bad signature / stale timestamp → 401, metric incremented
- [ ] payment.failed → slot released
- [ ] expiry job releases slot and marks EXPIRED
- [ ] late success after expiry → auto-refund path
- [ ] gateway down → breaker opens, booking still succeeds, intent created after recovery
- [ ] refund policy table (24 h / 50 % / doctor cancel)

**Consultation lifecycle & prescriptions**
- [ ] every legal transition succeeds; every illegal transition → 409
- [ ] only treating doctor may start/complete/prescribe
- [ ] prescription v2 revokes v1; content encrypted in DB (raw query shows `v1:` ciphertext, no plaintext)
- [ ] prescription read is audited

**Search**
- [ ] each filter, combined filters, sort orders, keyset pagination stable with ties, no duplicates across pages
- [ ] unverified doctors hidden; SQL-injection strings in `q` are inert
- [ ] cache hit on second call; invalidation after doctor update

**Security & hardening**
- [ ] rate limit returns 429 + `Retry-After`
- [ ] unknown fields rejected (mass assignment of `role`)
- [ ] 5xx response contains no stack trace
- [ ] logs contain no PHI/secrets (redaction test)
- [ ] encryption: round-trip, tamper detection (GCM tag), AAD mismatch fails, **key rotation**: old data readable after switching active version, `reencrypt` migrates all rows

**Audit**
- [ ] each write produces exactly one audit row in same txn (rolled-back txn → no audit row)
- [ ] `UPDATE/DELETE audit_logs` raises; chain verifies; manually corrupted row detected

**Ops**
- [ ] `/health/ready` 503 when DB down; graceful shutdown finishes in-flight requests
- [ ] OpenAPI document validates; every route documented

### 17.3 Load test (k6) — `scripts/k6/`

```js
export const options = {
  scenarios: {
    reads:  { executor: 'constant-arrival-rate', rate: 350, timeUnit: '1s', duration: '10m', preAllocatedVUs: 200, exec: 'search' },
    writes: { executor: 'constant-arrival-rate', rate: 50,  timeUnit: '1s', duration: '10m', preAllocatedVUs: 100, exec: 'book'   },
  },
  thresholds: {
    'http_req_duration{scenario:reads}':  ['p(95)<200'],
    'http_req_duration{scenario:writes}': ['p(95)<500'],
    http_req_failed: ['rate<0.001'],
  },
};
```
Pre-seed 5 k doctors, 500 k slots, 100 k patients (`npm run seed:load`). Save the k6 summary and Grafana screenshot in `docs/perf/` — evidence for the Scalability rubric.

---

## 18. Docker, CI/CD, infrastructure as code

### 18.1 `infra/docker/Dockerfile` (multi-stage, non-root)

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/live || exit 1
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/server.js"]          # worker: command: ["node","dist/worker.js"]
```
`.dockerignore`: `node_modules`, `.git`, `.env*`, `tests`, `docs`, `infra`.

### 18.2 `infra/docker/docker-compose.yml` (local = full stack incl. observability)

```yaml
name: amrutam
x-app-env: &app-env
  NODE_ENV: development
  DATABASE_URL: postgres://amrutam:amrutam@postgres:5432/amrutam
  REDIS_URL: redis://redis:6379
  JWT_KEYS: '{"k1":"ZGV2LW9ubHktMzItYnl0ZS1zZWNyZXQtYWFhYWFhYWE="}'
  JWT_ACTIVE_KID: k1
  ENC_KEYS: '{"1":"ZGV2LW9ubHktMzItYnl0ZS1lbmMta2V5LWFhYWFhYWE="}'
  ENC_ACTIVE_VERSION: "1"
  PAYMENT_PROVIDER: mock
  PAYMENT_WEBHOOK_SECRET: dev-webhook-secret
  OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
  METRICS_TOKEN: dev-metrics-token

services:
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: amrutam, POSTGRES_PASSWORD: amrutam, POSTGRES_DB: amrutam }
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL","pg_isready -U amrutam"], interval: 5s, retries: 10 }

  redis:
    image: redis:7-alpine
    command: ["redis-server","--appendonly","yes"]
    ports: ["6379:6379"]
    healthcheck: { test: ["CMD","redis-cli","ping"], interval: 5s, retries: 10 }

  migrate:
    build: { context: ../.., dockerfile: infra/docker/Dockerfile }
    command: ["npx","node-pg-migrate","up","-m","migrations"]
    environment: *app-env
    depends_on: { postgres: { condition: service_healthy } }
    restart: "no"

  api:
    build: { context: ../.., dockerfile: infra/docker/Dockerfile }
    environment: *app-env
    ports: ["3000:3000"]
    depends_on:
      migrate: { condition: service_completed_successfully }
      redis:   { condition: service_healthy }

  worker:
    build: { context: ../.., dockerfile: infra/docker/Dockerfile }
    command: ["node","dist/worker.js"]
    environment: *app-env
    depends_on:
      migrate: { condition: service_completed_successfully }
      redis:   { condition: service_healthy }

  mailhog:      { image: mailhog/mailhog, ports: ["8025:8025"] }
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.104.0
    command: ["--config=/etc/otel.yaml"]
    volumes: ["../observability/otel-collector.yaml:/etc/otel.yaml:ro"]
  jaeger:       { image: jaegertracing/all-in-one:1.58, ports: ["16686:16686"] }
  prometheus:
    image: prom/prometheus:v2.53.0
    volumes: ["../observability/prometheus.yml:/etc/prometheus/prometheus.yml:ro","../observability/alerts.yml:/etc/prometheus/alerts.yml:ro"]
    ports: ["9090:9090"]
  grafana:
    image: grafana/grafana:11.1.0
    volumes: ["../observability/grafana:/etc/grafana/provisioning:ro"]
    ports: ["3001:3000"]
  loki:         { image: grafana/loki:3.1.0, ports: ["3100:3100"] }

volumes: { pgdata: {} }
```
(The base64 values above are dev-only placeholders; `.env.example` explains how to generate real ones: `openssl rand -base64 32`.) `docker compose up --build` must give a working API at `:3000/docs` with data from `npm run seed`.

### 18.3 CI/CD — `.github/workflows/ci.yml`

```yaml
name: ci
on: { pull_request: {}, push: { branches: [main] } }
permissions: { contents: read }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4          # pin to commit SHA in real repo
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run openapi:generate && git diff --exit-code docs/openapi.yaml
      - run: npx @stoplight/spectral-cli lint docs/openapi.yaml

  test:
    runs-on: ubuntu-latest
    needs: quality
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_USER: test, POSTGRES_PASSWORD: test, POSTGRES_DB: test }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U test" --health-interval 5s --health-retries 10
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
    env:
      DATABASE_URL: postgres://test:test@localhost:5432/test
      REDIS_URL: redis://localhost:6379
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npm run migrate:up
      - run: npm run test:ci          # unit + integration + concurrency + security + e2e, with coverage gate
      - uses: actions/upload-artifact@v4
        with: { name: coverage, path: coverage }

  security:
    runs-on: ubuntu-latest
    needs: quality
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npm audit --omit=dev --audit-level=high
      - uses: gitleaks/gitleaks-action@v2

  image:
    runs-on: ubuntu-latest
    needs: [test, security]
    permissions: { contents: read, packages: write, id-token: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        if: github.ref == 'refs/heads/main'
        with: { registry: ghcr.io, username: "${{ github.actor }}", password: "${{ secrets.GITHUB_TOKEN }}" }
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: infra/docker/Dockerfile
          push: ${{ github.ref == 'refs/heads/main' }}
          load: ${{ github.ref != 'refs/heads/main' }}
          tags: ghcr.io/${{ github.repository }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - uses: aquasecurity/trivy-action@0.24.0
        with:
          image-ref: ghcr.io/${{ github.repository }}:${{ github.sha }}
          severity: HIGH,CRITICAL
          exit-code: "1"
          ignore-unfixed: true
```
`codeql.yml`: standard CodeQL workflow for `javascript-typescript` on PR + weekly. `deploy.yml`: on `main` success → deploy to **staging** (kubectl/kustomize or ECS) → smoke test (`/health/ready`, one booking via simulate) → **manual approval** environment → production rolling deploy; auto-rollback if readiness fails (`kubectl rollout status --timeout`). DB migrations run as a pre-deploy job and follow **expand → migrate → contract** so old and new pods work against the same schema (zero downtime).

### 18.4 `package.json` scripts

```json
{
  "dev": "tsx watch src/server.ts",
  "dev:worker": "tsx watch src/worker.ts",
  "build": "tsc -p tsconfig.build.json",
  "start": "node dist/server.js",
  "start:worker": "node dist/worker.js",
  "lint": "eslint . --max-warnings 0",
  "typecheck": "tsc --noEmit",
  "test": "jest --selectProjects unit",
  "test:integration": "jest --selectProjects integration",
  "test:ci": "jest --ci --coverage --runInBand",
  "test:load": "k6 run scripts/k6/booking.js",
  "migrate:up": "node-pg-migrate up -m migrations",
  "migrate:down": "node-pg-migrate down -m migrations",
  "migrate:create": "node-pg-migrate create -m migrations --migration-file-language sql",
  "seed": "tsx scripts/seed.ts",
  "seed:load": "tsx scripts/seed.ts --load",
  "admin:create": "tsx scripts/create-admin.ts",
  "openapi:generate": "tsx scripts/generate-openapi.ts",
  "docker:up": "docker compose -f infra/docker/docker-compose.yml up --build"
}
```

### 18.5 Infrastructure as code

**Kubernetes (`infra/k8s/`, kustomize)** — required objects:

| Object | Key settings |
|---|---|
| `Deployment api` | replicas 3, `maxUnavailable: 0`, readiness `/health/ready`, liveness `/health/live`, `terminationGracePeriodSeconds: 30` + `preStop sleep 5`, resources `requests 250m/256Mi, limits 1/512Mi`, `securityContext: runAsNonRoot, readOnlyRootFilesystem, allowPrivilegeEscalation:false, capabilities drop ALL`, topology spread across AZs |
| `Deployment worker` | replicas 2, same hardening, KEDA/HPA on queue depth |
| `HorizontalPodAutoscaler api` | min 3, max 20, CPU 60 % + custom `http_requests_per_second` |
| `PodDisruptionBudget` | `minAvailable: 2` |
| `Service` / `Ingress` | TLS via cert-manager, WAF annotations, body-size 100k |
| `NetworkPolicy` | default deny; allow ingress→api; api/worker→PG, Redis, DNS, payment/email egress only |
| `ConfigMap` / `ExternalSecret` | non-secret config / secrets from AWS Secrets Manager |
| `CronJob backup-verify` | weekly restore test (see §19) |

**Terraform (`infra/terraform/`, AWS reference)**: VPC (3 AZ, private subnets for data) · RDS PostgreSQL 16 **Multi-AZ** + 1 read replica + PITR (35 d) + KMS encryption + parameter group (`rds.force_ssl=1`) · ElastiCache Redis (replication group, Multi-AZ, TLS, AOF) · EKS or ECS Fargate · ALB + WAF (rate rules, OWASP managed rules) · ECR · Secrets Manager + KMS CMK (auto-rotation) · S3 buckets (audit archive with **Object Lock**, backups, versioning, cross-region replication) · CloudWatch/Managed Prometheus & Grafana · IAM with GitHub OIDC (no static keys). Provide `terraform plan` output (or `tflint`/`checkov` pass) in CI even if not applied.

---

## 19. Backup, DR & availability

### 19.1 Objectives

| | Target | How |
|---|---|---|
| **RPO** | ≤ 5 min | Continuous WAL archiving / RDS PITR; synchronous Multi-AZ standby (RPO≈0 for AZ failure) |
| **RTO** | ≤ 30 min (region loss) · ≤ 2 min (AZ/instance loss) | Multi-AZ automatic failover; cross-region replica promotion runbook |
| Availability | 99.95 % | §19.3 |

### 19.2 Backup strategy

| Data | Method | Retention | Verification |
|---|---|---|---|
| PostgreSQL | Daily automated snapshot + **PITR** (WAL, 35 d) + weekly logical `pg_dump --schema-only` for drift review; **cross-region** snapshot copy | 35 d PITR, 12 monthly snapshots | **Weekly automated restore** into scratch instance + row-count/checksum + `audit verify`; quarterly full DR game day |
| Audit archive | Monthly partitions → S3 (Parquet), **Object Lock WORM**, cross-region replication | 7 years | chain verification on restore |
| Redis | AOF every second + replica; **treated as rebuildable** — queue state is reconstructed from the PG outbox | — | outbox replay drill |
| Secrets/keys | Secrets Manager versioned; KMS CMK multi-region | — | rotation drill |
| IaC/config | Git | — | — |

**Restore runbook (`docs/runbooks/restore.md`):** declare incident → freeze writes (maintenance mode flag) → restore PITR to target timestamp → run integrity checks (FK scan, `audit verify`, orphan payments) → repoint `DATABASE_URL` → drain/replay outbox → un-freeze → post-mortem.

**Region-loss DR:** pilot-light in second region (Terraform-provisioned, scaled to 0, cross-region read replica, replicated S3/ECR). Promote replica, scale up pods, flip DNS (Route 53 health-checked failover, TTL 60 s). Reconcile payments with the provider (`payment-reconcile` job queries gateway for the last 24 h to settle any in-flight states).

### 19.3 Availability design (99.95 %)

* ≥ 3 API pods across 3 AZs, PDB, rolling updates with `maxUnavailable: 0`; readiness gates traffic; graceful shutdown (`SIGTERM` → stop accepting, finish in-flight ≤ 25 s, close pools, `/health/ready` → 503).
* Stateless API; sessions are JWT; no sticky sessions.
* Single points removed: Multi-AZ DB, Redis replica, multiple workers with `SKIP LOCKED`.
* Dependency failure isolation: payment gateway behind breaker + outbox; notifications async; Redis optional for reads.
* Zero-downtime migrations (expand/contract); feature flags via env for risky changes.
* Load shedding: rate limits + `503` with `Retry-After` when event-loop lag > 500 ms.
* Chaos checks (bonus): kill a pod, kill Redis, kill replica, block gateway; confirm SLO impact is nil/small.

---

## 20. Implementation roadmap & Copilot prompts

Suggested 5-day schedule; each phase ends with green lint/typecheck/tests and a commit.

| Day | Phase | Deliverable |
|---|---|---|
| 1 | P0 Bootstrap · P1 Foundation · P2 DB | repo, tsconfig, lint, env, app factory, errors, logger, migrations 001–008, Docker compose, CI skeleton |
| 2 | P3 Auth/RBAC/MFA · P4 Users | auth module, tokens, MFA, RBAC middleware, user/profile |
| 3 | P5 Doctors/Search · P6 Availability · P7 Booking + Idempotency | core flow + race tests |
| 4 | P8 Payments/Saga/Workers · P9 Prescriptions · P10 Audit/Analytics | outbox, jobs, webhook, audit chain |
| 5 | P11 Observability · P12 Tests/Load · P13 Infra · P14 Docs & demo | dashboards, k6, k8s/terraform, README, architecture doc, video |

### Copilot prompts (paste one at a time; each assumes this guide is attached with `#file:docs/IMPLEMENTATION_GUIDE.md`)

> **P0** — "Initialise a Node 20 + TypeScript (strict) + Express project per §2 and §4: tsconfig, ESLint (typescript-eslint + security plugin), Prettier, Husky, Jest projects (unit/integration/security/concurrency), `.env.example` from §5, `src/config/env.ts` with zod validation that exits on invalid config, `src/app.ts` factory and `src/server.ts` with graceful shutdown."

> **P1** — "Implement `src/common` per §4: `AppError` hierarchy and RFC 9457 problem+json error handler (§8.1), request-id middleware, pino logger with redaction (§16.1), prom-client metrics registry (§16.2), OpenTelemetry bootstrap, Kysely + `withTx` with retry on 40001/40P01 and `afterCommit` hooks (§11.2), Redis client and `CacheService.getOrLoad` with single-flight (§11.3), `retry()` with full-jitter backoff and opossum circuit-breaker wrapper (§12), awilix container with per-request scope. Add unit tests for retry, withTx retry, cache stampede."

> **P2** — "Create node-pg-migrate SQL migrations 001–008 exactly as in §6.3, plus `down` migrations. Add a Testcontainers helper that boots PG16 + Redis7 and applies migrations. Write `scripts/seed.ts` using §6.5."

> **P3** — "Implement the `auth` module per §7 and §8.2: register, login with lockout, TOTP MFA with backup codes and replay protection, forced MFA enrolment for DOCTOR/ADMIN, access-JWT key ring, refresh rotation with reuse detection, logout/logout-all, password change/forgot/reset. Implement `auth` middleware (verifies alg/kid/aud, checks `tokens_valid_after` via Redis), `requireRole`, `requireMfaStepUp`, and a boot-time check that every route declares access. Include all auth tests from §17.2."

> **P4** — "Implement `users` module (§8.2) with encrypted profile fields via `EncryptionService` (§14.3: AES-256-GCM, versioned keys, AAD, Env and KMS key providers) and the `reencrypt` job. Add admin user-management endpoints with step-up MFA. Tests: encryption round-trip, tamper detection, key rotation."

> **P5** — "Implement `doctors` module per §8.3 and §9.6: upsert profile, verification, `GET /doctors` with FTS + trigram + filters + keyset pagination + cache-aside + read replica. Tests per §17.2 Search. Include an `EXPLAIN` check script."

> **P6** — "Implement `availability` module per §8.4: bulk and recurrence slot creation honouring the exclusion constraint, list, delete, availability view with cache `avail:*`, plus `tryHold`, `release`, `confirm` repository methods used by consultations (§9.1)."

> **P7** — "Implement `idempotency` module (§10.1) and the `consultations` module per §8.5, §9.1–9.3: `book` exactly as the pseudo-code, state machine, cancel with refund policy, start/complete/no-show. Add the race test (50 concurrent bookings → 1 success) and all idempotency tests."

> **P8** — "Implement `outbox` (service + relay), `payments` (gateway interface + mock gateway with circuit breaker, intent creation job, webhook with raw-body HMAC + dedupe + saga transitions, refund job, dev simulate endpoint) and jobs in §13 including `consultation-expiry`, `slot-hold-sweeper`, late-payment auto-refund (§9.4). Tests per §17.2 Payments & saga."

> **P9** — "Implement `prescriptions` per §8.6 with encrypted payload, versioning, ownership rules, async PDF job. Tests per §17.2."

> **P10** — "Implement `audit` (hash chain with 16 shards, immutability, verify endpoint, query endpoint, partition job) per §15 and call `audit.record(trx, …)` from every write path and PHI read. Implement `analytics` (rollup job + overview/timeseries/top-doctors endpoints) per §8.8."

> **P11** — "Add Prometheus metrics, OTel spans (including trace propagation through outbox/jobs), Grafana dashboards, `prometheus.yml`, `alerts.yml` per §16."

> **P12** — "Write remaining tests from §17.2 (RBAC matrix over all routes, log redaction, security payloads, e2e journey), contract tests via jest-openapi, and k6 scripts per §17.3. Enforce coverage thresholds."

> **P13** — "Create Dockerfile, docker-compose, GitHub Actions (ci, codeql, deploy), Dependabot, k8s kustomize base+overlays, Terraform modules per §18."

> **P14** — "Generate `docs/openapi.yaml` from zod registry, write README, `docs/architecture.md` (2–4 pages: §3, §6, §9.1, §11, §19 with diagrams), `docs/threat-model.md`, `docs/security-checklist.md` from §14."

**Definition of done (every phase):** lint clean · types strict · tests written first or alongside · no TODOs left in security paths · OpenAPI updated · metrics + audit hooks present · no PHI in logs.

---

## 21. Demo video script & submission checklist

### 21.1 Five-minute demo (rehearse; screen-record)

| Time | Show |
|---|---|
| 0:00–0:30 | Architecture diagram + capacity math + module structure |
| 0:30–1:15 | `docker compose up`; Swagger UI; seeded data |
| 1:15–2:45 | **Core flow:** patient search → availability → book (show `PENDING_PAYMENT`) → simulate payment → `CONFIRMED` → doctor start/complete → prescription → patient reads it |
| 2:45–3:30 | **Reliability:** replay same Idempotency-Key (same response + header); run the 50-way race test; show payment-failure compensation freeing the slot |
| 3:30–4:15 | **Security:** MFA login, RBAC denial (IDOR → 404), DB shows encrypted columns, audit chain verify |
| 4:15–4:45 | **Observability:** Grafana booking-funnel dashboard, Jaeger trace API → worker, alert rules |
| 4:45–5:00 | CI green, k6 results vs SLO, DR/backup summary |

### 21.2 Final submission checklist (maps to the rubric)

- [ ] **Repo** with code + `infra/` (Docker, k8s, Terraform)
- [ ] **README** (setup in ≤ 5 commands)
- [ ] **OpenAPI** `docs/openapi.yaml` generated and linted
- [ ] **Architecture doc** (2–4 pages): HLD, booking sequence, ER, API overview, retry/backoff, partitioning, caching/concurrency, transactions/sagas, backup/DR
- [ ] **Tests + CI** green (coverage gate, race test, security tests)
- [ ] **Observability** dashboards + alerts + sample trace
- [ ] **Security**: checklist + threat model + data classification + key rotation runbook
- [ ] **Idempotency** demonstrably working (critical)
- [ ] **Critical security** (MFA, RBAC, encryption, rate limit, validation) demonstrably working (critical)
- [ ] **Demo video** ≤ 5 min
- [ ] **Bonus (+10):** k6 load report, chaos test evidence, consultation partitioning migration, read-replica routing, GDPR export endpoint, reschedule flow, OpenTelemetry trace across worker, cosign + SBOM

| Rubric item | Where it's covered |
|---|---|
| Architecture (20) | §3, §6, §9, §11, §19, ADRs |
| Core flows (20) | §8, §9, §10 |
| Code quality (15) | §2, §4 module contract, DI, lint, strict TS |
| Security (10) | §14, §15 |
| Observability (10) | §16 |
| Scalability (10) | §1.3, §6.4, §11, §17.3 |
| Infra/CI (10) | §18, §19 |

---

## 22. Appendices

### Appendix A — `.github/copilot-instructions.md` (copy verbatim)

```markdown
# Project: Amrutam telemedicine backend (Node 20, Express, TypeScript strict, PostgreSQL 16, Redis 7)

Source of truth: docs/IMPLEMENTATION_GUIDE.md. Follow it; do not invent endpoints, tables or states.

## Architecture
- Modular monolith. Each module in src/modules/<name> has: routes, controller, service, repository, schemas.
- Controllers: no business logic, no DB. Services: business rules + transactions. Repositories: Kysely only, accept optional `trx`.
- A module may call another module's SERVICE, never its repository.
- Dependency injection with awilix; never `new` a service inside another service.

## Coding rules
- TypeScript strict; no `any`; no non-null `!` except in tests. Prefer `unknown` + zod parsing.
- Validate ALL input (params, query, body, headers) with zod `.strict()`. Types are inferred from zod schemas.
- Every route is registered with OpenAPI metadata (zod-to-openapi) and declares `requireRole(...)` or `public`.
- SQL: parameterised Kysely only. Never concatenate user input into SQL.
- Never return DB rows from controllers; map to DTOs. Never expose *_enc, password_hash, mfa_secret_enc.
- Errors: throw AppError subclasses; the global handler emits RFC 9457 problem+json. Never leak stack traces.
- Times in UTC (ISO-8601). Money as integer minor units.
- Secrets only from env via src/config/env.ts. Never hardcode secrets or log them.

## Data & concurrency
- Every write path runs in ONE short DB transaction via `withTx`, which also writes audit_logs and outbox_events.
- No network calls inside a DB transaction. External calls happen in workers via the outbox.
- Booking uses the atomic conditional UPDATE on availability_slots (see guide §9.1). Never read-then-write.
- Status changes use optimistic locking: WHERE id=$ AND version=$ AND status=$expected.
- Endpoints marked 🔁 in the guide REQUIRE Idempotency-Key and use the idempotency service (same txn).

## Security (critical)
- Ownership check in every service method touching patient/doctor data; return 404 for foreign records.
- PHI/PII columns (*_enc) go through EncryptionService with AAD "table.column:rowId". Never log or cache PHI.
- Passwords: argon2id. Tokens: JWT key-ring + rotating opaque refresh tokens. MFA mandatory for DOCTOR/ADMIN.
- Webhooks: raw body + HMAC + timestamp + dedupe by event id.

## Observability
- Use the shared logger (pino, redaction on). Use route templates in metric labels. Add spans for saga steps.

## Testing
- Every feature ships with tests: unit + integration (Testcontainers). Security-sensitive code needs negative tests.
- Name tests by behaviour. No sleeps; use fake clock helpers. Run `npm run lint && npm run typecheck && npm test` before finishing.
```

### Appendix B — Error code catalogue

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 422 | zod failure (`errors[]`) |
| `WEAK_PASSWORD` | 422 | fails policy |
| `INVALID_CREDENTIALS` | 401 | bad email/password |
| `INVALID_MFA_CODE` / `MFA_TOKEN_EXPIRED` | 401 | MFA failures |
| `INVALID_REFRESH_TOKEN` | 401 | invalid, expired, or reused |
| `UNAUTHENTICATED` / `TOKEN_EXPIRED` | 401 | missing/invalid access token |
| `FORBIDDEN` / `MFA_STEP_UP_REQUIRED` | 403 | role / needs fresh MFA |
| `ACCOUNT_SUSPENDED` | 403 | |
| `ACCOUNT_LOCKED` | 423 | temporary lock |
| `NOT_FOUND` | 404 | includes "not yours" |
| `EMAIL_TAKEN` | 409 | |
| `SLOT_UNAVAILABLE` / `SLOT_NOT_DELETABLE` | 409 | |
| `PATIENT_DOUBLE_BOOKED` / `TOO_MANY_PENDING_PAYMENTS` | 409 | |
| `INVALID_STATE` / `CONCURRENT_MODIFICATION` / `TOO_LATE_TO_CANCEL` | 409 | state machine / locking |
| `SLOT_TOO_SOON` | 422 | below `MIN_BOOKING_LEAD_MINUTES` |
| `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_REUSED` | 422 | |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | |
| `RATE_LIMITED` | 429 | with `Retry-After` |
| `SERVICE_UNAVAILABLE` | 503 | dependency down / shutting down |
| `INTERNAL_ERROR` | 500 | generic |

### Appendix C — Dependency list

**Runtime:** `express`, `zod`, `@asteasolutions/zod-to-openapi`, `swagger-ui-express`, `pg`, `kysely`, `ioredis`, `bullmq`, `awilix`, `awilix-express`, `jsonwebtoken`, `argon2`, `otplib`, `qrcode`, `helmet`, `cors`, `hpp`, `express-rate-limit`, `rate-limit-redis`, `pino`, `pino-http`, `prom-client`, `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-http`, `opossum`, `pdfkit`, `nodemailer`, `uuid`, `node-pg-migrate`, `dotenv` (dev only).
**Dev:** `typescript`, `tsx`, `jest`, `ts-jest`, `supertest`, `jest-openapi`, `@testcontainers/postgresql`, `@testcontainers/redis`, `eslint`, `typescript-eslint`, `eslint-plugin-security`, `prettier`, `husky`, `lint-staged`, `@types/*`, `k6` (binary).

### Appendix D — Architecture-doc outline (the 2–4 page deliverable)

1. **Context & goals** (½ page): NFRs, capacity math (§1.3).
2. **High-level architecture & data flow**: diagram §3, module boundaries.
3. **Booking flow**: sequence diagram §9.1 + saga table §9.4.
4. **Data model**: ER diagram §6.1, key constraints, partitioning §6.4.
5. **Consistency & concurrency**: idempotency §10, locking/caching §11, retries §12.
6. **Security summary**: link to threat model; encryption, MFA, RBAC.
7. **Observability & SLOs**: §16.3.
8. **Scalability, availability, DR**: §19, load-test results.
9. **Trade-offs & future work**: modular monolith vs microservices, partitioning timing, KMS, read replicas, sharding.
