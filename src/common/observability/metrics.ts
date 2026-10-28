import type { NextFunction, Request, Response } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import { env } from '../../config/env.js';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_class'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
});
export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [metricsRegistry],
});
export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation'],
  registers: [metricsRegistry],
});
export const dbPoolConnections = new Gauge({
  name: 'db_pool_connections',
  help: 'Database pool connections',
  labelNames: ['state'],
  registers: [metricsRegistry],
});
export const dbTxRetries = new Counter({
  name: 'db_tx_retries_total',
  help: 'Database transaction retries',
  labelNames: ['reason'],
  registers: [metricsRegistry],
});
export const cacheRequests = new Counter({
  name: 'cache_requests_total',
  help: 'Cache requests',
  labelNames: ['cache', 'result'],
  registers: [metricsRegistry],
});
export const retries = new Counter({
  name: 'retries_total',
  help: 'Retries by operation',
  labelNames: ['op'],
  registers: [metricsRegistry],
});
export const authEvents = new Counter({
  name: 'auth_events_total',
  help: 'Authentication security events',
  labelNames: ['event'],
  registers: [metricsRegistry],
});
export const rateLimited = new Counter({
  name: 'rate_limited_total',
  help: 'Requests rejected by rate limiting',
  labelNames: ['route'],
  registers: [metricsRegistry],
});
export const webhookSignatureFailures = new Counter({
  name: 'webhook_signature_failures_total',
  help: 'Payment webhook signature validation failures',
  registers: [metricsRegistry],
});

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  res.once('finish', () => {
    const route = req.route?.path ?? 'unmatched';
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
    httpRequestDuration.observe({ method: req.method, route, status_class: statusClass }, seconds);
    httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

export async function metricsHandler(req: Request, res: Response): Promise<void> {
  if (req.header('authorization') !== `Bearer ${env.METRICS_TOKEN}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.type(metricsRegistry.contentType).send(await metricsRegistry.metrics());
}
