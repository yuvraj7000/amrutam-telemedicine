import { Queue, type JobsOptions } from 'bullmq';
import Redis from 'ioredis';

import { env } from '../config/env.js';

export const queueNames = [
  'outbox-relay',
  'payment-intent',
  'payment-refund',
  'prescription-pdf',
  'consultation-expiry',
  'slot-hold-sweeper',
  'analytics-rollup',
  'audit-partition',
  'idempotency-cleanup',
  'reencrypt',
] as const;

export type QueueName = (typeof queueNames)[number];
export type JobPayload = Record<string, unknown>;

const defaultJobOptions: JobsOptions = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: 1_000,
  removeOnFail: false,
};

export function createQueueConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

const queueConnection = createQueueConnection();

export const queues = Object.fromEntries(
  queueNames.map((name) => [
    name,
    new Queue<JobPayload>(name, {
      connection: queueConnection,
      defaultJobOptions,
    }),
  ]),
) as Record<QueueName, Queue<JobPayload>>;

export const deadLetterQueues = Object.fromEntries(
  queueNames.map((name) => [
    name,
    new Queue<JobPayload>(`${name}-dlq`, {
      connection: queueConnection,
      defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
    }),
  ]),
) as Record<QueueName, Queue<JobPayload>>;

export async function closeQueues(): Promise<void> {
  await Promise.all([
    ...Object.values(queues).map((queue) => queue.close()),
    ...Object.values(deadLetterQueues).map((queue) => queue.close()),
  ]);
  if (queueConnection.status !== 'end') await queueConnection.quit();
}
