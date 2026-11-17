import { z } from 'zod'
import { logger } from '../logger.js'
import { clearUnreadMessage, clearUnreadThrough, dropUnread, fanOutUnread } from '../lib/unread.js'
import { listActiveMemberIds } from '../repositories/chat.repository.js'

const sentSchema = z.object({
  chatId: z.string(),
  messageId: z.string(),
  senderId: z.string(),
  seq: z.number().int().positive(),
})

const deletedSchema = z.object({
  chatId: z.string(),
  messageId: z.string(),
  senderId: z.string(),
})

const readSchema = z.object({
  chatId: z.string(),
  messageId: z.string(),
  userId: z.string(),
})

const lastSeenJobSchema = z.object({
  chatId: z.string(),
  userId: z.string(),
  seq: z.number().int().positive(),
})

const removedSchema = z.object({
  chatId: z.string(),
  userId: z.string(),
})

// Unread counts only. The message is already in Firestore before this runs.
export async function processChatEvent(name: string, data: unknown): Promise<void> {
  switch (name) {
    case 'message.sent': {
      const job = sentSchema.parse(data)
      const members = await listActiveMemberIds(job.chatId)
      await fanOutUnread(job.chatId, job.messageId, job.senderId, job.seq, members)
      return
    }
    case 'message.deleted': {
      const job = deletedSchema.parse(data)
      const members = await listActiveMemberIds(job.chatId)
      await clearUnreadMessage(
        job.chatId,
        job.messageId,
        members.filter((id) => id !== job.senderId),
      )
      return
    }
    case 'message.read': {
      const job = readSchema.parse(data)
      await clearUnreadMessage(job.chatId, job.messageId, [job.userId])
      return
    }
    case 'lastseen.updated': {
      const job = lastSeenJobSchema.parse(data)
      await clearUnreadThrough(job.chatId, job.userId, job.seq)
      return
    }
    case 'member.removed': {
      const job = removedSchema.parse(data)
      await dropUnread(job.chatId, job.userId)
      return
    }
    default:
      logger.warn({ name }, 'ignored unknown chat job')
  }
}
