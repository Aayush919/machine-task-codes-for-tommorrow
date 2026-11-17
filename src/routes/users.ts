import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { createUser, getUser, listAllUsers } from '../services/user.service.js'
import { createUserSchema, parseRouteId } from '../validators.js'

export const userRouter = Router()

function userDto(user: { id: string; name: string; email: string | null; createdAt: Date }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
  }
}

userRouter.post(
  '/users',
  asyncHandler(async (req, res) => {
    const body = createUserSchema.parse(req.body)
    const user = await createUser({ name: body.name, email: body.email })
    res.status(201).json({ user: userDto(user) })
  }),
)

userRouter.get(
  '/users',
  asyncHandler(async (_req, res) => {
    const users = await listAllUsers()
    res.json({ users: users.map(userDto) })
  }),
)

userRouter.get(
  '/users/:userId',
  asyncHandler(async (req, res) => {
    const userId = parseRouteId(req.params.userId, 'userId')
    const user = await getUser(userId)
    res.json({ user: userDto(user) })
  }),
)
