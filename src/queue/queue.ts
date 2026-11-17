import { Queue } from 'bullmq'
import { logger } from '../logger.js'
import { bullConnection } from '../lib/redis.js'

export const CHAT_QUEUE = 'chat-events'
const PREFIX = 'cftchat'

let queue: Queue | null = null

export function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(CHAT_QUEUE, {
      connection: bullConnection(),
      prefix: PREFIX,
    })
    queue.on('error', (error: Error) => {
      logger.warn({ err: error.message }, 'redis queue unavailable; chat APIs continue')
    })
  }
  return queue
}

export async function enqueue(name: string, data: Record<string, unknown>): Promise<void> {
  try {
    await withTimeout(
      getQueue().add(name, data, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 250 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      }),
      1500,
    )
  } catch (error) {
    logger.warn({ err: error, name }, 'failed to enqueue job; message is already saved')
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('redis timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export async function closeQueue(): Promise<void> {
  if (!queue) return
  await queue.close()
  queue = null
}
