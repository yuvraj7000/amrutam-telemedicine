import type { PoolClient, QueryResultRow } from 'pg';
import type { AuditContext } from '../audit/hash-chain.js';
import { inAuditTransaction, recordAudit } from '../audit/hash-chain.js';

type IssueRow = QueryResultRow & {
  id: string;
  doctor_id: string;
  patient_id: string;
  status: string;
  recent_completion: boolean;
};

export type PrescriptionMetadata = {
  id: string;
  consultation_id: string;
  doctor_id: string;
  patient_id: string;
  version: number;
  status: string;
  issued_at: Date;
  valid_until: Date | null;
  payload_enc?: string;
};

export class PrescriptionsRepository {
  async issue(input: {
    consultationId: string;
    doctorUserId: string;
    prescriptionId: string;
    payloadEnc: string;
    validUntil?: string;
    audit: AuditContext;
  }): Promise<
    { kind: 'created'; row: PrescriptionMetadata } | { kind: 'missing' } | { kind: 'invalid-state' }
  > {
    return inAuditTransaction(async (trx) => {
      const consultation = await trx.query<IssueRow>(
        `SELECT c.id,c.doctor_id,c.patient_id,c.status,
                (c.completed_at >= NOW()-interval '24 hours') AS recent_completion
           FROM consultations c JOIN doctors d ON d.id=c.doctor_id
          WHERE c.id=$1 AND d.user_id=$2 FOR UPDATE OF c`,
        [input.consultationId, input.doctorUserId],
      );
      const row = consultation.rows[0];
      if (!row) return { kind: 'missing' };
      if (row.status !== 'IN_PROGRESS' && !(row.status === 'COMPLETED' && row.recent_completion)) {
        await recordAudit(trx, {
          ...input.audit,
          action: 'prescription.issue',
          resourceType: 'prescription',
          resourceId: input.consultationId,
          outcome: 'DENIED',
          metadata: { fields: ['status'] },
        });
        return { kind: 'invalid-state' };
      }

      const versionResult = await trx.query<{ version: number }>(
        'SELECT COALESCE(MAX(version),0)+1 AS version FROM prescriptions WHERE consultation_id=$1',
        [input.consultationId],
      );
      const version = versionResult.rows[0]?.version ?? 1;
      await trx.query(
        `UPDATE prescriptions SET status='REVOKED'
          WHERE consultation_id=$1 AND status='ISSUED'`,
        [input.consultationId],
      );
      const inserted = await trx.query<PrescriptionMetadata>(
        `INSERT INTO prescriptions
          (id,consultation_id,doctor_id,patient_id,version,status,payload_enc,valid_until)
         VALUES ($1,$2,$3,$4,$5,'ISSUED',$6,$7)
         RETURNING id,consultation_id,doctor_id,patient_id,version,status,issued_at,valid_until`,
        [
          input.prescriptionId,
          input.consultationId,
          row.doctor_id,
          row.patient_id,
          version,
          input.payloadEnc,
          input.validUntil ?? null,
        ],
      );
      await trx.query(
        `INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload)
         VALUES ('prescription',$1,'prescription.issued',$2::jsonb)`,
        [input.prescriptionId, JSON.stringify({ prescriptionId: input.prescriptionId })],
      );
      await recordAudit(trx, {
        ...input.audit,
        action: 'prescription.issue',
        resourceType: 'prescription',
        resourceId: input.prescriptionId,
        outcome: 'SUCCESS',
        metadata: { fields: ['diagnosis', 'medications', 'advice', 'followUpDate', 'validUntil'] },
      });
      return { kind: 'created', row: inserted.rows[0] as PrescriptionMetadata };
    });
  }

  async listForActor(
    consultationId: string,
    audit: AuditContext,
  ): Promise<PrescriptionMetadata[] | undefined> {
    return inAuditTransaction(async (trx) => {
      const result = await trx.query<PrescriptionMetadata>(
        `SELECT p.id,p.consultation_id,p.doctor_id,p.patient_id,p.version,p.status,p.issued_at,p.valid_until
           FROM prescriptions p JOIN consultations c ON c.id=p.consultation_id
           JOIN doctors d ON d.id=c.doctor_id
          WHERE c.id=$1 AND (c.patient_id=$2 OR d.user_id=$2)
          ORDER BY p.version DESC`,
        [consultationId, audit.actorId],
      );
      const consultation = await trx.query(
        `SELECT 1 FROM consultations c JOIN doctors d ON d.id=c.doctor_id
          WHERE c.id=$1 AND (c.patient_id=$2 OR d.user_id=$2)`,
        [consultationId, audit.actorId],
      );
      if (!consultation.rowCount) return undefined;
      await recordAudit(trx, {
        ...audit,
        action: 'prescription.list',
        resourceType: 'consultation',
        resourceId: consultationId,
        outcome: 'SUCCESS',
        metadata: { fields: ['id', 'version', 'status', 'issuedAt', 'validUntil'] },
      });
      return result.rows;
    });
  }

  async getForActor(id: string, audit: AuditContext): Promise<PrescriptionMetadata | undefined> {
    return inAuditTransaction(async (trx: PoolClient) => {
      const result = await trx.query<PrescriptionMetadata>(
        `SELECT p.id,p.consultation_id,p.doctor_id,p.patient_id,p.version,p.status,p.issued_at,
                p.valid_until,p.payload_enc
           FROM prescriptions p JOIN consultations c ON c.id=p.consultation_id
           JOIN doctors d ON d.id=c.doctor_id
          WHERE p.id=$1 AND (c.patient_id=$2 OR d.user_id=$2)`,
        [id, audit.actorId],
      );
      const row = result.rows[0];
      if (row) {
        await recordAudit(trx, {
          ...audit,
          action: 'prescription.read',
          resourceType: 'prescription',
          resourceId: id,
          outcome: 'SUCCESS',
          metadata: {
            fields: ['diagnosis', 'medications', 'advice', 'followUpDate', 'validUntil'],
          },
        });
      }
      return row;
    });
  }

  async recordDenied(audit: AuditContext, resourceId: string, action: string): Promise<void> {
    await inAuditTransaction((trx) =>
      recordAudit(trx, {
        ...audit,
        action,
        resourceType: 'prescription',
        resourceId,
        outcome: 'DENIED',
        metadata: { fields: ['ownership'] },
      }),
    );
  }
}
