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
import { EVENTS_PATH, PROVENANCE_PATH, SIGNERS_REF } from './protocol'

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
  /**
   * Whether a repository here may hold a Signer List, and be defended by it.
   *
   * Read twice. It conditions the two sentences that say walgit refuses nothing
   * on the strength of a signature and keeps no list of allowed signers, both
   * of which stop being true the moment the gate is on; and it is what renders
   * `## Hold a name`, the section that teaches claiming, granting, revoking and
   * reading a list. This is the document ADR-0012 put discovery in, so an agent
   * that came looking learns a name is holdable before it is refused for
   * pushing to somebody else's.
   *
   * Paired with `signedPushes` at the section, never read alone: with no nonce
   * seed nothing can sign, so every push to a claimed name is refused as
   * unsigned and no client can sign its way out. Teaching an agent to claim a
   * name there would hand it a command that cannot work — the same defect as a
   * cap nothing enforces.
   */
  signerLists: boolean
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
   *
   * Unless it does. Where Signer Lists are on, both of those answers change —
   * a fingerprint can be what a name is defended by, and there IS a list of
   * allowed signers, written by whoever holds the name. The two sentences are
   * conditioned rather than rewritten because saying "the gate exists" is what
   * stops this document from lying; how to write one is `## Hold a name`, and
   * this section points at it rather than repeating it.
   */
  const signing = facts.signedPushes
    ? `
## Say who pushed

A push here can carry a **push certificate**: a small signed document naming
the refs it moves and a nonce this host issued. walgit verifies the signature
itself and records the fingerprint of the key that made it.${
        facts.signerLists
          ? ` A name that has
written a **Signer List** takes pushes from the keys that list names and refuses
everything else; a name nobody has written one for refuses nothing, which is
every name until someone does. *Hold a name*, below, is how one is written.`
          : ' Nothing is refused on the strength of it.'
      }

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
key you push with is the key that signs. There is nothing to register here${
        facts.signerLists
          ? `: a
key walgit has never seen is accepted anywhere a Signer List does not say
otherwise, and the list is a file in a repository rather than an account here.`
          : ` —
walgit keeps no list of allowed signers, which is exactly why it can accept a
key it has never seen.`
      }

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

${
  facts.signerLists
    ? `**Unsigned pushes are ordinary, until a name says otherwise.** Signing is not
authentication and buys no access by itself: an unsigned push lands exactly as a
signed one does, to the same names, with the same rules, on every name nobody
has claimed — which is every name until someone writes a Signer List for one. A
name that has written one takes pushes from the keys that list names and refuses
everything else, saying so in the refusal. Reads are never gated, a claimed
repository stays world-readable, and no name is owned by the key that merely
pushed to it first — only by the list it wrote.`
    : `**Unsigned pushes are ordinary.** Signing is not authentication and buys no
access: an unsigned push lands exactly as a signed one does, to the same names,
with the same rules. Nothing here is refused for being anonymous, no name is
owned by the key that first pushed it, and a repository with a recorded Signer
is still world-writable by anyone. If provenance ever starts refusing things,
it will say so on this page first.`
}
`
    : ''

  /**
   * The one sentence in the section below that is rendered rather than written:
   * on a deployment that collects idle repositories, idle expiry IS the way
   * back from a lost key, and on one that does not there is none. Claiming
   * either on the wrong deployment is the drift every limit here is rendered
   * to avoid.
   */
  const lostKey =
    facts.retentionHours === null
      ? 'A lost key ends the name: nobody can push to it again.'
      : `Where a key is lost, ${hours(facts.retentionHours)} without a push collects the repository
and frees the name with it — the only way back.`

  /**
   * Ownership, taught where an agent went looking for it.
   *
   * This is the discovery ADR-0012 chose: `GET /` gains nothing, because it is
   * read mid-task and has a byte budget, and because ownership's failure lands
   * on our server in our words at the moment it is relevant. The refusal
   * teaches whoever hit it; this teaches whoever came looking first.
   *
   * Every spelling here is the one `src/signers.ts` refuses with — the ref, the
   * file name, `ssh-keygen -lf`, "a grant governs the NEXT push", the two ways
   * a list is refused — so an agent that reads this and an agent that reads a
   * refusal are not being told about two different files.
   *
   * "List two keys" is a subsection rather than a footnote on purpose. The
   * single-key list is the shape an agent writes by default and the one with no
   * way back: there is no escrow and no support address here, and the ADR
   * bounded a lost key with multi-key lists, revocation, and idle expiry where
   * a deployment has it.
   */
  const ownership =
    facts.signedPushes && facts.signerLists
      ? `
## Hold a name

Every name here is free until somebody claims it, and claiming one is a push. A
repository that has written a **Signer List** to \`${SIGNERS_REF}\` takes
pushes signed by the keys that list names and refuses everything else, saying
so. A name nobody has written one for refuses nothing.

The list is a commit whose tree holds a file called \`signers\`: one SSH key
fingerprint per line, blank lines and \`#\` comments ignored. A fingerprint is
what \`ssh-keygen -lf <key>\` prints.

\`\`\`
# laptop
SHA256:BMBEMXbMBsnjXwgNs+86IiJrPgYlZEsWxaKZW/2/1dw
# the key that is not on the laptop
SHA256:oGJ8Ai9nQ5wnTfEEqcnybGDBTBYRhLKlbBLXSpOfZ0Y
\`\`\`

### Claim one

\`\`\`sh
set -e -o pipefail
git init -q claim && cd claim
ssh-keygen -lf ~/.ssh/id_ed25519.pub | awk '{print $2}'  > signers
ssh-keygen -lf ~/.ssh/id_backup.pub  | awk '{print $2}' >> signers
git add signers
git -c user.email=agent@localhost -c user.name=agent commit -qm claim
git -c gpg.format=ssh -c user.signingkey=~/.ssh/id_ed25519.pub \\
    push --signed=if-asked https://${host}/$NAME.git HEAD:${SIGNERS_REF}
\`\`\`

The first line is load-bearing. A key file that is not there must stop this,
because the alternative is a half-written list claiming the name with one key —
or with the wrong one, if the key that signs is the one that was missing.

The list has its own history and nothing in your working repository changes to
write one. What changes is every push after it: from here on, a push to this
name — yours included, and to any ref — must carry a signature from a key the
list names. Only the founding push is free, because **a grant governs the next
push**: the list that judges a push is the one that stood before it, and before
the founding push there was none.

### List two keys

There is no recovery for a lost key: no escrow, no proof of identity, no support
address. A second key — another machine, or one kept where the first is not — is
the whole of the recovery story, and the one-key list is the shape most agents
write.
${lostKey}

### Grant and revoke

Both are a commit on the same ref, pushed by a key the list already names:
adding a line grants, removing one revokes. A grant governs the NEXT push, so an
agent that was just added should retry once the granting push has landed. A
revoked key is refused from its next push onward, and revoking it undoes nothing
that key already pushed. Nothing here is retroactive.${
          facts.appendOnly
            ? ` Refs only move
forward here, so nothing it pushed can be taken away afterwards either.`
            : ''
        }

### Read a list

\`\`\`sh
# is this name claimed at all? the ref exists, or it does not.
git ls-remote https://${host}/$NAME.git ${SIGNERS_REF}

# the keys themselves. a clone does not fetch refs/walgit/*, so ask for it.
git fetch -q https://${host}/$NAME.git ${SIGNERS_REF} && git cat-file -p FETCH_HEAD:signers

# or read the copy the refusal reads, without a repository to fetch into.
curl https://${host}${PROVENANCE_PATH}?repo=$NAME
{"repo":"$NAME","provenance":{…},"claim":{"signers":["SHA256:BMBE…"],"ts":"2026-08-30T19:00:00.000Z"}}
\`\`\`

The ref is the authority and \`claim\` is a copy of it, kept so that the refusal
in \`pre-receive\` never has to read a git object. \`claim\` is **omitted** for a
name nobody has claimed, which is most of them.

Reads are gated by none of this. A claimed repository, its list and its
provenance stay as readable as they were, to anyone who can read the rest.

### Two lists that are refused

An **empty** list, and one walgit **cannot read**, are refused on claimed and
unclaimed names alike — deleting the ref is the empty case spelled differently.
An empty list would hand the name to the next stranger, which is a way to lose
it rather than a way to release it; an unreadable one would leave you believing
you hold a name the host still thinks is free. To hand a name on, push a list
naming the other key. To stop using it, stop pushing.
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

### The published client

\`\`\`sh
bunx @zabaca/agentgit watch          # npx works too; no dependencies
\`\`\`

Run it inside a clone and there is nothing left to decide: it reads the host and the repository from the remote, and the ref from the branch you are on. On each event it fetches — and only fetches. Your branch, your working tree and any work in progress are left alone, because a watcher that moved branches under a working agent would be a menace.

| flag | what it is for |
| --- | --- |
| \`--once\` | exit 0 after the first ref moves. **This is the handoff primitive**: block until the other agent pushes, then carry on. |
| \`--on '<cmd>'\` | run a shell command in the clone after a fetch. \`$AGENTGIT_REPO\`, \`$AGENTGIT_REF\` and \`$AGENTGIT_SHA\` are set. |
| \`--json\` | one JSON object per line instead of prose — parse this rather than the prose. |
| \`--ref <ref>\` | a full ref name, repeatable. Defaults to the branch you are on; \`--all-refs\` for every ref. |
| \`<repo>=<dir>\` | watch several checkouts on one socket. |
| \`--host\`, \`--token\` | for a deployment the remote does not name, or one that needs a credential. |

\`\`\`
{"event":"watching","host":"${host}","repos":["my-thing"]}
{"event":"fetched","ref":"refs/heads/main","sha":"d4e5f6…","current":true}
{"event":"collides","ref":"refs/heads/main","paths":["src/index.ts"]}
\`\`\`

### The whole client, without installing anything

The client above is a convenience, not a dependency. The protocol is one socket and one JSON message, so if you would rather not install anything:

\`\`\`sh
bun -e 'const w=new WebSocket("${ws}")
  w.onopen=()=>w.send(JSON.stringify({watch:[{repo:"my-thing"}]}))
  w.onmessage=e=>JSON.parse(e.data).ok||Bun.spawnSync(["git","fetch"])
  w.onclose=()=>process.exit(75)' &
\`\`\`

It exits when the socket closes so a supervisor restarts it, and the new handshake catches up whatever moved meanwhile. No cursor, no state file, no keepalive. A longer version that watches several repositories on one socket ships with walgit at \`examples/watch.ts\`.

### Did it land on top of me

The question worth asking after a fetch, and what \`collides\` above is reporting. git answers it without touching your working tree:

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
${signing}${ownership}${events}
## If a push is refused

Read the message. A refusal names what it refused and what to do instead — it is not a transport failure, and retrying the same push unchanged will not help. The usual cause is a name already held by an unrelated history: push to a new one.

## What this is not

Not a forge: no pull requests, no code review, no CI, no issues.${facts.publicAccess ? ' Not private: everything here is readable by everyone.' : ''}${facts.retentionHours !== null ? ` Not permanent: ${hours(facts.retentionHours)} from the last push, a repository is collected.` : ' Not an archive: nothing here is a promise to keep your history.'} Not a place for anything you cannot lose.
`
}
