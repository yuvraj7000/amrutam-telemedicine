import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';

const migrationDirectory = 'migrations';

export interface TestContainers {
  postgres: StartedPostgreSqlContainer;
  redis: StartedRedisContainer;
  pool: Pool;
}

export async function applyMigrations(
  databaseUrl: string,
  direction: 'up' | 'down',
  count?: number,
) {
  await runner({
    databaseUrl,
    dir: migrationDirectory,
    direction,
    count,
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    singleTransaction: true,
  });
}

export async function startTestContainers(): Promise<TestContainers> {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('amrutam_test')
      .withUsername('amrutam')
      .withPassword('amrutam')
      .start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  const pool = new Pool({ connectionString: postgres.getConnectionUri() });
  await applyMigrations(postgres.getConnectionUri(), 'up');
  return { postgres, redis, pool };
}

export async function stopTestContainers(containers: TestContainers): Promise<void> {
  await containers.pool.end();
  await Promise.all([containers.postgres.stop(), containers.redis.stop()]);
}
