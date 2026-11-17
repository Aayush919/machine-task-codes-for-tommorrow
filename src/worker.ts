import { Worker } from 'bullmq'
import { logger } from './logger.js'
import { bullConnection } from './lib/redis.js'
import { processChatEvent } from './queue/processor.js'
import { CHAT_QUEUE } from './queue/queue.js'

let worker: Worker | null = null

export async function startWorker(): Promise<Worker> {
  if (worker) return worker
  const next = new Worker(
    CHAT_QUEUE,
    async (job) => {
      await processChatEvent(job.name, job.data)
    },
    {
      connection: bullConnection(),
      prefix: 'cftchat',
      concurrency: 8,
    },
  )
  next.on('error', (error: Error) => {
    logger.warn({ err: error.message }, 'redis worker unavailable; chat APIs continue')
  })
  next.on('failed', (job, error) => {
    logger.error({ err: error, jobId: job?.id, name: job?.name }, 'chat job failed')
  })
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('Redis did not connect'))
      }, 5000)
      next.waitUntilReady().then(
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  } catch (error) {
    await next.close().catch(() => undefined)
    throw error
  }
  worker = next
  logger.info('chat worker started')
  return worker
}

export async function stopWorker(): Promise<void> {
  if (!worker) return
  await worker.close()
  worker = null
}

const invokedDirectly = process.argv.some((arg) => /(?:^|\/)worker\.(ts|js)$/.test(arg))
if (invokedDirectly) {
  void startWorker().catch((error: unknown) => {
    logger.warn({ err: error }, 'worker failed to start')
  })
}
