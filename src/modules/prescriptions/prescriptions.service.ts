import { randomUUID } from 'node:crypto';
import type { EncryptionService } from '../../common/crypto/encryption.service.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/index.js';
import type { AuditContext } from '../audit/hash-chain.js';
import type { PrescriptionsRepository } from './prescriptions.repository.js';
import type { PrescriptionInput } from './prescriptions.schemas.js';

export class PrescriptionsService {
  constructor(
    private readonly repository: PrescriptionsRepository,
    private readonly encryption: EncryptionService,
  ) {}

  async issue(
    consultationId: string,
    actor: AuditContext,
    role: string,
    input: PrescriptionInput,
  ): Promise<Record<string, unknown>> {
    if (role !== 'DOCTOR') {
      await this.repository.recordDenied(actor, consultationId, 'prescription.issue');
      throw new ForbiddenError();
    }
    const id = randomUUID();
    const payloadEnc = await this.encryption.encrypt(
      JSON.stringify(input),
      `prescriptions.payload_enc:${id}`,
    );
    const result = await this.repository.issue({
      consultationId,
      doctorUserId: actor.actorId as string,
      prescriptionId: id,
      payloadEnc,
      validUntil: input.validUntil,
      audit: actor,
    });
    if (result.kind === 'missing') {
      await this.repository.recordDenied(actor, consultationId, 'prescription.issue');
      throw new NotFoundError();
    }
    if (result.kind === 'invalid-state') {
      throw new ConflictError();
    }
    return this.metadata(result.row);
  }

  async list(
    consultationId: string,
    actor: AuditContext,
    role: string,
  ): Promise<Record<string, unknown>[]> {
    if (role !== 'PATIENT' && role !== 'DOCTOR') {
      await this.repository.recordDenied(actor, consultationId, 'prescription.list');
      throw new ForbiddenError();
    }
    const rows = await this.repository.listForActor(consultationId, actor);
    if (!rows) {
      await this.repository.recordDenied(actor, consultationId, 'prescription.list');
      throw new NotFoundError();
    }
    return rows.map((row) => this.metadata(row));
  }

  async get(id: string, actor: AuditContext, role: string): Promise<Record<string, unknown>> {
    if (role !== 'PATIENT' && role !== 'DOCTOR') {
      await this.repository.recordDenied(actor, id, 'prescription.read');
      throw new ForbiddenError();
    }
    const row = await this.repository.getForActor(id, actor);
    if (!row?.payload_enc) {
      await this.repository.recordDenied(actor, id, 'prescription.read');
      throw new NotFoundError();
    }
    const payload = JSON.parse(
      await this.encryption.decrypt(row.payload_enc, `prescriptions.payload_enc:${id}`),
    ) as PrescriptionInput;
    return { ...this.metadata(row), payload };
  }

  private metadata(row: {
    id: string;
    consultation_id: string;
    doctor_id: string;
    patient_id: string;
    version: number;
    status: string;
    issued_at: Date;
    valid_until: Date | null;
  }): Record<string, unknown> {
    return {
      id: row.id,
      consultationId: row.consultation_id,
      doctorId: row.doctor_id,
      patientId: row.patient_id,
      version: row.version,
      status: row.status,
      issuedAt: row.issued_at,
      validUntil: row.valid_until,
    };
  }
}
