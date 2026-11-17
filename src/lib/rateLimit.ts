import { config } from '../config.js'
import { AppError, Errors } from '../errors.js'
import { logger } from '../logger.js'
import { redis } from './redis.js'

/** Fixed window. A crashed expire is repaired on the next send via pttl. */
export async function consumeSendRateLimit(userId: string): Promise<void> {
  const key = `cft:rl:send:${userId}`
  try {
    const count = await redis.incr(key)
    const ttl = await redis.pttl(key)
    if (ttl < 0) await redis.pexpire(key, config.rateLimitWindowMs)
    if (count > config.rateLimitMax) {
      throw Errors.tooMany(`Send limit is ${config.rateLimitMax} messages per minute`)
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    logger.error({ err: error, userId }, 'rate limit check failed; allowing send')
  }
}
