import { Prisma } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { AppError } from '../errors.js'
import { logger } from '../logger.js'

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    })
    return
  }

  if (err instanceof AppError) {
    const body: { code: string; message: string; details?: unknown } = {
      code: err.code,
      message: err.message,
    }
    if (err.details !== undefined) body.details = err.details
    res.status(err.status).json({ error: body })
    return
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Related user or chat was not found' },
    })
    return
  }

  if (isBodyError(err, 'entity.parse.failed') || (err instanceof SyntaxError && 'body' in err)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } })
    return
  }

  if (isBodyError(err, 'entity.too.large')) {
    res.status(413).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body is too large' } })
    return
  }

  logger.error({ err, reqId: req.id }, 'unhandled error')
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } })
}

function isBodyError(err: unknown, type: string): boolean {
  return typeof err === 'object' && err !== null && 'type' in err && (err as { type?: string }).type === type
}
