import { createHmac } from 'node:crypto';
import type { PaymentGateway, PaymentWebhook } from './payment-gateway.js';

export class MockPaymentGateway implements PaymentGateway {
  constructor(private readonly secret: string) {}

  async createPaymentIntent(
    paymentId: string,
  ): Promise<{ providerPaymentId: string; clientSecret: string }> {
    return { providerPaymentId: `mock_pi_${paymentId}`, clientSecret: `mock_secret_${paymentId}` };
  }

  createWebhook(
    event: PaymentWebhook,
    timestamp = Math.floor(Date.now() / 1000),
  ): { rawBody: Buffer; signature: string } {
    const rawBody = Buffer.from(JSON.stringify(event));
    const digest = createHmac('sha256', this.secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
    return { rawBody, signature: `t=${timestamp},v1=${digest}` };
  }
}
