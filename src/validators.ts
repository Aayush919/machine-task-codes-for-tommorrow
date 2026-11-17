import { z } from 'zod'
import { Errors } from './errors.js'

export const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Ids can only contain letters, numbers, underscores, and hyphens')

export const limitSchema = z.union([z.string(), z.number(), z.undefined()]).transform((value, ctx) => {
  if (value === undefined || value === '') return 50
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'limit must be an integer between 1 and 100',
    })
    return z.NEVER
  }
  return parsed
})

const emptyToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value)

export const createUserSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  email: z.preprocess(emptyToUndefined, z.string().trim().email('Invalid email').max(160).optional()),
})

export const createDirectSchema = z
  .object({
    userAId: idSchema,
    userBId: idSchema,
  })
  .refine((value) => value.userAId !== value.userBId, {
    message: 'userAId and userBId must be different',
    path: ['userBId'],
  })

export const createGroupSchema = z.object({
  creatorId: idSchema,
  title: z.string().trim().min(1, 'Title is required').max(80),
  memberIds: z.array(idSchema).min(1, 'Add at least one other member').max(199),
})

export const renameChatSchema = z.object({
  actorId: idSchema,
  title: z.string().trim().min(1, 'Title is required').max(80),
})

export const addMemberSchema = z.object({
  actorId: idSchema,
  userId: idSchema,
})

export const removeMemberSchema = z.object({
  actorId: idSchema,
})

export const updateRoleSchema = z.object({
  actorId: idSchema,
  role: z.enum(['admin', 'member']),
})

export const leaveChatSchema = z.object({
  userId: idSchema,
})

export const sendMessageSchema = z.object({
  senderId: idSchema,
  text: z.string(),
  clientMessageId: idSchema.optional(),
})

export const editMessageSchema = z.object({
  userId: idSchema,
  text: z.string(),
})

export const actorSchema = z.object({
  userId: idSchema,
})

export const deleteMessageSchema = z.object({
  userId: idSchema,
  scope: z.enum(['me', 'everyone']).default('everyone'),
})

export const lastSeenSchema = z.object({
  userId: idSchema,
  messageId: idSchema,
})

export const listMessagesQuerySchema = z.object({
  limit: limitSchema,
  cursor: z.string().trim().min(1).optional(),
  userId: idSchema.optional(),
})

export const listChatsQuerySchema = z.object({
  limit: limitSchema,
  cursor: z.string().trim().min(1).optional(),
})

export const memberQuerySchema = z.object({
  userId: idSchema,
})

export function parseRouteId(value: string | string[] | undefined, field: string): string {
  const raw = Array.isArray(value) ? value[0] : value
  const parsed = idSchema.safeParse(raw)
  if (!parsed.success) throw Errors.validation(`Invalid ${field}`)
  return parsed.data
}
