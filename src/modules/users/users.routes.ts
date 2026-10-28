import { Router } from 'express';
import { asyncHandler } from '../../common/middleware/async-handler.js';
import { authenticate } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import type { EncryptionService } from '../../common/crypto/encryption.service.js';
import { container } from '../../container.js';
import { UsersController } from './users.controller.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';
import { profileSchema, updateUserSchema } from './users.schemas.js';
import { registry } from '../../openapi/registry.js';
export function usersRoutes(): Router {
  const router = Router();
  const controller = new UsersController(
    new UsersService(
      new UsersRepository(),
      container.resolve<EncryptionService>('encryptionService'),
    ),
  );
  router.get('/me', authenticate, asyncHandler(controller.getMe));
  router.patch(
    '/me',
    authenticate,
    validate({ body: updateUserSchema }),
    asyncHandler(controller.updateMe),
  );
  router.put(
    '/me/profile',
    authenticate,
    validate({ body: profileSchema }),
    asyncHandler(controller.updateProfile),
  );
  registry.registerPath({
    method: 'get',
    path: '/users/me',
    responses: { 200: { description: 'Current user' } },
  });
  registry.registerPath({
    method: 'patch',
    path: '/users/me',
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: registry.register('UpdateUserRequest', updateUserSchema) },
        },
      },
    },
    responses: { 200: { description: 'Updated user' } },
  });
  registry.registerPath({
    method: 'put',
    path: '/users/me/profile',
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: registry.register('UpdateProfileRequest', profileSchema) },
        },
      },
    },
    responses: { 200: { description: 'Updated profile' } },
  });
  return router;
}
