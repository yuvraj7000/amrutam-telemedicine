import type { CacheService } from '../../common/cache/cache.service.js';
import { ValidationError } from '../../common/errors/index.js';
import type { AuditContext } from '../audit/hash-chain.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type {
  AnalyticsGranularity,
  AnalyticsMetric,
  AnalyticsRange,
  AnalyticsRepository,
} from './analytics.repository.js';

function validateRange(range: AnalyticsRange): void {
  const start = Date.parse(`${range.from}T00:00:00.000Z`);
  const end = Date.parse(`${range.to}T00:00:00.000Z`);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start ||
    end - start > 366 * 86_400_000
  ) {
    throw new ValidationError(
      'The analytics date range must be ordered and no longer than 367 days.',
    );
  }
}

export class AnalyticsService {
  constructor(
    private readonly repository: AnalyticsRepository,
    private readonly cache: CacheService,
    private readonly audit: AuditRepository,
  ) {}

  async overview(range: AnalyticsRange, actor: AuditContext): Promise<Record<string, unknown>> {
    validateRange(range);
    await this.recordView(actor, ['from', 'to']);
    return this.cache.getOrLoad(`analytics:overview:${range.from}:${range.to}`, 60, () =>
      this.repository.overview(range),
    );
  }

  async timeseries(
    metric: AnalyticsMetric,
    granularity: AnalyticsGranularity,
    range: AnalyticsRange,
    actor: AuditContext,
  ) {
    validateRange(range);
    await this.recordView(actor, ['metric', 'granularity', 'from', 'to']);
    return this.repository.timeseries(metric, granularity, range);
  }

  async topDoctors(
    by: 'consultations' | 'revenue' | 'rating',
    range: AnalyticsRange,
    limit: number,
    actor: AuditContext,
  ) {
    validateRange(range);
    await this.recordView(actor, ['by', 'limit', 'from', 'to']);
    return this.repository.topDoctors(by, range, limit);
  }

  private async recordView(actor: AuditContext, fields: string[]): Promise<void> {
    await this.audit.record({
      ...actor,
      action: 'analytics.view',
      resourceType: 'analytics',
      outcome: 'SUCCESS',
      metadata: { fields },
    });
  }
}
