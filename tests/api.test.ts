import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { app } from '../src/app.js'
import { clock } from '../src/clock.js'
import { config } from '../src/config.js'
import { createDirect, createUser, expectStatus, send, waitForQueue } from './helpers.js'
import { sleep } from '../src/sleep.js'

afterEach(() => {
  config.rateLimitMax = 5000
  config.editWindowMs = 15 * 60 * 1000
  config.groupMaxMembers = 200
  clock.now = () => new Date()
})

describe('users and health', () => {
  it('reports dependencies and rejects unknown routes', async () => {
    const health = await request(app).get('/health')
    expectStatus(health, 200)
    expect(health.body.ok).toBe(true)

    const missing = await request(app).get('/nope')
    expectStatus(missing, 404)
  })

  it('creates a user and rejects a duplicate email', async () => {
    const user = await createUser('Aayush', 'aayush@example.com')
    const fetched = await request(app).get(`/users/${user.id}`)
    expectStatus(fetched, 200)
    expect(fetched.body.user.name).toBe('Aayush')

    const again = await request(app).post('/users').send({ name: 'Other', email: 'aayush@example.com' })
    expectStatus(again, 409)
  })
})

describe('direct chats', () => {
  it('returns the same chat regardless of order, and rejects a chat with yourself', async () => {
    const a = await createUser('A')
    const b = await createUser('B')

    const self = await createDirect(a.id, a.id)
    expectStatus(self, 400)

    const missing = await createDirect(a.id, 'missing-user')
    expectStatus(missing, 404)

    const first = await createDirect(a.id, b.id)
    expectStatus(first, 201)
    const second = await createDirect(b.id, a.id)
    expectStatus(second, 200)
    expect(second.body.chatId).toBe(first.body.chatId)
    expect(second.body.memberIds).toEqual([a.id, b.id].sort())

    const listed = await request(app).get(`/user/${a.id}/chats`)
    expectStatus(listed, 200)
    expect(listed.body.chats).toHaveLength(1)
    expect(listed.body.chats[0].memberIds).toEqual([a.id, b.id].sort())
  })

  it('collapses concurrent creates into one chat', async () => {
    const a = await createUser('A')
    const b = await createUser('B')
    const responses = await Promise.all(Array.from({ length: 6 }, () => createDirect(a.id, b.id)))
    const ids = new Set(responses.map((res) => res.body.chatId as string))
    expect(ids.size).toBe(1)
    expect(responses.every((res) => res.status === 200 || res.status === 201)).toBe(true)

    const listed = await request(app).get(`/user/${a.id}/chats`)
    expect(listed.body.chats).toHaveLength(1)
  })

  it('lets a member leave and reopen the same direct chat', async () => {
    const a = await createUser('A')
    const b = await createUser('B')
    const created = await createDirect(a.id, b.id)
    const chatId = created.body.chatId as string

    const left = await request(app).post(`/chat/${chatId}/leave`).send({ userId: a.id })
    expectStatus(left, 200)

    const blocked = await send(chatId, a.id, 'hello')
    expectStatus(blocked, 403)

    const reopened = await createDirect(a.id, b.id)
    expectStatus(reopened, 200)
    expect(reopened.body.chatId).toBe(chatId)

    const again = await send(chatId, a.id, 'back')
    expectStatus(again, 201)
  })

  it('does not let a direct chat gain a third member', async () => {
    const a = await createUser('A')
    const b = await createUser('B')
    const c = await createUser('C')
    const created = await createDirect(a.id, b.id)
    const added = await request(app)
      .post(`/chat/${created.body.chatId}/members`)
      .send({ actorId: a.id, userId: c.id })
    expectStatus(added, 409)
  })
})

describe('messages', () => {
  it('stores messages in send order and pages the newest window first', async () => {
    const a = await createUser('A')
    const b = await createUser('B')
    const chatId = (await createDirect(a.id, b.id)).body.chatId as string

    const empty = await request(app).get(`/chat/${chatId}/messages`).query({ userId: a.id })
    expectStatus(empty, 200)
    expect(empty.body.messages).toEqual([])

    for (const text of ['one', 'two', 'three']) {
      expectStatus(await send(chatId, a.id, text), 201)
    }

    const all = await request(app).get(`/chat/${chatId}/messages`).query({ userId: b.id, limit: 50 })
    expect(all.body.messages.map((message: { text: string }) => message.text)).toEqual(['one', 'two', 'three'])

    const page = await request(app).get(`/chat/${chatId}/messages`).query({ userId: b.id, limit: 2 })
    expect(page.body.messages.map((message: { text: string }) => message.text)).toEqual(['two', 'three'])
    const older = await request(app)
      .get(`/chat/${chatId}/messages`)
      .query({ userId: b.id, limit: 2, cursor: page.body.nextCursor })
    expect(older.body.messages.map((message: { text: string }) => message.text)).toEqual(['one'])
    expect(older.body.nextCursor).toBeNull()

    const spec = await request(app).get(`/chat/${chatId}/messages`).query({ limit: 50 })
    expectStatus(spec, 200)
    expect(spec.body.messages).toHaveLength(3)

    const stranger = await createUser('C')
    const denied = await request(app).get(`/chat/${chatId}/messages`).query({ userId: stranger.id })
    expectStatus(denied, 403)

    expectStatus(await request(app).get(`/chat/${chatId}/messages`).query({ limit: 0 }), 400)
    expectStatus(await request(app).get(`/chat/${chatId}/messages`).query({ cursor: 'not-a-cursor' }), 400)
  })

  it('rejects empty, huge, and unauthorized sends', async () => {
    const a = await createUser('A')
    const b = await createUser('B')
    const c = await createUser('C')
    const chatId = (await createDirect(a.id, b.id)).body.chatId as string

    expectStatus(await send(chatId, a.id, '   '), 400)
    expectStatus(await send(chatId, a.id, 'a'.repeat(4001)), 400)
    expectStatus(await request(app).post(`/chat/${chatId}/message/send`).send({ senderId: a.id }), 400)
    expectStatus(await send(chatId, c.id, 'nope'), 403)
    expectStatus(await send('missing-chat', a.id, 'hi'), 404)
  })

  it('keeps both messages when two sends race, and dedupes a client retry', async () => {
    const a = await createUser('A')
    const b = await createUser('B')
    const chatId = (await createDirect(a.id, b.id)).body.chatId as string

    const raced = await Promise.all([send(chatId, a.id, 'a'), send(chatId, b.id, 'b')])
    expect(raced.every((res) => res.status === 201)).toBe(true)

    const first = await send(chatId, a.id, 'original', { clientMessageId: 'retry-1' })
    const second = await send(chatId, a.id, 'different', { clientMessageId: 'retry-1' })
    expectStatus(first, 201)
    expectStatus(second, 200)
    expect(second.body.deduped).toBe(true)
    expect(second.body.message.messageId).toBe(first.body.message.messageId)
    expect(second.body.message.text).toBe('original')

    const listed = await request(app).get(`/chat/${chatId}/messages`).query({ userId: a.id })
    expect(listed.body.messages).toHaveLength(3)
  })

  it('records a read once and does not move last seen backwards', async () => {
    const a = await createUser('A')
    const b = await createUser('B')
    const chatId = (await createDirect(a.id, b.id)).body.chatId as string
    const first = await send(chatId, a.id, 'one')
    const second = await send(chatId, a.id, 'two')
    const firstId = first.body.message.messageId as string
    const secondId = second.body.message.messageId as string

    const read = await request(app).post(`/chat/${chatId}/message/${secondId}/read`).send({ userId: b.id })
    expectStatus(read, 200)
    expect(read.body.created).toBe(true)
    const again = await request(app).post(`/chat/${chatId}/message/${secondId}/read`).send({ userId: b.id })
    expectStatus(again, 200)
    expect(again.body.created).toBe(false)
    expect(again.body.readAt).toBe(read.body.readAt)

    const reads = await request(app).get(`/chat/${chatId}/message/${secondId}/reads`).query({ userId: a.id })
    expect(reads.body.reads).toEqual([{ userId: b.id, readAt: read.body.readAt }])

    const stranger = await createUser('C')
    expectStatus(await request(app).post(`/chat/${chatId}/message/${secondId}/read`).send({ userId: stranger.id }), 403)
    expectStatus(await request(app).post(`/chat/${chatId}/message/missing-msg/read`).send({ userId: b.id }), 404)

    const seen = await request(app).post(`/chat/${chatId}/lastseen`).send({ userId: b.id, messageId: secondId })
    expectStatus(seen, 200)
    expect(seen.body.advanced).toBe(true)

    const older = await request(app).post(`/chat/${chatId}/lastseen`).send({ userId: b.id, messageId: firstId })
    expectStatus(older, 200)
    expect(older.body.advanced).toBe(false)
    expect(older.body.lastSeenMessageId).toBe(secondId)

    const otherChat = (await createDirect(a.id, stranger.id)).body.chatId as string
    const wrong = await request(app).post(`/chat/${otherChat}/lastseen`).send({ userId: a.id, messageId: secondId })
    expectStatus(wrong, 404)
  })

  it('tracks unread per member, then clears it on read, delete, and last seen', async () => {
    const a = await createUser('A')
    const b = await createUser('B')
    const c = await createUser('C')
    const chat = await request(app).post('/chat/group').send({
      creatorId: a.id,
      title: 'Team',
      memberIds: [b.id, c.id],
    })
    expectStatus(chat, 201)
    const chatId = chat.body.chatId as string

    const first = await send(chatId, a.id, 'hello')
    await waitForQueue()
    expect(await unread(b.id, chatId)).toBe(1)
    expect(await unread(c.id, chatId)).toBe(1)
    expect(await unread(a.id, chatId)).toBe(0)

    await request(app).post(`/chat/${chatId}/message/${first.body.message.messageId}/read`).send({ userId: b.id })
    await waitForQueue()
    expect(await unread(b.id, chatId)).toBe(0)
    expect(await unread(c.id, chatId)).toBe(1)

    const second = await send(chatId, a.id, 'again')
    const third = await send(chatId, a.id, 'later')
    await waitForQueue()
    expect(await unread(b.id, chatId)).toBe(2)
    expect(await unread(c.id, chatId)).toBe(3)

    await request(app).post(`/chat/${chatId}/lastseen`).send({
      userId: c.id,
      messageId: second.body.message.messageId,
    })
    await waitForQueue()
    expect(await unread(c.id, chatId)).toBe(1)

    await request(app).post(`/chat/${chatId}/lastseen`).send({
      userId: c.id,
      messageId: third.body.message.messageId,
    })
    await waitForQueue()
    expect(await unread(c.id, chatId)).toBe(0)

    const doomed = await send(chatId, a.id, 'forget me')
    await waitForQueue()
    expect(await unread(b.id, chatId)).toBe(3)
    await request(app).delete(`/chat/${chatId}/message/${doomed.body.message.messageId}`).send({ userId: a.id })
    await waitForQueue()
    expect(await unread(b.id, chatId)).toBe(2)
  })

  it('lets only the sender edit inside the window, and soft-deletes', async () => {
    const a = await createUser('A')
    const b = await createUser('B')
    const chatId = (await createDirect(a.id, b.id)).body.chatId as string
    const first = await send(chatId, a.id, 'draft')
    const second = await send(chatId, a.id, 'final')
    const firstId = first.body.message.messageId as string
    const secondId = second.body.message.messageId as string

    const edited = await request(app).patch(`/chat/${chatId}/message/${firstId}`).send({ userId: a.id, text: 'fixed' })
    expectStatus(edited, 200)
    expect(edited.body.message.text).toBe('fixed')
    expect(edited.body.message.editedAt).toEqual(expect.any(String))

    const notMine = await request(app).patch(`/chat/${chatId}/message/${firstId}`).send({ userId: b.id, text: 'hack' })
    expectStatus(notMine, 403)

    const listed = await request(app).get(`/user/${b.id}/chats`)
    expect(listed.body.chats[0].lastMessage.text).toBe('final')

    const lastEdit = await request(app).patch(`/chat/${chatId}/message/${secondId}`).send({ userId: a.id, text: 'shipped' })
    expectStatus(lastEdit, 200)
    const afterEdit = await request(app).get(`/user/${b.id}/chats`)
    expect(afterEdit.body.chats[0].lastMessage.text).toBe('shipped')

    clock.now = () => new Date(Date.now() + 16 * 60 * 1000)
    const tooLate = await request(app).patch(`/chat/${chatId}/message/${secondId}`).send({ userId: a.id, text: 'late' })
    expectStatus(tooLate, 403)

    const removed = await request(app).delete(`/chat/${chatId}/message/${secondId}`).send({ userId: a.id })
    expectStatus(removed, 200)
    expect(removed.body.message.text).toBeNull()
    expect(removed.body.message.deletedAt).toEqual(expect.any(String))

    const removedAgain = await request(app).delete(`/chat/${chatId}/message/${secondId}`).send({ userId: a.id })
    expectStatus(removedAgain, 200)

    const editDeleted = await request(app).patch(`/chat/${chatId}/message/${secondId}`).send({ userId: a.id, text: 'nope' })
    expectStatus(editDeleted, 409)

    const notSender = await request(app).delete(`/chat/${chatId}/message/${firstId}`).send({ userId: b.id })
    expectStatus(notSender, 403)

    const preview = await request(app).get(`/user/${a.id}/chats`)
    expect(preview.body.chats[0].lastMessage.deleted).toBe(true)
    expect(preview.body.chats[0].lastMessage.text).toBeNull()
  })

  it('hides a message only for the member who deletes it for themselves', async () => {
    const a = await createUser('A')
    const b = await createUser('B')
    const chatId = (await createDirect(a.id, b.id)).body.chatId as string
    const sent = await send(chatId, a.id, 'secret')
    const messageId = sent.body.message.messageId as string

    const blocked = await request(app)
      .delete(`/chat/${chatId}/message/${messageId}`)
      .send({ userId: b.id, scope: 'everyone' })
    expectStatus(blocked, 403)

    const hidden = await request(app)
      .delete(`/chat/${chatId}/message/${messageId}`)
      .send({ userId: b.id, scope: 'me' })
    expectStatus(hidden, 200)

    const again = await request(app)
      .delete(`/chat/${chatId}/message/${messageId}`)
      .send({ userId: b.id, scope: 'me' })
    expectStatus(again, 200)

    const asB = await request(app).get(`/chat/${chatId}/messages?userId=${b.id}`)
    expect(asB.body.messages.map((message: { text: string | null }) => message.text)).not.toContain('secret')

    const asA = await request(app).get(`/chat/${chatId}/messages?userId=${a.id}`)
    expect(asA.body.messages.map((message: { text: string | null }) => message.text)).toContain('secret')

    const spec = await request(app).get(`/chat/${chatId}/messages`)
    expect(spec.body.messages.map((message: { text: string | null }) => message.text)).toContain('secret')

    const listB = await request(app).get(`/user/${b.id}/chats`)
    expect(listB.body.chats[0].lastMessage).toBeNull()
    expect(listB.body.chats[0].lastMessageHiddenForMe).toBe(true)

    const listA = await request(app).get(`/user/${a.id}/chats`)
    expect(listA.body.chats[0].lastMessage.text).toBe('secret')
  })

  it('rate limits sends per user', async () => {
    config.rateLimitMax = 2
    const a = await createUser('A')
    const b = await createUser('B')
    const chatId = (await createDirect(a.id, b.id)).body.chatId as string
    expectStatus(await send(chatId, a.id, '1'), 201)
    expectStatus(await send(chatId, a.id, '2'), 201)
    expectStatus(await send(chatId, a.id, '3'), 429)
    const listed = await request(app).get(`/chat/${chatId}/messages`).query({ userId: a.id })
    expect(listed.body.messages).toHaveLength(2)
  })
})

describe('groups', () => {
  it('dedupes members and keeps admin actions to admins', async () => {
    const a = await createUser('A')
    const b = await createUser('B')
    const c = await createUser('C')

    const tooSmall = await request(app).post('/chat/group').send({ creatorId: a.id, title: 'Nope', memberIds: [a.id] })
    expectStatus(tooSmall, 400)

    const created = await request(app).post('/chat/group').send({
      creatorId: a.id,
      title: '  Standup  ',
      memberIds: [b.id, b.id, a.id],
    })
    expectStatus(created, 201)
    expect(created.body.memberIds).toEqual([a.id, b.id].sort())
    const chatId = created.body.chatId as string

    const forbidden = await request(app).post(`/chat/${chatId}/members`).send({ actorId: b.id, userId: c.id })
    expectStatus(forbidden, 403)

    const added = await request(app).post(`/chat/${chatId}/members`).send({ actorId: a.id, userId: c.id })
    expectStatus(added, 201)
    expect(added.body.memberIds).toEqual([a.id, b.id, c.id].sort())

    const duplicate = await request(app).post(`/chat/${chatId}/members`).send({ actorId: a.id, userId: c.id })
    expectStatus(duplicate, 409)

    const renameDenied = await request(app).patch(`/chat/${chatId}`).send({ actorId: b.id, title: 'Hijack' })
    expectStatus(renameDenied, 403)
    const renamed = await request(app).patch(`/chat/${chatId}`).send({ actorId: a.id, title: 'Daily' })
    expectStatus(renamed, 200)
    expect(renamed.body.title).toBe('Daily')

    const demoteLast = await request(app)
      .patch(`/chat/${chatId}/members/${a.id}`)
      .send({ actorId: a.id, role: 'member' })
    expectStatus(demoteLast, 409)

    const promoted = await request(app)
      .patch(`/chat/${chatId}/members/${b.id}`)
      .send({ actorId: a.id, role: 'admin' })
    expectStatus(promoted, 200)
    const demoted = await request(app)
      .patch(`/chat/${chatId}/members/${a.id}`)
      .send({ actorId: b.id, role: 'member' })
    expectStatus(demoted, 200)

    const removed = await request(app).delete(`/chat/${chatId}/members/${c.id}`).send({ actorId: b.id })
    expectStatus(removed, 200)
    expectStatus(await send(chatId, c.id, 'still here?'), 403)

    const rejoined = await request(app).post(`/chat/${chatId}/members`).send({ actorId: b.id, userId: c.id })
    expectStatus(rejoined, 201)
    expectStatus(await send(chatId, c.id, 'back'), 201)
  })

  it('promotes someone when the last admin leaves', async () => {
    const a = await createUser('A')
    const b = await createUser('B')
    const created = await request(app).post('/chat/group').send({
      creatorId: a.id,
      title: 'Pair',
      memberIds: [b.id],
    })
    const chatId = created.body.chatId as string
    const left = await request(app).post(`/chat/${chatId}/leave`).send({ userId: a.id })
    expectStatus(left, 200)
    expect(left.body.promotedUserId).toBe(b.id)

    const view = await request(app).get(`/chat/${chatId}`).query({ userId: b.id })
    expectStatus(view, 200)
    expect(view.body.members).toEqual([{ userId: b.id, role: 'admin' }])
    expectStatus(await request(app).get(`/chat/${chatId}`).query({ userId: a.id }), 403)
  })

  it('orders a user chat list by recent activity and pages it', async () => {
    const a = await createUser('A')
    const b = await createUser('B')
    const c = await createUser('C')
    const d = await createUser('D')
    const ab = (await createDirect(a.id, b.id)).body.chatId as string
    const ac = (await createDirect(a.id, c.id)).body.chatId as string
    const ad = (await createDirect(a.id, d.id)).body.chatId as string
    await send(ab, b.id, 'first')
    await sleep(20)
    await send(ac, c.id, 'second')
    await sleep(20)
    await send(ad, d.id, 'third')

    const page = await request(app).get(`/user/${a.id}/chats`).query({ limit: 2 })
    expectStatus(page, 200)
    expect(page.body.chats.map((chat: { chatId: string }) => chat.chatId)).toEqual([ad, ac])
    const rest = await request(app).get(`/user/${a.id}/chats`).query({ limit: 2, cursor: page.body.nextCursor })
    expect(rest.body.chats.map((chat: { chatId: string }) => chat.chatId)).toEqual([ab])

    expectStatus(await request(app).get('/user/missing-user/chats'), 404)
  })
})

async function unread(userId: string, chatId: string): Promise<number> {
  const res = await request(app).get(`/user/${userId}/chats`)
  expectStatus(res, 200)
  const chat = (res.body.chats as Array<{ chatId: string; unreadCount: number }>).find((item) => item.chatId === chatId)
  if (!chat) throw new Error(`chat ${chatId} missing from list`)
  return chat.unreadCount
}
