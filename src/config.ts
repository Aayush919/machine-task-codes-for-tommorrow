import { config as loadEnv } from 'dotenv'
import { z } from 'zod'

loadEnv()

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  FIREBASE_PROJECT_ID: z.string().min(1),
  EDIT_WINDOW_MS: z.coerce.number().int().nonnegative().default(15 * 60 * 1000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  MESSAGE_MAX_LENGTH: z.coerce.number().int().positive().default(4000),
  GROUP_MAX_MEMBERS: z.coerce.number().int().min(2).default(200),
  WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
  throw new Error(`Invalid environment: ${details}`)
}

export const config = {
  nodeEnv: parsed.data.NODE_ENV,
  port: parsed.data.PORT,
  logLevel: parsed.data.LOG_LEVEL,
  databaseUrl: parsed.data.DATABASE_URL,
  redisUrl: parsed.data.REDIS_URL,
  firebaseProjectId: parsed.data.FIREBASE_PROJECT_ID,
  editWindowMs: parsed.data.EDIT_WINDOW_MS,
  rateLimitWindowMs: parsed.data.RATE_LIMIT_WINDOW_MS,
  rateLimitMax: parsed.data.RATE_LIMIT_MAX,
  messageMaxLength: parsed.data.MESSAGE_MAX_LENGTH,
  groupMaxMembers: parsed.data.GROUP_MAX_MEMBERS,
  workerEnabled: parsed.data.WORKER_ENABLED,
}
