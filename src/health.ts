import { logger } from './logger.js'
import { getDb } from './lib/firestore.js'
import { prisma } from './lib/prisma.js'
import { redis } from './lib/redis.js'

export type DependencyStatus = {
  postgres: 'up' | 'down'
  redis: 'up' | 'down'
  firestore: 'up' | 'down'
}

export async function dependencyStatus(): Promise<DependencyStatus> {
  const status: DependencyStatus = { postgres: 'down', redis: 'down', firestore: 'down' }

  try {
    await prisma.$queryRaw`SELECT 1`
    status.postgres = 'up'
  } catch (error) {
    logger.error({ err: error }, 'postgres check failed')
  }

  try {
    const pong = await redis.ping()
    if (pong === 'PONG') status.redis = 'up'
  } catch (error) {
    logger.warn({ err: error }, 'redis check failed')
  }

  try {
    await getDb().collection('_health').doc('ping').get()
    status.firestore = 'up'
  } catch (error) {
    logger.error({ err: error }, 'firestore check failed')
  }

  return status
}
