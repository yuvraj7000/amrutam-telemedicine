import type { RequestHandler } from 'express';
import { NotFoundError } from '../errors/index.js';

export const notFound: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`No route matches ${req.method} ${req.originalUrl}.`));
};
