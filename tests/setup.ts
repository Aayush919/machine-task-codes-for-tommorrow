import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach } from 'vitest'

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('Refusing to run tests without FIRESTORE_EMULATOR_HOST. Use npm test.')
}

const exec = promisify(execFile)

beforeAll(async () => {
  await exec('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: process.cwd(),
    env: process.env,
  })
  const { startWorker } = await import('../src/worker.js')
  await startWorker()
})

beforeEach(async () => {
  const { prisma } = await import('../src/lib/prisma.js')
  const { getQueue } = await import('../src/queue/queue.js')
  const failed = await getQueue().getFailed(0, 100)
  await Promise.all(failed.map((job) => job.remove()))
  await prisma.chat.deleteMany()
  await prisma.user.deleteMany()
})

afterAll(async () => {
  const { stopWorker } = await import('../src/worker.js')
  const { closeQueue } = await import('../src/queue/queue.js')
  const { disconnectRedis } = await import('../src/lib/redis.js')
  const { disconnectPrisma } = await import('../src/lib/prisma.js')
  await stopWorker()
  await closeQueue()
  await disconnectRedis()
  await disconnectPrisma()
})
