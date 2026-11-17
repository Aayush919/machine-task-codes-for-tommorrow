import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { errorHandler } from './middleware/errorHandler.js'
import { requestContext } from './middleware/requestContext.js'
import { api } from './routes/index.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.use(helmet())
  app.use(cors())
  app.use(express.json({ limit: '32kb' }))
  app.use(requestContext)
  app.use(api)
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } })
  })
  app.use(errorHandler)
  return app
}

export const app = createApp()
