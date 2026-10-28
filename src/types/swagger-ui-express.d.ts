declare module 'swagger-ui-express' {
  import type { RequestHandler } from 'express';

  interface SwaggerUiExpress {
    serve: RequestHandler[];
    setup(specification: object): RequestHandler;
  }

  const swaggerUi: SwaggerUiExpress;
  export = swaggerUi;
}
