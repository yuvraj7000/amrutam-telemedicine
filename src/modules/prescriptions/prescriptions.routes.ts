import { Router } from 'express';
import { asyncHandler } from '../../common/middleware/async-handler.js';
import { authenticate } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import type { EncryptionService } from '../../common/crypto/encryption.service.js';
import { container } from '../../container.js';
import { registry } from '../../openapi/registry.js';
import { PrescriptionsController } from './prescriptions.controller.js';
import { PrescriptionsRepository } from './prescriptions.repository.js';
import { PrescriptionsService } from './prescriptions.service.js';
import {
  consultationIdSchema,
  prescriptionIdSchema,
  prescriptionInputSchema,
} from './prescriptions.schemas.js';

export function prescriptionsRoutes(): Router {
  const router = Router();
  const encryption = container.resolve<EncryptionService>('encryptionService');
  const controller = new PrescriptionsController(
    new PrescriptionsService(new PrescriptionsRepository(), encryption),
  );
  router.post(
    '/consultations/:consultationId/prescriptions',
    authenticate,
    validate({
      params: consultationIdSchema,
      body: prescriptionInputSchema,
    }),
    asyncHandler(controller.issue),
  );
  router.get(
    '/consultations/:consultationId/prescriptions',
    authenticate,
    validate({
      params: consultationIdSchema,
    }),
    asyncHandler(controller.list),
  );
  router.get(
    '/prescriptions/:id',
    authenticate,
    validate({ params: prescriptionIdSchema }),
    asyncHandler(controller.get),
  );
  registry.registerPath({
    method: 'post',
    path: '/consultations/{consultationId}/prescriptions',
    request: {
      params: registry.register('IssuePrescriptionConsultationIdPath', consultationIdSchema),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: registry.register('IssuePrescriptionRequest', prescriptionInputSchema),
          },
        },
      },
    },
    responses: { 201: { description: 'Prescription issued' } },
  });
  registry.registerPath({
    method: 'get',
    path: '/consultations/{consultationId}/prescriptions',
    request: {
      params: registry.register('ListPrescriptionConsultationIdPath', consultationIdSchema),
    },
    responses: { 200: { description: 'Prescription version metadata' } },
  });
  registry.registerPath({
    method: 'get',
    path: '/prescriptions/{id}',
    request: { params: registry.register('PrescriptionIdPath', prescriptionIdSchema) },
    responses: { 200: { description: 'Prescription details' } },
  });
  return router;
}
