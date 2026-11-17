import { app } from './app.js'
import { config } from './config.js'
import { dependencyStatus } from './health.js'
import { logger } from './logger.js'
import { disconnectPrisma } from './lib/prisma.js'
import { disconnectRedis } from './lib/redis.js'
import { closeQueue } from './queue/queue.js'
import { startWorker, stopWorker } from './worker.js'

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'chat api listening')
})

if (config.workerEnabled) {
  void startWorker().catch((error: unknown) => {
    logger.warn({ err: error }, 'worker failed to start; chat APIs continue')
  })
}

void dependencyStatus().then((status) => {
  const ready = status.postgres === 'up' && status.firestore === 'up'
  if (!ready) {
    logger.error({ status }, 'postgres or firestore is down; /health will report it')
    return
  }
  if (status.redis !== 'up') {
    logger.warn(status, 'redis is down; chat APIs are up, unread counts are skipped')
    return
  }
  logger.info(status, 'dependencies are up')
})

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  server.close()
  await stopWorker()
  await closeQueue()
  await disconnectRedis()
  await disconnectPrisma()
  process.exit(0)
}

process.on('SIGINT', () => {
  void shutdown('SIGINT')
})
process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
