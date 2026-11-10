import type {
  TelegramChat,
  TelegramMessage,
  TelegramPerson,
  TelegramPosition,
  TelegramPush,
} from '../src/telegram/wire'

/** Tessa's Telegram user id in tests: the account the bridge is signed in as. */
export const account = { id: '7000000001' }

export const POSITION: TelegramPosition = { pts: 7292, qts: 0, date: 1_794_000_000, seq: 11 }

/** A one-to-one chat with a person (id 2001, "Dana Reyes") unless a test says otherwise. Bots pass `bot: true` and get a bot's kind. */
export function chat(
  over: {
    id?: string
    name?: string
    bot?: boolean
    phone?: string
    username?: string
    muted?: boolean
    archived?: boolean
    readInboxMaxId?: number
  } = {},
): TelegramChat {
  const id = over.id ?? '2001'
  const bot = over.bot === true
  return {
    id,
    kind: bot ? 'bot' : 'user',
    person: {
      id,
      name: over.name ?? 'Dana Reyes',
      bot,
      ...(over.phone !== undefined && { phone: over.phone }),
      ...(over.username !== undefined && { username: over.username }),
    },
    muted: over.muted ?? false,
    ...(over.archived !== undefined && { archived: over.archived }),
    ...(over.readInboxMaxId !== undefined && { readInboxMaxId: over.readInboxMaxId }),
  }
}

/** A basic group (`-` and its id) unless `super` is set, which makes it a supergroup (`-100` and its id); named by its title. */
export function group(
  over: { id?: string; title?: string; muted?: boolean; archived?: boolean; readInboxMaxId?: number } = {},
): TelegramChat {
  return {
    id: over.id ?? '-1001234567',
    kind: 'group',
    title: over.title ?? 'Founders',
    muted: over.muted ?? false,
    ...(over.archived !== undefined && { archived: over.archived }),
    ...(over.readInboxMaxId !== undefined && { readInboxMaxId: over.readInboxMaxId }),
  }
}

/** A channel Tessa follows. */
export function channel(over: { id?: string; title?: string; muted?: boolean; archived?: boolean } = {}): TelegramChat {
  return {
    id: over.id ?? '-1009876543',
    kind: 'channel',
    title: over.title ?? 'Cloudflare Status',
    muted: over.muted ?? false,
    ...(over.archived !== undefined && { archived: over.archived }),
  }
}

/** A person who writes in a group. */
export const member = (id: string, name: string, over: { bot?: boolean; phone?: string } = {}): TelegramPerson => ({
  id,
  name,
  bot: over.bot === true,
  ...(over.phone !== undefined && { phone: over.phone }),
})

/** A message in a group by a member (or Tessa's own, with `out`). */
export function groupMessage(over: Partial<TelegramMessage> & { id: number; chatId?: string }): TelegramMessage {
  return { chatId: '-1001234567', at: '2026-11-05T10:00:00.000Z', out: false, text: `message ${over.id}`, ...over }
}

export function message(over: Partial<TelegramMessage> & { id: number }): TelegramMessage {
  return { chatId: '2001', at: '2026-11-05T10:00:00.000Z', out: false, text: `message ${over.id}`, ...over }
}

export function push(
  chats: TelegramChat[],
  messages: TelegramMessage[],
  over: { mirror?: boolean; position?: TelegramPosition; chatPositions?: Record<string, number> } = {},
): TelegramPush {
  return {
    account,
    chats,
    messages,
    ...(over.mirror && { mirror: true }),
    ...(over.position && { position: over.position }),
    ...(over.chatPositions && { chatPositions: over.chatPositions }),
  }
}
