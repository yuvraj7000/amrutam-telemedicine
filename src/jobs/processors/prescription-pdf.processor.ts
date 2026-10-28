export interface PrescriptionPdfJob {
  eventId?: string;
  payload?: Record<string, unknown>;
}

export interface PrescriptionPdfAdapter {
  /** Implementations should use eventId as their idempotency key for storage writes. */
  createAndStore(job: PrescriptionPdfJob): Promise<void>;
}

let adapter: PrescriptionPdfAdapter | undefined;

export function configurePrescriptionPdfAdapter(pdfAdapter: PrescriptionPdfAdapter): void {
  adapter = pdfAdapter;
}

export async function processPrescriptionPdf(job: PrescriptionPdfJob): Promise<void> {
  if (!adapter) throw new Error('Prescription PDF renderer and storage adapter are not configured');
  await adapter.createAndStore(job);
}
