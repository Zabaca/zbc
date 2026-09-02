/**
 * `GET /` is the whole API surface.
 *
 * There is no create endpoint and no client library — the API is git — so this
 * text is the only thing standing between an agent and a working repository.
 * It is written for a model: plain text, short declarative sentences, one
 * worked example, no markup to parse and no link needed to understand it.
 *
 * The limits are the content, not the fine print. An agent that learns about
 * the retention window after pushing has been misled, so every limit the
 * instance enforces is stated before the example — and a limit the instance
 * does NOT enforce is never claimed, which is why the text is rendered from
 * `Capabilities` (`shared/capabilities.ts`) — the one derivation the push path
 * and the two edge documents also read — rather than written once as a
 * constant.
 */

import type { Capabilities } from '../shared/capabilities'
import { describeBytes } from '../shared/policy'
import { EVENTS_PATH, PROVENANCE_PATH } from '../shared/protocol'

/**
 * Rendered per request rather than baked at boot, because the host an agent
 * must type is the host it reached us on: a deployment behind a proxy, a
 * preview URL and a local test each need the example to work verbatim.
 *
 * A full ORIGIN, scheme included, unlike the two edge documents which take a
 * bare hostname and supply `https://` themselves — a local test reaches this
 * over plain http and the example has to work verbatim there too. That is why
 * neither spelling of the host is a field on `Capabilities`.
 *
 * What this page does with each capability is the shortest reading of it in the
 * package. It has a byte budget, and ADR-0012 put ownership's discovery in
 * `/llms.txt` and in the refusal itself — so `namesCanRefuse` buys two
 * corrections here and nothing else, and `namesCanBeClaimed` is not read at
 * all: this document never teaches anyone to hold a name.
 */
export function renderInstructions(origin: string, caps: Capabilities): string {
  const lines: string[] = [
    'walgit — a git host for agents.',
    '',
    ...wrap(
      'Push to a name and the repository exists. There is no account to create, no repository to create first, and no API besides git itself.',
    ),
    '',
    'BEFORE YOU PUSH',
    '',
  ]

  for (const fact of facts(caps)) lines.push(...wrap(`- ${fact}`), '')

  lines.push(
    'PUSH A REPOSITORY YOU ALREADY HAVE',
    '',
    '    NAME=my-project-$(openssl rand -hex 4)',
    `    git remote add walgit ${origin}/$NAME.git`,
    '    git push walgit HEAD:refs/heads/main',
    '',
    'START FROM NOTHING',
    '',
    '    NAME=scratch-$(openssl rand -hex 4)',
    '    git init . && git add -A',
    '    git -c user.email=agent@localhost -c user.name=agent commit -m first',
    `    git push ${origin}/$NAME.git HEAD:refs/heads/main`,
    '',
    "READ SOMEBODY ELSE'S WORK",
    '',
    `    git clone ${origin}/$NAME.git`,
    '',
    ...(caps.signedPushes ? signingSection(origin, caps.namesCanRefuse) : []),
    ...(caps.events ? watchSection(origin) : []),
    ...(caps.events
      ? []
      : [...wrap(`The full manual, with worked examples, is at ${origin}/llms.txt.`), '']),
    'IF A PUSH IS REFUSED',
    '',
    ...wrap(
      'Read the message. A refusal names what it refused and what to do instead; it is not a transport failure, and retrying the same push will not change it. The usual cause is that the name is already held by an unrelated history — push to a new name.',
    ),
    '',
  )

  return `${lines.join('\n')}\n`
}

function facts(caps: Capabilities): string[] {
  const facts: string[] = [
    caps.publicAccess
      ? publicAccessFact(caps.namesCanRefuse)
      : 'This instance requires a credential. Send it as the password of an HTTP basic credential or as a bearer token; the username is ignored.',
    'A repository is created by the first push to its name. Names are a single segment, claimed first-come, and never reassigned.',
  ]

  if (caps.appendOnly) {
    /**
     * The last sentence is gated too, and for the same reason the access bullet
     * above it is: *"That holds for everyone, so a stranger can build on your
     * work"* is the same promise of unconditional writability in different
     * words, and a document that corrects one sentence and leaves the next one
     * contradicting it has not been corrected. What append-only guarantees is
     * unchanged — it is who gets to push at all that the gate narrows — so the
     * gated version says *whoever the name takes a push from* and hands the
     * question back to the bullet that answers it.
     */
    facts.push(
      `Refs are append-only. A push that would rewrite history or delete a ref is refused. You can always add a commit or a branch; nothing can ever be removed. ${
        caps.namesCanRefuse
          ? 'Whoever the name takes a push from can build on your work but cannot destroy it.'
          : 'That holds for everyone, so a stranger can build on your work but cannot destroy it.'
      }`,
    )
  }
  if (caps.retentionHours !== null) {
    facts.push(
      `A repository is deleted ${describeHours(caps.retentionHours)} after its LAST PUSH. Cloning does not extend it; pushing does. This is scratch space — copy the work elsewhere if it must outlive that window.`,
    )
  }
  if (caps.maxPushBytes !== null) {
    facts.push(`A single push may not exceed ${describeBytes(caps.maxPushBytes)}.`)
  }
  if (caps.maxRepoBytes !== null) {
    facts.push(`One repository may not exceed ${describeBytes(caps.maxRepoBytes)} in total.`)
  }

  facts.push(
    'Put a random suffix on the name. Many agents run near-identical prompts at the same time; a plain name is probably taken already, and a taken name means your push is refused.',
  )
  return facts
}

/**
 * What a push costs, on a host that asks for nothing.
 *
 * The gated sentence is the SHORTER of the two, which is the whole difficulty:
 * this page had three bytes of headroom under the 3,000-byte budget asserted in
 * `instructions.test.ts`, and the correction had to be bought rather than
 * added. What it cost is the opening summary — *"Everything here is public."* —
 * which said in five words what *"world-readable"* says three words later, and
 * the word *"by"* in *"by anyone"*. What it deliberately did NOT cost is *"or
 * anything you would not publish"*: that clause is the one that catches the
 * case an agent has not thought of, and a warning about secrets is not the
 * place to find savings. The page still grows on net — the signing clause is
 * longer with the gate on than without it — and the measured figures live in
 * the budget test rather than here, so there is one place to keep current.
 *
 * It names the Signer List and stops. Not the ref, not `ssh-keygen`, not how to
 * write one — ADR-0012 put that in `/llms.txt` and in the refusal, and this
 * page's job is only to stop claiming the opposite.
 */
function publicAccessFact(namesCanRefuse: boolean): string {
  return namesCanRefuse
    ? 'Every repository is world-readable. Anyone may push, with no credential, unless a name holds a Signer List. Do not push a secret, a token, or anything you would not publish.'
    : 'Everything here is public. Every repository is world-readable and world-writable, by anyone, with no credential. Do not push a secret, a token, or anything you would not publish.'
}

/**
 * Signing, in the fewest lines that leave an agent able to do it.
 *
 * This document is read mid-task, so the section is the flag, the config it
 * needs and where the answer comes back — the argument for any of it is in
 * `/llms.txt`. `--signed=if-asked` rather than `=yes` deliberately: it signs
 * against a host that takes certificates and pushes normally against one that
 * does not, so an agent can put one form in its habits and never branch on
 * which host it is talking to.
 */
function signingSection(origin: string, namesCanRefuse: boolean): string[] {
  return [
    'SIGN A PUSH, AND BE CREDITED FOR IT',
    '',
    ...wrap(
      'Push with --signed=if-asked and the fingerprint of your key is recorded as who moved each ref. Any SSH key works, including the one you already push to GitHub with. ' +
        (namesCanRefuse
          ? 'Unsigned is fine unless a name holds a Signer List.'
          : 'Nothing is refused for being unsigned.'),
    ),
    '',
    '    git -c gpg.format=ssh -c user.signingkey=~/.ssh/id_ed25519.pub \\',
    '        push --signed=if-asked walgit HEAD:refs/heads/main',
    `    curl ${origin}${PROVENANCE_PATH}?repo=$NAME`,
    '',
  ]
}

/**
 * The stream, described where an agent will actually read about it.
 *
 * Written as the answer to "is my main still current?", because that is the
 * question the polling it replaces was asking. The wire vocabulary is the one
 * `shared/events.ts` implements — a `watch` message, a handshake carrying the
 * current sha of everything watched, then one message per ref that moves — so
 * the text and the protocol cannot describe two different things.
 *
 * No cursor is mentioned anywhere, deliberately: events are latest state, and
 * an agent told to resume from a position would build a client the server has
 * no way to serve.
 */
function watchSection(origin: string): string[] {
  return [
    'WATCH FOR PUSHES INSTEAD OF FETCHING ON A TIMER',
    '',
    '    bunx @zabaca/agentgit watch',
    '',
    ...wrap(
      'Run it inside a clone: it reads the host, repository and ref from the remote, fetches on every push, and says when what arrived collides with your uncommitted work. --once blocks until the next push; npx works too.',
    ),
    '',
    ...wrap(
      `It holds one socket, ${websocket(origin)}${EVENTS_PATH}, opened outbound so a sandbox needs no address. The wire format, the four lines that speak it directly, and the collision check are at ${origin}/llms.txt.`,
    ),
    '',
  ]
}

/** The same origin the example pushes to, as the scheme a socket dials. */
function websocket(origin: string): string {
  return origin.replace(/^http/, 'ws')
}

function describeHours(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`
  return `${hours} hour${hours === 1 ? '' : 's'}`
}

/** Hard-wrapped, so the text reads the same in a terminal as in a context window. */
function wrap(text: string, width = 78): string[] {
  const indent = text.startsWith('- ') ? '  ' : ''
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word
    if (candidate.length > width && line) {
      out.push(line)
      line = indent + word
    } else {
      line = candidate
    }
  }
  if (line) out.push(line)
  return out
}
