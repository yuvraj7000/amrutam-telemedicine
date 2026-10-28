import { basename } from 'node:path';
import { createServer, type Server } from 'node:http';

import { context, trace } from '@opentelemetry/api';
import { Worker, type Job } from 'bullmq';
import { Gauge, Histogram } from 'prom-client';

import { container } from './container.js';
import type { EncryptionService } from './common/crypto/encryption.service.js';
import { primaryPool, closeDatabase } from './common/db/kysely.js';
import { metricsRegistry } from './common/observability/metrics.js';
import { logger } from './common/observability/logger.js';
import { startTracing, stopTracing } from './common/observability/tracing.js';
import { closeRedis } from './common/cache/redis.js';
import { env } from './config/env.js';
import {
  deadLetterQueues,
  queues,
  queueNames,
  createQueueConnection,
  closeQueues,
  type JobPayload,
  type QueueName,
} from './jobs/queues.js';
import { startScheduler } from './jobs/scheduler.js';
import { processAnalyticsRollup } from './jobs/processors/analytics-rollup.processor.js';
import { processAuditPartition } from './jobs/processors/audit-partition.processor.js';
import { processConsultationExpiry } from './jobs/processors/consultation-expiry.processor.js';
import { processIdempotencyCleanup } from './jobs/processors/idempotency-cleanup.processor.js';
import { processOutboxRelay } from './jobs/processors/outbox-relay.processor.js';
import { processPaymentIntent } from './jobs/processors/payment-intent.processor.js';
import { processPrescriptionPdf } from './jobs/processors/prescription-pdf.processor.js';
import { processReencrypt } from './jobs/processors/reencrypt.processor.js';
import { processRefund } from './jobs/processors/refund.processor.js';
import { processSlotHoldExpiry } from './jobs/processors/slot-expiry.processor.js';
import { configurePaymentIntentGateway } from './jobs/processors/payment-intent.processor.js';
import { MockPaymentGateway } from './modules/payments/gateway/mock-gateway.js';
import { markOutboxPublished } from './modules/outbox/outbox.service.js';

const workerConnection = createQueueConnection();

const workerConcurrency: Record<QueueName, number> = {
  'outbox-relay': 1,
  'payment-intent': 10,
  'payment-refund': 5,
  'prescription-pdf': 3,
  'consultation-expiry': 1,
  'slot-hold-sweeper': 1,
  'analytics-rollup': 1,
  'audit-partition': 1,
  'idempotency-cleanup': 1,
  reencrypt: 2,
};

const queueDepth = new Gauge({
  name: 'queue_depth',
  help: 'Waiting and delayed jobs by queue',
  labelNames: ['queue'],
  registers: [metricsRegistry],
});
const queueFailed = new Gauge({
  name: 'queue_failed',
  help: 'Failed jobs by queue',
  labelNames: ['queue'],
  registers: [metricsRegistry],
});
const outboxLag = new Gauge({
  name: 'outbox_lag_seconds',
  help: 'Age of the oldest unpublished outbox event',
  registers: [metricsRegistry],
});
const jobDuration = new Histogram({
  name: 'job_duration_seconds',
  help: 'Worker job duration',
  labelNames: ['job', 'result'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300],
  registers: [metricsRegistry],
});

function parentTraceContext(traceparent: unknown): ReturnType<typeof context.active> {
  if (typeof traceparent !== 'string') return context.active();
  const parsed = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(traceparent);
  if (!parsed || /^0+$/.test(parsed[1] ?? '') || /^0+$/.test(parsed[2] ?? '')) {
    return context.active();
  }
  return trace.setSpanContext(context.active(), {
    traceId: parsed[1] as string,
    spanId: parsed[2] as string,
    traceFlags: Number.parseInt(parsed[3] as string, 16),
    isRemote: true,
  });
}

async function dispatch(name: QueueName, job: Job<JobPayload>): Promise<unknown> {
  const data = job.data;
  switch (name) {
    case 'outbox-relay':
      return processOutboxRelay();
    case 'payment-intent':
      return processPaymentIntent(data);
    case 'payment-refund':
      return processRefund(data);
    case 'prescription-pdf':
      return processPrescriptionPdf(data);
    case 'consultation-expiry':
      return processConsultationExpiry();
    case 'slot-hold-sweeper':
      return processSlotHoldExpiry();
    case 'analytics-rollup':
      return processAnalyticsRollup(data);
    case 'audit-partition':
      return processAuditPartition();
    case 'idempotency-cleanup':
      return processIdempotencyCleanup();
    case 'reencrypt':
      return processReencrypt(
        container.resolve<EncryptionService>('encryptionService'),
        container.resolve<{ activeVersion(): number }>('keyProvider').activeVersion(),
        Boolean(env.KMS_KEY_ID),
      );
  }
}

function isFinalAttempt(job: Job<JobPayload>): boolean {
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

async function updateQueueMetrics(): Promise<void> {
  await Promise.all(
    queueNames.map(async (name) => {
      const [counts, failed] = await Promise.all([
        queues[name].getJobCounts('waiting', 'delayed', 'prioritized'),
        queues[name].getFailedCount(),
      ]);
      queueDepth.set(
        { queue: name },
        (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0),
      );
      queueFailed.set({ queue: name }, failed);

      const dlqFailed = await deadLetterQueues[name].getFailedCount();
      queueDepth.set({ queue: `${name}-dlq` }, await deadLetterQueues[name].getWaitingCount());
      queueFailed.set(
        { queue: `${name}-dlq` },
        dlqFailed + (await deadLetterQueues[name].getWaitingCount()),
      );
    }),
  );
  const result = await primaryPool.query<{ age_seconds: number | null }>(
    `SELECT extract(epoch FROM (now() - min(created_at)))::float8 AS age_seconds
     FROM outbox_events WHERE published_at IS NULL`,
  );
  outboxLag.set(result.rows[0]?.age_seconds ?? 0);
}

let workers: Worker<JobPayload>[] = [];
let metricsTimer: NodeJS.Timeout | undefined;
let metricsServer: Server | undefined;
let shuttingDown = false;

async function startMetricsServer(): Promise<void> {
  metricsServer = createServer((request, response) => {
    if (request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${env.METRICS_TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    void metricsRegistry
      .metrics()
      .then((body) => {
        response.writeHead(200, { 'content-type': metricsRegistry.contentType });
        response.end(body);
      })
      .catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve, reject) => {
    metricsServer?.once('error', reject);
    metricsServer?.listen(9464, '0.0.0.0', resolve);
  });
}

export async function shutdownWorker(signal = 'shutdown'): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Worker graceful shutdown started');
  if (metricsTimer) clearInterval(metricsTimer);
  if (metricsServer?.listening) {
    await new Promise<void>((resolve, reject) => {
      metricsServer?.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await Promise.all(workers.map((worker) => worker.close()));
  if (workerConnection.status !== 'end') await workerConnection.quit();
  await Promise.all([closeQueues(), closeDatabase(), closeRedis(), stopTracing()]);
  logger.info('Worker graceful shutdown completed');
}

export async function startWorker(): Promise<void> {
  if (env.PAYMENT_PROVIDER !== 'mock') {
    throw new Error(
      `The ${env.PAYMENT_PROVIDER} payment adapter is not configured in this worker.`,
    );
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('The mock payment provider cannot be used in production.');
  }
  const paymentGateway = new MockPaymentGateway(env.PAYMENT_WEBHOOK_SECRET);
  configurePaymentIntentGateway({
    createIntent: (request) => paymentGateway.createPaymentIntent(request.paymentId),
  });
  startTracing();
  workers = queueNames.map((name) => {
    const worker = new Worker<JobPayload>(
      name,
      async (job) => {
        const startedAt = process.hrtime.bigint();
        const parent = parentTraceContext(job.data.traceparent);
        const tracer = trace.getTracer('amrutam-worker');
        return context.with(parent, () =>
          tracer.startActiveSpan(`worker.${name}`, async (span) => {
            try {
              const result = await dispatch(name, job);
              if (typeof job.data.eventId === 'string') {
                await markOutboxPublished(job.data.eventId);
              }
              jobDuration.observe(
                { job: name, result: 'success' },
                Number(process.hrtime.bigint() - startedAt) / 1e9,
              );
              return result;
            } catch (error) {
              jobDuration.observe(
                { job: name, result: 'failure' },
                Number(process.hrtime.bigint() - startedAt) / 1e9,
              );
              throw error;
            } finally {
              span.end();
            }
          }),
        );
      },
      { connection: workerConnection, concurrency: workerConcurrency[name] },
    );
    worker.on('completed', (job) => {
      logger.info({ queue: name, jobId: job.id }, 'Worker job completed');
    });
    worker.on('failed', (job, error) => {
      if (!job) return;
      logger.error(
        {
          queue: name,
          jobId: job.id,
          attemptsMade: job.attemptsMade,
          errorType: error instanceof Error ? error.name : 'unknown',
        },
        'Worker job failed',
      );
      if (!isFinalAttempt(job)) return;
      const deadLetterId = `failed-${String(job.id).replace(/:/g, '-')}`;
      void deadLetterQueues[name]
        .add(
          'dead-letter',
          {
            originalJobId: job.id,
            originalQueue: name,
            attemptsMade: job.attemptsMade,
            failureType: error instanceof Error ? error.name : 'unknown',
            eventId: job.data.eventId,
            eventType: job.data.eventType,
            aggregateType: job.data.aggregateType,
            aggregateId: job.data.aggregateId,
          },
          { jobId: deadLetterId },
        )
        .catch((deadLetterError: unknown) => {
          logger.error(
            {
              queue: name,
              jobId: job.id,
              errorType: deadLetterError instanceof Error ? deadLetterError.name : 'unknown',
            },
            'Unable to persist failed job to dead-letter queue',
          );
        });
    });
    worker.on('error', (error) =>
      logger.error(
        { queue: name, errorType: error instanceof Error ? error.name : 'unknown' },
        'Worker error',
      ),
    );
    return worker;
  });

  await startScheduler();
  await startMetricsServer();
  metricsTimer = setInterval(() => {
    void updateQueueMetrics().catch((error: unknown) => {
      logger.error(
        { errorType: error instanceof Error ? error.name : 'unknown' },
        'Unable to update worker metrics',
      );
    });
  }, 15_000);
  metricsTimer.unref();
  await updateQueueMetrics();
  logger.info({ queues: queueNames.length }, 'Background worker started');
}

if (['worker.js', 'worker.ts'].includes(basename(process.argv[1] ?? ''))) {
  process.once('SIGTERM', () => {
    void shutdownWorker('SIGTERM').catch((error: unknown) => {
      logger.error(
        { errorType: error instanceof Error ? error.name : 'unknown' },
        'Worker shutdown failed',
      );
      process.exitCode = 1;
    });
  });
  process.once('SIGINT', () => {
    void shutdownWorker('SIGINT').catch((error: unknown) => {
      logger.error(
        { errorType: error instanceof Error ? error.name : 'unknown' },
        'Worker shutdown failed',
      );
      process.exitCode = 1;
    });
  });
  void startWorker().catch((error: unknown) => {
    logger.error(
      { errorType: error instanceof Error ? error.name : 'unknown' },
      'Worker startup failed',
    );
    process.exitCode = 1;
    void shutdownWorker('startup-failure');
  });
}
