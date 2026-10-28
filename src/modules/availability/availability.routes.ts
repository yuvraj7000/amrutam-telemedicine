import { Router } from 'express';
import { asyncHandler } from '../../common/middleware/async-handler.js';
import { authenticate } from '../../common/middleware/auth.js';
import { requireRole } from '../../common/middleware/rbac.js';
import { validate } from '../../common/middleware/validate.js';
import { env } from '../../config/env.js';
import { idempotencyKeyHeaders, registry } from '../../openapi/registry.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { AvailabilityController } from './availability.controller.js';
import { AvailabilityRepository } from './availability.repository.js';
import {
  availabilityQuerySchema,
  createSlotsSchema,
  doctorIdSchema,
  slotIdSchema,
  slotQuerySchema,
} from './availability.schemas.js';
import { AvailabilityService } from './availability.service.js';

export function availabilityRoutes(): Router {
  const router = Router();
  const idempotency = new IdempotencyService(undefined, env.IDEMPOTENCY_TTL_HOURS);
  const controller = new AvailabilityController(
    new AvailabilityService(new AvailabilityRepository(idempotency)),
  );
  router.post(
    '/me/slots',
    authenticate,
    requireRole('DOCTOR'),
    validate({ body: createSlotsSchema }),
    asyncHandler(controller.create),
  );
  router.get(
    '/me/slots',
    authenticate,
    requireRole('DOCTOR'),
    validate({ query: slotQuerySchema }),
    asyncHandler(controller.listMine),
  );
  router.get(
    '/:doctorId/availability',
    authenticate,
    validate({ params: doctorIdSchema, query: availabilityQuerySchema }),
    asyncHandler(controller.publicAvailability),
  );
  router.delete(
    '/me/slots/:id',
    authenticate,
    requireRole('DOCTOR'),
    validate({ params: slotIdSchema }),
    asyncHandler(controller.delete),
  );
  registry.registerPath({
    method: 'post',
    path: '/availability/me/slots',
    request: {
      headers: idempotencyKeyHeaders,
      body: {
        required: true,
        content: {
          'application/json': {
            schema: registry.register('CreateAvailabilitySlotsRequest', createSlotsSchema),
          },
        },
      },
    },
    responses: { 201: { description: 'Create doctor availability slots' } },
  });
  registry.registerPath({
    method: 'get',
    path: '/availability/me/slots',
    request: { query: registry.register('DoctorSlotsQuery', slotQuerySchema) },
    responses: { 200: { description: 'List the authenticated doctor availability slots' } },
  });
  registry.registerPath({
    method: 'get',
    path: '/availability/{doctorId}/availability',
    request: {
      params: registry.register('AvailabilityDoctorIdPath', doctorIdSchema),
      query: registry.register('PublicAvailabilityQuery', availabilityQuerySchema),
    },
    responses: { 200: { description: 'List available appointment times' } },
  });
  registry.registerPath({
    method: 'delete',
    path: '/availability/me/slots/{id}',
    request: { params: registry.register('AvailabilitySlotIdPath', slotIdSchema) },
    responses: { 204: { description: 'Delete an unbooked availability slot' } },
  });
  return router;
}
