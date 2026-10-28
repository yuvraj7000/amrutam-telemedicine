import type { Queue } from 'bullmq';

import { logger } from '../common/observability/logger.js';
import { queues, type JobPayload, type QueueName } from './queues.js';

interface Schedule {
  queue: Queue<JobPayload>;
  id: string;
  every?: number;
  pattern?: string;
  data?: JobPayload;
}

const schedules: Schedule[] = [
  { queue: queues['outbox-relay'], id: 'relay-pending-outbox', every: 1_000 },
  { queue: queues['consultation-expiry'], id: 'expire-pending-consultations', every: 30_000 },
  { queue: queues['slot-hold-sweeper'], id: 'sweep-expired-slot-holds', every: 60_000 },
  { queue: queues['analytics-rollup'], id: 'hourly-analytics-rollup', every: 3_600_000 },
  {
    queue: queues['analytics-rollup'],
    id: 'nightly-analytics-recompute',
    pattern: '5 0 * * *',
    data: { dayOffset: 1 },
  },
  { queue: queues['audit-partition'], id: 'create-audit-partitions', pattern: '0 0 * * *' },
  { queue: queues['idempotency-cleanup'], id: 'cleanup-expired-records', every: 3_600_000 },
];

export async function startScheduler(): Promise<void> {
  for (const schedule of schedules) {
    await schedule.queue.upsertJobScheduler(
      schedule.id,
      schedule.every
        ? { every: schedule.every }
        : { pattern: schedule.pattern as string, tz: 'UTC' },
      {
        name: 'run',
        data: schedule.data ?? {},
        opts: {
          attempts: 8,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: 1_000,
          removeOnFail: false,
        },
      },
    );
    logger.info(
      { scheduler: schedule.id, queue: schedule.queue.name },
      'Worker schedule registered',
    );
  }
}

export async function enqueueReencryption(): Promise<void> {
  const queueName: QueueName = 'reencrypt';
  await queues[queueName].add('run', {}, { jobId: `reencrypt-${Date.now()}` });
}
