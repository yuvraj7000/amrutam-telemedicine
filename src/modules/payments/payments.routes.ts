import express, { Router } from 'express';
import { asyncHandler } from '../../common/middleware/async-handler.js';
import { authenticate, publicRoute } from '../../common/middleware/auth.js';
import { requireMfaStepUp, requireRole } from '../../common/middleware/rbac.js';
import { validate } from '../../common/middleware/validate.js';
import { idempotencyKeyHeaders, registry } from '../../openapi/registry.js';
import { z } from 'zod';
import { createPaymentsDependencies } from './payments.service.js';
import { PaymentsController } from './payments.controller.js';
import { paymentIdSchema, refundSchema, simulatePaymentSchema } from './payments.schemas.js';

export function paymentsRoutes(): Router {
  const router = Router();
  const controller = new PaymentsController(createPaymentsDependencies().service);
  router.post(
    '/webhook',
    publicRoute,
    express.raw({ type: 'application/json', limit: '100kb' }),
    asyncHandler(controller.webhook),
  );
  router.get(
    '/:id',
    authenticate,
    validate({ params: paymentIdSchema }),
    asyncHandler(controller.getById),
  );
  router.post(
    '/:id/refund',
    authenticate,
    requireRole('ADMIN'),
    requireMfaStepUp,
    validate({ params: paymentIdSchema, body: refundSchema }),
    asyncHandler(controller.refund),
  );
  registry.registerPath({
    method: 'post',
    path: '/payments/webhook',
    request: {
      headers: registry.register(
        'PaymentWebhookHeaders',
        z
          .object({
            'X-Signature': z.string().min(1),
          })
          .strict(),
      ),
      body: {
        required: true,
        description: 'Raw JSON body signed by the payment provider.',
        content: { 'application/json': { schema: z.record(z.unknown()) } },
      },
    },
    responses: { 200: { description: 'Apply a verified payment-provider event' } },
  });
  registry.registerPath({
    method: 'get',
    path: '/payments/{id}',
    request: { params: registry.register('PaymentIdPath', paymentIdSchema) },
    responses: { 200: { description: 'Payment status' } },
  });
  registry.registerPath({
    method: 'post',
    path: '/payments/{id}/refund',
    request: {
      headers: idempotencyKeyHeaders,
      params: registry.register('RefundPaymentIdPath', paymentIdSchema),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: registry.register('RefundPaymentRequest', refundSchema),
          },
        },
      },
    },
    responses: { 202: { description: 'Request a payment refund' } },
  });
  return router;
}

export function devPaymentsRoutes(): Router {
  const router = Router();
  const controller = new PaymentsController(createPaymentsDependencies().service);
  router.post(
    '/:id/simulate',
    authenticate,
    validate({ params: paymentIdSchema, body: simulatePaymentSchema }),
    asyncHandler(controller.simulate),
  );
  registry.registerPath({
    method: 'post',
    path: '/dev/payments/{id}/simulate',
    request: {
      params: registry.register('SimulatePaymentIdPath', paymentIdSchema),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: registry.register('SimulatePaymentRequest', simulatePaymentSchema),
          },
        },
      },
    },
    responses: {
      200: { description: 'Simulate a payment outcome in non-production environments' },
    },
  });
  return router;
}
