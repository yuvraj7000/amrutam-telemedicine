import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { registry } from './registry.js';
export function buildOpenApiDocument() {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Amrutam API',
      version: '1.0.0',
      description: 'Versioned REST API for the Amrutam telemedicine platform.',
    },
    servers: [{ url: '/api/v1' }],
  });
}
