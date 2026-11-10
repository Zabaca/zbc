// The small questions every reader of an answer or a request body asks of a value, written once for the space (reach.ts reads the inbox's and meet's answers, views.ts the inbox's other views,
// conversation.ts the page's bodies, client/compose.ts the Worker's outcomes). Only a type is imported, so the page can use them too.

import type { MailKind } from '@space/workspace'

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A whole number, zero or more: a count, an id, a position, or a time in milliseconds. */
export const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

export const isText = (v: unknown): v is string => typeof v === 'string'
export const isList = (v: unknown): v is unknown[] => Array.isArray(v)
export const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

/** A draft on a channel the inbox cannot send on (a text, a LinkedIn or other direct message): the person sends it themselves and marks it sent. False for an email and for an inbox that does not say its kind. */
export const isHandDraft = (kind: MailKind | null | undefined): boolean => kind === 'sms' || kind === 'manual'

/**
 * Whether a draft is sent by hand (Copy words, Mark sent) and not by the inbox. A text or a direct message always is. A Telegram draft is sent by the inbox through the bridge wherever it is
 * `sendable` (a one-to-one chat or a group the space holds); it is a hand draft only where it is not: a channel, a draft on no conversation, or one on a thread this answer does not hold. A send that
 * is waiting on the bridge (`stuck`) is neither.
 */
export const byHand = (d: { kind: MailKind | null | undefined; sendable: boolean; stuck: boolean; sending?: boolean }): boolean =>
  isHandDraft(d.kind) || (d.kind === 'telegram' && !d.sendable && !d.stuck && d.sending !== true)
