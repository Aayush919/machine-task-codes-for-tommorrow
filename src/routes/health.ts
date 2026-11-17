import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { dependencyStatus } from '../health.js'

export const healthRouter = Router()

healthRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const status = await dependencyStatus()
    const ok = status.postgres === 'up' && status.firestore === 'up'
    res.status(ok ? 200 : 503).json({ ok, ...status })
  }),
)
