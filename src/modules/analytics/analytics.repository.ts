import { primaryPool, readPool } from '../../common/db/kysely.js';

const analyticsPool = readPool ?? primaryPool;

const GLOBAL_DOCTOR_ID = '00000000-0000-0000-0000-000000000000';
export type AnalyticsRange = { from: string; to: string };
export type AnalyticsMetric = 'consultations' | 'revenue' | 'cancellations';
export type AnalyticsGranularity = 'day' | 'week';

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

export class AnalyticsRepository {
  async overview(range: AnalyticsRange): Promise<Record<string, unknown>> {
    const [historical, today, activeDoctors] = await Promise.all([
      analyticsPool.query<Record<string, unknown>>(
        `WITH per_day AS (
           SELECT day,
             CASE WHEN COUNT(*) FILTER (WHERE doctor_id=$3)>0
               THEN MAX(consultations_total) FILTER (WHERE doctor_id=$3)
               ELSE COALESCE(SUM(consultations_total) FILTER (WHERE doctor_id<>$3),0) END consultations,
             CASE WHEN COUNT(*) FILTER (WHERE doctor_id=$3)>0
               THEN MAX(completed) FILTER (WHERE doctor_id=$3)
               ELSE COALESCE(SUM(completed) FILTER (WHERE doctor_id<>$3),0) END completed,
             CASE WHEN COUNT(*) FILTER (WHERE doctor_id=$3)>0
               THEN MAX(cancelled) FILTER (WHERE doctor_id=$3)
               ELSE COALESCE(SUM(cancelled) FILTER (WHERE doctor_id<>$3),0) END cancelled,
             CASE WHEN COUNT(*) FILTER (WHERE doctor_id=$3)>0
               THEN MAX(no_show) FILTER (WHERE doctor_id=$3)
               ELSE COALESCE(SUM(no_show) FILTER (WHERE doctor_id<>$3),0) END no_show,
             CASE WHEN COUNT(*) FILTER (WHERE doctor_id=$3)>0
               THEN MAX(revenue_minor) FILTER (WHERE doctor_id=$3)
               ELSE COALESCE(SUM(revenue_minor) FILTER (WHERE doctor_id<>$3),0) END revenue_minor,
             CASE WHEN COUNT(*) FILTER (WHERE doctor_id=$3)>0
               THEN MAX(refunds_minor) FILTER (WHERE doctor_id=$3)
               ELSE COALESCE(SUM(refunds_minor) FILTER (WHERE doctor_id<>$3),0) END refunds_minor,
             CASE WHEN COUNT(*) FILTER (WHERE doctor_id=$3)>0
               THEN MAX(new_patients) FILTER (WHERE doctor_id=$3)
               ELSE COALESCE(SUM(new_patients) FILTER (WHERE doctor_id<>$3),0) END new_patients,
             CASE WHEN COUNT(*) FILTER (WHERE doctor_id=$3)>0
               THEN MAX(avg_lead_hours) FILTER (WHERE doctor_id=$3)
               ELSE AVG(avg_lead_hours) FILTER (WHERE doctor_id<>$3) END avg_lead_hours
           FROM analytics_daily
          WHERE day >= $1::date AND day <= $2::date AND day < CURRENT_DATE
          GROUP BY day
         )
         SELECT COALESCE(SUM(consultations),0) consultations,COALESCE(SUM(completed),0) completed,
                COALESCE(SUM(cancelled),0) cancelled,COALESCE(SUM(no_show),0) no_show,
                COALESCE(SUM(revenue_minor),0) revenue_minor,COALESCE(SUM(refunds_minor),0) refunds_minor,
                COALESCE(SUM(new_patients),0) new_patients,AVG(avg_lead_hours) avg_lead_hours
           FROM per_day`,
        [range.from, range.to, GLOBAL_DOCTOR_ID],
      ),
      analyticsPool.query<Record<string, unknown>>(
        `SELECT
           (SELECT COUNT(*) FROM consultations c WHERE c.scheduled_start::date=CURRENT_DATE) consultations,
           (SELECT COUNT(*) FROM consultations c WHERE c.scheduled_start::date=CURRENT_DATE AND c.status='COMPLETED') completed,
           (SELECT COUNT(*) FROM consultations c WHERE c.scheduled_start::date=CURRENT_DATE AND c.status='CANCELLED') cancelled,
           (SELECT COUNT(*) FROM consultations c WHERE c.scheduled_start::date=CURRENT_DATE AND c.status='NO_SHOW') no_show,
           (SELECT COALESCE(SUM(p.amount_minor) FILTER (WHERE p.status IN ('SUCCEEDED','REFUNDED','PARTIALLY_REFUNDED')),0)
              FROM payments p JOIN consultations c ON c.id=p.consultation_id
             WHERE c.scheduled_start::date=CURRENT_DATE) revenue_minor,
           (SELECT COALESCE(SUM(p.refunded_minor),0)
              FROM payments p JOIN consultations c ON c.id=p.consultation_id
             WHERE c.scheduled_start::date=CURRENT_DATE) refunds_minor,
           (SELECT COUNT(*) FROM users u WHERE u.role='PATIENT' AND u.created_at::date=CURRENT_DATE) new_patients,
           (SELECT AVG(EXTRACT(EPOCH FROM (c.scheduled_start-c.created_at))/3600.0)
              FROM consultations c WHERE c.scheduled_start::date=CURRENT_DATE) avg_lead_hours
         WHERE CURRENT_DATE BETWEEN $1::date AND $2::date`,
        [range.from, range.to],
      ),
      analyticsPool.query<{ count: string }>(
        `SELECT COUNT(*) count FROM doctors d JOIN users u ON u.id=d.user_id
          WHERE d.verification_status='VERIFIED' AND d.is_accepting=true
            AND u.status='ACTIVE' AND u.deleted_at IS NULL`,
      ),
    ]);
    const past = historical.rows[0] ?? {};
    const live = today.rows[0] ?? {};
    const total = (key: string) => number(past[key]) + number(live[key]);
    const consultations = total('consultations');
    const completed = total('completed');
    const cancelled = total('cancelled');
    const noShow = total('no_show');
    const divisor = consultations || 1;
    const leadValues = [past.avg_lead_hours, live.avg_lead_hours]
      .map(number)
      .filter((value) => value > 0);
    return {
      range,
      totals: {
        consultations,
        completed,
        cancelled,
        noShow,
        revenueMinor: total('revenue_minor'),
        refundsMinor: total('refunds_minor'),
        activeDoctors: number(activeDoctors.rows[0]?.count),
        newPatients: total('new_patients'),
      },
      rates: {
        completionRate: completed / divisor,
        cancellationRate: cancelled / divisor,
        noShowRate: noShow / divisor,
      },
      avgBookingLeadHours: leadValues.length
        ? leadValues.reduce((sum, value) => sum + value, 0) / leadValues.length
        : 0,
    };
  }

  async timeseries(
    metric: AnalyticsMetric,
    granularity: AnalyticsGranularity,
    range: AnalyticsRange,
  ): Promise<{ metric: AnalyticsMetric; points: Array<{ t: string; v: number }> }> {
    const column =
      metric === 'consultations'
        ? 'consultations_total'
        : metric === 'revenue'
          ? 'revenue_minor'
          : 'cancelled';
    const liveExpression =
      metric === 'consultations'
        ? 'COUNT(c.id)'
        : metric === 'revenue'
          ? "COALESCE(SUM(p.amount_minor) FILTER (WHERE p.status IN ('SUCCEEDED','REFUNDED','PARTIALLY_REFUNDED')),0)"
          : "COUNT(c.id) FILTER (WHERE c.status='CANCELLED')";
    const result = await analyticsPool.query<{ t: Date; v: string | number }>(
      `WITH daily_rollup AS (
         SELECT day,
           CASE WHEN COUNT(*) FILTER (WHERE doctor_id=$3)>0
             THEN MAX(${column}) FILTER (WHERE doctor_id=$3)
             ELSE COALESCE(SUM(${column}) FILTER (WHERE doctor_id<>$3),0) END::numeric AS value
           FROM analytics_daily
          WHERE day >= $1::date AND day <= $2::date AND day < CURRENT_DATE
          GROUP BY day
       ), daily AS (
         SELECT day,value FROM daily_rollup
         UNION ALL
         SELECT CURRENT_DATE, ${liveExpression}::numeric
           FROM consultations c LEFT JOIN payments p ON p.consultation_id=c.id
          WHERE c.scheduled_start::date=CURRENT_DATE
            AND CURRENT_DATE BETWEEN $1::date AND $2::date
          HAVING CURRENT_DATE BETWEEN $1::date AND $2::date
       )
       SELECT DATE_TRUNC('${granularity}',day)::date AS t, SUM(value)::numeric AS v
         FROM daily GROUP BY DATE_TRUNC('${granularity}',day)::date ORDER BY t`,
      [range.from, range.to, GLOBAL_DOCTOR_ID],
    );
    return { metric, points: result.rows.map((row) => ({ t: isoDate(row.t), v: number(row.v) })) };
  }

  async topDoctors(
    by: 'consultations' | 'revenue' | 'rating',
    range: AnalyticsRange,
    limit: number,
  ): Promise<{ data: Array<{ doctorId: string; displayName: string; value: number }> }> {
    if (by === 'rating') {
      const result = await analyticsPool.query<{
        id: string;
        display_name: string;
        value: string | number;
      }>(
        `SELECT d.id,d.display_name,d.rating_avg AS value
           FROM doctors d JOIN users u ON u.id=d.user_id
          WHERE d.verification_status='VERIFIED' AND u.status='ACTIVE' AND u.deleted_at IS NULL
          ORDER BY d.rating_avg DESC,d.rating_count DESC,d.id LIMIT $1`,
        [limit],
      );
      return {
        data: result.rows.map((row) => ({
          doctorId: row.id,
          displayName: row.display_name,
          value: number(row.value),
        })),
      };
    }

    const column = by === 'consultations' ? 'consultations_total' : 'revenue_minor';
    const liveExpression =
      by === 'consultations'
        ? 'COUNT(DISTINCT c.id)'
        : "COALESCE(SUM(p.amount_minor) FILTER (WHERE p.status IN ('SUCCEEDED','REFUNDED','PARTIALLY_REFUNDED')),0)";
    const result = await analyticsPool.query<{
      id: string;
      display_name: string;
      value: string | number;
    }>(
      `WITH values_by_doctor AS (
         SELECT doctor_id,SUM(${column})::numeric AS value
           FROM analytics_daily
          WHERE doctor_id<>$3 AND day >= $1::date AND day <= $2::date AND day < CURRENT_DATE
          GROUP BY doctor_id
         UNION ALL
         SELECT c.doctor_id,${liveExpression}::numeric
           FROM consultations c LEFT JOIN payments p ON p.consultation_id=c.id
          WHERE c.scheduled_start::date=CURRENT_DATE
            AND CURRENT_DATE BETWEEN $1::date AND $2::date
          GROUP BY c.doctor_id
       )
       SELECT d.id,d.display_name,SUM(v.value)::numeric AS value
         FROM values_by_doctor v JOIN doctors d ON d.id=v.doctor_id
        GROUP BY d.id,d.display_name ORDER BY value DESC,d.id LIMIT $4`,
      [range.from, range.to, GLOBAL_DOCTOR_ID, limit],
    );
    return {
      data: result.rows.map((row) => ({
        doctorId: row.id,
        displayName: row.display_name,
        value: number(row.value),
      })),
    };
  }
}
