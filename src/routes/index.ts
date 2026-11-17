import { Router } from 'express'
import { chatRouter } from './chats.js'
import { healthRouter } from './health.js'
import { userRouter } from './users.js'

export const api = Router()

api.use(healthRouter)
api.use(userRouter)
api.use(chatRouter)
