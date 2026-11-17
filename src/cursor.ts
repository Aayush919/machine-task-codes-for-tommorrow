import { Errors } from './errors.js'

export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeCursor(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
  } catch {
    throw Errors.validation('Invalid cursor')
  }
}

export function encodeSeqCursor(seq: number): string {
  return encodeCursor({ seq })
}

export function decodeSeqCursor(value: string): number {
  const parsed = decodeCursor(value)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('seq' in parsed) ||
    typeof parsed.seq !== 'number' ||
    !Number.isInteger(parsed.seq) ||
    parsed.seq < 1
  ) {
    throw Errors.validation('Invalid cursor')
  }
  return parsed.seq
}

export function encodeChatCursor(updatedAt: Date, chatId: string): string {
  return encodeCursor({ t: updatedAt.toISOString(), id: chatId })
}

export function decodeChatCursor(value: string): { updatedAt: Date; chatId: string } {
  const parsed = decodeCursor(value)
  if (typeof parsed !== 'object' || parsed === null || !('t' in parsed) || !('id' in parsed)) {
    throw Errors.validation('Invalid cursor')
  }
  const record = parsed as { t: unknown; id: unknown }
  if (typeof record.t !== 'string' || typeof record.id !== 'string' || !record.id) {
    throw Errors.validation('Invalid cursor')
  }
  const updatedAt = new Date(record.t)
  if (Number.isNaN(updatedAt.getTime())) throw Errors.validation('Invalid cursor')
  return { updatedAt, chatId: record.id }
}
