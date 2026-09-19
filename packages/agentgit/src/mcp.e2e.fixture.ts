/**
 * A walgit, doubled only where walgit computes, in a process of its own.
 *
 * Its own process is not tidiness: the client fetches with `spawnSync`, so a
 * host served from the same loop would be asked for a pack by a caller that is
 * blocking the loop it would be answered on. That deadlocks, and the symptom is
 * a test that simply never finishes.
 *
 *   bun src/mcp.e2e.fixture.ts <host.git> <repo> [<pusher clone>]
 *
 * It prints one line — `127.0.0.1:<port>` — and then serves two things: the
 * event stream at `/_walgit/events`, and enough smart-HTTP for a fetch. With a
 * pusher clone named, the first subscription is answered with current state and
 * then followed by a real push and the Ref Event it produces; without one,
 * nothing ever moves, which is the deadline case.
 */

import { spawnSync } from 'node:child_process'

const [hostPath, repo, pusher] = process.argv.slice(2)
if (!hostPath || !repo) throw new Error('usage: mcp.e2e.fixture.ts <host.git> <repo> [<pusher>]')

const WATCHED_REF = 'refs/heads/main'

const git = (dir: string, args: string[]) =>
  spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd: dir,
    encoding: 'utf8',
  })

const headOf = (ref: string) => git(hostPath, ['rev-parse', ref]).stdout.trim()

/** The pkt-line a smart-HTTP advertisement opens with. */
const pktLine = (payload: string) =>
  `${(payload.length + 4).toString(16).padStart(4, '0')}${payload}`

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request, bun) {
    const url = new URL(request.url)

    if (url.pathname === '/_walgit/events') {
      return bun.upgrade(request)
        ? undefined
        : new Response('expected a websocket', { status: 400 })
    }

    if (url.pathname === `/${repo}.git/info/refs`) {
      const advertised = Bun.spawnSync([
        'git',
        'upload-pack',
        '--stateless-rpc',
        '--advertise-refs',
        hostPath,
      ])
      return new Response(
        new Blob([
          `${pktLine('# service=git-upload-pack\n')}0000`,
          new Uint8Array(advertised.stdout),
        ]),
        {
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
        },
      )
    }

    if (url.pathname === `/${repo}.git/git-upload-pack`) {
      const asked = Bun.spawnSync({
        cmd: ['git', 'upload-pack', '--stateless-rpc', hostPath],
        stdin: Buffer.from(await request.arrayBuffer()),
      })
      return new Response(new Uint8Array(asked.stdout), {
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
      })
    }

    return new Response('not found', { status: 404 })
  },
  websocket: {
    message(socket) {
      // Whatever was asked for, the reply is current state (docs/adr/0009).
      socket.send(
        JSON.stringify({
          ok: true,
          refs: [{ repo, ref: WATCHED_REF, sha: headOf(WATCHED_REF) }],
        }),
      )
      if (pusher === undefined) return

      // The other agent, pushing while the first one waits.
      Bun.write(`${pusher}/README.md`, `pushed at ${Date.now()}\n`)
      git(pusher, ['add', 'README.md'])
      git(pusher, ['commit', '-m', 'second'])
      git(pusher, ['push', 'origin', 'main'])
      socket.send(JSON.stringify({ repo, ref: WATCHED_REF, sha: headOf(WATCHED_REF) }))
    },
  },
})

process.stdout.write(`127.0.0.1:${server.port}\n`)
