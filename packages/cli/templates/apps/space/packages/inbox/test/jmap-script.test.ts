import { describe, expect, test } from 'bun:test'
import { type CliIo, runCli, USAGE } from '../scripts/cli'
import { bundledInstall } from '../src/workspace'
import { harness, T0 } from '../test-support/harness'
import { CLIENT_ID, CLIENT_SECRET, throughSpace } from '../test-support/space-door'

/** Claude's script reading a mailbox on the mail server: the `jmap` command, and the mailbox beside the others in queue and conversation. It reads, marks nothing read, and shows no key. */

const DOOR_URL = bundledInstall.agentDoor()?.url ?? 'no door'
const parse = (r: { output: string }) => JSON.parse(r.output)

function script(h: ReturnType<typeof harness>) {
  const door = throughSpace(h)
  const io: CliIo = {
    env: { INBOX_URL: DOOR_URL, INBOX_ACCESS_CLIENT_ID: CLIENT_ID, INBOX_ACCESS_CLIENT_SECRET: CLIENT_SECRET },
    sopsKey: () => {
      throw new Error('sops must not be called when the env is set')
    },
    readInput: async (spec) => spec,
    fetch: (url, init) => door.fetch(url, init),
  }
  return (...argv: string[]) => runCli(argv, io)
}

describe('the script and a mailbox on the mail server', () => {
  test('`jmap` shows each mailbox: its state, its push, its counts, and no key', async () => {
    const h = harness({}, { jmap: true })
    h.jmapServer.deliver({ subject: 'Hello', from: 'Dana Smith <dana@example.com>', at: T0 - 1000 })
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    const run = script(h)
    const out = await run('jmap')
    expect(out.exitCode).toBe(0)
    const body = parse(out)
    expect(body.mailboxes).toHaveLength(1)
    expect(body.mailboxes[0]).toMatchObject({
      kind: 'jmap',
      address: 'test@harborline.example',
      name: 'harborline',
      state: 'live',
      declared: true,
      messages: 1,
      conversations: 1,
      open: 1,
      unreadOpen: 1,
    })
    expect(out.output).not.toContain(h.jmapServer.key)
    expect(out.output).not.toContain(h.jmapServer.accessSecret)
    expect(USAGE).toContain('jmap ')
  })

  test('with none declared it shows an empty list, and the conversation and queue carry the pill and the kind', async () => {
    const none = harness()
    expect(parse(await script(none)('jmap'))).toEqual({ mailboxes: [] })

    const h = harness({}, { jmap: true })
    h.jmapServer.deliver({ subject: 'Hello', from: 'Dana Smith <dana@example.com>', at: T0 - 1000 })
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    const run = script(h)
    const queue = parse(await run('queue'))
    expect(queue.rows[0]).toMatchObject({
      mailbox: { name: 'harborline', address: 'test@harborline.example' },
      mailboxKind: 'jmap',
    })
    const convo = parse(await run('conversation', queue.rows[0].id))
    expect(convo.messages[0]).toMatchObject({ body: expect.stringContaining('Body of') })
    expect(JSON.stringify(convo)).not.toContain('gmailUrl":"https')
    // reading marks nothing read, here or on the server
    expect(h.jmapServer.emails.size).toBe(1)
    expect([...h.jmapServer.emails.values()][0]?.keywords.$seen).toBeUndefined()
  })
})
