export type PaymentEventType = 'payment.succeeded' | 'payment.failed' | 'refund.succeeded';
export type PaymentWebhook = {
  id: string;
  type: PaymentEventType;
  data: { paymentId: string; amountMinor: number; reason?: string };
};
export interface PaymentGateway {
  createPaymentIntent(
    paymentId: string,
    amountMinor: number,
    currency: string,
  ): Promise<{ providerPaymentId: string; clientSecret: string }>;
  createWebhook(event: PaymentWebhook, timestamp?: number): { rawBody: Buffer; signature: string };
}
