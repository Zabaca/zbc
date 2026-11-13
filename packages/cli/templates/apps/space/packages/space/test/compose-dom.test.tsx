// Writing from the space as a browser runs it, in a stand-in DOM, over the Worker's own functions and the invented people of the local fixtures: the New email box (who, From, subject, words, files; one press
// is one send; a refusal gives the message back with the same key; a send that went opens the person's conversation), and a draft edited in its card at a revision (a draft that moved on is
// shown beside the person's words and nothing is saved over it). The DOM is registered for this file only, so React is imported after it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { DraftView } from '../src/conversation'
import { NOW, mount, realFetch, sleep, standInWorker } from './compose-support'

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46])
const pdf = (name = 'quote.pdf') => new File([PDF], name, { type: 'application/pdf' })

async function openNew(to = '') {
  const { NewEmailPane } = await import('../src/client/NewEmail')
  const went: string[] = []
  const changed: number[] = []
  const page = await mount((h) => h(NewEmailPane, { to, onChanged: () => void changed.push(1), go: (p: string) => void went.push(p) }) as never)
  return { page, went, changed }
}

const ask = (e: Element | null) => (e as HTMLInputElement | null)?.value

describe('the New email box', () => {
  test('offers Automatic, each Gmail account and each business mailbox by name and address, and the people the space knows as suggestions for the To box', async () => {
    standInWorker()
    const { page } = await openNew()
    const options = [...(page.q('new-from')?.querySelectorAll('option') ?? [])].map((o) => [o.getAttribute('value'), o.textContent])
    expect(options).toEqual([
      ['auto', 'Automatic: where they last wrote to, else your own Gmail'],
      ['gmail:gmail-northfield', 'northfield Gmail (tessa@northfield.example)'],
      ['business:ridgeway', 'Ridgeway Cycles (info@ridgewaycycles.example)'],
      ['business:shiftlantern', 'ShiftLantern (hello@shiftlantern.example)'],
      ['jmap:harborline', 'harborline (test@harborline.example)'],
    ])
    const suggested = [...document.querySelectorAll('#new-email-people option')].map((o) => o.getAttribute('value'))
    expect(suggested).toContain('dana@harbordental.example')
    expect(new Set(suggested).size).toBe(suggested.length)
    expect(page.q<HTMLButtonElement>('send')?.disabled).toBe(true)
    expect(page.q('new-why')?.textContent).toBe('Say who it is to.')
    await page.unmount()
  })

  test('says under From which account Automatic sends from, before anything is pressed, and says nothing once an account is chosen', async () => {
    standInWorker()
    const { page } = await openNew()
    expect(page.q('new-from-auto')?.textContent).toBe('Automatic sends this from northfield (tessa@northfield.example).')
    await page.type(page.q('new-from'), 'business:ridgeway')
    expect(page.q('new-from-auto')).toBeNull()
    await page.unmount()
  })

  test('Send waits for an address, a subject and words, and names what is missing', async () => {
    standInWorker()
    const { page } = await openNew()
    await page.type(page.q('new-to'), 'not an address')
    expect(page.q('new-why')?.textContent).toBe('That is not an email address.')
    await page.type(page.q('new-to'), 'new@example.net')
    expect(page.q('new-why')?.textContent).toBe('Add a subject.')
    await page.type(page.q('new-subject'), 'Your visit')
    expect(page.q('new-why')?.textContent).toBe('Write something to say.')
    await page.type(page.q('compose-text'), 'We are glad you are coming in.')
    expect(page.q('new-why')).toBeNull()
    expect(page.q<HTMLButtonElement>('send')?.disabled).toBe(false)
    await page.unmount()
  })

  test('a person the space knows is named under the box, and an address with a name around it is read as its address', async () => {
    standInWorker()
    const { page } = await openNew()
    await page.type(page.q('new-to'), 'dana@harbordental.example')
    expect(page.q('new-known')?.textContent).toBe('Dana Reyes')
    await page.type(page.q('new-to'), 'Someone <Someone@Example.net>')
    expect(page.q('new-known')).toBeNull()
    await page.type(page.q('new-subject'), 'Hello')
    await page.type(page.q('compose-text'), 'Hi.')
    expect(page.q<HTMLButtonElement>('send')?.disabled).toBe(false)
    await page.unmount()
  })

  test('one press is one send: the mailbox chosen goes with it, the key is made once, a second press while it waits changes nothing, and the person’s conversation opens', async () => {
    const worker = standInWorker()
    const { page, went, changed } = await openNew()
    await page.type(page.q('new-to'), 'Newcomer <New@Example.net>')
    await page.type(page.q('new-from'), 'business:ridgeway')
    await page.type(page.q('new-subject'), 'Your visit')
    await page.type(page.q('compose-text'), 'We are glad you are coming in.')
    await page.submit(page.q('send'))
    await page.submit(page.q('send'))
    const sends = worker.calls.filter((c) => c.path === '/api/email')
    expect(sends).toHaveLength(1)
    expect(sends[0]?.body).toMatchObject({ address: 'new@example.net', name: 'Newcomer', subject: 'Your visit', text: 'We are glad you are coming in.', from: { kind: 'business', mailboxId: 'ridgeway' } })
    expect((sends[0]?.body as { key: string }).key).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
    expect((worker.apps.inbox as unknown as { sent: unknown[] }).sent).toHaveLength(1)
    expect(went).toEqual(['/inbox/new%40example.net'])
    expect(changed.length).toBeGreaterThan(0)
    await page.unmount()
  })

  test('a refusal gives the message back in the inbox’s words with the same key, and pressing Send again after putting it right sends it', async () => {
    const worker = standInWorker()
    const { page, went } = await openNew()
    await page.type(page.q('new-to'), 'new@example.net')
    await page.type(page.q('new-from'), 'business:ridgeway')
    await page.type(page.q('new-subject'), 'Your visit')
    await page.type(page.q('compose-text'), 'We are glad \u2014 truly glad.')
    expect(page.q('new-dash')).not.toBeNull()
    await page.submit(page.q('send'))
    expect(page.q('compose-notice')?.textContent).toContain('em dash')
    expect(page.q('compose-notice')?.getAttribute('data-tone')).toBe('error')
    expect(went).toEqual([])
    expect(ask(page.q('new-subject'))).toBe('Your visit')
    await page.type(page.q('compose-text'), 'We are glad, truly glad.')
    await page.submit(page.q('send'))
    const sends = worker.calls.filter((c) => c.path === '/api/email')
    expect(sends).toHaveLength(2)
    expect((sends[0]?.body as { key: string }).key).toBe((sends[1]?.body as { key: string }).key)
    expect(went).toEqual(['/inbox/new%40example.net'])
    await page.unmount()
  })

  test('files are offered for a business mailbox only, go as a form with the words, and are refused in words from Gmail and from Automatic', async () => {
    const worker = standInWorker()
    const { page, went } = await openNew()
    expect(page.q('attach')).toBeNull()
    expect(page.q('new-no-files')?.textContent).toContain('To attach files')
    await page.type(page.q('new-from'), 'business:shiftlantern')
    expect(page.q('attach')).not.toBeNull()
    await page.attach(page.q('attach-input'), [pdf('quote (final).pdf')])
    expect(page.all('chosen-file')).toHaveLength(1)
    await page.type(page.q('new-to'), 'worker@example.net')
    await page.type(page.q('new-subject'), 'Your guide')
    await page.type(page.q('compose-text'), 'The guide is attached.')
    // Changing the mailbox to Gmail with the file still chosen is not a quiet drop of the file: Send is held, with the reason.
    await page.type(page.q('new-from'), 'gmail:gmail-northfield')
    expect(page.q('new-why')?.textContent).toContain('a business mailbox only')
    expect(page.q<HTMLButtonElement>('send')?.disabled).toBe(true)
    await page.type(page.q('new-from'), 'business:shiftlantern')
    await page.submit(page.q('send'))
    const sent = worker.calls.filter((c) => c.path === '/api/email/files')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).toMatchObject({ file: 'quote (final).pdf' })
    expect(JSON.parse(String((sent[0]?.body as { json: string }).json))).toMatchObject({ address: 'worker@example.net', from: { kind: 'business', mailboxId: 'shiftlantern' } })
    expect(went).toEqual(['/inbox/worker%40example.net'])
    await page.unmount()
  })

  test('when the inbox’s mailboxes cannot be read only Automatic is offered and the box says so', async () => {
    const worker = standInWorker()
    worker.apps.inbox.mailboxes = async () => ({ ok: false, kind: 'failed', reason: 'broken', message: 'The inbox could not answer that. Nothing was changed.' })
    const { page } = await openNew()
    expect([...(page.q('new-from')?.querySelectorAll('option') ?? [])].map((o) => o.getAttribute('value'))).toEqual(['auto'])
    expect(page.q('new-from-problem')?.textContent).toContain('only Automatic')
    await page.unmount()
  })

  test('from an inbox that does not say it can honour a chosen mailbox and files (an older one) only Automatic is offered, with files and a mailbox unavailable, and the box says why', async () => {
    const worker = standInWorker()
    worker.apps.inbox.views.state.capabilities = undefined
    const { page, went } = await openNew()
    expect([...(page.q('new-from')?.querySelectorAll('option') ?? [])].map((o) => o.getAttribute('value'))).toEqual(['auto'])
    expect(page.q('new-from-problem')?.textContent).toContain('has not been updated')
    expect(page.q('attach')).toBeNull()
    await page.type(page.q('new-to'), 'new@example.net')
    await page.type(page.q('new-subject'), 'Hello')
    await page.type(page.q('compose-text'), 'Hi.')
    await page.submit(page.q('send'))
    expect(worker.calls.filter((c) => c.path === '/api/email')).toHaveLength(1)
    expect(went).toEqual(['/inbox/new%40example.net'])
    await page.unmount()
  })

  test('started from a link to write to someone, the box starts on their address', async () => {
    standInWorker()
    const { page } = await openNew('dana@harbordental.example')
    expect(ask(page.q('new-to'))).toBe('dana@harbordental.example')
    expect(page.q('new-known')?.textContent).toBe('Dana Reyes')
    await page.unmount()
  })

  test('a send the inbox cannot say went out keeps the box, says so, clears the boxes so it is not sent again, and points at the conversation; a lost one offers no second try', async () => {
    const worker = standInWorker()
    worker.apps.inbox.script.send.push('sending')
    const { page, went } = await openNew()
    await page.type(page.q('new-to'), 'new@example.net')
    await page.type(page.q('new-subject'), 'Hello')
    await page.type(page.q('compose-text'), 'Hi.')
    await page.submit(page.q('send'))
    expect(went).toEqual([])
    expect(page.q('compose-notice')?.textContent).toContain('did not say whether this went out')
    expect(ask(page.q('new-to'))).toBe('')
    await page.click(page.q('open-sent'))
    expect(went).toEqual(['/inbox/new%40example.net'])
    // And one the space lost track of: the box is locked and the only button writes another.
    worker.apps.inbox.script.send.push('throw')
    await page.type(page.q('new-to'), 'other@example.net')
    await page.type(page.q('new-subject'), 'Hello again')
    await page.type(page.q('compose-text'), 'Hi again.')
    await page.submit(page.q('send'))
    expect(page.q('compose-notice')?.textContent).toContain('cannot tell whether it went out')
    expect(page.q('send')).toBeNull()
    expect(page.q('write-another')).not.toBeNull()
    expect(page.q<HTMLInputElement>('new-subject')?.readOnly).toBe(true)
    // The notice points at the conversation, to look: the email may have gone.
    expect(page.q('open-sent')?.textContent).toContain('other@example.net')
    await page.click(page.q('open-sent'))
    expect(went.at(-1)).toBe('/inbox/other%40example.net')
    await page.click(page.q('write-another'))
    expect(ask(page.q('new-subject'))).toBe('')
    await page.unmount()
  })
})

// ── The draft card ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function openCard() {
  const { DraftEditor } = await import('../src/client/DraftEdit')
  const draft: DraftView = { id: 'd-1', conversationId: 't-lena-1', subject: 'Re: Can you look at the menu page', text: 'Hi Lena, I will fix it today.', rev: 1, author: 'claude', stuck: false, at: NOW, why: 'She asked.', editedBy: null, canCopyEveryone: true, kind: 'email', sentFrom: null, sendsFrom: null, to: 'lena@example.net', toName: 'Lena', cc: [], through: 1, refusal: null, sending: false, sendable: true }
  const closed: boolean[] = []
  const changed: number[] = []
  let current = draft
  let rerender: (() => void) | null = null
  const page = await mount((h, { useState }) => {
    function Card() {
      const [d, setD] = useState(current)
      rerender = () => setD({ ...current })
      return h(DraftEditor, { draft: d, onChanged: () => void changed.push(1), onClose: (saved: boolean) => void closed.push(saved) })
    }
    return h(Card) as never
  })
  return {
    page,
    closed,
    changed,
    /** The draft changed under the person: Claude edited it. The card is read again and gets the new revision. */
    moveOn: async (over: Partial<typeof draft>) => {
      current = { ...current, ...over }
      const { act } = await import('react')
      await act(async () => {
        rerender?.()
        await sleep(20)
      })
    },
  }
}

describe('editing a draft in its card', () => {
  test('saves the subject and the words at the revision shown, and leaves the editor having saved', async () => {
    const worker = standInWorker()
    const { page, closed, changed } = await openCard()
    await page.type(page.q('edit-text'), 'Hi Lena, I will fix it today and send you a link.')
    await page.type(page.q('edit-subject'), 'Re: The menu page')
    await page.click(page.q('save-draft'))
    const saved = worker.calls.filter((c) => c.path === '/api/inbox/draft-edit')
    expect(saved).toHaveLength(1)
    expect(saved[0]?.body).toEqual({ draftId: 'd-1', rev: 1, subject: 'Re: The menu page', text: 'Hi Lena, I will fix it today and send you a link.' })
    expect(closed).toEqual([])
    expect(changed.length).toBeGreaterThan(0)
    await page.unmount()
  })

  test('Save waits for a change, and for words: a draft needs a body', async () => {
    standInWorker()
    const { page } = await openCard()
    expect(page.q<HTMLButtonElement>('save-draft')?.disabled).toBe(true)
    await page.type(page.q('edit-text'), '  Hi Lena, I will fix it today.  \n')
    expect(page.q<HTMLButtonElement>('save-draft')?.disabled).toBe(true)
    await page.type(page.q('edit-text'), '   ')
    expect(page.q<HTMLButtonElement>('save-draft')?.disabled).toBe(true)
    expect(page.q('edit-blank')).not.toBeNull()
    await page.type(page.q('edit-text'), 'Different words.')
    expect(page.q<HTMLButtonElement>('save-draft')?.disabled).toBe(false)
    await page.unmount()
  })

  test('a draft that changed after it was opened is shown beside the person’s words, nothing is saved, and Keep mine writes over the revision that was seen', async () => {
    const worker = standInWorker()
    const { page, closed, moveOn } = await openCard()
    await page.type(page.q('edit-text'), 'My words.')
    await moveOn({ rev: 2, text: 'Claude’s new words.' })
    expect(page.q('draft-moved')?.textContent).toContain('Claude’s new words.')
    expect(page.q<HTMLButtonElement>('save-draft')?.disabled).toBe(true)
    // Until one is chosen, no save is made at the old revision.
    await page.click(page.q('save-draft'))
    expect(worker.calls.filter((c) => c.path === '/api/inbox/draft-edit')).toEqual([])
    await page.click(page.q('keep-mine'))
    expect(page.q('draft-moved')).toBeNull()
    expect(ask(page.q('edit-text'))).toBe('My words.')
    await page.click(page.q('save-draft'))
    expect(worker.calls.filter((c) => c.path === '/api/inbox/draft-edit')[0]?.body).toMatchObject({ draftId: 'd-1', rev: 2, text: 'My words.' })
    expect(closed).toEqual([])
    await page.unmount()
  })

  test('Use the new words takes them into the boxes, and a refusal from the inbox is said in its words with what was typed still in the boxes', async () => {
    standInWorker()
    const { page, moveOn } = await openCard()
    await page.type(page.q('edit-text'), 'My words.')
    await moveOn({ rev: 2, text: 'Claude’s new words.' })
    await page.click(page.q('use-theirs'))
    expect(ask(page.q('edit-text'))).toBe('Claude’s new words.')
    expect(page.q('draft-moved')).toBeNull()
    await page.unmount()
  })

  test('on a reply it can copy everyone, named in the save only when it changed, and the conflict shows who is copied, why, and who changed it', async () => {
    const worker = standInWorker()
    const { page, moveOn } = await openCard()
    expect(page.q<HTMLInputElement>('edit-copy')?.checked).toBe(false)
    await page.click(page.q('edit-copy'))
    await page.click(page.q('save-draft'))
    expect(worker.calls.filter((c) => c.path === '/api/inbox/draft-edit')[0]?.body).toEqual({ draftId: 'd-1', rev: 1, subject: 'Re: Can you look at the menu page', text: 'Hi Lena, I will fix it today.', copyEveryone: true })
    await page.unmount()
    const again = await openCard()
    await again.page.type(again.page.q('edit-text'), 'My words.')
    await again.moveOn({ rev: 2, text: 'Claude’s new words.', editedBy: 'claude', why: 'She asked twice.', cc: [{ name: 'Marcus', address: 'marcus@example.net' }] })
    expect(again.page.q('draft-moved')?.textContent).toContain('Claude changed this draft')
    expect(again.page.q('draft-moved')?.textContent).toContain('Cc: marcus@example.net')
    expect(again.page.q('draft-moved')?.textContent).toContain('Why: She asked twice.')
    await again.page.unmount()
    void moveOn
  })

  test('the Cc box shows who the draft copies, adds and removes addresses, and names the whole list in the save only when it changed', async () => {
    const worker = standInWorker()
    const { page, moveOn } = await openCard()
    expect(ask(page.q('edit-cc'))).toBe('')
    expect(page.q<HTMLButtonElement>('save-draft')?.disabled).toBe(true)
    await page.type(page.q('edit-cc'), 'ann@example.org, Bob Jones <bob@example.net>')
    expect(page.q<HTMLButtonElement>('save-draft')?.disabled).toBe(false)
    await page.click(page.q('save-draft'))
    const saved = worker.calls.filter((c) => c.path === '/api/inbox/draft-edit')
    expect(saved).toHaveLength(1)
    // The Cc alone: no words, no subject and no copy-everyone in the save.
    expect(saved[0]?.body).toEqual({ draftId: 'd-1', rev: 1, subject: 'Re: Can you look at the menu page', text: 'Hi Lena, I will fix it today.', cc: ['ann@example.org', 'bob@example.net'] })
    await page.unmount()
    void moveOn
  })

  test('a draft that moved on takes its new Cc into the box with Use the new words, and taking one off saves the list that is left', async () => {
    const worker = standInWorker()
    const { page, moveOn } = await openCard()
    await moveOn({ rev: 2, cc: [{ name: 'Marcus', address: 'marcus@example.net' }, { name: 'Ann', address: 'ann@example.org' }] })
    // The draft moved on under the person (Claude copied two people): taking the new words takes the new Cc into the box too.
    await page.click(page.q('use-theirs'))
    expect(ask(page.q('edit-cc'))).toBe('marcus@example.net, ann@example.org')
    await page.type(page.q('edit-cc'), 'ann@example.org')
    await page.click(page.q('save-draft'))
    expect(worker.calls.filter((c) => c.path === '/api/inbox/draft-edit')[0]?.body).toMatchObject({ draftId: 'd-1', rev: 2, cc: ['ann@example.org'] })
    await page.unmount()
  })

  test('ticking copy-everyone and editing the Cc are not done at once: the box is left as the draft has it until the tick is saved', async () => {
    const worker = standInWorker()
    const { page } = await openCard()
    await page.click(page.q('edit-copy'))
    expect(page.q<HTMLInputElement>('edit-cc')?.readOnly).toBe(true)
    expect(page.q('edit-cc-after-copy')?.textContent).toContain('Save the tick box first')
    await page.click(page.q('save-draft'))
    const body = worker.calls.filter((c) => c.path === '/api/inbox/draft-edit')[0]?.body as Record<string, unknown>
    expect(body.copyEveryone).toBe(true)
    expect(body).not.toHaveProperty('cc')
    await page.unmount()
  })

  test('a draft that is not an email, or whose Cc the inbox did not say, has no Cc box', async () => {
    standInWorker()
    const { page, moveOn } = await openCard()
    expect(page.q('edit-cc')).not.toBeNull()
    await moveOn({ kind: 'sms' })
    expect(page.q('edit-cc')).toBeNull()
    await moveOn({ kind: 'email', cc: null })
    expect(page.q('edit-cc')).toBeNull()
    await page.unmount()
  })

  test('where only who is copied changed, the conflict says the words are the same; a draft that cannot copy has no checkbox', async () => {
    standInWorker()
    const { page, moveOn } = await openCard()
    await moveOn({ rev: 2, editedBy: 'assistant', cc: [{ name: 'Marcus', address: 'marcus@example.net' }] })
    expect(page.q('draft-moved-same')?.textContent).toBe('The words are the same; The assistant changed who is copied, or why it was drafted.')
    await moveOn({ canCopyEveryone: false })
    expect(page.q('edit-copy')).toBeNull()
    await page.unmount()
  })

  test('an em dash can be saved, with a word that the send will refuse it; Cancel leaves without saving', async () => {
    const worker = standInWorker()
    const { page, closed } = await openCard()
    await page.type(page.q('edit-text'), 'Hi Lena \u2014 today.')
    expect(page.q('edit-dash')?.textContent).toContain('will not send it')
    await page.click(page.q('cancel-edit'))
    expect(closed).toEqual([false])
    expect(worker.calls.filter((c) => c.path === '/api/inbox/draft-edit')).toEqual([])
    await page.unmount()
  })
})
