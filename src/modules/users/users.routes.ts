import { Router } from 'express';
import { authenticate } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { EnvKeyProvider } from '../../common/crypto/key-provider.js';
import { env } from '../../config/env.js';
import { UsersController } from './users.controller.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';
import { profileSchema, updateUserSchema } from './users.schemas.js';
import { registry } from '../../openapi/registry.js';
export function usersRoutes(): Router {
  const router = Router();
  const controller = new UsersController(new UsersService(new UsersRepository(), new EncryptionService(new EnvKeyProvider(env))));
  router.get('/me', authenticate, controller.getMe);
  router.patch('/me', authenticate, validate({ body: updateUserSchema }), controller.updateMe);
  router.put('/me/profile', authenticate, validate({ body: profileSchema }), controller.updateProfile);
  registry.registerPath({ method: 'get', path: '/users/me', responses: { 200: { description: 'Current user' } } });
  registry.registerPath({ method: 'patch', path: '/users/me', responses: { 200: { description: 'Updated user' } } });
  registry.registerPath({ method: 'put', path: '/users/me/profile', responses: { 200: { description: 'Updated profile' } } });
  return router;
}