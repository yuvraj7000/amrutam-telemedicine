import { Router } from 'express';
import { asyncHandler } from '../../common/middleware/async-handler.js';
import { authenticate } from '../../common/middleware/auth.js';
import { requireRole } from '../../common/middleware/rbac.js';
import { validate } from '../../common/middleware/validate.js';
import { registry } from '../../openapi/registry.js';
import { DoctorsController } from './doctors.controller.js';
import { DoctorsRepository } from './doctors.repository.js';
import {
  doctorIdSchema,
  doctorProfileSchema,
  doctorSearchSchema,
  verificationSchema,
} from './doctors.schemas.js';
import { DoctorsService } from './doctors.service.js';

export function doctorsRoutes(): Router {
  const router = Router();
  const controller = new DoctorsController(new DoctorsService(new DoctorsRepository()));
  router.get(
    '/',
    authenticate,
    validate({ query: doctorSearchSchema }),
    asyncHandler(controller.search),
  );
  router.put(
    '/me',
    authenticate,
    requireRole('DOCTOR'),
    validate({ body: doctorProfileSchema }),
    asyncHandler(controller.updateMe),
  );
  router.get(
    '/:id',
    authenticate,
    validate({ params: doctorIdSchema }),
    asyncHandler(controller.getById),
  );
  registry.registerPath({
    method: 'get',
    path: '/doctors',
    request: { query: registry.register('DoctorSearchQuery', doctorSearchSchema) },
    responses: { 200: { description: 'Search verified doctors' } },
  });
  registry.registerPath({
    method: 'put',
    path: '/doctors/me',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: registry.register('UpdateDoctorProfileRequest', doctorProfileSchema),
          },
        },
      },
    },
    responses: { 200: { description: 'Update the authenticated doctor profile' } },
  });
  registry.registerPath({
    method: 'get',
    path: '/doctors/{id}',
    request: {
      params: registry.register('DoctorIdPath', doctorIdSchema),
    },
    responses: { 200: { description: 'Doctor profile' } },
  });
  return router;
}

export function adminDoctorsRoutes(): Router {
  const router = Router();
  const controller = new DoctorsController(new DoctorsService(new DoctorsRepository()));
  router.patch(
    '/:id/verification',
    authenticate,
    requireRole('ADMIN'),
    validate({ params: doctorIdSchema, body: verificationSchema }),
    asyncHandler(controller.verify),
  );
  registry.registerPath({
    method: 'patch',
    path: '/admin/doctors/{id}/verification',
    request: {
      params: registry.register('VerificationDoctorIdPath', doctorIdSchema),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: registry.register('DoctorVerificationRequest', verificationSchema),
          },
        },
      },
    },
    responses: { 200: { description: 'Update doctor verification status' } },
  });
  return router;
}
