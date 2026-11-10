// A person's history as one run by time, and the paging back through it: pure functions on literal data.
import { describe, expect, test } from 'bun:test'
import { type ChatMessage, type HistorySource, type MailMessage, cutoffOf, mergeHistory, oldestId, refreshSources, sourcesToPage, withEarlier, withEarlierPage } from '../src/history'

const mail = (id: string, at: number, conversationId = 't1'): MailMessage => ({ id, conversationId, subject: 'S', direction: 'in', at, from: 'Ana', text: `mail ${id}`, textCut: false })
const said = (id: number, at: number): ChatMessage => ({ id, conversationId: 11, authorName: 'Ana', mine: false, at, text: `chat ${id}`, edited: false })
const mailSource = (messages: MailMessage[], more = false, contactId = 'c1'): HistorySource => ({ kind: 'mail', contactId, messages, more })
const chatSource = (messages: ChatMessage[], more = false): HistorySource => ({ kind: 'chat', conversationId: 11, messages, more })
const texts = (sources: HistorySource[]) => mergeHistory(sources).entries.map((e) => e.message.text)

describe('the merge', () => {
  test('emails and direct messages are one run by time, oldest first, whichever source each came from', () => {
    expect(texts([mailSource([mail('a', 10), mail('c', 30)]), chatSource([said(1, 20), said(2, 40)])])).toEqual(['mail a', 'chat 1', 'mail c', 'chat 2'])
  })

  test('at the same moment an email comes before a chat message, and within a source the order is the id’s', () => {
    expect(texts([chatSource([said(1, 10)]), mailSource([mail('b', 10), mail('a', 10)])])).toEqual(['mail a', 'mail b', 'chat 1'])
  })

  test('an email that two of a person’s contacts are both on is one entry', () => {
    const shared = mail('m1', 10, 't-shared')
    const entries = mergeHistory([mailSource([shared], false, 'c-work'), mailSource([shared, mail('m2', 20)], false, 'c-gmail')]).entries
    expect(entries.map((e) => e.message.id)).toEqual(['m1', 'm2'])
  })

  test('chat messages of two conversations never collide on a number', () => {
    const other: HistorySource = { kind: 'chat', conversationId: 12, messages: [{ ...said(1, 15), conversationId: 12 }], more: false }
    expect(mergeHistory([chatSource([said(1, 10)]), other]).entries).toHaveLength(2)
  })
})

describe('paging back', () => {
  // The mail reaches back to 100 and has more; the chat reaches back to 10 and has none: a chat message at 10 and a mail at 100 would put a
  // gap between them where mail from 11 to 99 may be. Only what both sources have been read back to is shown.
  const mailPage = mailSource([mail('m100', 100), mail('m200', 200)], true)
  const chatAll = chatSource([said(1, 10), said(2, 150)], false)

  test('shows only as far back as every source that has more has been read', () => {
    expect(cutoffOf([mailPage, chatAll])).toBe(100)
    expect(texts([mailPage, chatAll])).toEqual(['mail m100', 'chat 2', 'mail m200'])
    expect(mergeHistory([mailPage, chatAll]).hasEarlier).toBe(true)
  })

  test('when nothing has more, everything is shown and there is no earlier', () => {
    const all = [mailSource([mail('a', 5)]), chatAll]
    expect(cutoffOf(all)).toBeNull()
    expect(texts(all)).toEqual(['mail a', 'chat 1', 'chat 2'])
    expect(mergeHistory(all).hasEarlier).toBe(false)
  })

  test('the next page is asked of the source that stopped first, by the id of the oldest message held', () => {
    expect(sourcesToPage([mailPage, chatAll]).map((s) => s.kind)).toEqual(['mail'])
    expect(oldestId(mailPage)).toBe('m100')
    const chatMore = chatSource([said(7, 300)], true)
    // Both have more: the one that reaches back less far is paged, the other already reaches further.
    expect(sourcesToPage([mailPage, chatMore]).map((s) => s.kind)).toEqual(['chat'])
    expect(oldestId(chatMore)).toBe('7')
  })

  test('an older page comes in before what is held, and what it brings makes the held-back chat appear', () => {
    const paged = withEarlier(mailPage, { messages: [mail('m050', 50), mail('m060', 60)], more: false })
    expect(paged.messages.map((m) => m.id)).toEqual(['m050', 'm060', 'm100', 'm200'])
    expect(paged.more).toBe(false)
    expect(texts([paged, chatAll])).toEqual(['chat 1', 'mail m050', 'mail m060', 'mail m100', 'chat 2', 'mail m200'])
  })

  test('a page that repeats a message does not hold it twice', () => {
    const paged = withEarlier(mailPage, { messages: [mail('m100', 100), mail('m090', 90)], more: true })
    expect(paged.messages.map((m) => m.id)).toEqual(['m090', 'm100', 'm200'])
  })
})

describe('reading the newest page again while the conversation is open', () => {
  test('new messages join, and the older pages already read stay', () => {
    const held = [mailSource([mail('m1', 1), mail('m2', 2), mail('m3', 3)], false)]
    const fresh = [mailSource([mail('m2', 2), mail('m3', 3), mail('m4', 4)], true)]
    const next = refreshSources(held, fresh)[0] as Extract<HistorySource, { kind: 'mail' }>
    expect(next.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    // The fresh page says more because it is only a page; what is held reaches the start, so nothing is left to page.
    expect(next.more).toBe(false)
  })

  test('where nothing older was held, the fresh page’s word on more stands', () => {
    const held = [chatSource([said(5, 5), said(6, 6)], true)]
    const fresh = [chatSource([said(5, 5), said(6, 6), said(7, 7)], true)]
    const next = refreshSources(held, fresh)[0] as Extract<HistorySource, { kind: 'chat' }>
    expect(next.messages.map((m) => m.id)).toEqual([5, 6, 7])
    expect(next.more).toBe(true)
  })

  test('a fresh page that reaches back to nothing held replaces it, so there is never a gap', () => {
    const held = [chatSource([said(1, 1), said(2, 2)], false)]
    const fresh = [chatSource([said(90, 90), said(91, 91)], true)]
    const next = refreshSources(held, fresh)[0] as Extract<HistorySource, { kind: 'chat' }>
    expect(next.messages.map((m) => m.id)).toEqual([90, 91])
    expect(next.more).toBe(true)
  })

  test('a source that is new is taken as it is', () => {
    expect(refreshSources([], [chatSource([said(1, 1)])])).toHaveLength(1)
  })
})

describe('an older page that arrives after a refresh', () => {
  const held = chatSource([said(50, 50), said(51, 51)], true)
  const page = { messages: [said(40, 40), said(41, 41)], more: true }

  test('is placed when the source still stops where it did when the page was asked for', () => {
    const next = withEarlierPage([held], 'chat:11', '50', page)[0] as Extract<HistorySource, { kind: 'chat' }>
    expect(next.messages.map((m) => m.id)).toEqual([40, 41, 50, 51])
  })

  test('is dropped when a refresh replaced what was held in between, so no gap opens', () => {
    // The refresh found more than a page of new messages: what was held is gone and the source now stops at 90.
    const replaced = refreshSources([held], [chatSource([said(90, 90), said(91, 91)], true)])
    const next = withEarlierPage(replaced, 'chat:11', '50', page)[0] as Extract<HistorySource, { kind: 'chat' }>
    expect(next.messages.map((m) => m.id)).toEqual([90, 91])
    expect(next.more).toBe(true)
  })

  test('is placed when the refresh only added to the end, since the source still stops at the same message', () => {
    const grown = refreshSources([held], [chatSource([said(50, 50), said(51, 51), said(52, 52)], true)])
    const next = withEarlierPage(grown, 'chat:11', '50', page)[0] as Extract<HistorySource, { kind: 'chat' }>
    expect(next.messages.map((m) => m.id)).toEqual([40, 41, 50, 51, 52])
  })

  test('leaves the other sources alone', () => {
    const mail = mailSource([mail50()], true)
    expect(withEarlierPage([mail, held], 'chat:11', '50', page)[0]).toBe(mail)
  })
})

function mail50(): MailMessage {
  return { id: 'm50', conversationId: 't1', subject: 'S', direction: 'in', at: 50, from: 'Ana', text: 'mail m50', textCut: false }
}
