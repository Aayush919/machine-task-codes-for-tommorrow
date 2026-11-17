import { Redis, type RedisOptions } from 'ioredis'
import { config } from '../config.js'
import { logger } from '../logger.js'

let redisDownLogged = false

function noteRedisDown(error: unknown): void {
  if (redisDownLogged) return
  redisDownLogged = true
  const message = error instanceof Error ? error.message : String(error)
  logger.warn({ err: message }, 'redis unavailable; chat APIs continue without unread counts')
}

// If Redis is down, commands fail fast. Chat APIs still succeed; unread counts are skipped.
export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 1000,
  commandTimeout: 1000,
  retryStrategy(times: number) {
    return Math.min(times * 200, 2000)
  },
})

redis.on('error', noteRedisDown)
redis.on('ready', () => {
  redisDownLogged = false
})

export function bullConnection(): RedisOptions {
  const url = new URL(config.redisUrl)
  const dbFromPath = url.pathname.replace('/', '')
  const db = dbFromPath ? Number(dbFromPath) : 0
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number.isInteger(db) ? db : 0,
    maxRetriesPerRequest: null,
    connectTimeout: 1000,
  }
}

export async function disconnectRedis(): Promise<void> {
  if (redis.status === 'end') return
  redis.disconnect()
}
