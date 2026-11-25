import type { TextsChat, TextsMessage, TextsPush } from '../src/texts/wire'

/** The paired phone in tests: the bridge's own id for it. */
export const account = { id: 'phone-1' }

/** Dana's number: invented, in the reserved range for fiction. */
export const DANA = '+15555550123'

/** A one-to-one chat with a person (Dana Reyes, chat c-2001) unless a test says otherwise. */
export function person(over: { id?: string; name?: string; address?: string } = {}): TextsChat {
  return { id: over.id ?? 'c-2001', kind: 'person', name: over.name ?? 'Dana Reyes', address: over.address ?? DANA }
}

/** A short code's chat (five digits). */
export function shortCode(over: { id?: string; name?: string; address?: string } = {}): TextsChat {
  const address = over.address ?? '55501'
  return { id: over.id ?? 'c-5501', kind: 'short-code', name: over.name ?? address, address }
}

/** A sender that has a name and no number. */
export function named(over: { id?: string; name?: string; address?: string } = {}): TextsChat {
  const address = over.address ?? 'ExampleBank'
  return { id: over.id ?? 'c-6601', kind: 'named-sender', name: over.name ?? 'Example Bank', address }
}

/** A business chat. */
export function business(over: { id?: string; name?: string; address?: string } = {}): TextsChat {
  return {
    id: over.id ?? 'c-7701',
    kind: 'business',
    name: over.name ?? 'Example Air',
    address: over.address ?? 'example-air-agent',
  }
}

/** A group chat. */
export function group(over: { id?: string; name?: string } = {}): TextsChat {
  return {
    id: over.id ?? 'g-9001',
    kind: 'group',
    name: over.name ?? 'Book club',
    members: [{ address: '+15555550124', name: 'Eli Park' }],
  }
}

/** A message in Dana's chat unless a test says otherwise: from them, unread. */
export function message(over: Partial<TextsMessage> & { id: string }): TextsMessage {
  return {
    chatId: 'c-2001',
    at: '2026-11-05T10:00:00.000Z',
    out: false,
    read: false,
    text: `message ${over.id}`,
    ...over,
  }
}

export function push(chats: TextsChat[], messages: TextsMessage[], over: { mirror?: boolean } = {}): TextsPush {
  return { account, chats, messages, ...(over.mirror && { mirror: true }) }
}
