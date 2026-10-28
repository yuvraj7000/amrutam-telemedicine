import { primaryPool } from '../../common/db/kysely.js';

interface RollupJobData {
  dayOffset?: number;
  day?: string;
}

function rollupDay(data: RollupJobData): string {
  if (data.day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.day)) throw new Error('Invalid rollup day');
    return data.day;
  }
  const day = new Date();
  day.setUTCDate(day.getUTCDate() - (data.dayOffset ?? 0));
  return day.toISOString().slice(0, 10);
}

export async function processAnalyticsRollup(data: RollupJobData = {}): Promise<void> {
  const day = rollupDay(data);
  await primaryPool.query(
    `WITH payment_totals AS (
       SELECT consultation_id,
              sum(amount_minor)::bigint AS revenue_minor,
              sum(refunded_minor)::bigint AS refunds_minor
       FROM payments
       WHERE status IN ('SUCCEEDED', 'REFUNDED', 'PARTIALLY_REFUNDED')
       GROUP BY consultation_id
     ),
     eligible_consultations AS (
       SELECT consultation.id, consultation.doctor_id, consultation.patient_id,
              consultation.status, consultation.scheduled_start,
              coalesce(payment.revenue_minor, 0)::bigint AS revenue_minor,
              coalesce(payment.refunds_minor, 0)::bigint AS refunds_minor
       FROM consultations AS consultation
       LEFT JOIN payment_totals AS payment ON payment.consultation_id = consultation.id
       WHERE consultation.scheduled_start >= $1::date
         AND consultation.scheduled_start < ($1::date + interval '1 day')
     ),
     first_patient_consultation AS (
       SELECT patient_id, min(scheduled_start) AS first_at
       FROM consultations
       GROUP BY patient_id
     ),
     doctor_rollups AS (
       SELECT consultation.doctor_id,
              count(*)::int AS consultations_total,
              count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
              count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
              count(*) FILTER (WHERE status = 'NO_SHOW')::int AS no_show,
              sum(revenue_minor)::bigint AS revenue_minor,
              sum(refunds_minor)::bigint AS refunds_minor,
              count(DISTINCT consultation.patient_id) FILTER (
                WHERE first_at >= $1::date AND first_at < ($1::date + interval '1 day')
              )::int AS new_patients,
              round(avg(extract(epoch FROM (scheduled_start - consultation.created_at)) / 3600)::numeric, 2)
                AS avg_lead_hours
       FROM eligible_consultations AS consultation
       LEFT JOIN first_patient_consultation AS first_patient
         ON first_patient.patient_id = consultation.patient_id
       GROUP BY consultation.doctor_id
     ),
     rows_to_write AS (
       SELECT $1::date AS day, doctor_id, consultations_total, completed, cancelled, no_show,
              revenue_minor, refunds_minor, new_patients, avg_lead_hours
       FROM doctor_rollups
       UNION ALL
       SELECT $1::date, '00000000-0000-0000-0000-000000000000'::uuid,
              count(*)::int,
              count(*) FILTER (WHERE status = 'COMPLETED')::int,
              count(*) FILTER (WHERE status = 'CANCELLED')::int,
              count(*) FILTER (WHERE status = 'NO_SHOW')::int,
              coalesce(sum(revenue_minor), 0)::bigint,
              coalesce(sum(refunds_minor), 0)::bigint,
              count(DISTINCT consultation.patient_id) FILTER (
                WHERE first_at >= $1::date AND first_at < ($1::date + interval '1 day')
              )::int,
              round(avg(extract(epoch FROM (scheduled_start - consultation.created_at)) / 3600)::numeric, 2)
       FROM eligible_consultations AS consultation
       LEFT JOIN first_patient_consultation AS first_patient
         ON first_patient.patient_id = consultation.patient_id
     )
     INSERT INTO analytics_daily (
       day, doctor_id, consultations_total, completed, cancelled, no_show,
       revenue_minor, refunds_minor, new_patients, avg_lead_hours
     )
     SELECT * FROM rows_to_write
     ON CONFLICT (day, doctor_id) DO UPDATE SET
       consultations_total = EXCLUDED.consultations_total,
       completed = EXCLUDED.completed,
       cancelled = EXCLUDED.cancelled,
       no_show = EXCLUDED.no_show,
       revenue_minor = EXCLUDED.revenue_minor,
       refunds_minor = EXCLUDED.refunds_minor,
       new_patients = EXCLUDED.new_patients,
       avg_lead_hours = EXCLUDED.avg_lead_hours`,
    [day],
  );
}
