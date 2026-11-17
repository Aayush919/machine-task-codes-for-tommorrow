import { redis } from './redis.js'

export function unreadKey(userId: string, chatId: string): string {
  return `cft:unread:${userId}:${chatId}`
}

export async function getUnreadCounts(userId: string, chatIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (chatIds.length === 0) return counts
  const pipeline = redis.pipeline()
  for (const chatId of chatIds) pipeline.zcard(unreadKey(userId, chatId))
  const results = await pipeline.exec()
  chatIds.forEach((chatId, index) => {
    const entry = results?.[index]
    const value = entry && !entry[0] && typeof entry[1] === 'number' ? entry[1] : 0
    counts.set(chatId, value)
  })
  return counts
}

export async function fanOutUnread(
  chatId: string,
  messageId: string,
  senderId: string,
  seq: number,
  memberIds: string[],
): Promise<void> {
  const pipeline = redis.pipeline()
  for (const memberId of memberIds) {
    if (memberId === senderId) continue
    pipeline.zadd(unreadKey(memberId, chatId), seq, messageId)
  }
  await pipeline.exec()
}

export async function clearUnreadMessage(chatId: string, messageId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return
  const pipeline = redis.pipeline()
  for (const userId of userIds) pipeline.zrem(unreadKey(userId, chatId), messageId)
  await pipeline.exec()
}

export async function clearUnreadThrough(chatId: string, userId: string, seq: number): Promise<void> {
  await redis.zremrangebyscore(unreadKey(userId, chatId), '-inf', seq)
}

export async function dropUnread(chatId: string, userId: string): Promise<void> {
  await redis.del(unreadKey(userId, chatId))
}
