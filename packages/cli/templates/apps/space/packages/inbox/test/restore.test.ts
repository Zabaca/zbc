import { describe, expect, test } from 'bun:test'
import { type CliIo, runCli, USAGE } from '../scripts/cli'
import { CONFIRM_WINDOW_MS, RESTORE_PREFIX } from '../src/restore'
import { AGENT, AGENT_AUD, AGENT_ID, asHttp, harness, mint, OWNER, STRANGER, T0 } from '../test-support/harness'

/**
 * Restoring the inbox's store (src/restore.ts): the flow, who may do what, and the record that outlives a restore. Tessa restores from the space
 * (the part's `prepareRestore` and `confirmRestore`, test/space-views.test.ts), which call the restore step as him, and this file drives that step the same way:
 * the owner's calls are the step's own methods with his address as the actor, and `OWNER` below stands for that. Claude reads the bookmarks through its door (the real
 * router and verifier), which has no restore route at all. The step runs over a fake of the Durable Object's storage whose
 * bookmarks behave as Cloudflare's page says and a bucket that can fail.
 *
 * What none of it can show is Cloudflare: that the object really keeps 30 days, that arming a restore and calling `abort`
 * really restores, what the abort looks like to the caller. Those are the runbook's live check, on a scratch object.
 */

type H = ReturnType<typeof harness>

const iso = (ms: number) => new Date(ms).toISOString()
const TESSA = 'tessa@northfield.example'

/** A store with some history: a bookmark at T0 with `row` = "before", then an hour later `row` = "after". */
function withHistory() {
  const h = harness()
  h.objectStorage.kv.set('row', 'before')
  const earlier = h.objectStorage.mark()
  h.tick(60 * 60_000)
  h.objectStorage.kv.set('row', 'after')
  return { h, earlier, earlierTime: iso(T0 + 1000) }
}

/** Read the bookmarks: Claude's door for the agent (and a refusal for anyone else), the step's own `restoreBookmarks` for Tessa. */
const get = async (h: H, who: Record<string, unknown> | null, path = '/api/restore') => {
  if (who !== OWNER) return h.request(who, 'GET', path)
  const time = new URL(path, 'https://door.test').searchParams.get('time')
  return asHttp(await h.store.call('restoreBookmarks', time))
}
/** Step one as Tessa: what the space's `prepareRestore` and the deleted route both did, a call of the step with his address. Anyone else meets Claude's door, which has no such route. */
const prepare = async (h: H, body: any, who: Record<string, unknown> | null = OWNER) => {
  if (who !== OWNER) return h.request(who, 'POST', '/api/restore/prepare', body)
  return asHttp(await h.store.call('prepareRestore', { bookmark: body.bookmark, time: body.time } as never, TESSA))
}
/** Step two as Tessa, with the restart that follows it (an abort that rejects the call that makes it, which is the restart happening). */
const confirm = async (h: H, body: any, who: Record<string, unknown> | null = OWNER) => {
  if (who !== OWNER) return h.request(who, 'POST', '/api/restore/confirm', body)
  const done = await h.store.call('confirmRestore', { token: body.token, bookmark: body.bookmark } as never, TESSA)
  try {
    await h.store.call('restartForRestore', TESSA)
  } catch {
    // The restart is an abort, which rejects the call that asked for it.
  }
  return asHttp(done)
}
const recordKeys = (h: H) => [...h.bucket.objects.keys()].filter((k) => k.startsWith(RESTORE_PREFIX)).sort()
const recordOf = (h: H, key: string) => JSON.parse(h.bucket.text(key))

describe('reading the bookmark', () => {
  test('Tessa and Claude can both read the current bookmark, and the bookmark for a time', async () => {
    const { h, earlier, earlierTime } = withHistory()
    for (const who of [OWNER, AGENT]) {
      const now = await get(h, who)
      expect(now.status).toBe(200)
      expect(now.json.current).toMatch(/fakebookmark$/)
      expect(now.json.forTime).toBeNull()
      expect(now.json.restores).toEqual([])
      const then = await get(h, who, `/api/restore?time=${encodeURIComponent(earlierTime)}`)
      expect(then.json.forTime).toEqual({ time: earlierTime, bookmark: earlier })
    }
  })

  test('a person Access let in who is not Tessa, and a request with no assertion, read nothing', async () => {
    const { h } = withHistory()
    expect((await get(h, STRANGER)).status).toBe(403)
    expect((await get(h, null)).status).toBe(401)
  })

  test('a time must state its zone, must have happened, and must be within what is kept', async () => {
    const { h } = withHistory()
    const ask = async (time: string) => get(h, OWNER, `/api/restore?time=${encodeURIComponent(time)}`)
    expect((await ask('2026-10-20T12:30:00')).status).toBe(422)
    expect((await ask('yesterday')).status).toBe(422)
    expect((await ask('2026-12-31T00:00:00Z')).json.error).toContain('not happened yet')
    const old = await ask('2026-01-01T00:00:00Z')
    expect(old.status).toBe(422)
    expect(old.json.error).toContain('30 days')
  })

  test('a zone offset with a plus sign reaches the store as the time it names', async () => {
    const { h, earlier } = withHistory()
    // 12:30Z is 13:30+01:00 and is before the second hour, so it finds the bookmark taken at T0.
    const r = await get(h, OWNER, `/api/restore?time=${encodeURIComponent('2026-10-20T13:30:00+01:00')}`)
    expect(r.json.forTime).toEqual({ time: '2026-10-20T12:30:00.000Z', bookmark: earlier })
  })

  test('a store that cannot give a bookmark (local development) says so and is not a crash', async () => {
    const { h } = withHistory()
    h.objectStorage.failBookmark = true
    const r = await get(h, OWNER)
    expect(r.status).toBe(503)
    expect(r.json.error).toContain('current bookmark')
  })
})

describe('only Tessa can restore, and the default is no', () => {
  test('Claude’s door has neither step, and nothing was written or armed', async () => {
    const { h, earlier } = withHistory()
    const prepared = await prepare(h, { bookmark: earlier }, AGENT)
    expect(prepared.status).toBe(404)
    expect((await confirm(h, { token: 'x', bookmark: earlier }, AGENT)).status).toBe(404)
    expect(recordKeys(h)).toEqual([])
    expect(h.objectStorage.kv.has('restore:pending')).toBe(false)
    expect(h.objectStorage.armings).toEqual([])
  })

  test('another person Access let in, and a request with no assertion, are refused too', async () => {
    const { h, earlier } = withHistory()
    expect((await prepare(h, { bookmark: earlier }, STRANGER)).status).toBe(403)
    expect((await prepare(h, { bookmark: earlier }, null)).status).toBe(401)
    expect(h.objectStorage.armings).toEqual([])
  })

  test('the module refuses anyone but Tessa on its own, so a route added later cannot open it', async () => {
    const { h, earlier } = withHistory()
    for (const actor of [`agent:${AGENT_ID}`, 'dev@localhost', 'someone@example.com', '']) {
      expect(await h.restores.prepareRestore({ bookmark: earlier }, actor)).toMatchObject({ ok: false, status: 403 })
      expect(await h.restores.confirmRestore({ token: 't', bookmark: earlier }, actor)).toMatchObject({
        ok: false,
        status: 403,
      })
      expect(await h.restores.restartForRestore(actor)).toMatchObject({ ok: false, status: 403 })
    }
    expect(recordKeys(h)).toEqual([])
  })

  test('the step names Tessa’s refusal in words the space can show', async () => {
    const { h, earlier } = withHistory()
    const refused = asHttp(await h.store.call('prepareRestore', { bookmark: earlier } as never, `agent:${AGENT_ID}`))
    expect(refused.status).toBe(403)
    expect(refused.json.error).toBe('Only Tessa can restore the inbox’s store.')
    expect(recordKeys(h)).toEqual([])
  })
})

describe('the two-step restore', () => {
  test('preparing changes nothing in the store, keeps a record, and answers a token good for five minutes for that bookmark', async () => {
    const { h, earlier, earlierTime } = withHistory()
    const r = await prepare(h, { time: earlierTime })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({
      target: earlier,
      targetTime: earlierTime,
      expiresAt: iso(h.now() + CONFIRM_WINDOW_MS),
    })
    expect(r.json.token).toMatch(/^token-/)
    expect(h.objectStorage.armedTo).toBeNull()
    expect(h.objectStorage.restarts).toBe(0)
    expect(h.objectStorage.kv.get('row')).toBe('after')
    const [key] = recordKeys(h)
    expect(key).toMatch(/^restores\/2026-10-20T13:00:00\.000Z-prepared-/)
    expect(recordOf(h, key as string)).toMatchObject({
      kind: 'prepared',
      actor: TESSA,
      target: earlier,
      undoBookmark: null,
    })
  })

  test('a bookmark can be named instead of a time, and exactly one of them must be', async () => {
    const { h, earlier } = withHistory()
    expect((await prepare(h, { bookmark: earlier })).json.target).toBe(earlier)
    expect((await prepare(h, {})).status).toBe(422)
    expect((await prepare(h, { bookmark: earlier, time: '2026-10-20T12:30:00Z' })).status).toBe(422)
    expect((await prepare(h, { bookmark: 'drop table; --' })).status).toBe(422)
    expect((await prepare(h, { bookmark: 42 })).status).toBe(422)
    expect((await prepare(h, { time: 42 })).status).toBe(422)
  })

  test('confirming asks for the token AND the bookmark, and a wrong one changes nothing', async () => {
    const { h, earlier } = withHistory()
    const plan = (await prepare(h, { bookmark: earlier })).json
    expect((await confirm(h, { token: plan.token })).status).toBe(422)
    expect((await confirm(h, { token: plan.token, bookmark: 'some-other-bookmark' })).status).toBe(422)
    expect((await confirm(h, { token: 'nope', bookmark: earlier })).status).toBe(409)
    expect((await confirm(h, { bookmark: earlier })).status).toBe(409)
    expect(h.objectStorage.armings).toEqual([])
    expect(h.objectStorage.restarts).toBe(0)
    // And the right pair still works afterwards: a wrong try does not spend the token.
    expect((await confirm(h, { token: plan.token, bookmark: earlier })).status).toBe(200)
  })

  test('with nothing prepared there is nothing to confirm', async () => {
    const { h, earlier } = withHistory()
    expect((await confirm(h, { token: 'x', bookmark: earlier })).status).toBe(409)
  })

  test('a confirmation expires after five minutes and is then gone', async () => {
    const { h, earlier } = withHistory()
    const plan = (await prepare(h, { bookmark: earlier })).json
    h.tick(CONFIRM_WINDOW_MS + 1000)
    const late = await confirm(h, { token: plan.token, bookmark: earlier })
    expect(late.status).toBe(409)
    expect(late.json.error).toContain('expired')
    expect(h.objectStorage.armings).toEqual([])
    expect(h.objectStorage.kv.has('restore:pending')).toBe(false)
  })

  test('a newer preparation replaces the earlier one, and the earlier token no longer works', async () => {
    const { h, earlier } = withHistory()
    const first = (await prepare(h, { bookmark: earlier })).json
    const second = (await prepare(h, { bookmark: earlier })).json
    expect((await confirm(h, { token: first.token, bookmark: earlier })).status).toBe(409)
    expect((await confirm(h, { token: second.token, bookmark: earlier })).status).toBe(200)
  })

  test('confirming arms the restore, answers the undo bookmark, restarts the object once, and the token is spent', async () => {
    const { h, earlier } = withHistory()
    const plan = (await prepare(h, { bookmark: earlier })).json
    h.tick(30_000)
    const done = await confirm(h, { token: plan.token, bookmark: earlier })
    expect(done.status).toBe(200)
    expect(done.json).toMatchObject({ restoredTo: earlier, by: TESSA, at: iso(h.now()) })
    expect(done.json.undoBookmark).toMatch(/fakebookmark$/)
    expect(done.json.undoBookmark).not.toBe(earlier)
    expect(done.json.next).toContain(done.json.undoBookmark)
    expect(h.objectStorage.armings).toEqual([earlier])
    expect(h.objectStorage.restarts).toBe(1)
    // The runtime made a new object, which serves again; the old token is spent.
    expect(h.restores.armed).toBe(false)
    expect((await confirm(h, { token: plan.token, bookmark: earlier })).status).toBe(409)
  })

  test('the store is what it was at the bookmark afterwards, and the undo bookmark puts back what was replaced', async () => {
    const { h, earlier } = withHistory()
    const plan = (await prepare(h, { bookmark: earlier })).json
    const done = (await confirm(h, { token: plan.token, bookmark: earlier })).json
    expect(h.objectStorage.kv.get('row')).toBe('before')

    // The undo is the same two steps with the bookmark the answer carried.
    const again = (await prepare(h, { bookmark: done.undoBookmark })).json
    const undone = await confirm(h, { token: again.token, bookmark: done.undoBookmark })
    expect(undone.status).toBe(200)
    expect(h.objectStorage.kv.get('row')).toBe('after')
    // A restore can itself be undone, so each answers a bookmark of its own.
    expect(undone.json.undoBookmark).not.toBe(done.undoBookmark)
  })
})

describe('the record survives the restore', () => {
  test('who, when, target and undo bookmark are in R2 under restores/ after the restore, which rolled back the store itself', async () => {
    const { h, earlier, earlierTime } = withHistory()
    // Something the store holds that was written after the target: a restore takes it away, and an audit row of its own with it.
    h.objectStorage.kv.set('audit-row', 'written after the target')
    const plan = (await prepare(h, { time: earlierTime })).json
    h.tick(10_000)
    const done = (await confirm(h, { token: plan.token, bookmark: earlier })).json

    expect(h.objectStorage.kv.has('audit-row')).toBe(false)
    const keys = recordKeys(h)
    expect(keys).toHaveLength(2)
    const restored = recordOf(h, keys.find((k) => k.includes('-restored-')) as string)
    expect(restored).toMatchObject({
      kind: 'restored',
      at: iso(h.now()),
      actor: TESSA,
      target: earlier,
      targetTime: earlierTime,
      current: plan.current,
      undoBookmark: done.undoBookmark,
      expiresAt: null,
    })
    // The preparation and the restore it led to are one id.
    expect(keys.map((k) => recordOf(h, k).id)).toEqual([restored.id, restored.id])
  })

  test('the bookmark answer lists the latest records, newest first, so the undo bookmark is readable later', async () => {
    const { h, earlier } = withHistory()
    const plan = (await prepare(h, { bookmark: earlier })).json
    h.tick(10_000)
    const done = (await confirm(h, { token: plan.token, bookmark: earlier })).json
    const report = (await get(h, AGENT)).json
    expect(report.restores.map((r: { kind: string }) => r.kind)).toEqual(['restored', 'prepared'])
    expect(report.restores[0]).toMatchObject({ undoBookmark: done.undoBookmark, target: earlier, actor: TESSA })
    expect(report.restoresError).toBeNull()
  })

  test('only the ten latest records come back', async () => {
    const { h, earlier } = withHistory()
    for (let i = 0; i < 12; i += 1) {
      h.tick(1000)
      await prepare(h, { bookmark: earlier })
    }
    const report = (await get(h, OWNER)).json
    expect(report.restores).toHaveLength(10)
    expect(report.restores[0].at > report.restores[9].at).toBe(true)
  })

  test('a bucket that will not list leaves the bookmarks readable and says why', async () => {
    const { h } = withHistory()
    h.bucket.failList = true
    const report = (await get(h, OWNER)).json
    expect(report.current).toMatch(/fakebookmark$/)
    expect(report.restores).toEqual([])
    expect(report.restoresError).toContain('could not be read')
  })
})

describe('no record, no restore', () => {
  test('a bucket that will not take the preparation means nothing is prepared', async () => {
    const { h, earlier } = withHistory()
    h.bucket.failPut = true
    const r = await prepare(h, { bookmark: earlier })
    expect(r.status).toBe(503)
    expect(h.objectStorage.kv.has('restore:pending')).toBe(false)
  })

  test('a bucket that will not take the restore’s record cancels the arming and restarts the store once, which changes nothing', async () => {
    const { h, earlier } = withHistory()
    const plan = (await prepare(h, { bookmark: earlier })).json
    h.objectStorage.kv.set('written-since', 'a sync, a draft, a sent marker')
    h.bucket.failPut = true
    const r = await confirm(h, { token: plan.token, bookmark: earlier })
    expect(r.status).toBe(503)
    expect(r.json.error).toContain('cancelled')
    // Armed to the target, then armed back to the moment of arming (the undo bookmark), then restarted so that the arming is
    // applied and gone: left pending it would apply at the next restart and erase every write between.
    expect(h.objectStorage.armings).toHaveLength(2)
    expect(h.objectStorage.armings[0]).toBe(earlier)
    expect(h.objectStorage.restarts).toBe(1)
    expect(h.objectStorage.armedTo).toBeNull()
    // The store is what it was when the restore was armed: nothing was lost, and the target was not applied.
    expect(h.objectStorage.kv.get('row')).toBe('after')
    expect(h.objectStorage.kv.get('written-since')).toBe('a sync, a draft, a sent marker')
    expect(h.restores.armed).toBe(false)
    expect((await h.request(AGENT, 'GET', '/api/audit')).status).toBe(200)
    expect(recordKeys(h).some((k) => k.includes('-restored-'))).toBe(false)
  })

  test('if the arming cannot be cancelled either, the answer says what is applied and the store restarts to apply it', async () => {
    const { h, earlier } = withHistory()
    const plan = (await prepare(h, { bookmark: earlier })).json
    h.bucket.failPut = true
    const arm = h.objectStorage.armRestore.bind(h.objectStorage)
    let calls = 0
    h.objectStorage.armRestore = async (b) => {
      calls += 1
      if (calls === 2) throw new Error('would not cancel')
      return arm(b)
    }
    const r = await confirm(h, { token: plan.token, bookmark: earlier })
    expect(r.status).toBe(503)
    expect(r.json.error).toContain('restarts now')
    expect(r.json.error).toContain(earlier)
    // The restore was armed and could not be unarmed, so it is applied, at once, and its undo bookmark was said.
    expect(h.objectStorage.restarts).toBe(1)
    expect(h.objectStorage.kv.get('row')).toBe('before')
    expect(h.restores.armed).toBe(false)
  })

  test('a Worker with no bucket bound prepares and restores nothing, and still reads the bookmark', async () => {
    const h = harness({}, { restoreBucket: false })
    h.objectStorage.mark()
    const bookmark = (await get(h, OWNER)).json
    expect(bookmark.current).toMatch(/fakebookmark$/)
    expect(bookmark.restoresError).toContain('no raw-mail bucket')
    expect((await prepare(h, { bookmark: bookmark.current })).status).toBe(503)
    expect((await confirm(h, { token: 't', bookmark: bookmark.current })).status).toBe(503)
  })

  test('Cloudflare refusing to arm leaves nothing armed, no restore record, and the token spent', async () => {
    const { h, earlier } = withHistory()
    const plan = (await prepare(h, { bookmark: earlier })).json
    h.objectStorage.failArm = true
    const r = await confirm(h, { token: plan.token, bookmark: earlier })
    expect(r.status).toBe(422)
    expect(r.json.error).toContain('Nothing was changed')
    expect(recordKeys(h).some((k) => k.includes('-restored-'))).toBe(false)
    expect(h.objectStorage.restarts).toBe(0)
    expect((await confirm(h, { token: plan.token, bookmark: earlier })).status).toBe(409)
  })

  test('a bookmark Cloudflare does not know is refused at the second step, with nothing changed', async () => {
    const { h } = withHistory()
    const plan = (await prepare(h, { bookmark: 'a-bookmark-that-is-not-ours' })).json
    const r = await confirm(h, { token: plan.token, bookmark: 'a-bookmark-that-is-not-ours' })
    expect(r.status).toBe(422)
    expect(h.objectStorage.restarts).toBe(0)
    expect(h.restores.armed).toBe(false)
  })
})

describe('an armed restore is never left waiting', () => {
  /** A confirmed restore whose route never made its restart call: the client went away, say. */
  async function armedWithoutRestart() {
    const { h, earlier } = withHistory()
    const plan = (await prepare(h, { bookmark: earlier })).json
    const done = await h.restores.confirmRestore({ token: plan.token, bookmark: earlier }, TESSA)
    expect(done.ok).toBe(true)
    expect(h.restores.armed).toBe(true)
    expect(h.objectStorage.restarts).toBe(0)
    return { h, earlier }
  }

  test('the next call of any kind restarts the object, which applies the restore, and the call after it is served', async () => {
    const { h } = await armedWithoutRestart()
    await expect(h.store.call('listAudit', 1)).rejects.toThrow('aborted')
    expect(h.objectStorage.restarts).toBe(1)
    expect(h.objectStorage.kv.get('row')).toBe('before')
    expect(h.restores.armed).toBe(false)
    expect((await h.request(AGENT, 'GET', '/api/audit')).status).toBe(200)
  })

  test('a call that is not a store call, a read of the bookmark, restarts it too', async () => {
    const { h } = await armedWithoutRestart()
    await expect(h.store.call('restoreBookmarks', null)).rejects.toThrow('aborted')
    expect(h.objectStorage.restarts).toBe(1)
    expect(h.restores.armed).toBe(false)
  })

  test('the alarm restarts it as well (worker.ts calls the same one line first)', async () => {
    const { h } = await armedWithoutRestart()
    expect(() => h.restores.restartIfArmed()).toThrow('aborted')
    expect(h.objectStorage.restarts).toBe(1)
    expect(h.restores.armed).toBe(false)
  })

  test('with nothing armed it does nothing', async () => {
    const { h } = withHistory()
    h.restores.restartIfArmed()
    expect(h.objectStorage.restarts).toBe(0)
  })

  test('the route’s own restart call is the one that does it when it comes', async () => {
    const { h } = await armedWithoutRestart()
    await expect(h.store.call('restartForRestore', TESSA)).rejects.toThrow()
    expect(h.objectStorage.restarts).toBe(1)
    expect(h.objectStorage.kv.get('row')).toBe('before')
    expect(await h.restores.restartForRestore(`agent:${AGENT_ID}`)).toMatchObject({ ok: false, status: 403 })
  })

  test('a restart with no restore armed is refused, so nothing restarts the store for no reason', async () => {
    const { h } = withHistory()
    expect(await h.restores.restartForRestore(TESSA)).toMatchObject({ ok: false, status: 409 })
    expect(h.objectStorage.restarts).toBe(0)
  })
})

describe('Claude’s script', () => {
  const script = (h: H) => {
    const io: CliIo = {
      env: { INBOX_URL: 'https://door.test', INBOX_ACCESS_CLIENT_ID: AGENT_ID, INBOX_ACCESS_CLIENT_SECRET: 's' },
      sopsKey: () => {
        throw new Error('sops must not be called when the env is set')
      },
      readInput: async (spec) => spec,
      fetch: async (url, init) => {
        const headers = new Headers(init.headers)
        headers.set('cf-access-jwt-assertion', await mint(AGENT, { audience: AGENT_AUD }))
        return h.app.request(url, { ...init, headers }, h.env)
      },
    }
    return (...argv: string[]) => runCli(argv, io)
  }

  test('`bookmark` prints the current bookmark, and with a time the bookmark for then', async () => {
    const { h, earlier } = withHistory()
    const run = script(h)
    const now = await run('bookmark')
    expect(now.exitCode).toBe(0)
    expect(JSON.parse(now.output).current).toMatch(/fakebookmark$/)
    const then = JSON.parse((await run('bookmark', '2026-10-20T05:30:00-07:00')).output)
    expect(then.forTime).toEqual({ time: '2026-10-20T12:30:00.000Z', bookmark: earlier })
  })

  test('there is no command that restores, and the usage says so', async () => {
    const { h } = withHistory()
    const run = script(h)
    for (const command of ['restore', 'prepare-restore', 'confirm-restore']) {
      const r = await run(command, 'x')
      expect(r.exitCode).toBe(1)
      expect(r.output).toBe(USAGE)
    }
    expect(USAGE).toContain('bookmark [iso-time]')
    expect(USAGE).toContain('restoring is the owner')
    expect(h.objectStorage.armings).toEqual([])
  })

  test('a time with no zone is refused by the inbox, and the script says what it said', async () => {
    const { h } = withHistory()
    const r = await script(h)('bookmark', '2026-10-20T12:30:00')
    expect(r.exitCode).toBe(1)
    expect(r.output).toContain('422')
  })
})
