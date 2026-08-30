/**
 * `/llms.txt` — the long version, for an agent that came looking.
 *
 * There are now two documents for the same audience, and the difference
 * between them is when they are read rather than who reads them.
 *
 *   GET /          is read IN BAND. An agent hits it because a push failed or
 *                  because it is orienting mid-task, and every line costs it
 *                  context it wanted to spend on the task. It stays terse.
 *   GET /llms.txt  is read DELIBERATELY, by an agent or a harness that went
 *                  looking for the manual. Length is close to free here, so
 *                  this is where worked examples and the reasoning live.
 *
 * The rule that keeps them from becoming two versions of the truth: every
 * enforced limit in both is rendered from the same environment the push path
 * reads, never written as prose. A cap this deployment does not enforce cannot
 * appear in either document, because neither has a constant to state it with.
 *
 * Markdown rather than plain text, following the llms.txt convention: the
 * headings are the index, and a model can skim them without parsing anything.
 */

import { MAX_REFS_PER_ENTRY, MAX_WATCH_ENTRIES } from './events'
import { describeBytes } from './policy'
import { EVENTS_PATH, PROVENANCE_PATH } from './protocol'

export interface LlmsFacts {
  /** The hostname the request arrived on — every command below uses it. */
  host: string
  /** `null` when this deployment collects nothing, and the text then says so. */
  retentionHours: number | null
  maxPushBytes: number | null
  maxRepoBytes: number | null
  /** Whether this deployment serves the ref-event stream. */
  events: boolean
  /** Whether reads and writes need no credential at all. */
  publicAccess: boolean
  /** Whether refs may only move forward here. */
  appendOnly: boolean
  /**
   * Whether this deployment takes a signed push and records who made it.
   *
   * From the nonce seed, the same value the container writes onto every
   * repository as `receive.certNonceSeed`. With no seed the capability is not
   * advertised on the wire and a client asking to sign is refused by its own
   * git, so a manual describing it here would be describing a flag that
   * cannot work on this host.
   */
  signedPushes: boolean
}

/** Only GET or HEAD on the one path. Nothing else is this document. */
export function wantsLlms(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  return pathname === '/llms.txt'
}

const hours = (n: number) => (n === 1 ? '1 hour' : `${n} hours`)

export function renderLlms(facts: LlmsFacts): string {
  const { host } = facts
  const ws = `wss://${host}${EVENTS_PATH}`

  const limits: string[] = []
  if (facts.publicAccess) {
    limits.push(
      '- **No credential.** Reads and writes take no token, no key and no account. Everything here is world-readable and world-writable. Do not push a secret.',
    )
  } else {
    limits.push(
      '- **A credential is required.** Send it as the Basic-auth password: `git clone https://walgit:$TOKEN@' +
        host +
        '/my-thing.git`.',
    )
  }
  limits.push(
    '- **A repository is created by its first push.** Names are one segment, claimed first-come, never reassigned. Put a random suffix on the name: many agents run near-identical prompts at the same time, and a taken name means a refused push.',
  )
  if (facts.appendOnly) {
    limits.push(
      '- **Refs only move forward.** A push that would rewrite history or delete a ref is refused. Adding a commit or a branch is always allowed. This is what makes it safe to hand a repository to a stranger: they can build on it and cannot take anything away.',
    )
  }
  if (facts.retentionHours !== null) {
    limits.push(
      `- **A repository is deleted ${hours(facts.retentionHours)} after its LAST push.** Cloning does not extend it; pushing does. This is scratch space. Copy anything that must outlive that window.`,
    )
  }
  if (facts.maxPushBytes !== null) {
    limits.push(
      `- **A single push may not exceed ${describeBytes(facts.maxPushBytes)}.** Refused in \`pre-receive\`, before anything is uploaded.`,
    )
  }
  if (facts.maxRepoBytes !== null) {
    limits.push(
      `- **One repository may not exceed ${describeBytes(facts.maxRepoBytes)}** in total.`,
    )
  }

  /**
   * Signing, argued rather than merely offered.
   *
   * The terse document gives an agent the flag and the endpoint; this is where
   * the two questions it will actually have get answered — what the host takes
   * a fingerprint to MEAN, and whether not signing costs anything. Both
   * answers are deliberately small, and saying so is the point: walgit
   * verifies a signature and records the key, and does nothing else with it
   * (docs/adr/0011). A manual that implied more would be describing an
   * ownership model this host does not have.
   */
  const signing = facts.signedPushes
    ? `
## Say who pushed

A push here can carry a **push certificate**: a small signed document naming
the refs it moves and a nonce this host issued. walgit verifies the signature
itself, records the fingerprint of the key that made it, and refuses nothing on
the strength of it.

\`\`\`sh
git -c gpg.format=ssh -c user.signingkey=~/.ssh/id_ed25519.pub \\
    push --signed=if-asked https://${host}/$NAME.git HEAD:refs/heads/main
\`\`\`

Use \`--signed=if-asked\`, not \`--signed=yes\`. It signs where the host takes a
certificate and pushes normally where it does not, so one command is correct
everywhere and an agent never has to branch on which host it is talking to.
\`--signed=yes\` against a host without the capability is refused by your own git
before anything reaches the network.

The key costs nothing to provision: if you already push to GitHub over SSH, the
key you push with is the key that signs. There is nothing to register here —
walgit keeps no list of allowed signers, which is exactly why it can accept a
key it has never seen.

### Read it back

\`\`\`sh
curl https://${host}${PROVENANCE_PATH}?repo=$NAME
{"repo":"$NAME","provenance":{"refs/heads/main":{"signer":"SHA256:BMBE…","ts":"2026-08-30T19:00:00.000Z"}}}
\`\`\`

One entry per ref that a signed push last moved, behind the same credential a
clone of that repository needs. A repository nobody has signed a push to
answers with an empty object — that is the ordinary case, not an error.

### What a fingerprint means here, and what it does not

The identity is the **key**, not a person and not an account: neither exists on
this host. What walgit claims when it records a Signer is exactly one thing —
*this key signed this push, over this nonce, for these refs* — and the nonce is
what stops the certificate being replayed onto another push.

It claims nothing about who holds the key. Two pushes with the same fingerprint
came from the same key; whether that is the same agent is between you and
whoever published the key. Matching a fingerprint against one you already trust
— from a GitHub profile, a prior message, your own \`~/.ssh\` — is the reader's
job, and it is the only thing that turns a fingerprint into a person.

**Unsigned pushes are ordinary.** Signing is not authentication and buys no
access: an unsigned push lands exactly as a signed one does, to the same names,
with the same rules. Nothing here is refused for being anonymous, no name is
owned by the key that first pushed it, and a repository with a recorded Signer
is still world-writable by anyone. If provenance ever starts refusing things,
it will say so on this page first.
`
    : ''

  const events = facts.events
    ? `
## Know when a ref moves, without asking

There is no webhook to configure and no endpoint to run. Open a WebSocket to \`${ws}\`, say what you care about, and the host talks down it. The connection is outbound, so a sandbox with no ingress is not a problem.

\`\`\`
-> {"watch":[{"repo":"my-thing","refs":["refs/heads/main"]}]}
<- {"ok":true,"refs":[{"repo":"my-thing","ref":"refs/heads/main","sha":"a1b2c3…"}]}
<- {"repo":"my-thing","ref":"refs/heads/main","sha":"d4e5f6…"}
\`\`\`

The first reply is current state for everything you named, so connecting and catching up are one operation. After that you get one message per ref that moves, and nothing in between.

Events are **latest state, not a log**. There is no cursor, no replay and no timer: if the socket drops, reconnect and the reply to your next \`watch\` is current state. Nothing is owed to you in between, which is why there is nothing to resume.

Omit \`refs\` to watch every ref in a repository. A \`sha\` of \`null\` means the ref is gone.

### The whole client

\`\`\`sh
bun -e 'const w=new WebSocket("${ws}")
  w.onopen=()=>w.send(JSON.stringify({watch:[{repo:"my-thing"}]}))
  w.onmessage=e=>JSON.parse(e.data).ok||Bun.spawnSync(["git","fetch"])
  w.onclose=()=>process.exit(75)' &
\`\`\`

It exits when the socket closes so a supervisor restarts it, and the new handshake catches up whatever moved meanwhile. No cursor, no state file, no keepalive. A longer version that watches several repositories on one socket ships with walgit at \`examples/watch.ts\`.

### Did it land on top of me

The question worth asking after a fetch. git answers it without touching your working tree:

\`\`\`sh
WIP=$(git stash create)
git merge-tree --write-tree --name-only \${WIP:-HEAD} origin/main
\`\`\`

\`stash create\` is the part that matters: \`merge-tree\` compares commits, so uncommitted edits — the normal state of an agent mid-task — are invisible to it otherwise.

| exit | meaning |
| --- | --- |
| 0 | no collision, including when you are simply behind — the merge is a fast-forward |
| 1 | collision; the tree oid is line one, then one path per line |
| other | git could not answer (unrelated histories, and similar). Not the same as "no collision" — say nothing rather than send somebody to reconcile a conflict that does not exist. |

Report it when it CHANGES, not on every event. A collision that is still there is still true, but an agent told the same thing on every unrelated push learns to ignore the channel.

### The rest of the wire

One message can name several repositories, and a deleted ref arrives as a null sha:

\`\`\`
-> {"watch":[{"repo":"my-thing","refs":["refs/heads/main"]},{"repo":"other"}]}
<- {"repo":"my-thing","ref":"refs/heads/gone","sha":null}
\`\`\`

There is no \`seq\` field and no cursor anywhere in this protocol. The omission is deliberate: no client should be written against a resume point the host will not honour.

Limits: at most **${MAX_WATCH_ENTRIES} repositories** per connection and **${MAX_REFS_PER_ENTRY} refs** per repository, and there is no wildcard. Over either, the subscription is refused with a message naming the cap and what you asked for. A socket that stops draining is closed rather than buffered; reconnect and the handshake makes you current.

Use the same credential a clone needs. A public deployment has a public stream.
`
    : ''

  return `# ${host}

A git host for agents. Push to a name and the repository exists. There is no account to create, no repository to create first, and no API besides git itself.

Smart-HTTP is the only transport.

## Before you push

${limits.join('\n')}

## Push something you already have

\`\`\`sh
NAME=my-project-$(openssl rand -hex 4)
git remote add walgit https://${host}/$NAME.git
git push walgit HEAD:refs/heads/main
\`\`\`

## Start from nothing

\`\`\`sh
NAME=scratch-$(openssl rand -hex 4)
git init . && git add -A
git -c user.email=agent@localhost -c user.name=agent commit -m first
git push https://${host}/$NAME.git HEAD:refs/heads/main
\`\`\`

## Read somebody else's work

\`\`\`sh
git clone https://${host}/$NAME.git
\`\`\`

Handing work to another agent is the URL and nothing else. There is no owner to ask, no invitation to send and no review to pass.
${signing}${events}
## If a push is refused

Read the message. A refusal names what it refused and what to do instead — it is not a transport failure, and retrying the same push unchanged will not help. The usual cause is a name already held by an unrelated history: push to a new one.

## What this is not

Not a forge: no pull requests, no code review, no CI, no issues.${facts.publicAccess ? ' Not private: everything here is readable by everyone.' : ''}${facts.retentionHours !== null ? ` Not permanent: ${hours(facts.retentionHours)} from the last push, a repository is collected.` : ' Not an archive: nothing here is a promise to keep your history.'} Not a place for anything you cannot lose.
`
}
