import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler.js'
import {
  addGroupMember,
  createDirectChat,
  createGroupChat,
  getChatForMember,
  leaveChat,
  listUserChats,
  removeGroupMember,
  renameGroup,
  updateMemberRole,
} from '../services/chat.service.js'
import {
  deleteMessage,
  editOwnMessage,
  getMessageReads,
  getMessages,
  markMessageRead,
  readLastSeenForMember,
  sendMessage,
  toDto,
  updateLastSeen,
} from '../services/message.service.js'
import {
  actorSchema,
  addMemberSchema,
  createDirectSchema,
  createGroupSchema,
  deleteMessageSchema,
  editMessageSchema,
  lastSeenSchema,
  leaveChatSchema,
  listChatsQuerySchema,
  listMessagesQuerySchema,
  memberQuerySchema,
  parseRouteId,
  removeMemberSchema,
  renameChatSchema,
  sendMessageSchema,
  updateRoleSchema,
} from '../validators.js'

export const chatRouter = Router()

chatRouter.post(
  '/chat/create',
  asyncHandler(async (req, res) => {
    const body = createDirectSchema.parse(req.body)
    const chat = await createDirectChat(body)
    res.status(chat.created ? 201 : 200).json(chat)
  }),
)

chatRouter.post(
  '/chat/group',
  asyncHandler(async (req, res) => {
    const body = createGroupSchema.parse(req.body)
    const chat = await createGroupChat(body)
    res.status(201).json(chat)
  }),
)

chatRouter.get(
  '/chat/:chatId',
  asyncHandler(async (req, res) => {
    const chatId = parseRouteId(req.params.chatId, 'chatId')
    const query = memberQuerySchema.parse(req.query)
    res.json(await getChatForMember(chatId, query.userId))
  }),
)

chatRouter.patch(
  '/chat/:chatId',
  asyncHandler(async (req, res) => {
    const chatId = parseRouteId(req.params.chatId, 'chatId')
    const body = renameChatSchema.parse(req.body)
    res.json(await renameGroup(chatId, body.actorId, body.title))
  }),
)

chatRouter.post(
  '/chat/:chatId/members',
  asyncHandler(async (req, res) => {
    const chatId = parseRouteId(req.params.chatId, 'chatId')
    const body = addMemberSchema.parse(req.body)
    const result = await addGroupMember(chatId, body.actorId, body.userId)
    res.status(201).json(result)
  }),
)

chatRouter.patch(
  '/chat/:chatId/members/:userId',
  asyncHandler(async (req, res) => {
    const chatId = parseRouteId(req.params.chatId, 'chatId')
    const userId = parseRouteId(req.params.userId, 'userId')
    const body = updateRoleSchema.parse(req.body)
    res.json(await updateMemberRole(chatId, body.actorId, userId, body.role))
  }),
)

chatRouter.delete(
  '/chat/:chatId/members/:userId',
  asyncHandler(async (req, res) => {
    const chatId = parseRouteId(req.params.chatId, 'chatId')
    const userId = parseRouteId(req.params.userId, 'userId')
    const body = removeMemberSchema.parse(req.body ?? {})
    res.json(await removeGroupMember(chatId, body.actorId, userId))
  }),
)

chatRouter.post(
  '/chat/:chatId/leave',
  asyncHandler(async (req, res) => {
    const chatId = parseRouteId(req.params.chatId, 'chatId')
    const body = leaveChatSchema.parse(req.body)
    res.json(await leaveChat(chatId, body.userId))
  }),
)

chatRouter.post(
  '/chat/:chatId/message/send',
  asyncHandler(async (req, res) => {
    const chatId = parseRouteId(req.params.chatId, 'chatId')
    const body = sendMessageSchema.parse(req.body)
    const result = await sendMessage({ chatId, ...body })
    res.status(result.deduped ? 200 : 201).json({
      deduped: result.deduped,
      message: toDto(result.message),
    })
  }),
)

chatRouter.get(
  '/chat/:chatId/messages',
  asyncHandler(async (req, res) => {
    const chatId = parseRouteId(req.params.chatId, 'chatId')
    const query = listMessagesQuerySchema.parse(req.query)
    res.json(await getMessages({ chatId, ...query }))
  }),
)

chatRouter.patch(
  '/chat/:chatId/message/:messageId',
  asyncHandler(async (req, res) => {
    const chatId = parseRouteId(req.params.chatId, 'chatId')
    const messageId = parseRouteId(req.params.messageId, 'messageId')
    const body = editMessageSchema.parse(req.body)
    res.json({ message: await editOwnMessage({ chatId, messageId, userId: body.userId, text: body.text }) })
  }),
)

chatRouter.delete(
  '/chat/:chatId/message/:messageId',
  asyncHandler(async (req, res) => {
    const chatId = parseRouteId(req.params.chatId, 'chatId')
    const messageId = parseRouteId(req.params.messageId, 'messageId')
    const body = deleteMessageSchema.parse(req.body ?? {})
    res.json({
      message: await deleteMessage({ chatId, messageId, userId: body.userId, scope: body.scope }),
    })
  }),
)

chatRouter.post(
  '/chat/:chatId/message/:messageId/read',
  asyncHandler(async (req, res) => {
    const chatId = parseRouteId(req.params.chatId, 'chatId')
    const messageId = parseRouteId(req.params.messageId, 'messageId')
    const body = actorSchema.parse(req.body)
    res.json(await markMessageRead({ chatId, messageId, userId: body.userId }))
  }),
)

chatRouter.get(
  '/chat/:chatId/message/:messageId/reads',
  asyncHandler(async (req, res) => {
    const chatId = parseRouteId(req.params.chatId, 'chatId')
    const messageId = parseRouteId(req.params.messageId, 'messageId')
    const query = memberQuerySchema.parse(req.query)
    res.json(await getMessageReads({ chatId, messageId, userId: query.userId }))
  }),
)

chatRouter.post(
  '/chat/:chatId/lastseen',
  asyncHandler(async (req, res) => {
    const chatId = parseRouteId(req.params.chatId, 'chatId')
    const body = lastSeenSchema.parse(req.body)
    res.json(await updateLastSeen({ chatId, userId: body.userId, messageId: body.messageId }))
  }),
)

chatRouter.get(
  '/chat/:chatId/lastseen/:userId',
  asyncHandler(async (req, res) => {
    const chatId = parseRouteId(req.params.chatId, 'chatId')
    const userId = parseRouteId(req.params.userId, 'userId')
    res.json(await readLastSeenForMember(chatId, userId))
  }),
)

chatRouter.get(
  '/user/:userId/chats',
  asyncHandler(async (req, res) => {
    const userId = parseRouteId(req.params.userId, 'userId')
    const query = listChatsQuerySchema.parse(req.query)
    res.json(await listUserChats(userId, query.limit, query.cursor))
  }),
)
