import { FieldValue, Timestamp, type DocumentData } from 'firebase-admin/firestore'
import { clock } from '../clock.js'
import { config } from '../config.js'
import { Errors } from '../errors.js'
import { getDb } from '../lib/firestore.js'

export type MessageRecord = {
  messageId: string
  chatId: string
  senderId: string
  text: string | null
  seq: number
  createdAt: Date
  editedAt: Date | null
  deletedAt: Date | null
  clientMessageId: string | null
}

export type ReadReceipt = {
  userId: string
  readAt: Date
}

export type LastSeenReceipt = {
  userId: string
  lastSeenMessageId: string
  lastSeenAt: Date
  lastSeenMessageCreatedAt: Date
}

function messages(chatId: string) {
  return getDb().collection('chats').doc(chatId).collection('messages')
}

function asDate(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Timestamp) return value.toDate()
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

function toMessage(chatId: string, id: string, data: DocumentData): MessageRecord {
  const createdAt = asDate(data.createdAt)
  if (!createdAt) throw new Error(`Message ${id} is missing createdAt`)
  if (typeof data.senderId !== 'string') throw new Error(`Message ${id} is missing senderId`)
  if (typeof data.seq !== 'number' || !Number.isInteger(data.seq)) throw new Error(`Message ${id} is missing seq`)
  const deletedAt = asDate(data.deletedAt)
  return {
    messageId: id,
    chatId,
    senderId: data.senderId,
    text: deletedAt ? null : typeof data.text === 'string' ? data.text : '',
    seq: data.seq,
    createdAt,
    editedAt: asDate(data.editedAt),
    deletedAt,
    clientMessageId: typeof data.clientMessageId === 'string' ? data.clientMessageId : null,
  }
}

export async function createMessage(input: {
  chatId: string
  messageId: string
  senderId: string
  text: string
  seq: number
  clientMessageId?: string
}): Promise<MessageRecord> {
  const ref = messages(input.chatId).doc(input.messageId)
  await ref.set({
    senderId: input.senderId,
    text: input.text,
    seq: input.seq,
    createdAt: FieldValue.serverTimestamp(), // Firestore clock, not the API clock
    editedAt: null,
    deletedAt: null,
    clientMessageId: input.clientMessageId ?? null,
  })
  const saved = await ref.get()
  const data = saved.data()
  if (!data) throw new Error('Firestore did not return the new message')
  return toMessage(input.chatId, saved.id, data)
}

export function newMessageId(chatId: string): string {
  return messages(chatId).doc().id
}

export async function getMessage(chatId: string, messageId: string): Promise<MessageRecord | null> {
  const snap = await messages(chatId).doc(messageId).get()
  const data = snap.data()
  if (!snap.exists || !data) return null
  return toMessage(chatId, snap.id, data)
}

export async function listMessages(
  chatId: string,
  limit: number,
  afterSeq?: number,
): Promise<{ messages: MessageRecord[]; hasMore: boolean }> {
  let query = messages(chatId).orderBy('seq', 'desc').limit(limit + 1)
  if (afterSeq !== undefined) query = query.startAfter(afterSeq)
  const snap = await query.get()
  const hasMore = snap.docs.length > limit
  const page = hasMore ? snap.docs.slice(0, limit) : snap.docs
  const records = page.map((doc) => toMessage(chatId, doc.id, doc.data())).reverse()
  return { messages: records, hasMore }
}

export async function hiddenMessageIds(chatId: string, userId: string, messageIds: string[]): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set()
  const refs = messageIds.map((messageId) => messages(chatId).doc(messageId).collection('hidden').doc(userId))
  const snaps = await getDb().getAll(...refs)
  const hidden = new Set<string>()
  snaps.forEach((snap, index) => {
    const messageId = messageIds[index]
    if (snap.exists && messageId) hidden.add(messageId)
  })
  return hidden
}

export async function chatsWithHiddenLastMessage(
  userId: string,
  pairs: Array<{ chatId: string; messageId: string }>,
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set()
  const refs = pairs.map((pair) => messages(pair.chatId).doc(pair.messageId).collection('hidden').doc(userId))
  const snaps = await getDb().getAll(...refs)
  const hidden = new Set<string>()
  snaps.forEach((snap, index) => {
    const chatId = pairs[index]?.chatId
    if (snap.exists && chatId) hidden.add(chatId)
  })
  return hidden
}

export async function hideMessageForUser(chatId: string, messageId: string, userId: string): Promise<MessageRecord> {
  const current = await getMessage(chatId, messageId)
  if (!current) throw Errors.notFound('Message not found')
  await messages(chatId).doc(messageId).collection('hidden').doc(userId).set(
    { userId, hiddenAt: Timestamp.fromDate(clock.now()) },
    { merge: true },
  )
  return current
}

export async function editMessage(chatId: string, messageId: string, userId: string, text: string): Promise<MessageRecord> {
  const ref = messages(chatId).doc(messageId)
  return getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const data = snap.data()
    if (!snap.exists || !data) throw Errors.notFound('Message not found')
    const current = toMessage(chatId, snap.id, data)
    if (current.senderId !== userId) throw Errors.forbidden('Only the sender can edit this message')
    if (current.deletedAt) throw Errors.conflict('Message is deleted')
    if (clock.now().getTime() - current.createdAt.getTime() > config.editWindowMs) {
      throw Errors.forbidden('The edit window has passed')
    }
    const editedAt = Timestamp.fromDate(clock.now())
    tx.update(ref, { text, editedAt })
    return { ...current, text, editedAt: editedAt.toDate() }
  })
}

export async function softDeleteMessage(chatId: string, messageId: string, userId: string): Promise<MessageRecord> {
  const ref = messages(chatId).doc(messageId)
  return getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const data = snap.data()
    if (!snap.exists || !data) throw Errors.notFound('Message not found')
    const current = toMessage(chatId, snap.id, data)
    if (current.senderId !== userId) throw Errors.forbidden('Only the sender can delete this message for everyone')
    if (current.deletedAt) return current
    const deletedAt = Timestamp.fromDate(clock.now())
    tx.update(ref, { text: '', deletedAt })
    return { ...current, text: null, deletedAt: deletedAt.toDate() }
  })
}

export async function markRead(chatId: string, messageId: string, userId: string): Promise<{ readAt: Date; created: boolean }> {
  const ref = messages(chatId).doc(messageId).collection('reads').doc(userId)
  return getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (snap.exists) {
      const readAt = asDate(snap.data()?.readAt) ?? clock.now()
      return { readAt, created: false }
    }
    const readAt = Timestamp.fromDate(clock.now())
    tx.set(ref, { userId, readAt })
    return { readAt: readAt.toDate(), created: true }
  })
}

export async function listReads(chatId: string, messageId: string): Promise<ReadReceipt[]> {
  const snap = await messages(chatId).doc(messageId).collection('reads').orderBy('readAt', 'asc').get()
  return snap.docs.map((doc) => ({
    userId: doc.id,
    readAt: asDate(doc.data().readAt) ?? new Date(0),
  }))
}

export async function advanceLastSeen(input: {
  chatId: string
  userId: string
  messageId: string
  messageCreatedAt: Date
}): Promise<LastSeenReceipt & { advanced: boolean }> {
  const ref = getDb().collection('chats').doc(input.chatId).collection('receipts').doc(input.userId)
  return getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const nextMs = input.messageCreatedAt.getTime()
    if (snap.exists) {
      const data = snap.data() ?? {}
      const currentMs = asDate(data.lastSeenMessageCreatedAt)?.getTime() ?? 0
      const currentId = typeof data.lastSeenMessageId === 'string' ? data.lastSeenMessageId : ''
      // Older message ids do not pull last seen backwards.
    const isNewer = nextMs > currentMs || (nextMs === currentMs && input.messageId > currentId)
      if (!isNewer) {
        return {
          advanced: false,
          userId: input.userId,
          lastSeenMessageId: currentId,
          lastSeenAt: asDate(data.lastSeenAt) ?? new Date(currentMs),
          lastSeenMessageCreatedAt: asDate(data.lastSeenMessageCreatedAt) ?? new Date(currentMs),
        }
      }
    }
    const seenAt = Timestamp.fromDate(clock.now())
    const messageTs = Timestamp.fromDate(input.messageCreatedAt)
    tx.set(ref, {
      userId: input.userId,
      lastSeenMessageId: input.messageId,
      lastSeenAt: seenAt,
      lastSeenMessageCreatedAt: messageTs,
    })
    return {
      advanced: true,
      userId: input.userId,
      lastSeenMessageId: input.messageId,
      lastSeenAt: seenAt.toDate(),
      lastSeenMessageCreatedAt: input.messageCreatedAt,
    }
  })
}

export async function getLastSeen(chatId: string, userId: string): Promise<LastSeenReceipt | null> {
  const snap = await getDb().collection('chats').doc(chatId).collection('receipts').doc(userId).get()
  if (!snap.exists) return null
  const data = snap.data() ?? {}
  const lastSeenAt = asDate(data.lastSeenAt)
  const messageCreatedAt = asDate(data.lastSeenMessageCreatedAt)
  if (!lastSeenAt || !messageCreatedAt || typeof data.lastSeenMessageId !== 'string') return null
  return {
    userId,
    lastSeenMessageId: data.lastSeenMessageId,
    lastSeenAt,
    lastSeenMessageCreatedAt: messageCreatedAt,
  }
}
