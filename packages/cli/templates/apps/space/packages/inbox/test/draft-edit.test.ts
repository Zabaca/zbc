import { describe, expect, test } from 'bun:test'
import { AGENT, harness } from '../test-support/harness'
import { as, ownerRequest } from '../test-support/owner-requests'

/**
 * Who wrote a draft and who changed it, an edit or a delete that must name the revision it was drawn from (from
 * everyone), what sets "who changed it" and what does not, a subject limit, and what a reply would be before it is a
 * draft: through the Worker as a function, with a Gmail that really ingests. These are the server's half of the
 * composer's rules (the composer saves words only over the revision they were written over, and says "Claude's draft,
 * edited by you").
 */

type H = ReturnType<typeof harness>

async function live(h: H, setup: () => void) {
  setup()
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
}

const convoId = (h: H): string =>
  (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = 't1'`).get() as { id: string }).id

const claudeDraft = async (h: H) =>
  (
    await h.request(AGENT, 'POST', '/api/drafts', {
      conversationId: convoId(h),
      body: 'Happy to help.',
      why: 'She asked.',
    })
  ).json

const glance = async (h: H) =>
  ((await ownerRequest(h, 'GET', '/api/queue?filter=drafts')).json.rows as { draft: unknown }[])[0]?.draft

const quote = (h: H) => live(h, () => h.google.mailbox.add({ id: 'm1', threadId: 't1', subject: 'Quote' }))

describe('who changed a draft', () => {
  test('Claude’s own draft is Claude’s alone; once Tessa edits it, the draft, the list glance and the script’s drafts say so', async () => {
    const h = harness()
    await quote(h)
    const draft = await claudeDraft(h)
    expect(draft).toMatchObject({ createdBy: expect.stringContaining('agent:'), updatedBy: draft.createdBy, rev: 0 })
    expect(await glance(h)).toMatchObject({ author: 'claude', editedBy: null })

    // Claude editing its own draft is not "edited by" anybody else.
    const own = (
      await h.request(AGENT, 'PATCH', `/api/drafts/${draft.id}`, { rev: 0, body: 'Happy to help, Tuesday.' })
    ).json
    expect(await glance(h)).toMatchObject({ author: 'claude', editedBy: null })

    await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, { rev: own.rev, body: 'Happy to help, Wednesday.' })
    expect(await glance(h)).toMatchObject({ author: 'claude', editedBy: 'owner' })
    const listed = (await ownerRequest(h, 'GET', '/api/drafts')).json as { id: string; updatedBy: string }[]
    expect(listed.find((d) => d.id === draft.id)).toMatchObject({ updatedBy: 'tessa@northfield.example' })
    const convo = (await ownerRequest(h, 'GET', `/api/conversations/${convoId(h)}`)).json
    expect(convo.drafts[0]).toMatchObject({ createdBy: draft.createdBy, updatedBy: 'tessa@northfield.example', rev: 2 })
  })

  test('only a change of the words sets who changed it: claiming a draft for a send, a refused send putting it back, and un-marking leave it alone', async () => {
    const h = harness()
    await quote(h)
    const draft = await claudeDraft(h)
    const stamps = () =>
      h.db.query(`SELECT updated_by, updated_at FROM message WHERE id = ?`).get(draft.id) as {
        updated_by: string
        updated_at: string
      }
    const before = stamps()
    h.tick()
    // Claim it for a send (Tessa pressing Send), then Gmail refuses and it goes back to a draft.
    const store = h.inbox
    const convo = store.getConversation(convoId(h))
    const through = convo.ok ? convo.value.through : null
    const plan = store.planSend(draft.id, { rev: 0, through }, 'tessa@northfield.example')
    if (!plan.ok) throw new Error(plan.error)
    expect(store.claimSend(plan.value, 'tessa@northfield.example').ok).toBe(true)
    expect(stamps()).toEqual(before)
    store.releaseClaim(draft.id, 'Gmail refused', 'tessa@northfield.example')
    expect(stamps()).toEqual(before)

    // A text Claude drafted that Tessa marks sent and then un-marks: still Claude's, unedited.
    const text = (
      await h.request(AGENT, 'POST', '/api/drafts', { address: '+15550100000', name: 'Marcus', body: 'Hi', why: 'why' })
    ).json
    const textStamp = () =>
      (h.db.query(`SELECT updated_by FROM message WHERE id = ?`).get(text.id) as { updated_by: string }).updated_by
    const first = textStamp()
    await ownerRequest(h, 'POST', `/api/messages/${text.id}/mark-sent`, {})
    await ownerRequest(h, 'POST', `/api/messages/${text.id}/unmark-sent`, {})
    expect(textStamp()).toBe(first)
    expect(await glance(h)).toMatchObject({ author: 'claude', editedBy: null })

    // An edit does set it.
    h.tick()
    await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, { rev: 0, body: 'Changed.' })
    expect(stamps().updated_by).toBe('tessa@northfield.example')
    expect(stamps().updated_at > before.updated_at).toBe(true)
  })
})

describe('an edit or a delete names the revision it was drawn from, from everyone', () => {
  test('an edit over a draft that has changed since is refused, nothing is changed, and the right revision is accepted', async () => {
    const h = harness()
    await quote(h)
    const draft = await claudeDraft(h)
    // Claude changes it after Tessa's page drew it at revision 0.
    await h.request(AGENT, 'PATCH', `/api/drafts/${draft.id}`, { rev: 0, body: 'Claude changed this.' })

    const stale = await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, { rev: 0, body: 'Tessa’s words.' })
    expect(stale.status).toBe(409)
    expect(stale.json.error).toContain('changed after it was shown')
    const after = (await ownerRequest(h, 'GET', `/api/conversations/${convoId(h)}`)).json.drafts[0]
    expect(after).toMatchObject({ body: 'Claude changed this.', rev: 1 })

    const fresh = await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, { rev: 1, body: 'Tessa’s words.' })
    expect(fresh.status).toBe(200)
    expect(fresh.json).toMatchObject({ body: 'Tessa’s words.', rev: 2 })
  })

  test('Claude cannot overwrite what Tessa saved unseen: the same rule, from the agent', async () => {
    const h = harness()
    await quote(h)
    const draft = await claudeDraft(h)
    await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, { rev: 0, body: 'Tessa’s words.' })
    const stale = await h.request(AGENT, 'PATCH', `/api/drafts/${draft.id}`, { rev: 0, body: 'Claude, unseen.' })
    expect(stale.status).toBe(409)
    expect((await h.request(AGENT, 'DELETE', `/api/drafts/${draft.id}?rev=0`)).status).toBe(409)
    const kept = (await ownerRequest(h, 'GET', `/api/conversations/${convoId(h)}`)).json.drafts[0]
    expect(kept.body).toBe('Tessa’s words.')
  })

  test('an edit or a delete with no revision, or one that is not a whole number, is 422 and changes nothing', async () => {
    const h = harness()
    await quote(h)
    const draft = await claudeDraft(h)
    // The rule is Claude's door's route (the owner's was the same code, in the page's router, which is gone); Tessa's edit and delete are the store's, covered above.
    for (const who of [AGENT]) {
      for (const rev of [undefined, null, '0', 1.5, 'abc', {}, true]) {
        const res = await as(h, who, 'PATCH', `/api/drafts/${draft.id}`, {
          body: 'x',
          ...(rev === undefined ? {} : { rev }),
        })
        expect(res.status, `PATCH ${JSON.stringify(rev)}`).toBe(422)
        expect(res.json.error).toContain('rev')
      }
      for (const query of ['', '?rev=', '?rev=abc', '?rev=1.5', '?rev=-1', '?rev=0x1', '?rev=%200']) {
        const res = await as(h, who, 'DELETE', `/api/drafts/${draft.id}${query}`)
        expect(res.status, `DELETE ${query}`).toBe(422)
      }
    }
    const kept = (await ownerRequest(h, 'GET', `/api/conversations/${convoId(h)}`)).json.drafts[0]
    expect(kept).toMatchObject({ body: 'Happy to help.', rev: 0 })
  })

  test('a delete over a draft that has changed since is refused and keeps it; the right revision deletes it', async () => {
    const h = harness()
    await quote(h)
    const draft = await claudeDraft(h)
    await h.request(AGENT, 'PATCH', `/api/drafts/${draft.id}`, { rev: 0, body: 'Claude changed this.' })

    expect((await ownerRequest(h, 'DELETE', `/api/drafts/${draft.id}?rev=0`)).status).toBe(409)
    expect(((await ownerRequest(h, 'GET', '/api/drafts')).json as unknown[]).length).toBe(1)

    expect((await ownerRequest(h, 'DELETE', `/api/drafts/${draft.id}?rev=1`)).status).toBe(200)
    expect(((await ownerRequest(h, 'GET', '/api/drafts')).json as unknown[]).length).toBe(0)
  })

  test('a subject is one line of at most 300 characters, on a new draft and on an edit', async () => {
    const h = harness()
    await quote(h)
    const long = 'S'.repeat(301)
    const made = await ownerRequest(h, 'POST', '/api/drafts', {
      conversationId: convoId(h),
      body: 'Hi',
      subject: long,
    })
    expect(made.status).toBe(422)
    const ok = await ownerRequest(h, 'POST', '/api/drafts', {
      conversationId: convoId(h),
      body: 'Hi',
      subject: 'S'.repeat(300),
    })
    expect(ok.status).toBe(201)
    const edited = await ownerRequest(h, 'PATCH', `/api/drafts/${ok.json.id}`, { rev: 0, subject: long })
    expect(edited.status).toBe(422)
  })
})

describe('what a reply would be, before it is a draft', () => {
  test('the conversation says who a reply goes to, the subject it takes and everyone “copy everyone” works from', async () => {
    const h = harness()
    await live(h, () =>
      h.google.mailbox.add({
        id: 'm1',
        threadId: 't1',
        from: 'Dana <dana@example.com>',
        to: 'tessa@northfield.example',
        cc: 'Bob <bob@example.com>',
        subject: 'Quote for the shop',
      }),
    )
    const convo = (await ownerRequest(h, 'GET', `/api/conversations/${convoId(h)}`)).json
    expect(convo.reply).toEqual({
      to: 'dana@example.com',
      subject: 'Re: Quote for the shop',
      everyone: ['dana@example.com', 'bob@example.com'],
    })
  })

  test('a message that asked for replies elsewhere: the reply is to its Reply-To, as the draft will be', async () => {
    const h = harness()
    await live(h, () =>
      h.google.mailbox.add({
        id: 'm1',
        threadId: 't1',
        from: 'Forms <forms@example.com>',
        subject: 'New enquiry',
        headers: { 'Reply-To': 'Pat <pat@example.org>' },
      }),
    )
    const convo = (await ownerRequest(h, 'GET', `/api/conversations/${convoId(h)}`)).json
    expect(convo.reply.to).toBe('pat@example.org')
    const draft = (await ownerRequest(h, 'POST', '/api/drafts', { conversationId: convoId(h), body: 'Hi Pat' })).json
    expect(draft).toMatchObject({ address: 'pat@example.org', subject: convo.reply.subject })
  })

  test('a conversation with no mailbox has no reply to describe', async () => {
    const h = harness()
    await quote(h)
    const text = (
      await ownerRequest(h, 'POST', '/api/drafts', { address: '+15550100000', name: 'Marcus', body: 'Hi Marcus' })
    ).json
    const sent = (await ownerRequest(h, 'POST', `/api/messages/${text.id}/mark-sent`, {})).json
    const convo = (await ownerRequest(h, 'GET', `/api/conversations/${sent.conversationId}`)).json
    expect(convo.reply).toBeNull()
  })
})
