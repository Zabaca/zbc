// What the space accepts as an answer from the inbox about drafts: the contract's own lists, and a Cc that may be absent but never half there.
import { describe, expect, test } from 'bun:test'
import { DRAFT_AUTHORS } from '@space/workspace'
import { isInboxDrafts, isInboxHistory } from '../src/reach'

const draft = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  conversationId: 't1',
  contactId: 'c1',
  toName: 'Dana',
  to: 'dana@x.example',
  cc: [],
  subject: 'Re',
  text: 'Hi',
  rev: 1,
  author: 'claude',
  stuck: false,
  at: 1,
  ...over,
})

describe('a draft in an answer', () => {
  test('is read with every author the contract names, and none it does not', () => {
    for (const author of DRAFT_AUTHORS) expect(isInboxDrafts([draft({ author })])).toBe(true)
    expect(isInboxDrafts([draft({ author: 'robot' })])).toBe(false)
  })

  test('may have no Cc at all (an inbox that predates it), which the space reads as not sendable, but never a Cc that is not a list of people', () => {
    const { cc: _gone, ...older } = draft()
    expect(isInboxDrafts([older])).toBe(true)
    expect(isInboxDrafts([draft({ cc: [{ name: 'Marcus', address: 'm@x.example' }] })])).toBe(true)
    expect(isInboxDrafts([draft({ cc: 'm@x.example' })])).toBe(false)
    expect(isInboxDrafts([draft({ cc: [{ name: 'Marcus' }] })])).toBe(false)
    expect(isInboxDrafts([draft({ cc: [null] })])).toBe(false)
  })
})

const answer = (message: Record<string, unknown>) => ({
  threads: [],
  more: false,
  messages: [{ id: 'm1', conversationId: 't1', subject: 'S', direction: 'in', at: 1, from: 'Dana', text: 'Hi', textCut: false, alsoOn: [], ...message }],
})

describe('a message in the inbox’s history', () => {
  test('may lack `read` and `to` (an inbox that predates them), and has them whole or not at all', () => {
    expect(isInboxHistory(answer({}))).toBe(true)
    expect(isInboxHistory(answer({ read: { visible: 'Hi', quoted: '' }, to: 'Dana <dana@x.example>' }))).toBe(true)
    expect(isInboxHistory(answer({ read: { visible: 'Hi' } }))).toBe(false)
    expect(isInboxHistory(answer({ read: 'Hi' }))).toBe(false)
    expect(isInboxHistory(answer({ to: 3 }))).toBe(false)
  })
})
