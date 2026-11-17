import type { Prisma } from '@prisma/client'
import { Errors } from '../errors.js'
import { isUniqueViolation, prisma } from '../lib/prisma.js'

export type MemberRole = 'admin' | 'member'

type ChatRow = {
  id: string
  type: 'direct' | 'group'
  title: string | null
  directKey: string | null
  createdById: string
  messageSeq: number
  lastMessageId: string | null
  lastMessageText: string | null
  lastMessageSenderId: string | null
  lastMessageAt: Date | null
  lastMessageDeleted: boolean
  lastMessageSeq: number | null
  createdAt: Date
  updatedAt: Date
}

// A:B and B:A are the same chat.
export function directChatKey(userAId: string, userBId: string): string {
  return [userAId, userBId].sort().join(':')
}

export async function lockChat(tx: Prisma.TransactionClient, chatId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Chat" WHERE "id" = ${chatId} FOR UPDATE
  `
  if (rows.length === 0) throw Errors.notFound('Chat not found')
}

export async function findUser(id: string) {
  return prisma.user.findUnique({ where: { id } })
}

export async function listUsers(): Promise<Array<{ id: string; name: string; email: string | null; createdAt: Date }>> {
  return prisma.user.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, email: true, createdAt: true },
  })
}

export async function findUsers(ids: string[]): Promise<Array<{ id: string }>> {
  return prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true } })
}

export async function createUser(input: { name: string; email?: string }) {
  try {
    return await prisma.user.create({ data: { name: input.name, email: input.email } })
  } catch (error) {
    if (isUniqueViolation(error)) throw Errors.conflict('Email already exists')
    throw error
  }
}

export async function findDirectChat(directKey: string) {
  return prisma.chat.findUnique({ where: { directKey } })
}

export async function insertDirectChat(input: { directKey: string; createdById: string; memberIds: [string, string] }) {
  return prisma.chat.create({
    data: {
      type: 'direct',
      directKey: input.directKey,
      createdById: input.createdById,
      members: {
        create: input.memberIds.map((userId) => ({ userId, role: 'member' as const })),
      },
    },
  })
}

export async function reactivateMembers(chatId: string, userIds: string[]): Promise<void> {
  await prisma.$transaction(
    userIds.map((userId) =>
      prisma.chatMember.update({
        where: { chatId_userId: { chatId, userId } },
        data: { leftAt: null },
      }),
    ),
  )
}

export async function insertGroupChat(input: { title: string; createdById: string; memberIds: string[] }) {
  return prisma.chat.create({
    data: {
      type: 'group',
      title: input.title,
      createdById: input.createdById,
      members: {
        create: input.memberIds.map((userId) => ({
          userId,
          role: userId === input.createdById ? ('admin' as const) : ('member' as const),
        })),
      },
    },
  })
}

export async function findChat(
  chatId: string,
): Promise<(ChatRow & { members: Array<{ userId: string; role: MemberRole; joinedAt: Date; leftAt: Date | null }> }) | null> {
  return prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      members: {
        where: { leftAt: null },
        select: { userId: true, role: true, joinedAt: true, leftAt: true },
        orderBy: { userId: 'asc' },
      },
    },
  })
}

export async function findMembership(chatId: string, userId: string) {
  return prisma.chatMember.findUnique({ where: { chatId_userId: { chatId, userId } } })
}

export async function listActiveMemberIds(chatId: string): Promise<string[]> {
  const rows: Array<{ userId: string }> = await prisma.chatMember.findMany({
    where: { chatId, leftAt: null },
    select: { userId: true },
  })
  return rows.map((row: { userId: string }) => row.userId)
}

export async function countActiveAdmins(tx: Prisma.TransactionClient, chatId: string): Promise<number> {
  return tx.chatMember.count({ where: { chatId, role: 'admin', leftAt: null } })
}

export async function allocateMessageSeq(chatId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ messageSeq: number }>>`
    UPDATE "Chat"
    SET "messageSeq" = "messageSeq" + 1
    WHERE "id" = ${chatId}
    RETURNING "messageSeq"
  `
  const seq = rows[0]?.messageSeq
  if (seq === undefined) throw Errors.notFound('Chat not found')
  return Number(seq)
}

export async function recordLatestMessage(input: {
  chatId: string
  messageId: string
  text: string
  senderId: string
  createdAt: Date
  seq: number
}): Promise<void> {
  await prisma.chat.updateMany({
    where: {
      id: input.chatId,
      OR: [{ lastMessageSeq: null }, { lastMessageSeq: { lt: input.seq } }],
    },
    data: {
      lastMessageId: input.messageId,
      lastMessageText: input.text,
      lastMessageSenderId: input.senderId,
      lastMessageAt: input.createdAt,
      lastMessageDeleted: false,
      lastMessageSeq: input.seq,
      updatedAt: new Date(),
    },
  })
}

export async function rewriteLastMessageText(chatId: string, messageId: string, text: string): Promise<void> {
  await prisma.chat.updateMany({
    where: { id: chatId, lastMessageId: messageId, lastMessageDeleted: false },
    data: { lastMessageText: text, updatedAt: new Date() },
  })
}

export async function tombstoneLastMessage(chatId: string, messageId: string): Promise<void> {
  await prisma.chat.updateMany({
    where: { id: chatId, lastMessageId: messageId },
    data: { lastMessageText: null, lastMessageDeleted: true, updatedAt: new Date() },
  })
}

export async function claimIdempotency(input: {
  chatId: string
  senderId: string
  clientMessageId: string
  messageId: string
}): Promise<{ messageId: string; created: boolean }> {
  try {
    await prisma.messageIdempotency.create({ data: input })
    return { messageId: input.messageId, created: true }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const existing = await prisma.messageIdempotency.findUnique({
      where: {
        chatId_senderId_clientMessageId: {
          chatId: input.chatId,
          senderId: input.senderId,
          clientMessageId: input.clientMessageId,
        },
      },
    })
    if (!existing) throw Errors.conflict('Send collided. Retry.')
    return { messageId: existing.messageId, created: false }
  }
}

export async function releaseIdempotency(input: {
  chatId: string
  senderId: string
  clientMessageId: string
}): Promise<void> {
  await prisma.messageIdempotency.delete({
    where: {
      chatId_senderId_clientMessageId: input,
    },
  })
}

export type ChatListRow = {
  id: string
  updatedAt: Date
}

export async function listChatPage(
  userId: string,
  limit: number,
  cursor?: { updatedAt: Date; chatId: string },
): Promise<ChatListRow[]> {
  const rows = await prisma.chatMember.findMany({
    where: {
      userId,
      leftAt: null,
      ...(cursor
        ? {
            OR: [
              { chat: { updatedAt: { lt: cursor.updatedAt } } },
              { AND: [{ chat: { updatedAt: cursor.updatedAt } }, { chatId: { lt: cursor.chatId } }] },
            ],
          }
        : {}),
    },
    orderBy: [{ chat: { updatedAt: 'desc' } }, { chatId: 'desc' }],
    take: limit,
    select: {
      chatId: true,
      chat: { select: { updatedAt: true } },
    },
  })
  return rows.map((row: { chatId: string; chat: { updatedAt: Date } }) => ({
    id: row.chatId,
    updatedAt: row.chat.updatedAt,
  }))
}

export type ChatWithMembers = ChatRow & {
  members: Array<{ userId: string; role: MemberRole }>
}

export async function loadChats(ids: string[]): Promise<ChatWithMembers[]> {
  if (ids.length === 0) return []
  return prisma.chat.findMany({
    where: { id: { in: ids } },
    include: {
      members: {
        where: { leftAt: null },
        select: { userId: true, role: true },
        orderBy: { userId: 'asc' },
      },
    },
  })
}

export async function renameChat(chatId: string, title: string) {
  return prisma.chat.update({ where: { id: chatId }, data: { title } })
}
