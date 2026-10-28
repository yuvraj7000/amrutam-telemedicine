import { EncryptionService } from '../../src/common/crypto/encryption.service.js';
import { EnvKeyProvider } from '../../src/common/crypto/key-provider.js';
import { auditHash, auditShard } from '../../src/modules/audit/hash-chain.js';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service.js';
import { PrescriptionsService } from '../../src/modules/prescriptions/prescriptions.service.js';
import type {
  PrescriptionMetadata,
  PrescriptionsRepository,
} from '../../src/modules/prescriptions/prescriptions.repository.js';

const key = Buffer.alloc(32, 7).toString('base64');
const auditActor = { actorId: 'doctor-user', actorRole: 'DOCTOR' };
const prescription: PrescriptionMetadata = {
  id: 'prescription-1',
  consultation_id: 'consultation-1',
  doctor_id: 'doctor-1',
  patient_id: 'patient-1',
  version: 1,
  status: 'ISSUED',
  issued_at: new Date('2026-10-27T00:00:00.000Z'),
  valid_until: null,
};

describe('audit, prescription access and admin analytics', () => {
  it('uses stable sharding and binds the full canonical audit record into the hash', () => {
    expect(auditShard('resource', 'actor')).toBe(auditShard('resource', 'actor'));
    expect(auditShard('resource', 'actor')).toBeGreaterThanOrEqual(0);
    expect(auditShard('resource', 'actor')).toBeLessThan(16);
    const row = {
      id: 'audit-1',
      created_at: new Date('2026-10-27T00:00:00.000Z'),
      seq: '1',
      actor_id: 'actor',
      action: 'prescription.read',
      resource_type: 'prescription',
      resource_id: 'resource',
      outcome: 'SUCCESS' as const,
      metadata: { fields: ['diagnosis'] },
    };
    const hash = auditHash('0'.repeat(64), row);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(auditHash('0'.repeat(64), { ...row, metadata: { fields: ['advice'] } })).not.toBe(hash);
  });

  it('encrypts prescription payloads with prescription-specific AAD and returns metadata only on issue', async () => {
    const encryption = new EncryptionService(
      new EnvKeyProvider({ ENC_KEYS: { '1': key }, ENC_ACTIVE_VERSION: 1 }),
    );
    const repo = {
      issue: jest.fn(async (input: { prescriptionId: string; payloadEnc: string }) => ({
        kind: 'created' as const,
        row: { ...prescription, id: input.prescriptionId },
      })),
      recordDenied: jest.fn(),
    } as unknown as PrescriptionsRepository;
    const service = new PrescriptionsService(repo, encryption);
    const input = {
      diagnosis: 'Clinical diagnosis',
      medications: [
        {
          name: 'Medicine',
          dosage: '1 tablet',
          frequency: 'daily',
          durationDays: 5,
        },
      ],
    };

    const result = await service.issue('consultation-1', auditActor, 'DOCTOR', input);
    expect(result).not.toHaveProperty('payload');
    const issueArgs = (repo.issue as jest.Mock).mock.calls[0]?.[0] as {
      prescriptionId: string;
      payloadEnc: string;
    };
    await expect(
      encryption.decrypt(
        issueArgs.payloadEnc,
        `prescriptions.payload_enc:${issueArgs.prescriptionId}`,
      ),
    ).resolves.toContain('Clinical diagnosis');
    await expect(
      encryption.decrypt(issueArgs.payloadEnc, 'prescriptions.payload_enc:another-prescription'),
    ).rejects.toThrow();
  });

  it('audits and denies a prescription request from a non-doctor before writing', async () => {
    const repository = {
      issue: jest.fn(),
      recordDenied: jest.fn(),
    } as unknown as PrescriptionsRepository;
    const service = new PrescriptionsService(
      repository,
      new EncryptionService(new EnvKeyProvider({ ENC_KEYS: { '1': key }, ENC_ACTIVE_VERSION: 1 })),
    );
    await expect(
      service.issue('consultation-1', { actorId: 'patient-1', actorRole: 'PATIENT' }, 'PATIENT', {
        diagnosis: 'x',
        medications: [{ name: 'm', dosage: '1', frequency: 'daily', durationDays: 1 }],
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(repository.recordDenied).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'patient-1' }),
      'consultation-1',
      'prescription.issue',
    );
    expect(repository.issue).not.toHaveBeenCalled();
  });

  it('audits and hides a prescription when the patient is not its owner', async () => {
    const repository = {
      getForActor: jest.fn(async () => undefined),
      recordDenied: jest.fn(),
    } as unknown as PrescriptionsRepository;
    const service = new PrescriptionsService(
      repository,
      new EncryptionService(new EnvKeyProvider({ ENC_KEYS: { '1': key }, ENC_ACTIVE_VERSION: 1 })),
    );
    await expect(
      service.get(
        'prescription-1',
        { actorId: 'unrelated-patient', actorRole: 'PATIENT' },
        'PATIENT',
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(repository.recordDenied).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'unrelated-patient' }),
      'prescription-1',
      'prescription.read',
    );
  });

  it('audits admin analytics views and rejects invalid ranges before querying', async () => {
    const audit = { record: jest.fn(async () => undefined) };
    const repository = { overview: jest.fn(async () => ({ totals: {} })) };
    const cache = {
      getOrLoad: jest.fn(async (_key: string, _ttl: number, load: () => Promise<unknown>) =>
        load(),
      ),
    };
    const service = new AnalyticsService(repository as never, cache as never, audit as never);
    await expect(
      service.overview(
        { from: '2026-10-01', to: '2026-10-31' },
        { actorId: 'admin', actorRole: 'ADMIN' },
      ),
    ).resolves.toEqual({ totals: {} });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'analytics.view',
        metadata: { fields: ['from', 'to'] },
      }),
    );
    await expect(
      service.overview(
        { from: '2026-11-01', to: '2026-10-01' },
        { actorId: 'admin', actorRole: 'ADMIN' },
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(repository.overview).toHaveBeenCalledTimes(1);
  });
});
