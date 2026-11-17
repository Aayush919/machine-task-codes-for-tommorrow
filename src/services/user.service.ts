import { config } from '../config.js'
import { Errors } from '../errors.js'
import { createUser as insertUser, findUser, findUsers, listUsers } from '../repositories/chat.repository.js'

export async function createUser(input: { name: string; email?: string }) {
  return insertUser(input)
}

export async function listAllUsers() {
  return listUsers()
}

export async function getUser(id: string) {
  const user = await findUser(id)
  if (!user) throw Errors.notFound('User not found')
  return user
}

export async function assertUsersExist(ids: string[]): Promise<void> {
  const unique = [...new Set(ids)]
  const found = await findUsers(unique)
  if (found.length === unique.length) return
  const known = new Set(found.map((user: { id: string }) => user.id))
  const missing = unique.filter((id) => !known.has(id))
  throw Errors.notFound(`User not found: ${missing.join(', ')}`)
}

export function assertGroupSize(memberCount: number): void {
  if (memberCount < 2) throw Errors.validation('A group needs at least two members')
  if (memberCount > config.groupMaxMembers) {
    throw Errors.validation(`A group can have at most ${config.groupMaxMembers} members`)
  }
}
