import type { Prisma } from '@prisma/client'
import { config } from '../config.js'
import { decodeChatCursor, encodeChatCursor } from '../cursor.js'
import { Errors } from '../errors.js'
import { logger } from '../logger.js'
import { isUniqueViolation, prisma } from '../lib/prisma.js'
import { getUnreadCounts } from '../lib/unread.js'
import { enqueue } from '../queue/queue.js'
import {
  countActiveAdmins,
  directChatKey,
  findChat,
  findDirectChat,
  findMembership,
  insertDirectChat,
  insertGroupChat,
  listChatPage,
  loadChats,
  lockChat,
  type ChatWithMembers,
  type MemberRole,
  reactivateMembers,
  renameChat,
} from '../repositories/chat.repository.js'
import { chatsWithHiddenLastMessage } from '../repositories/message.repository.js'
import { assertGroupSize, assertUsersExist, getUser } from './user.service.js'

export { directChatKey }

type MemberView = { userId: string; role: MemberRole }

function memberIdsOf(members: Array<{ userId: string }>): string[] {
  return members.map((member: { userId: string }) => member.userId).sort()
}

export async function createDirectChat(input: { userAId: string; userBId: string }) {
  await assertUsersExist([input.userAId, input.userBId])
  const key = directChatKey(input.userAId, input.userBId)
  const existing = await findDirectChat(key)
  if (existing) {
    await reactivateMembers(existing.id, [input.userAId, input.userBId])
    return {
      chatId: existing.id,
      type: 'direct' as const,
      memberIds: [input.userAId, input.userBId].sort(),
      created: false,
    }
  }

  try {
    const chat = await insertDirectChat({
      directKey: key,
      createdById: input.userAId,
      memberIds: [input.userAId, input.userBId],
    })
    return {
      chatId: chat.id,
      type: 'direct' as const,
      memberIds: [input.userAId, input.userBId].sort(),
      created: true,
    }
  } catch (error) {
    // Two creates at the same time: the unique key keeps one row, return that chat.
    if (!isUniqueViolation(error)) throw error
    const again = await findDirectChat(key)
    if (!again) throw error
    await reactivateMembers(again.id, [input.userAId, input.userBId])
    return {
      chatId: again.id,
      type: 'direct' as const,
      memberIds: [input.userAId, input.userBId].sort(),
      created: false,
    }
  }
}

export async function createGroupChat(input: { creatorId: string; title: string; memberIds: string[] }) {
  const memberIds = [...new Set([input.creatorId, ...input.memberIds])]
  assertGroupSize(memberIds.length)
  await assertUsersExist(memberIds)
  const chat = await insertGroupChat({
    title: input.title.trim(),
    createdById: input.creatorId,
    memberIds,
  })
  return {
    chatId: chat.id,
    type: 'group' as const,
    title: chat.title,
    memberIds: [...memberIds].sort(),
    created: true,
  }
}

export async function requireActiveMember(chatId: string, userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!user) throw Errors.notFound('User not found')
  const chat = await prisma.chat.findUnique({ where: { id: chatId } })
  if (!chat) throw Errors.notFound('Chat not found')
  const membership = await findMembership(chatId, userId)
  if (!membership) throw Errors.forbidden('You are not a member of this chat')
  if (membership.leftAt) throw Errors.forbidden('You left this chat')
  return { chat, membership }
}

async function requireGroupAdmin(chatId: string, actorId: string) {
  const { chat, membership } = await requireActiveMember(chatId, actorId)
  if (chat.type !== 'group') throw Errors.conflict('Direct chats have exactly two members')
  if (membership.role !== 'admin') throw Errors.forbidden('Only an admin can do that')
  return { chat, membership }
}

export async function getChatForMember(chatId: string, userId: string) {
  const { chat } = await requireActiveMember(chatId, userId)
  const full = await findChat(chat.id)
  if (!full) throw Errors.notFound('Chat not found')
  return presentChat(full)
}

export async function renameGroup(chatId: string, actorId: string, title: string) {
  await requireGroupAdmin(chatId, actorId)
  const chat = await renameChat(chatId, title.trim())
  return { chatId: chat.id, title: chat.title }
}

export async function addGroupMember(chatId: string, actorId: string, userId: string) {
  await requireGroupAdmin(chatId, actorId)
  await assertUsersExist([userId])
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockChat(tx, chatId)
    const existing = await tx.chatMember.findUnique({ where: { chatId_userId: { chatId, userId } } })
    if (existing && !existing.leftAt) throw Errors.conflict('User is already a member')
    const active = await tx.chatMember.count({ where: { chatId, leftAt: null } })
    if (active >= config.groupMaxMembers) {
      throw Errors.validation(`A group can have at most ${config.groupMaxMembers} members`)
    }
    if (existing) {
      await tx.chatMember.update({
        where: { chatId_userId: { chatId, userId } },
        data: { leftAt: null, joinedAt: new Date(), role: 'member' },
      })
      return
    }
    await tx.chatMember.create({ data: { chatId, userId, role: 'member' } })
  })
  const chat = await findChat(chatId)
  return { chatId, memberIds: memberIdsOf(chat?.members ?? []) }
}

export async function removeGroupMember(chatId: string, actorId: string, userId: string) {
  if (actorId === userId) throw Errors.validation('Use leave to remove yourself')
  await requireGroupAdmin(chatId, actorId)
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockChat(tx, chatId)
    const target = await tx.chatMember.findUnique({ where: { chatId_userId: { chatId, userId } } })
    if (!target || target.leftAt) throw Errors.notFound('Member not found')
    if (target.role === 'admin') {
      const admins = await countActiveAdmins(tx, chatId)
      if (admins <= 1) throw Errors.conflict('Promote another admin first')
    }
    await tx.chatMember.update({
      where: { chatId_userId: { chatId, userId } },
      data: { leftAt: new Date() },
    })
  })
  await enqueue('member.removed', { chatId, userId })
  return { chatId, userId, removed: true }
}

export async function updateMemberRole(chatId: string, actorId: string, userId: string, role: MemberRole) {
  await requireGroupAdmin(chatId, actorId)
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockChat(tx, chatId)
    const target = await tx.chatMember.findUnique({ where: { chatId_userId: { chatId, userId } } })
    if (!target || target.leftAt) throw Errors.notFound('Member not found')
    if (target.role === role) return
    if (target.role === 'admin' && role === 'member') {
      const admins = await countActiveAdmins(tx, chatId)
      if (admins <= 1) throw Errors.conflict('Promote another admin first')
    }
    await tx.chatMember.update({
      where: { chatId_userId: { chatId, userId } },
      data: { role },
    })
  })
  return { chatId, userId, role }
}

export async function leaveChat(chatId: string, userId: string) {
  const { chat } = await requireActiveMember(chatId, userId)
  const promotedUserId = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockChat(tx, chatId)
    const current = await tx.chatMember.findUnique({ where: { chatId_userId: { chatId, userId } } })
    if (!current || current.leftAt) throw Errors.forbidden('You are not a member of this chat')
    let promoted: string | null = null
    if (chat.type === 'group' && current.role === 'admin') {
      const admins = await countActiveAdmins(tx, chatId)
      if (admins <= 1) {
        const successor = await tx.chatMember.findFirst({
          where: { chatId, leftAt: null, userId: { not: userId } },
          orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
        })
        if (successor) {
          await tx.chatMember.update({
            where: { chatId_userId: { chatId, userId: successor.userId } },
            data: { role: 'admin' },
          })
          promoted = successor.userId
        }
      }
    }
    await tx.chatMember.update({
      where: { chatId_userId: { chatId, userId } },
      data: { leftAt: new Date() },
    })
    return promoted
  })
  await enqueue('member.removed', { chatId, userId })
  return { chatId, userId, left: true, promotedUserId }
}

export async function listUserChats(userId: string, limit: number, cursor?: string) {
  await getUser(userId)
  const decoded = cursor ? decodeChatCursor(cursor) : undefined
  const rows = await listChatPage(userId, limit + 1, decoded)
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const ids = page.map((row) => row.id)
  const chats = await loadChats(ids)
  const byId = new Map(chats.map((chat: ChatWithMembers) => [chat.id, chat]))
  let unread = new Map<string, number>()
  try {
    unread = await getUnreadCounts(userId, ids)
  } catch (error) {
    logger.error({ err: error, userId }, 'unread lookup failed')
  }
  let hiddenChats = new Set<string>()
  try {
    const pairs = chats.flatMap((chat: ChatWithMembers) =>
      chat.lastMessageId ? [{ chatId: chat.id, messageId: chat.lastMessageId }] : [],
    )
    hiddenChats = await chatsWithHiddenLastMessage(userId, pairs)
  } catch (error) {
    logger.error({ err: error, userId }, 'hidden message lookup failed')
  }
  const last = page[page.length - 1]
  return {
    chats: page.flatMap((row) => {
      const chat = byId.get(row.id)
      if (!chat) return []
      return [presentChatSummary(chat, unread.get(chat.id) ?? 0, hiddenChats.has(chat.id))]
    }),
    nextCursor: hasMore && last ? encodeChatCursor(last.updatedAt, last.id) : null,
  }
}

function presentChat(chat: ChatWithMembers) {
  return {
    chatId: chat.id,
    type: chat.type,
    title: chat.title,
    createdById: chat.createdById,
    memberIds: memberIdsOf(chat.members),
    members: chat.members.map((member: MemberView) => ({ userId: member.userId, role: member.role })),
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  }
}

function presentChatSummary(chat: ChatWithMembers, unreadCount: number, hiddenForMe: boolean) {
  return {
    chatId: chat.id,
    type: chat.type,
    title: chat.title,
    memberIds: memberIdsOf(chat.members),
    members: chat.members.map((member: MemberView) => ({
      userId: member.userId,
      role: member.role,
    })),
    lastMessageHiddenForMe: hiddenForMe,
    lastMessage: chat.lastMessageId && !hiddenForMe
      ? {
          messageId: chat.lastMessageId,
          text: chat.lastMessageDeleted ? null : chat.lastMessageText,
          senderId: chat.lastMessageSenderId,
          createdAt: chat.lastMessageAt?.toISOString() ?? null,
          deleted: chat.lastMessageDeleted,
        }
      : null,
    unreadCount,
    updatedAt: chat.updatedAt.toISOString(),
  }
}
