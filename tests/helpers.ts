import request, { type Response } from 'supertest'
import { expect } from 'vitest'
import { app } from '../src/app.js'
import { getQueue } from '../src/queue/queue.js'
import { sleep } from '../src/sleep.js'

export function expectStatus(res: Response, status: number): void {
  expect(res.status, JSON.stringify(res.body)).toBe(status)
}

export async function createUser(name: string, email?: string) {
  const res = await request(app).post('/users').send({ name, email })
  expectStatus(res, 201)
  return res.body.user as { id: string; name: string; email: string | null }
}

export async function createDirect(userAId: string, userBId: string) {
  return request(app).post('/chat/create').send({ userAId, userBId })
}

export async function send(chatId: string, senderId: string, text: string, extra: Record<string, unknown> = {}) {
  return request(app).post(`/chat/${chatId}/message/send`).send({ senderId, text, ...extra })
}

export async function waitForQueue(): Promise<void> {
  const queue = getQueue()
  const deadline = Date.now() + 8_000
  let idlePasses = 0
  while (Date.now() < deadline) {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'paused')
    const pending = counts.waiting + counts.active + counts.delayed + counts.paused
    if (pending === 0) {
      idlePasses += 1
      if (idlePasses >= 3) {
        const failed = await queue.getFailed(0, 10)
        if (failed.length > 0) {
          throw new Error(failed.map((job) => `${job.name}: ${job.failedReason}`).join('\n'))
        }
        return
      }
    } else {
      idlePasses = 0
    }
    await sleep(40)
  }
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed')
  throw new Error(`queue did not drain: ${JSON.stringify(counts)}`)
}
