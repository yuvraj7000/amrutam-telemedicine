import { Router } from 'express';
import type { EncryptionService } from '../../common/crypto/encryption.service.js';
import { asyncHandler } from '../../common/middleware/async-handler.js';
import { authenticate } from '../../common/middleware/auth.js';
import { requireRole } from '../../common/middleware/rbac.js';
import { validate } from '../../common/middleware/validate.js';
import { env } from '../../config/env.js';
import { idempotencyKeyHeaders, registry } from '../../openapi/registry.js';
import { ConsultationsController } from './consultations.controller.js';
import { ConsultationsRepository } from './consultations.repository.js';
import {
  bookConsultationSchema,
  cancelConsultationSchema,
  completeConsultationSchema,
  consultationIdSchema,
  listConsultationsSchema,
} from './consultations.schemas.js';
import { ConsultationsService } from './consultations.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { container } from '../../container.js';

export function consultationsRoutes(): Router {
  const router = Router();
  const idempotency = new IdempotencyService(undefined, env.IDEMPOTENCY_TTL_HOURS);
  const service = new ConsultationsService(
    new ConsultationsRepository(idempotency),
    idempotency,
    container.resolve<EncryptionService>('encryptionService'),
  );
  const controller = new ConsultationsController(service);
  router.post(
    '/',
    authenticate,
    requireRole('PATIENT'),
    validate({ body: bookConsultationSchema }),
    asyncHandler(controller.book),
  );
  router.get(
    '/',
    authenticate,
    validate({ query: listConsultationsSchema }),
    asyncHandler(controller.list),
  );
  router.get(
    '/:id',
    authenticate,
    validate({ params: consultationIdSchema }),
    asyncHandler(controller.getById),
  );
  router.post(
    '/:id/cancel',
    authenticate,
    validate({ params: consultationIdSchema, body: cancelConsultationSchema }),
    asyncHandler(controller.cancel),
  );
  router.post(
    '/:id/start',
    authenticate,
    requireRole('DOCTOR'),
    validate({ params: consultationIdSchema }),
    asyncHandler(controller.start),
  );
  router.post(
    '/:id/complete',
    authenticate,
    requireRole('DOCTOR'),
    validate({ params: consultationIdSchema, body: completeConsultationSchema }),
    asyncHandler(controller.complete),
  );
  router.post(
    '/:id/no-show',
    authenticate,
    requireRole('DOCTOR'),
    validate({ params: consultationIdSchema }),
    asyncHandler(controller.noShow),
  );
  registry.registerPath({
    method: 'post',
    path: '/consultations',
    request: {
      headers: idempotencyKeyHeaders,
      body: {
        required: true,
        content: {
          'application/json': {
            schema: registry.register('BookConsultationRequest', bookConsultationSchema),
          },
        },
      },
    },
    responses: { 201: { description: 'Book a consultation and initiate payment' } },
  });
  registry.registerPath({
    method: 'get',
    path: '/consultations',
    request: { query: registry.register('ListConsultationsQuery', listConsultationsSchema) },
    responses: {
      200: { description: 'List consultations for the authenticated patient or doctor' },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/consultations/{id}',
    request: { params: registry.register('ConsultationIdPath', consultationIdSchema) },
    responses: { 200: { description: 'Consultation details' } },
  });
  registry.registerPath({
    method: 'post',
    path: '/consultations/{id}/cancel',
    request: {
      headers: idempotencyKeyHeaders,
      params: registry.register('CancelConsultationIdPath', consultationIdSchema),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: registry.register('CancelConsultationRequest', cancelConsultationSchema),
          },
        },
      },
    },
    responses: { 200: { description: 'Cancel a consultation' } },
  });
  registry.registerPath({
    method: 'post',
    path: '/consultations/{id}/start',
    request: { params: registry.register('StartConsultationIdPath', consultationIdSchema) },
    responses: { 200: { description: 'Start a consultation' } },
  });
  registry.registerPath({
    method: 'post',
    path: '/consultations/{id}/complete',
    request: {
      params: registry.register('CompleteConsultationIdPath', consultationIdSchema),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: registry.register('CompleteConsultationRequest', completeConsultationSchema),
          },
        },
      },
    },
    responses: { 200: { description: 'Complete a consultation' } },
  });
  registry.registerPath({
    method: 'post',
    path: '/consultations/{id}/no-show',
    request: { params: registry.register('NoShowConsultationIdPath', consultationIdSchema) },
    responses: { 200: { description: 'Mark a consultation as no-show' } },
  });
  return router;
}
