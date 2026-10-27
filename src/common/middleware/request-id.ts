import type { RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';

export const requestId: RequestHandler = (req, res, next) => {
  const requestIdHeader = req.get('X-Request-Id');
  const id = requestIdHeader?.trim() || randomUUID();
  res.setHeader('X-Request-Id', id);
  res.locals.requestId = id;
  next();
};
