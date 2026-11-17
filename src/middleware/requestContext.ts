import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { logger } from '../logger.js'

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id')
  const id = incoming && incoming.length > 0 && incoming.length <= 128 ? incoming : randomUUID()
  req.id = id
  res.setHeader('x-request-id', id)
  const started = Date.now()
  res.on('finish', () => {
    logger.info({
      reqId: id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Date.now() - started,
    })
  })
  next()
}
