# Chat backend

Users, chats, and membership live in PostgreSQL. Messages, read receipts, and last-seen pointers live in Firestore. The API listens on port **3000**.

Redis is optional. It holds unread counts and the send rate limit, and BullMQ uses it to update those counts after a message is already saved. If Redis is not running, every required chat API still succeeds. Unread counts stay at 0 and the rate limit is skipped.

There is no WebSocket. A client sees a new message by calling `GET /chat/:chatId/messages` again.

## What each part does

| Piece | Required | Role |
| --- | --- | --- |
| PostgreSQL | Yes | Users, chats, members, last-message preview, message sequence |
| Firestore | Yes | Message text, timestamp, read receipts, last seen |
| Redis | No | Unread counts, send rate limit, BullMQ queue |
| Docker | No | One command that starts PostgreSQL, Redis, the Firestore emulator, and the API |

The Firestore emulator is a local Firestore. The API code is the same one that talks to a real Firebase project. With `FIRESTORE_EMULATOR_HOST` set, writes go to the emulator. Remove that variable and set `GOOGLE_APPLICATION_CREDENTIALS` to use a real project.

Nothing in this repository is live chat data. The first run creates empty tables and an empty emulator. Data appears when the APIs are called.

## Option 1 — Docker, one command

Install Docker, then from this folder:

```bash
docker compose up --build
```

That starts PostgreSQL, Redis, the Firestore emulator, and the API. The API applies the database migrations on startup. The API is at http://localhost:3000.

Stop it with `docker compose down`.

Ports on your machine: `3000` (API) and `8080` (Firestore emulator). Those two need to be free. PostgreSQL and Redis stay inside Docker, so a database you already have on `5432` or `6379` does not stop this command.

## Option 2 — commands, no Docker

Install Node.js 20 or newer, PostgreSQL 16, and Java 21 (Java is only for the Firestore emulator). Redis is optional. Install it if you want unread counts.

`npm run emulators` looks for Homebrew's OpenJDK 21 when `java` is not already on PATH. Any other Java 21 install is fine as long as `java -version` works. Docker does not need Java on the host. The image installs it.

Create the database once, as a PostgreSQL superuser:

```sql
CREATE USER chat WITH PASSWORD 'chat';
CREATE DATABASE chat OWNER chat;
```

Then:

```bash
cp .env.example .env
npm install
npm run db:migrate
```

Terminal 1:

```bash
npm run emulators
```

Terminal 2:

```bash
npm run dev
```

The API is at http://localhost:3000.

`.env` sets `PORT=3000`. Leave `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` while using the emulator.

If Redis is not installed, leave `REDIS_URL` as it is and do not start Redis. `GET /health` stays OK when PostgreSQL and Firestore are up. The `redis` field reads `down`.

## APIs

Base URL is `http://localhost:3000`. User and chat ids come back from create calls. They are not values you invent.

| Method | Path | Body or query | Result |
| --- | --- | --- | --- |
| `GET` | `/health` | | `200` when Postgres and Firestore are up. `redis` may be `down`. |
| `POST` | `/users` | `{ "name", "email"? }` | `201` `{ user: { id, name, email, createdAt } }` |
| `GET` | `/users` | | `{ users }` |
| `GET` | `/users/:userId` | | `{ user }` |
| `POST` | `/chat/create` | `{ "userAId", "userBId" }` | `201` the first time, `200` if that pair already has a chat. Body: `{ chatId, type: "direct", memberIds, created }` |
| `POST` | `/chat/group` | `{ "creatorId", "title", "memberIds" }` | `201` `{ chatId, type: "group", title, memberIds, created }` |
| `GET` | `/chat/:chatId` | `?userId=` | Chat, members, and roles. Caller must be an active member. |
| `PATCH` | `/chat/:chatId` | `{ "actorId", "title" }` | Rename a group. Admin only. |
| `POST` | `/chat/:chatId/members` | `{ "actorId", "userId" }` | `201`. Add a group member. Admin only. |
| `PATCH` | `/chat/:chatId/members/:userId` | `{ "actorId", "role" }` | `role` is `admin` or `member`. The last admin cannot be demoted. |
| `DELETE` | `/chat/:chatId/members/:userId` | `{ "actorId" }` | Remove someone else. Use leave to remove yourself. |
| `POST` | `/chat/:chatId/leave` | `{ "userId" }` | `{ chatId, userId, left, promotedUserId }` |
| `POST` | `/chat/:chatId/message/send` | `{ "senderId", "text", "clientMessageId"? }` | `201`, or `200` when `clientMessageId` was already used. `{ deduped, message }` |
| `GET` | `/chat/:chatId/messages` | `?limit=50&cursor=&userId=` | Latest page, oldest first. `nextCursor` loads older pages. `limit` is 1 to 100. `userId` is optional. |
| `PATCH` | `/chat/:chatId/message/:messageId` | `{ "userId", "text" }` | Sender only, within 15 minutes. |
| `DELETE` | `/chat/:chatId/message/:messageId` | `{ "userId", "scope"? }` | `scope` is `everyone` (default) or `me`. |
| `POST` | `/chat/:chatId/message/:messageId/read` | `{ "userId" }` | `{ chatId, messageId, userId, readAt, created }` |
| `GET` | `/chat/:chatId/message/:messageId/reads` | `?userId=` | `{ reads: [{ userId, readAt }] }` |
| `POST` | `/chat/:chatId/lastseen` | `{ "userId", "messageId" }` | Moves forward only. An older id does not change the pointer. |
| `GET` | `/chat/:chatId/lastseen/:userId` | | `{ chatId, userId, lastSeenMessageId, lastSeenAt }` |
| `GET` | `/user/:userId/chats` | `?limit=50&cursor=` | Chats, member ids, last-message preview, `unreadCount`. |

`POST /chat/create` always returns `chatId`. The same pair, in either order, returns the same chat. A second call is `200`, the first is `201`.

Create two users, then a chat:

```bash
curl -s localhost:3000/users -H 'content-type: application/json' -d '{"name":"A"}'
curl -s localhost:3000/users -H 'content-type: application/json' -d '{"name":"B"}'
curl -s localhost:3000/chat/create -H 'content-type: application/json' \
  -d '{"userAId":"<a>","userBId":"<b>"}'
```

`requests.http` has a ready call for every row above. Replace `USER_A_ID`, `CHAT_ID`, and `MESSAGE_ID` with ids from earlier responses. This service is the API only. There is no web page.

## Behaviour worth knowing

- A direct chat is unique on the sorted pair of user ids. Concurrent creates hit that unique key and return the winner.
- Leaving a direct chat and calling create again reopens that same chat.
- Message order is a per-chat sequence allocated in Postgres, stored on the Firestore document next to the server timestamp. Two messages in the same millisecond stay in accept order. `GET` returns the latest `limit` messages, oldest first, with an opaque `nextCursor` for older pages.
- `userId` on `GET /messages` is optional so the spec call works. When it is present, the caller must be an active member.
- Send accepts an optional `clientMessageId`. A retry returns the original message and does not write a second one. The mapping is in Postgres, so it survives a Redis flush.
- Last seen only moves forward. An older message id leaves the current pointer where it is.
- Read receipts are one document per user under the message. Marking the same message read again returns the original `readAt`.
- Only the sender can edit, and only for 15 minutes (`EDIT_WINDOW_MS`). Delete for everyone clears the text and can be called twice. Delete for me hides that message for one member.
- When Redis is up, unread is a sorted set scored by message sequence. The worker adds it after send, removes one id on read or delete, and drops everything up to the last-seen sequence. The sender is not counted.
- When Redis is up, sends are capped per user (`RATE_LIMIT_MAX` per minute).
- Group admin changes lock the chat row. The last admin cannot be demoted or removed. If they leave, the longest-standing other member is promoted.
- A group needs two people and stops at `GROUP_MAX_MEMBERS` (200). Direct chats reject an add-member call.

## Tests

`npm test` starts the Firestore emulator and runs the API suite against Postgres, Redis db 3, and the emulator. It will not run without `FIRESTORE_EMULATOR_HOST`, so a test run cannot touch a real Firebase project.

```bash
npm test
```

## Layout

```
src/routes          HTTP
src/services        membership rules, edit window, idempotency
src/repositories    Postgres and Firestore
src/queue           BullMQ worker
```
