import { config } from '../config.js'
import { decodeSeqCursor, encodeSeqCursor } from '../cursor.js'
import { Errors } from '../errors.js'
import { logger } from '../logger.js'
import { prisma } from '../lib/prisma.js'
import { consumeSendRateLimit } from '../lib/rateLimit.js'
import { enqueue } from '../queue/queue.js'
import { sleep } from '../sleep.js'
import {
  allocateMessageSeq,
  recordLatestMessage,
  releaseIdempotency,
  claimIdempotency,
  rewriteLastMessageText,
  tombstoneLastMessage,
} from '../repositories/chat.repository.js'
import {
  advanceLastSeen,
  createMessage,
  editMessage,
  getLastSeen as readLastSeen,
  getMessage,
  hiddenMessageIds,
  hideMessageForUser,
  listMessages,
  listReads,
  markRead,
  newMessageId,
  softDeleteMessage,
  type MessageRecord,
} from '../repositories/message.repository.js'
import { requireActiveMember } from './chat.service.js'

export function normalizeText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) throw Errors.validation('Text is required')
  if (trimmed.includes('\0')) throw Errors.validation('Text cannot contain null characters')
  if (trimmed.length > config.messageMaxLength) {
    throw Errors.validation(`Text must be at most ${config.messageMaxLength} characters`)
  }
  return trimmed
}

async function loadOwnedMessage(chatId: string, messageId: string): Promise<MessageRecord> {
  const message = await getMessage(chatId, messageId)
  if (!message) throw Errors.notFound('Message not found')
  return message
}

async function waitForStoredMessage(chatId: string, messageId: string): Promise<MessageRecord> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const message = await getMessage(chatId, messageId)
    if (message) return message
    await sleep(50)
  }
  throw Errors.conflict('This clientMessageId is already in use. Retry shortly.')
}

export async function sendMessage(input: {
  chatId: string
  senderId: string
  text: string
  clientMessageId?: string
}) {
  await requireActiveMember(input.chatId, input.senderId)
  const text = normalizeText(input.text)
  await consumeSendRateLimit(input.senderId)

  let reservedId: string | null = null
  if (input.clientMessageId) {
    reservedId = newMessageId(input.chatId)
    const claim = await claimIdempotency({
      chatId: input.chatId,
      senderId: input.senderId,
      clientMessageId: input.clientMessageId,
      messageId: reservedId,
    })
    if (!claim.created) {
      const existing = await waitForStoredMessage(input.chatId, claim.messageId)
      return { message: existing, deduped: true }
    }
  }

  const messageId = reservedId ?? newMessageId(input.chatId)
  let committed = false
  try {
    // Order comes from Postgres. The text and timestamp go to Firestore.
    const seq = await allocateMessageSeq(input.chatId)
    const message = await createMessage({
      chatId: input.chatId,
      messageId,
      senderId: input.senderId,
      text,
      seq,
      clientMessageId: input.clientMessageId,
    })
    committed = true
    try {
      await recordLatestMessage({
        chatId: input.chatId,
        messageId: message.messageId,
        text: message.text ?? text,
        senderId: message.senderId,
        createdAt: message.createdAt,
        seq: message.seq,
      })
    } catch (error) {
      logger.error({ err: error, chatId: input.chatId, messageId }, 'failed to update chat preview')
    }
    await enqueue('message.sent', {
      chatId: input.chatId,
      messageId: message.messageId,
      senderId: message.senderId,
      seq: message.seq,
    })
    return { message, deduped: false }
  } catch (error) {
    if (input.clientMessageId && !committed) {
      await releaseIdempotency({
        chatId: input.chatId,
        senderId: input.senderId,
        clientMessageId: input.clientMessageId,
      }).catch((releaseError: unknown) => {
        logger.error({ err: releaseError }, 'failed to release idempotency key')
      })
    }
    throw error
  }
}

export async function getMessages(input: { chatId: string; userId?: string; limit: number; cursor?: string }) {
  if (input.userId) {
    await requireActiveMember(input.chatId, input.userId)
  } else {
    await requireChat(input.chatId)
  }
  const afterSeq = input.cursor ? decodeSeqCursor(input.cursor) : undefined
  if (!input.userId) {
    const page = await listMessages(input.chatId, input.limit, afterSeq)
    const oldest = page.messages[0]
    return {
      messages: page.messages.map(toDto),
      nextCursor: page.hasMore && oldest ? encodeSeqCursor(oldest.seq) : null,
    }
  }

  const visible: MessageRecord[] = []
  let cursorSeq = afterSeq
  let scannedOldest = afterSeq
  let exhausted = false
  for (let pass = 0; pass < 8 && visible.length <= input.limit && !exhausted; pass += 1) {
    const page = await listMessages(input.chatId, input.limit, cursorSeq)
    if (page.messages.length === 0) {
      exhausted = true
      break
    }
    const hidden = await hiddenMessageIds(
      input.chatId,
      input.userId,
      page.messages.map((message) => message.messageId),
    )
    for (const message of page.messages) {
      if (!hidden.has(message.messageId)) visible.push(message)
    }
    exhausted = !page.hasMore
    scannedOldest = page.messages[0]?.seq
    cursorSeq = scannedOldest
  }

  visible.sort((left, right) => left.seq - right.seq)
  const pageMessages = visible.slice(-input.limit)
  const oldest = pageMessages[0]
  const hasMore = visible.length > input.limit || !exhausted
  const resumeSeq = oldest?.seq ?? scannedOldest
  return {
    messages: pageMessages.map(toDto),
    nextCursor: hasMore && resumeSeq !== undefined ? encodeSeqCursor(resumeSeq) : null,
  }
}

async function requireChat(chatId: string) {
  const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: { id: true } })
  if (!chat) throw Errors.notFound('Chat not found')
  return chat
}

export async function editOwnMessage(input: { chatId: string; messageId: string; userId: string; text: string }) {
  await requireActiveMember(input.chatId, input.userId)
  const text = normalizeText(input.text)
  const message = await editMessage(input.chatId, input.messageId, input.userId, text)
  try {
    await rewriteLastMessageText(input.chatId, message.messageId, text)
  } catch (error) {
    logger.error({ err: error, messageId: message.messageId }, 'failed to refresh preview after edit')
  }
  return toDto(message)
}

export async function deleteMessage(input: {
  chatId: string
  messageId: string
  userId: string
  scope: 'me' | 'everyone'
}) {
  await requireActiveMember(input.chatId, input.userId)
  // "me" hides it for one person. "everyone" clears the text for the chat.
  if (input.scope === 'me') {
    const message = await hideMessageForUser(input.chatId, input.messageId, input.userId)
    return toDto(message)
  }
  return deleteOwnMessage(input)
}

export async function deleteOwnMessage(input: { chatId: string; messageId: string; userId: string }) {
  await requireActiveMember(input.chatId, input.userId)
  const before = await loadOwnedMessage(input.chatId, input.messageId)
  const message = await softDeleteMessage(input.chatId, input.messageId, input.userId)
  if (!before.deletedAt) {
    try {
      await tombstoneLastMessage(input.chatId, message.messageId)
    } catch (error) {
      logger.error({ err: error, messageId: message.messageId }, 'failed to tombstone preview')
    }
    await enqueue('message.deleted', {
      chatId: input.chatId,
      messageId: message.messageId,
      senderId: message.senderId,
    })
  }
  return toDto(message)
}

export async function markMessageRead(input: { chatId: string; messageId: string; userId: string }) {
  await requireActiveMember(input.chatId, input.userId)
  await loadOwnedMessage(input.chatId, input.messageId)
  const receipt = await markRead(input.chatId, input.messageId, input.userId)
  await enqueue('message.read', {
    chatId: input.chatId,
    messageId: input.messageId,
    userId: input.userId,
  })
  return {
    chatId: input.chatId,
    messageId: input.messageId,
    userId: input.userId,
    readAt: receipt.readAt.toISOString(),
    created: receipt.created,
  }
}

export async function getMessageReads(input: { chatId: string; messageId: string; userId: string }) {
  await requireActiveMember(input.chatId, input.userId)
  await loadOwnedMessage(input.chatId, input.messageId)
  const reads = await listReads(input.chatId, input.messageId)
  return {
    reads: reads.map((read) => ({ userId: read.userId, readAt: read.readAt.toISOString() })),
  }
}

export async function updateLastSeen(input: { chatId: string; userId: string; messageId: string }) {
  await requireActiveMember(input.chatId, input.userId)
  const message = await loadOwnedMessage(input.chatId, input.messageId)
  const receipt = await advanceLastSeen({
    chatId: input.chatId,
    userId: input.userId,
    messageId: message.messageId,
    messageCreatedAt: message.createdAt,
  })
  if (receipt.advanced) {
    await enqueue('lastseen.updated', {
      chatId: input.chatId,
      userId: input.userId,
      seq: message.seq,
    })
  }
  return {
    chatId: input.chatId,
    userId: input.userId,
    requestedMessageId: input.messageId,
    lastSeenMessageId: receipt.lastSeenMessageId,
    lastSeenAt: receipt.lastSeenAt.toISOString(),
    advanced: receipt.advanced,
  }
}

export async function readLastSeenForMember(chatId: string, userId: string) {
  await requireActiveMember(chatId, userId)
  const receipt = await readLastSeen(chatId, userId)
  if (!receipt) {
    return { chatId, userId, lastSeenMessageId: null, lastSeenAt: null }
  }
  return {
    chatId,
    userId,
    lastSeenMessageId: receipt.lastSeenMessageId,
    lastSeenAt: receipt.lastSeenAt.toISOString(),
  }
}

export function toDto(message: MessageRecord) {
  return {
    messageId: message.messageId,
    chatId: message.chatId,
    senderId: message.senderId,
    text: message.text,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
  }
}
