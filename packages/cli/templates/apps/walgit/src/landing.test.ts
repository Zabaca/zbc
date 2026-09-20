/**
 * The landing page is answered at the edge, because a link on an aggregator
 * points at `/` and none of that traffic should reach the one container serving
 * git. Rendering it is pure, so the module lives in `shared/` and is tested
 * here with the rest of the suite rather than behind a Workers runtime — the
 * same arrangement as `telemetry.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'

import { capabilitiesFrom, type CapabilityEnv } from '../shared/capabilities'
import { ZERO_OID } from '../shared/protocol'
import { renderLanding, wantsLanding } from '../shared/landing'
import { operatorFrom, type OperatorEnv } from '../shared/operator'
import { PROPOSALS_PREFIX, SIGNERS_TARGET } from './proposals'
import { checkSignerAllowed } from './signers'

const HOST = 'agentgit.zabaca.com'

/**
 * Fixtures are ENVIRONMENTS read through `capabilitiesFrom`, never
 * `Capabilities` literals: two of the booleans are two readings of one flag, so
 * a literal can spell a deployment that cannot exist — a name that can be
 * claimed on a host where nothing can sign — and this page's whole job is to
 * describe deployments that do.
 */
const caps = (env: CapabilityEnv) => capabilitiesFrom(env)
const EVENTS: CapabilityEnv = {
  WALGIT_EVENTS_URL: `https://${HOST}`,
  WALGIT_EVENTS_TOKEN: 'events',
}
const SEED: CapabilityEnv = { WALGIT_PUSH_CERT_SEED: 'nonce-seed' }
const GATE: CapabilityEnv = { WALGIT_SIGNER_LISTS: '1' }
const PUBLIC: CapabilityEnv = { WALGIT_PUBLIC: '1' }
const APPEND: CapabilityEnv = { WALGIT_APPEND_ONLY: '1' }
/** The two flags agentgit runs on, and the shape most of this file assumes. */
const OPEN: CapabilityEnv = { ...PUBLIC, ...APPEND }

/** A deployment that enforces and offers nothing. */
const NOTHING = caps({})

describe('wantsLanding', () => {
  test('a browser asking for HTML at the root gets the page', () => {
    expect(wantsLanding('GET', '/', 'text/html,application/xhtml+xml,*/*;q=0.8')).toBe(true)
    expect(wantsLanding('HEAD', '/', 'text/html')).toBe(true)
  })

  // The whole safety property of serving two things at one URL: git must never
  // be handed markup where it expects the protocol.
  test('git and curl keep the plain-text instructions', () => {
    expect(wantsLanding('GET', '/', '*/*')).toBe(false)
    expect(wantsLanding('GET', '/', '')).toBe(false)
    expect(wantsLanding('GET', '/', 'application/x-git-upload-pack-advertisement')).toBe(false)
  })

  test('only the root, and only a read', () => {
    expect(wantsLanding('GET', '/repo.git/info/refs', 'text/html')).toBe(false)
    expect(wantsLanding('POST', '/', 'text/html')).toBe(false)
    expect(wantsLanding('GET', '/_walgit/health', 'text/html')).toBe(false)
  })
})

describe('renderLanding', () => {
  /**
   * The page is the launch page, so the first screen has to answer the two
   * questions a stranger arrives with: what is this called, and what is it
   * for. It used to answer neither — the name lived in the `<title>` and the
   * footer, and the lede said "somewhere of its own to put it", which is a
   * complaint rather than a purpose.
   *
   * The two facts are the ticket's, not the copy's: agentgit is scratch
   * repositories, and it is handoffs between agents. Asserted against the
   * hero specifically, because a name in the tab title is not a name the
   * reader of the page sees.
   */
  test('the hero names agentgit, and the handoff has a section of its own', () => {
    const html = renderLanding(HOST, NOTHING)
    const hero = html.split('<div class="cta">')[0] ?? ''
    expect(hero).toContain('agentgit')
    // The handoff left the hero for a section, so it is asserted there.
    expect(hero).not.toContain('handing work to another agent')
    expect(html).toContain('<h2>Hand it to the next agent. Send the URL.</h2>')
    expect(html).toContain('git clone https://agentgit.zabaca.com/study-42.git')
    // First argument after the hero: the handoff is what the URL is FOR, and
    // it reads before the socket, which is what makes the handoff instant.
    const withEvents = renderLanding(HOST, caps({ ...EVENTS, ...SEED, ...GATE }))
    const at = (s: string) => withEvents.indexOf(s)
    expect(at('Hand it to the next agent')).toBeLessThan(at('Claim it. Only your keys push'))
    expect(at('Claim it. Only your keys push')).toBeLessThan(at('Stop asking whether main moved'))
    expect(at('Stop asking whether main moved')).toBeLessThan(
      at('Stop discovering conflicts at push time'),
    )
  })

  // "Nothing else to send" is a capability claim, and is rendered as one.
  test('the handoff promises nothing else to send only where nothing else is asked for', () => {
    expect(renderLanding(HOST, caps(OPEN))).toContain(
      'There is nothing else to send: no invite, no token',
    )
    const held = renderLanding(HOST, NOTHING)
    expect(held).not.toContain('no invite, no token')
    expect(held).toContain('the one token the host already asks every agent for')
  })

  test('every command names the host the request arrived on', () => {
    const page = renderLanding('walgit.zabaca.com', NOTHING)
    // The repository name is a field the visitor edits, so the URL in the
    // command is split around it. The host is not: it is whichever hostname
    // this request arrived on, and a page naming a different one would hand a
    // visitor a command that pushes somewhere they have never been.
    expect(page).toContain('https://walgit.zabaca.com/<span id="repo-echo">')
    expect(page).not.toContain('agentgit.zabaca.com')
  })

  /**
   * The name field.
   *
   * Creating a repository here IS naming it, so the name is the only decision
   * the front of the page asks anyone to make, and the only editable thing on
   * it. Everything below is about the command staying true to the field: what a
   * visitor copies has to be what they can see.
   */
  test('the command carries a name a visitor can change', () => {
    const page = renderLanding(HOST, NOTHING)
    expect(page).toContain('id="repo"')
    expect(page).toContain('<span id="repo-echo">my-thing</span>')
    // Rendered rather than filled in by script, so a page with no JavaScript
    // still offers a command that works.
    expect(page).toContain('value="my-thing"')
  })

  test('no placeholder survives into the page', () => {
    const page = renderLanding(
      HOST,
      caps({ WALGIT_RETENTION_HOURS: '24', WALGIT_MAX_PUSH_BYTES: String(1024 ** 2) }),
    )
    expect(page).not.toContain('{{')
  })

  // The point of rendering from the env rather than from copy: a page that
  // promised a window nothing collects would be a lie told at the top of the
  // funnel.
  test('with no retention set, the page promises no window', () => {
    const page = renderLanding(HOST, NOTHING)
    expect(page).not.toContain('24 hours')
    expect(page).not.toContain('is collected')
    expect(page).toContain('nothing here is a promise to keep your history')
  })

  /**
   * The window is fine print, not a term.
   *
   * It used to take the fourth slot in `The rules.` ahead of the size caps and
   * describe itself as "scratch space, on purpose". It is neither a feature nor
   * a purpose: it is a safeguard against spam and the cost of a repository
   * nobody pushes to again, and a claimed name is meant to outlive it. So the
   * page states it once, in the caveat under the roadmap, and never sells it.
   * The size caps and the per-client rate went the same way, for the same
   * reason: a safeguard is not a term.
   */
  test('with retention set, the window is fine print and never a term', () => {
    const page = renderLanding(
      HOST,
      caps({ WALGIT_RETENTION_HOURS: '24', WALGIT_MAX_PUSH_BYTES: String(99 * 1024 * 1024) }),
    )
    expect(page).toContain(
      'Not permanent: 24 hours from the last push, an unclaimed repository is collected.',
    )
    expect(page).not.toContain('A repository lives 24 hours')
    expect(page).not.toContain('scratch space')
    expect(page).toContain('99 MiB per push')
  })

  /**
   * The figure, without the nine digits behind it.
   *
   * `describeBytes` renders the exact count because the REFUSAL it was written
   * for is read by a client comparing a number to its own. On a page somebody
   * is deciding whether to use this host at all it is noise mid-sentence, so
   * `shortBytes` strips the parenthetical — derived from the same rendering,
   * never formatted a second time, so the page still cannot disagree with what
   * `pre-receive` prints. Asserted both ways round: the figure survives, the
   * digits do not.
   */
  test('the size caps are fine print in the caveat, not a term', () => {
    const page = renderLanding(HOST, caps({ WALGIT_MAX_PUSH_BYTES: String(99 * 1024 * 1024) }))
    expect(page).toContain('Limits: 99 MiB per push.')
    expect(page).not.toContain('103809024')
    expect(page).not.toContain('<span class="k">Bounded</span>')
  })

  test('a deployment that enforces nothing prints no limits line at all', () => {
    const page = renderLanding(HOST, NOTHING)
    expect(page).not.toContain('per push')
    expect(page).not.toContain('per repository')
    expect(page).not.toContain('Limits:')
  })
})

describe('the ref-event stream on the page', () => {
  test('with events on, the page describes the same capability', () => {
    const page = renderLanding(HOST, caps(EVENTS))
    expect(page).toContain('Stop asking whether main moved.')
    // The socket's address, in the scheme a socket dials. The frames it
    // exchanges are the manual's — a reader who is going to run the command
    // does not need to see them, and a reader who wants them wants /llms.txt.
    expect(page).toContain('wss://agentgit.zabaca.com/_walgit/events')
    expect(page).not.toContain('{{')
  })

  // The same rule the limits follow: a page describing a socket the deployment
  // does not claim would 404 whoever believed it.
  test('with events off, the page does not mention it', () => {
    const page = renderLanding(HOST, NOTHING)
    expect(page).not.toContain('_walgit/events')
    expect(page).not.toContain('WebSocket')
    expect(page).not.toContain('{{')
  })
})

/**
 * The client on the page.
 *
 * `GET /` is the whole API surface, and the answer to "how do I use this" has
 * to be on it: an agent that cannot find the client from here will poll, which
 * is the cost the stream exists to remove. One command, and what it prints.
 * Everything a reader would need next — the flags, the frames, the four lines
 * the command replaces — is a document away, and naming that document here
 * only spends space on a signpost.
 */
describe('the events section carries a runnable client', () => {
  test('with events on, the page names the published client and how to get it', () => {
    const html = renderLanding(HOST, caps(EVENTS))
    expect(html).toContain('bunx @zabaca/agentgit watch')
    // Named, not spelled out twice: what a reader on node needs from this page
    // is that their runtime is not excluded.
    expect(html).toContain('npx')
  })

  /**
   * It still sells nothing. It no longer links nowhere.
   *
   * This test asserted the opposite until now — that `/llms.txt` appeared
   * exactly once, in the `<head>`, and that no anchor a reader could click
   * existed anywhere on the page. *"The page argues; it does not index"* was
   * the rule, and the half of it that held up is the half about selling: there
   * is still no pricing, no signup, no logo wall and no flag index.
   *
   * What did not hold up is the linking. The page carried two anchors in total
   * — an in-page skip link and the operator's mailto — so `Open source` was a
   * claim with nowhere to check it and *"the full recipe is in /llms.txt"* was
   * an instruction to retype a path from memory. A reader who finished the
   * argument and wanted the source, the client or the manual was handed
   * nothing to follow, which is not restraint, it is a dead end.
   *
   * The `<head>` alternate stays and is still the one an agent's fetch tool
   * finds. The count is gone with the rule it encoded.
   */
  test('it sells nothing, and links to the three things a reader wants next', () => {
    const html = renderLanding(HOST, caps(EVENTS))
    // Unchanged: the agent-facing route to the manual, for a fetch tool that
    // sent a browser's Accept and landed on the HTML.
    expect(html).toContain(
      '<link rel="alternate" type="text/plain" href="https://agentgit.zabaca.com/llms.txt"',
    )
    // The manual, the source and the client, each reachable by clicking.
    expect(html).toContain('<a href="/llms.txt">')
    expect(html).toContain('<a href="https://github.com/Zabaca/zbc">Open source</a>')
    expect(html).toContain('https://www.npmjs.com/package/@zabaca/agentgit')
    // Still not a shop and still not an index.
    expect(html).not.toContain('SDK: ')
    expect(html).not.toContain('--json')
    expect(html).not.toContain('Pricing')
    expect(html).not.toContain('Sign up')
  })

  /**
   * The web view is an Advertised capability, so the link to it exists exactly
   * where the route does.
   *
   * A footer link to `/repos` on a deployment with `WALGIT_WEB` unset would
   * send a reader to a path the Worker does not claim and the container
   * answers 404 for — the same lie the client link is gated against one test
   * below.
   */
  test('the repository list is linked only where it is served', () => {
    expect(renderLanding(HOST, caps({ ...OPEN, WALGIT_WEB: '1' }))).toContain('<a href="/repos">')
    expect(renderLanding(HOST, caps(OPEN))).not.toContain('/repos')
    expect(renderLanding(HOST, NOTHING)).not.toContain('/repos')
  })

  /**
   * The client link is gated like every other mention of the client.
   *
   * A footer is the easiest place on a page to put an unconditional link, and
   * an unconditional link to a watcher is the one lie this file exists to
   * prevent: a deployment serving no stream would be advertising a command
   * against a socket its own Worker answers 404 for.
   */
  test('and the client link is absent wherever the client is', () => {
    const html = renderLanding(HOST, caps(OPEN))
    expect(html).not.toContain('npmjs.com')
    expect(html).not.toContain('@zabaca/agentgit')
    // The two that hold on every deployment do not leave with it.
    expect(html).toContain('<a href="/llms.txt">')
    expect(html).toContain('<a href="https://github.com/Zabaca/zbc">Open source</a>')
  })

  test('with events off, no client is shown', () => {
    const html = renderLanding(HOST, NOTHING)
    expect(html).not.toContain('_walgit/events')
    expect(html).not.toContain('@zabaca/agentgit')
  })
})

/**
 * The two sections after the claim: letting another key push, and going
 * private. Both are rendered from the flags the claim needs, and Private from
 * one more — so a deployment that cannot hold a Reader List never describes
 * one.
 */
describe('the grant and the private sections', () => {
  const HELD = caps({ ...OPEN, ...SEED, ...GATE })
  const PRIVATE = caps({ ...OPEN, ...SEED, ...GATE, WALGIT_PRIVATE_REPOS: 'private-seed' })

  test('a claimed deployment describes the grant, as a diff and not a recipe', () => {
    const html = renderLanding(HOST, HELD)
    expect(html).toContain('<h2>Let another agent push.</h2>')
    expect(html).toContain('+SHA256:kq3LmW…')
    expect(html).not.toContain('gpg.format=ssh')
    expect(html).not.toContain('agentgit accept')
    expect(html.indexOf('Claim it. Only your keys push')).toBeLessThan(
      html.indexOf('Let another agent push'),
    )
  })

  // With Proposals on, the new agent asks instead of sending a fingerprint.
  // The ref is built from the same constant the gate resolves, so the page
  // cannot advertise a target the host does not admit.
  test('with Proposals on, the new agent proposes itself and a Signer accepts', () => {
    const html = renderLanding(HOST, caps({ ...OPEN, ...SEED, ...GATE, WALGIT_PROPOSALS: '1' }))
    expect(html).toContain(`HEAD:${PROPOSALS_PREFIX}${SIGNERS_TARGET}/kq3LmW`)
    expect(html).toContain('agentgit accept kq3LmW')
    expect(html).toContain('accepted kq3LmW (5b1c09e4) onto refs/walgit/signers')
    expect(html).not.toContain('+SHA256:kq3LmW…')
  })

  test('private renders only where a Reader List can be written', () => {
    const html = renderLanding(HOST, PRIVATE)
    expect(html).toContain('<h2>Keep it to yourselves.</h2>')
    expect(html).toContain(`fatal: could not read Username for 'https://${HOST}'`)
    expect(html).toContain('Signers read without being listed')
    expect(html.indexOf('Let another agent push')).toBeLessThan(
      html.indexOf('Keep it to yourselves'),
    )
    expect(renderLanding(HOST, HELD)).not.toContain('Keep it to yourselves')
  })

  test('neither renders where nothing can be claimed', () => {
    for (const html of [renderLanding(HOST, NOTHING), renderLanding(HOST, caps(OPEN))]) {
      expect(html).not.toContain('Let another agent push')
      expect(html).not.toContain('Keep it to yourselves')
    }
  })
})

/**
 * The chapter break before the client: a rule, a kicker, a heading, one
 * paragraph, no illustration. It says "different problem" and names the
 * command, and it is gated on the socket the two sections under it need.
 */
describe('the client chapter', () => {
  test('opens the client half of the page, before the socket', () => {
    const html = renderLanding(HOST, caps(EVENTS))
    expect(html).toContain('<h2>Many agents, one branch.</h2>')
    expect(html).toContain('<code>@zabaca/agentgit</code>')
    // The command is the chapter's, so it reads before either section on it.
    expect(html.indexOf('Many agents, one branch')).toBeLessThan(html.indexOf('id="watch-cmd"'))
    expect(html.indexOf('id="watch-cmd"')).toBeLessThan(
      html.indexOf('Stop asking whether main moved'),
    )
  })

  test('and is absent wherever the socket is', () => {
    for (const html of [renderLanding(HOST, NOTHING), renderLanding(HOST, caps(OPEN))]) {
      expect(html).not.toContain('Many agents, one branch')
    }
  })
})

/**
 * The collision section, which is what the socket is for.
 *
 * Every sentence in it is a behaviour of `packages/agentgit/src/watch.ts`, and
 * the transcript is lines it prints — so the assertions are against the
 * client's actual strings, not the page's own. Gated on `events` like the
 * section above it: no socket, no event, no collision to report.
 */
describe('the collision section', () => {
  test('with events on, it shows the notice and the all-clear the client prints', () => {
    const html = renderLanding(HOST, caps(EVENTS))
    expect(html).toContain('<h2>Stop discovering conflicts at push time.</h2>')
    expect(html).toContain('COLLIDES with your work in src/index.ts')
    expect(html).toContain('no longer collides with your work')
    // Uncommitted edits count, which is the reason the check is worth having.
    expect(html).toContain('uncommitted edits included')
    // And it never merges on the agent's behalf.
    expect(html).toContain('No merge, no stash, no rebase.')
  })

  test('and is absent wherever the socket is', () => {
    for (const html of [renderLanding(HOST, NOTHING), renderLanding(HOST, caps(OPEN))]) {
      expect(html).not.toContain('Stop discovering conflicts at push time')
      expect(html).not.toContain('no longer collides')
    }
  })
})

describe('the page says a push can land on work in progress', () => {
  // Not the git incantation any more — that is the client's job and the
  // manual's. What the page owes a reader is that the question is answered at
  // all, and what the answer looks like when it is yes.
  test('with events on, the collision the client reports is shown', () => {
    const html = renderLanding(HOST, caps(EVENTS))
    expect(html).toContain('flags what collides with your uncommitted work')
    expect(html).toContain('COLLIDES with your work in')
  })

  test('with events off, it is absent with everything else', () => {
    const html = renderLanding(HOST, NOTHING)
    expect(html).not.toContain('COLLIDES')
  })
})

/**
 * Signing, which is a term rather than an argument.
 *
 * It changes nothing about how anyone uses the service — an unsigned push is
 * accepted exactly as it was — so it belongs in the list of what is true here.
 * And it follows the same rule every limit on this page follows: git refuses
 * `--signed` client-side against a host with no seed, so a page inviting
 * somebody to sign a deployment that cannot accept one would be sending them
 * to a refusal it caused.
 */
describe('the signing term', () => {
  test('with signing on, the page says what a signature buys and what it does not', () => {
    const page = renderLanding(HOST, caps(SEED))
    expect(page).toContain('records that key')
    expect(page).toContain('--signed=if-asked')
    // The line the whole design turns on. Losing it would make the page read
    // as a host that prefers signed pushes, which it is not.
    expect(page).toContain('Nothing is refused for being unsigned')
    expect(page).not.toContain('{{')
  })

  test('and stops saying it once a name can refuse an unsigned push', () => {
    // The claim list is what is TRUE here, so it cannot go on promising that
    // nothing is refused for being unsigned while `pre-receive` refuses it.
    const page = renderLanding(HOST, caps({ ...SEED, ...GATE }))
    expect(page).toContain('Signer List')
    expect(page).not.toContain('Nothing is refused for being unsigned')
    expect(page).not.toContain('{{')
  })

  test('with signing off, the page never mentions it', () => {
    const page = renderLanding(HOST, NOTHING)
    expect(page).not.toContain('--signed')
    expect(page).not.toContain('Attributed')
    expect(page).not.toContain('{{')
  })
})

/**
 * The roadmap replaced a "what it is not" section, and the difference matters:
 * the old one listed absences as settled facts, and three of the four were
 * things being built. A page that calls them absences is out of date the day
 * one lands.
 */
describe('the rules', () => {
  // Every row makes the reader do something differently: refuse a force push,
  // withhold a secret, copy the work out, sign if they want credit. Durability
  // was the one row that did not — it described the server's disks, which is
  // walgit's business and not a visitor's — so it is stated in the ADR and in
  // the README, and not here.
  test('says nothing about how the server stores anything', () => {
    const page = renderLanding(HOST, caps({ ...EVENTS, ...SEED }))
    expect(page).not.toContain('object storage')
    expect(page).not.toContain('Durable')
  })
})

/**
 * The `Public` term, which is the sentence the gate falsified.
 *
 * "Every repository is world-readable and world-writable" was true of every
 * deployment until a name could hold a Signer List, and it is the first thing
 * on this page anybody reads about write access — so it is exactly the claim
 * that must not outlive the config, like every limit beside it.
 */
describe('the Public term states what pre-receive actually refuses', () => {
  test('with Signer Lists off, it is the unconditional sentence', () => {
    const html = renderLanding(HOST, caps(OPEN))
    expect(html).toContain(
      '<b>Every repository is world-readable and world-writable.</b> Sharing is a URL',
    )
  })

  test('with them on, it stops promising a write nobody can make', () => {
    const html = renderLanding(HOST, caps({ ...OPEN, ...GATE }))
    expect(html).not.toContain('world-readable and world-writable.')
    expect(html).toContain('world-writable until its name is claimed')
    // Reads are untouched, and ADR-0012 is emphatic that none of this is a step
    // toward private repositories — so the line that says so stays.
    expect(html).toContain('Privacy is not free yet')
  })

  /**
   * `Anyone may add` is the same promise in three words, one term above. A
   * page that corrects `Public` and leaves `Append-only` alone has put two
   * answers to one question four lines apart — which is worse than the single
   * wrong answer it started with.
   */
  test('and the term above it stops making the same promise in three words', () => {
    expect(renderLanding(HOST, caps(OPEN))).toContain(
      'Anyone may add; no one may rewrite or delete.',
    )
    const held = renderLanding(HOST, caps({ ...OPEN, ...GATE }))
    expect(held).not.toContain('Anyone may add')
    expect(held).toContain('Whoever the name takes a push from may add')
    // What append-only guarantees is untouched: it is who may push that the
    // gate narrows, so the promise itself is word for word what it was.
    expect(held).toContain('<b>Nothing you push can be destroyed.</b>')
    expect(held).toContain('no one may rewrite or delete')
  })

  /**
   * Read from the flag ALONE, unlike the section and the roadmap below, which
   * are paired with `signedPushes`. Those two send a visitor off to claim a
   * name and must not do it where nothing can sign; this one only says what is
   * refused — and `pre-receive` refuses on this flag by itself, so a deployment
   * that sets it with no seed refuses EVERY push to a claimed name. Gating the
   * correction on the seed would leave that deployment making the one claim it
   * is furthest from keeping.
   */
  test('and it is corrected on the flag alone, with no nonce seed', () => {
    const html = renderLanding(HOST, caps({ ...OPEN, ...GATE }))
    expect(html).toContain('world-writable until its name is claimed')
    // Still without inviting anyone to claim anything on a host where no push
    // can be signed: the correction names no ref and no command.
    expect(html).not.toContain('refs/walgit/signers')
    expect(html).not.toContain('--signed')
  })
})

/**
 * The two terms that were prose until now.
 *
 * `Public` and `Append-only` are opt-in flags a consumer scaffolding walgit has
 * neither of until they set them, and both terms stated their capability
 * unconditionally — so a deployment running on tokens with append-only off
 * served a page, at the edge, before any auth, to anyone, asserting that every
 * repository was world-writable and that nothing pushed to it could be
 * destroyed. Neither was true of it. This is the same rule the limits have
 * always followed, finally applied to the two terms that never did.
 */
describe('the terms that state a flag are rendered from it', () => {
  test('with WALGIT_PUBLIC unset, the page promises no write to a stranger', () => {
    const html = renderLanding(HOST, caps(APPEND))
    expect(html).not.toContain('world-writable')
    expect(html).not.toContain('world-readable')
    expect(html).not.toContain('Sharing is a URL')
    expect(html).not.toContain('{{')
  })

  // Not omitted, unlike `Append-only`: access is the one thing a reader of
  // `The rules.` has to be told either way, and a list that simply drops it
  // reads as a host that asks for nothing.
  test('and states the other answer in its place', () => {
    const html = renderLanding(HOST, caps(APPEND))
    expect(html).toContain('<span class="k">Credentialed</span>')
    expect(html).toContain('<b>Reads and writes need a credential.</b>')
    // The form git actually sends it in — the same one /llms.txt and `GET /`
    // name, so the three documents describe one credential.
    expect(html).toContain('Basic-auth password or as a bearer token')
  })

  // Two words above the terms, and read before them. The hero COMMAND is
  // knowingly left alone: it needs a token placeholder no `Capabilities` field
  // can supply, and that is copy.
  test('and the hero stops saying no token is needed', () => {
    expect(renderLanding(HOST, caps(APPEND))).not.toContain('<span>No token</span>')
    expect(renderLanding(HOST, caps(OPEN))).toContain('<span>No token</span>')
  })

  // The same two claims, in the one string that is read where the page is not:
  // a search result and a link preview show this and nothing else.
  test('and the meta description, which travels further than the page', () => {
    expect(renderLanding(HOST, caps(APPEND))).toContain(
      '<meta name="description" content="A git host for AI agents. No account, no key: push to a name and the repository exists.">',
    )
    expect(renderLanding(HOST, caps(OPEN))).toContain(
      '<meta name="description" content="A public git host for AI agents. No account, no token, no key: push to a name and the repository exists.">',
    )
  })

  // Every configuration that renders MORE of the page, not just the smallest
  // one: the promise was in three places, and the ownership section — which
  // needs the gate and a seed to render at all — is the one a fixture of
  // `PUBLIC` alone never reaches.
  test('with WALGIT_APPEND_ONLY unset, nothing on the page says a push is safe', () => {
    for (const env of [
      PUBLIC,
      { ...PUBLIC, ...GATE, ...SEED },
      { ...PUBLIC, ...GATE, ...EVENTS },
    ]) {
      const html = renderLanding(HOST, caps(env))
      expect(html).not.toContain('Nothing you push can be destroyed')
      expect(html).not.toContain('no one may rewrite or delete')
      expect(html).not.toContain('Append-only')
      expect(html).not.toContain('cannot take anything away')
      expect(html).not.toContain('{{')
    }
  })

  /**
   * The ownership section argued from append-only in its opening paragraph —
   * the same promise in a third place, two sections above the term. Without
   * the flag the case for holding a name is not weaker but different, and
   * plainly worse: a stranger can move `main` or delete a ref.
   */
  test('and the section that argues for a name argues the right cost', () => {
    const held = renderLanding(HOST, caps({ ...PUBLIC, ...GATE, ...SEED }))
    expect(held).toContain('Claim it. Only your keys push')
    expect(held).not.toContain('Append-only defends their write')
    expect(held).not.toContain('neither of you can ever remove it')
    expect(held).toContain('<em>whoever pushes last wins</em>')

    // With the flag it is word for word the paragraph that shipped.
    expect(renderLanding(HOST, caps({ ...OPEN, ...GATE, ...SEED }))).toContain(
      "An unclaimed name takes anyone's push, and append-only keeps it forever — a stranger's branch in your agent's repository is <em>there for good</em>. Claim the name and that stops.",
    )
  })

  // The term LEAVES rather than stating the opposite, like every unenforced
  // limit: "refs can be rewritten" is what every git host does and is not a
  // rule of this one.
  test('and the term leaves rather than being replaced', () => {
    const html = renderLanding(HOST, caps(PUBLIC))
    expect(html).not.toContain('<span class="k">Append-only</span>')
    expect(html).toContain('<span class="k">Public</span>')
  })

  // The roadmap makes the same promise seven words into the Pull requests row,
  // so gating only the term would have moved the false sentence one section
  // down rather than removing it. What is MISSING there is the same either way.
  test('and the roadmap stops leaning on it too', () => {
    const off = renderLanding(HOST, caps(PUBLIC))
    expect(off).not.toContain('Append-only already makes a proposal safe to push')
    expect(off).toContain('A branch is already the whole of a proposal.')
    expect(off).toContain('a way to say it landed — not a review UI')

    expect(renderLanding(HOST, caps(OPEN))).toContain(
      'Append-only already makes a proposal safe to push.',
    )
  })

  // Both terms already varied on `namesCanRefuse` (PR #106). The outer gate is
  // what is new, so the two-way split has to survive it word for word.
  test('the Signer List wording is untouched by the outer gate', () => {
    const open = renderLanding(HOST, caps(OPEN))
    expect(open).toContain('<b>Every repository is world-readable and world-writable.</b>')
    expect(open).toContain('Anyone may add; no one may rewrite or delete.')

    const held = renderLanding(HOST, caps({ ...OPEN, ...GATE }))
    expect(held).toContain(
      '<b>Every repository is world-readable, and world-writable until its name is claimed.</b>',
    )
    expect(held).toContain('Whoever the name takes a push from may add; no one may rewrite')
  })

  /**
   * Every term but `Public` can be absent, and the list is drawn as rows
   * separated by borders — so a placeholder that renders nothing leaves a rule
   * with no row under it. All four corners of the two flags, plus the two that
   * empty the rest of the list, have to come out as a run of real `<li>`s.
   */
  test('no corner of the two flags leaves an empty or dangling term', () => {
    for (const env of [
      {},
      PUBLIC,
      APPEND,
      OPEN,
      { ...OPEN, ...GATE, ...SEED },
      { WALGIT_RETENTION_HOURS: '24' },
    ] satisfies CapabilityEnv[]) {
      const html = renderLanding(HOST, caps(env))
      const list = html.slice(
        html.indexOf('<ul class="claims">'),
        html.indexOf('</ul>', html.indexOf('<ul class="claims">')),
      )
      expect(list).not.toContain('<li></li>')
      // The rows are one per line, so a blank line inside the list IS the
      // dangling rule: nothing separates the terms but their own newlines.
      // First line is the `<ul>`, last is the indent before the `</ul>`.
      const rows = list.split('\n').slice(1, -1)
      expect(rows.every((row) => row.trim().startsWith('<li>'))).toBe(true)
      expect(rows.length).toBeGreaterThan(0)
      expect(html).not.toContain('{{')
    }
  })

  /**
   * agentgit sets both flags (`walgit-public.ts`), so the deployment this page
   * was written for must read exactly as it did — this change is only about the
   * deployments that set neither. The whole page is compared, not the two
   * terms, because the gates moved the assembly of `The rules.` as well as its
   * contents.
   *
   * `Crawlable` is the one term below that no flag gates: `/robots.txt` says
   * the same thing on every deployment, so it is listed here unconditionally
   * rather than being another reading of a capability.
   */
  test('and the deployment that sets both is byte-for-byte the page it already had', () => {
    const html = renderLanding(HOST, caps({ ...OPEN, ...GATE, ...SEED, ...EVENTS }))
    expect(html).toContain(
      `      <ul class="claims">
        <li><span class="k">Append-only</span><span class="v"><b>Nothing you push can be destroyed.</b> Whoever the name takes a push from may add; no one may rewrite or delete.</span></li>
        <li><span class="k">Public</span><span class="v"><b>Every repository is world-readable, and world-writable until its name is claimed.</b> Sharing is a URL, not an invitation. Privacy is not free yet.</span></li>
        <li><span class="k">Attributed</span><span class="v"><b>A push signed with your key records that key's fingerprint.</b> Unsigned is fine unless a name has written a Signer List. The fingerprint is the whole identity. <code>git push --signed=if-asked</code>.</span></li>
        <li><span class="k">Crawlable</span><span class="v"><b><code>/robots.txt</code> says yes, out loud.</b> <code>Allow: /</code> for every agent, and <code>Content-Signal: search=yes, ai-input=yes, ai-train=yes</code> — told so in the one file it checks.</span></li>
      </ul>`,
    )
  })
})

/**
 * Ownership, argued as a section rather than stated as a term.
 *
 * It is the second argument on this page for the same reason the events section
 * is the first: the two commands in the hero already show that there was no
 * signup, and neither shows what append-only costs. `Nothing you push can be
 * destroyed` is met in `The rules.` as a protection; this is the half of it
 * that is a bill — a stranger's branch in your name is as permanent as yours —
 * and the answer to it.
 */
describe('the section that argues for holding a name', () => {
  // Append-only included, because the section's opening paragraph is the cost
  // append-only creates and now renders from it — this fixture is agentgit's
  // real shape, and the flag-off wording has its own case above.
  const HELD = caps({ ...OPEN, ...SEED, ...GATE })

  test('it makes the case append-only creates, then answers it', () => {
    const html = renderLanding(HOST, HELD)
    expect(html).toContain('<h2>Claim it. Only your keys push.</h2>')
    const flat = html.replace(/\s+/g, ' ')
    // The cost, which is the argument. Without it the section is a feature
    // announcement, and a reader has no reason to spend a push on one.
    expect(flat).toContain('is <em>there for good</em>')
    expect(flat).toContain('Claiming one takes a single push.')
    // The two things a visitor must have before they act: where the list goes,
    // and the one piece of advice with no way back if it is ignored.
    expect(html).toContain('<code>refs/walgit/signers</code>')
    expect(flat).toContain('List two keys')
    // It renders before `The rules.`, beside the events argument rather than
    // after the summary of it, so the terms below read as what both settle.
    expect(html.indexOf('Claim it. Only your keys push')).toBeLessThan(
      html.indexOf('<h2>The rules.</h2>'),
    )
  })

  /**
   * The panel is checked against the HOOK, not against itself.
   *
   * The obvious version of this test — assert the page contains the three
   * sentences the page was written with — is tautological: it passes however
   * far `heldMessage` drifts, which is the one thing it exists to catch. So it
   * runs the real gate and asserts the page's transcript is a subset of what
   * `pre-receive` actually writes. A page and a hook describing two different
   * refusals is worse than a wrong cap here, because the refusal is the only
   * documentation the agent hitting it has.
   *
   * Compared with whitespace flattened, deliberately: the hook wraps for a
   * terminal and the panel wraps for a 52-column box, and re-wrapping the same
   * sentence is not drift.
   */
  test('every line of the transcript is one the hook actually writes', () => {
    // The exact push the panel depicts: unsigned, on a host that advertises
    // signing, into a name that holds a list naming somebody else.
    const verdict = checkSignerAllowed(
      'study-42',
      { kind: 'unsigned', signable: true },
      ['SHA256:BMBEMXbMBsnjXwgNs+86IiJrPgYlZEsWxaKZW/2/1dw'],
      [{ ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: 'a'.repeat(40) }],
    )
    expect(verdict.ok).toBe(false)
    const refusal = (verdict as { message: string }).message.replace(/\s+/g, ' ')

    const page = renderLanding(HOST, HELD)
    const start = page.indexOf(
      '<pre class="tx"><span class="ln"><span class="p">$</span> git push agentgit',
    )
    expect(start).toBeGreaterThan(-1)
    const markup = page.slice(start, page.indexOf('</pre>', start))
    // The panel's own text, as a reader sees it: tags out, entities back, one
    // line. The hook wraps for a terminal and this wraps for a 52-column box,
    // and re-wrapping the same sentence is not drift.
    const shown = markup
      .replace(/<[^>]*>/g, '')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&')
      .replace(/\s+/g, ' ')

    for (const line of [
      'walgit: refused — study-42 is held by a Signer List.',
      'Your push carries no signature, so walgit cannot tell whose it is. A name that holds a Signer List takes signed pushes only:',
      'git push --signed=yes origin HEAD:refs/heads/<branch>',
      'Nothing was uploaded; the repository is unchanged.',
    ]) {
      expect(shown).toContain(line)
      expect(refusal).toContain(line)
    }

    // It is an EXCERPT — the remedy block is long and the prose beside the
    // panel has already given it — so it carries an elision mark rather than
    // reading as the whole message, and the foot says what was cut.
    expect(shown).toContain('…')
    expect(page).toContain('names a free name to use instead, and how to be added to this one')
  })

  /**
   * No recipe on the page, and no PART of one.
   *
   * Every abbreviation of the six commands hands a reader a command that fails,
   * and the `gpg.format` one locks them out of the name they just claimed. The
   * only safe short form is none: the section names where the list goes and
   * leaves the commands to the manual, which the page links twice.
   */
  test('the recipe is in the manual, and no fragment of it is on the page', () => {
    const html = renderLanding(HOST, HELD)
    expect(html).toContain('<code>refs/walgit/signers</code>')
    for (const line of ['git init -q claim', 'git add signers', 'gpg.format=ssh', '$NAME.git']) {
      expect(html).not.toContain(line)
    }
    expect(html).not.toContain('<details')
    expect(html).toContain('<a href="/llms.txt">/llms.txt</a>')
  })

  test('with Signer Lists off, the whole section is absent', () => {
    const html = renderLanding(HOST, caps(SEED))
    expect(html).not.toContain('Claim it. Only your keys push')
    expect(html).not.toContain('refs/walgit/signers')
    expect(html).not.toContain('{{')
  })

  // The flag without a nonce seed is a misconfiguration in which nothing can
  // sign, so a section telling a visitor to claim a name would be sending them
  // to claim it with an unsigned push — after which every push to it, theirs
  // included, is refused for carrying no certificate.
  test('and the flag alone does not earn it: with no seed, there is no section', () => {
    const html = renderLanding(HOST, caps(GATE))
    expect(html).not.toContain('Claim it. Only your keys push')
    expect(html).not.toContain('{{')
  })
})

describe('the roadmap', () => {
  test('names what is missing, in every deployment', () => {
    const html = renderLanding(HOST, caps(EVENTS))
    for (const row of ['Ownership', 'Private', 'Pull requests']) {
      expect(html).toContain(row)
    }
    // CI is a runner — logs, status, compute — which is a different product,
    // not the next feature of this one. It was the row that never left.
    expect(html).not.toContain('<h3>CI</h3>')
  })

  // The one promise on the page that is not rendered from config, so it is the
  // one that has to say it is not a promise.
  test('promises no date', () => {
    expect(renderLanding(HOST, NOTHING)).toContain('Nothing here is a date')
    expect(renderLanding(HOST, caps({ ...SEED, ...GATE }))).toContain('Nothing here is a date')
  })

  /**
   * The section has to survive its rows leaving — all of them.
   *
   * Rows LEAVE as a deployment ships them. On the one that has shipped the most
   * (Signer Lists, Reader Lists and Proposals all on — agentgit) nothing is
   * left, and a heading over an empty list would read as a roadmap that ran
   * out. So the section is absent there, and the fine print that used to
   * close it stands on its own, on every deployment.
   */
  test('the section leaves with its last row, and the fine print stays', () => {
    const shipped = caps({
      ...OPEN,
      ...SEED,
      ...GATE,
      WALGIT_PRIVATE_REPOS: 'read-seed',
      WALGIT_PROPOSALS: '1',
      WALGIT_RETENTION_HOURS: '72',
    })
    const html = renderLanding(HOST, shipped)
    expect(html.split('<h3>').length - 1).toBe(0)
    expect(html).not.toContain("<h2>What's next.</h2>")
    expect(html).not.toContain('Nothing here is a date')
    expect(html).toContain('<p class="caveat fine">Not permanent: 72 hours from the last push')
  })

  // One row, so no order to describe.
  test('the lede stops promising an order once one row is left', () => {
    const html = renderLanding(
      HOST,
      caps({ ...OPEN, ...SEED, ...GATE, WALGIT_PRIVATE_REPOS: 'read-seed' }),
    )
    expect(html.split('<h3>').length - 1).toBe(1)
    expect(html).toContain('One thing is left, and nothing here is a date')
    expect(html).not.toContain('in the order it gets there')
  })

  // And keeps promising one everywhere there is still a sequence to promise.
  test('and keeps it wherever more than one row survives', () => {
    for (const env of [{}, SEED, { ...SEED, ...GATE }] satisfies CapabilityEnv[]) {
      const html = renderLanding(HOST, caps(env))
      expect(html.split('<h3>').length - 1).toBeGreaterThan(1)
      expect(html).toContain('Where this is going, in the order it gets there')
      expect(html).not.toContain('One thing is left')
    }
  })

  /**
   * The rows that describe ownership, which is now built on some deployments
   * and not on others — so they follow the same rule the limits do rather than
   * being copy. A page still calling ownership "Next" on a host where a name
   * already refuses a stranger is out of date about its own `pre-receive`.
   */
  test('with Signer Lists off, ownership is still the next thing', () => {
    const html = renderLanding(HOST, caps(SEED))
    expect(html).toContain('<span class="when">Next</span>')
    expect(html).toContain('the first key to push a name keeps it')
    expect(html).not.toContain('Shipped')
  })

  test('with them on, the Ownership row leaves rather than turning Shipped', () => {
    const html = renderLanding(HOST, caps({ ...SEED, ...GATE }))
    // This list is what is MISSING, and a section above now states ownership as
    // a rule of the host. A `Shipped` row would be the page carrying one
    // capability twice — once as a fact and once as an achievement — so the row
    // leaves entirely and the lede goes back to its plain sentence.
    expect(html).not.toContain('<span class="when">Shipped</span>')
    expect(html).not.toContain('the one thing that no longer is')
    expect(html).toContain(
      'Where this is going, in the order it gets there. Nothing here is a date',
    )
    // And it stops describing a policy nobody built: the design that shipped is
    // a list a name writes, not first-key-wins.
    expect(html).not.toContain('the first key to push a name keeps it')
    expect(html).not.toContain('<h3>Ownership</h3>')
    // Nothing else in the roadmap moved.
    for (const row of ['Private', 'Pull requests']) expect(html).toContain(row)
  })

  /**
   * Removing a row leaves an ODD number of them, and `.road` is a two-column
   * grid whose rules are its container background showing through a 1px gap —
   * so the missing fourth cell does not read as empty space, it paints a solid
   * `--rule` block beside the last card. The count is rendered from policy, so
   * both parities are ordinary and the last card spans when it is alone.
   */
  test('an odd roadmap does not leave a painted hole beside the last card', () => {
    const html = renderLanding(HOST, caps(SEED))
    expect(html.split('<h3>').length - 1).toBe(3)
    expect(html).toContain('.road li:last-child:nth-child(odd) { grid-column: 1 / -1; }')
    // With ownership built the list is two rows, and the rule is inert.
    expect(renderLanding(HOST, caps({ ...SEED, ...GATE })).split('<h3>').length - 1).toBe(2)
  })

  /**
   * The row reads the flag ALONE, like the two terms and unlike the section.
   *
   * It is a statement about whether the capability EXISTS, not an invitation to
   * use it — and on a deployment with the flag and no seed it exists and
   * refuses everyone. Reading it with the seed put two answers on one page: a
   * `Public` term saying a name can be claimed, four lines above a roadmap row
   * calling claiming a name the next thing to build.
   *
   * The section that teaches claiming still needs both, and does not render
   * here — so this state says a name can be claimed and never says how, which
   * is the correct thing to tell somebody who cannot do it.
   */
  test('the flag alone retires the row, even where nothing can sign', () => {
    const html = renderLanding(HOST, caps(GATE))
    expect(html).not.toContain('<span class="when">Next</span>')
    expect(html).not.toContain('the first key to push a name keeps it')
    expect(html).not.toContain('Shipped')
    // And still sends nobody to claim anything on a host where no push can be
    // signed: no ref, no command, no section.
    expect(html).not.toContain('refs/walgit/signers')
    expect(html).not.toContain('Claim it. Only your keys push')
  })

  /**
   * Private was written as "gated on the same fingerprint that already gets
   * recorded", which is the wrong noun: what a read would be gated on is the
   * Signer List a name holds, and ADR-0012 is explicit that holding a name is
   * not a step toward closing reads. Both halves of that are the correction.
   */
  test('and the Private row names the list, not the fingerprint', () => {
    const html = renderLanding(HOST, caps({ ...SEED, ...GATE }))
    expect(html).not.toContain('same fingerprint that already gets recorded')
    expect(html).toContain('Signer List')
    expect(html).toContain('today a claimed repository reads as openly as any other')
    // Not promised, and not made next by ownership having shipped.
    expect(html).not.toContain('<span class="when">Next</span>')
  })
})

/**
 * Private, which is a roadmap row on most deployments and a rule on one
 * (docs/adr/0013).
 *
 * The row has promised "after ownership" since ownership was designed, and
 * ADR-0013 spends it. What makes this worth rendering rather than rewriting is
 * the same thing that made ownership worth it: the mechanism ships in the app
 * template OFF, so on every deployment but the one that sets the seed the
 * roadmap row is still the true sentence, and a page that stated the rule
 * everywhere would be promising a gate its own container does not run.
 */
describe('Private moves from the roadmap to the rules', () => {
  const PRIVATE: CapabilityEnv = { WALGIT_PRIVATE_REPOS: 'read-seed' }
  const CLOSED = caps({ ...OPEN, ...SEED, ...GATE, ...PRIVATE })

  test('it is a term in The rules., beside Append-only and Public', () => {
    const html = renderLanding(HOST, CLOSED)
    expect(html).toContain('<span class="k">Private</span>')
    // The two it stands beside, so the list is the three rules together.
    expect(html).toContain('<span class="k">Append-only</span>')
    expect(html).toContain('<span class="k">Public</span>')
    // And it names the file, not a setting: presence is the whole switch.
    expect(html).toContain('Reader List')
  })

  test('and leaves the roadmap, which no longer calls it missing', () => {
    const html = renderLanding(HOST, CLOSED)
    expect(html).not.toContain('<h3>Private</h3>')
    expect(html).not.toContain('Reads are still gated on nothing')
    expect(html).not.toContain('holding a name is not a step toward closing it')
    // One row left — Pull requests — and the lede says so without an order.
    expect(html.split('<h3>').length - 1).toBe(1)
    expect(html).toContain('One thing is left')
  })

  // The term four lines above it said "Privacy is not free yet", which is the
  // sentence this capability makes false. Correcting one and leaving the other
  // puts two answers to one question in one list.
  test('and the Public term stops saying privacy is not free yet', () => {
    const html = renderLanding(HOST, CLOSED)
    expect(html).not.toContain('Privacy is not free yet')
    expect(html).toContain('world-writable until its name is claimed')
    // Still true everywhere the seed is unset.
    expect(renderLanding(HOST, caps({ ...OPEN, ...SEED, ...GATE }))).toContain(
      'Privacy is not free yet',
    )
  })

  test('with no seed the row keeps the words it has today', () => {
    const html = renderLanding(HOST, caps({ ...OPEN, ...SEED, ...GATE }))
    expect(html).toContain('<h3>Private</h3>')
    expect(html).toContain('today a claimed repository reads as openly as any other')
    expect(html).not.toContain('<span class="k">Private</span>')
  })

  // A Reader List lives in the Signer List's tree, so the seed alone gates
  // nothing — `namesCanBePrivate` is the field that encodes it, and the page
  // must not state a rule the container would not enforce.
  test('and the seed alone does not make it a rule', () => {
    for (const env of [
      { ...OPEN, ...PRIVATE },
      { ...OPEN, ...GATE, ...PRIVATE },
    ]) {
      const html = renderLanding(HOST, caps(env))
      expect(html).not.toContain('<span class="k">Private</span>')
      expect(html).toContain('<h3>Private</h3>')
    }
  })

  /**
   * Nor does a deployment that asks for a token at the front door.
   *
   * `The rules.` would otherwise carry two adjacent terms answering one
   * question in opposite directions — `Credentialed` saying there is no
   * per-repository privacy and one credential reads every name, and `Private`
   * saying a name can refuse a reader with no account and no token. The second
   * is the false one there: a Read Challenge is Basic auth in the header the
   * deployment token occupies, so nobody can present one.
   */
  test('and a credentialed deployment keeps the term that is true there', () => {
    const html = renderLanding(HOST, caps({ ...SEED, ...GATE, ...PRIVATE }))
    expect(html).toContain('<span class="k">Credentialed</span>')
    expect(html).toContain('no per-repository privacy')
    expect(html).not.toContain('<span class="k">Private</span>')
    // And the roadmap row stays, because it is still what is missing there.
    expect(html).toContain('<h3>Private</h3>')
  })
})

/**
 * Proposals, which is a roadmap row on most deployments and a rule on one
 * (docs/adr/0018).
 *
 * The same rule Ownership and Private follow, one row further down: the page
 * may not carry a capability twice, once as a fact and once as an achievement.
 * `Pull requests` has said "under design" since the page was written, and this
 * is where that row is spent.
 */
describe('Proposals move from the roadmap to the rules', () => {
  const PROPOSALS: CapabilityEnv = { WALGIT_PROPOSALS: '1' }
  const OPEN_PROPOSALS = caps({ ...OPEN, ...SEED, ...GATE, ...PROPOSALS })

  test('it is a term in The rules., and names the namespace', () => {
    const html = renderLanding(HOST, OPEN_PROPOSALS)
    expect(html).toContain('<span class="k">Proposals</span>')
    expect(html).toContain('refs/walgit/proposals/')
  })

  test('and leaves the roadmap, which no longer calls it under design', () => {
    const html = renderLanding(HOST, OPEN_PROPOSALS)
    expect(html).not.toContain('<h3>Pull requests</h3>')
  })

  test('with the flag off the row keeps the words it has today', () => {
    const html = renderLanding(HOST, caps({ ...OPEN, ...SEED, ...GATE }))
    expect(html).toContain('<h3>Pull requests</h3>')
    expect(html).not.toContain('<span class="k">Proposals</span>')
  })

  // The flag alone advertises a handoff no push could make: a Proposal is a
  // SIGNED push to a name that holds a Signer List.
  test('and neither the flag alone nor an ungated deployment makes it a rule', () => {
    for (const env of [
      { ...OPEN, ...PROPOSALS },
      { ...OPEN, ...GATE, ...PROPOSALS },
    ]) {
      const html = renderLanding(HOST, caps(env))
      expect(html).not.toContain('<span class="k">Proposals</span>')
      expect(html).toContain('<h3>Pull requests</h3>')
    }
  })
})

/**
 * Who runs this, and what happens to what you push.
 *
 * The page is the launch page, and the first question an aggregator asks in
 * the first ten minutes is who to send a takedown to. It is the one thing on
 * the page that cannot be derived from a capability flag — a deployment's
 * operator is not a capability, it is who is answerable for one — so it comes
 * from its own two variables, read through `operatorFrom`.
 *
 * The expiry promise stands in the same block deliberately: the honest answer
 * to "take this down" on a deployment that collects is usually "it already
 * will", and the two facts are read together or not at all.
 */
describe('who runs this', () => {
  const RUN: OperatorEnv = {
    WALGIT_OPERATOR: 'Zabaca',
    WALGIT_CONTACT: 'abuse@zabaca.com',
  }
  const COLLECTS = caps({ ...OPEN, WALGIT_RETENTION_HOURS: '24' })

  test('the operator, the contact and the window are one block', () => {
    const html = renderLanding(HOST, COLLECTS, operatorFrom(RUN))
    const block = html.split('<h2>Who runs this.</h2>')[1]?.split('</section>')[0] ?? ''
    expect(block).toContain('Zabaca')
    expect(block).toContain('abuse@zabaca.com')
    expect(block).toContain('24 hours')
  })

  test('the contact is reachable, not merely printed', () => {
    const html = renderLanding(HOST, COLLECTS, operatorFrom(RUN))
    expect(html).toContain('href="mailto:abuse@zabaca.com"')
  })

  // Every claim on this page is rendered rather than written, and a contact
  // address is the one where a placeholder would be actively harmful: mail to
  // a name nobody reads is worse than an admission that there is nobody to
  // write to.
  test('a deployment that names nobody carries no block at all', () => {
    const html = renderLanding(HOST, COLLECTS, operatorFrom({}))
    expect(html).not.toContain('Who runs this.')
    expect(html).not.toContain('{{')
  })

  test('an operator with no address says who, and offers no way to write', () => {
    const html = renderLanding(HOST, COLLECTS, operatorFrom({ WALGIT_OPERATOR: 'Zabaca' }))
    expect(html).toContain('Who runs this.')
    expect(html).toContain('Zabaca')
    expect(html).not.toContain('mailto:')
  })

  // The same rule the window follows everywhere else on this page: a
  // deployment that collects nothing must not promise that anything expires.
  test('with no retention the block states no window', () => {
    const html = renderLanding(HOST, caps(OPEN), operatorFrom(RUN))
    const block = html.split('<h2>Who runs this.</h2>')[1]?.split('</section>')[0] ?? ''
    expect(block).toContain('abuse@zabaca.com')
    expect(block).not.toContain('24 hours')
  })

  // The values are operator-supplied and land in markup.
  test('a contact carrying markup is escaped', () => {
    const html = renderLanding(
      HOST,
      COLLECTS,
      operatorFrom({ WALGIT_OPERATOR: '<script>x</script>' }),
    )
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
  })
})

/**
 * The three things this deployment can do this week, on the page that is the
 * launch page — and the same three absent from a deployment that offers none
 * of them. Each is already rendered from `Capabilities`; what this asserts is
 * the pair, because a claim that appears is only honest if the same claim
 * disappears.
 */
describe('Proposals, Private and the Client are advertised together', () => {
  const EVERYTHING = caps({
    ...OPEN,
    ...SEED,
    ...GATE,
    ...EVENTS,
    WALGIT_PRIVATE_REPOS: 'private-seed',
    WALGIT_PROPOSALS: '1',
  })

  test('a deployment that advertises all three says so', () => {
    const html = renderLanding(HOST, EVERYTHING)
    expect(html).toContain('<span class="k">Proposals</span>')
    expect(html).toContain('<span class="k">Private</span>')
    expect(html).toContain('bunx @zabaca/agentgit watch')
  })

  test('a deployment that advertises none of them stays silent about each', () => {
    const html = renderLanding(HOST, caps(OPEN))
    expect(html).not.toContain('<span class="k">Proposals</span>')
    expect(html).not.toContain('<span class="k">Private</span>')
    expect(html).not.toContain('@zabaca/agentgit')
  })
})

/**
 * The card, which is the page as an aggregator renders it.
 *
 * The placement of this whole document is justified by aggregator traffic, and
 * it had no card — so the one sentence written to travel further than the page
 * travelled nowhere, and a link posted anywhere rendered as a bare hostname.
 */
describe('the link preview', () => {
  test('the card carries the title and the sentence written to travel', () => {
    const html = renderLanding(HOST, caps(OPEN))
    expect(html).toContain('<meta property="og:type" content="website">')
    expect(html).toContain('<meta property="og:title" content="agentgit — Git for AI agents">')
    expect(html).toContain('<meta property="og:url" content="https://agentgit.zabaca.com/">')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    // The favicon is inline SVG: no route to shadow a repository, no asset to
    // fetch. Its three fills are the page's own palette.
    expect(html).toMatch(
      /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,[^"]*%23c56a3e[^"]*">/,
    )
  })

  /**
   * One rendering, three places. The description is the claim this page cannot
   * let outlive the config — it names two capability flags — and a card that
   * quoted a stale copy of it would put the lie where it travels furthest and
   * where nobody checking the page would ever see it.
   */
  test('and the card says exactly what the description says, on either deployment', () => {
    for (const env of [OPEN, APPEND] satisfies CapabilityEnv[]) {
      const html = renderLanding(HOST, caps(env))
      const described = /<meta name="description" content="([^"]+)">/.exec(html)?.[1]
      expect(described).toBeTruthy()
      expect(html).toContain(`<meta property="og:description" content="${described}">`)
      expect(html).toContain(`<meta name="twitter:description" content="${described}">`)
    }
  })

  /**
   * The card now has a picture, so it claims the layout that needs one.
   *
   * The absolute URL is the point of the assertion: a crawler resolves neither
   * a relative path nor a data URI, so an `og:image` that is not a full origin
   * on this deployment's own host is an empty card that looks filled in.
   */
  test('and carries the picture, absolute, at the size it is rendered', () => {
    const html = renderLanding(HOST, caps(OPEN))
    const url = `https://${HOST}/agentgit-og.png`
    expect(html).toContain(`<meta property="og:image" content="${url}">`)
    expect(html).toContain(`<meta name="twitter:image" content="${url}">`)
    // The two numbers a large-summary card is specified at, and the two the
    // committed PNG is rendered at (`og-image.test.ts`).
    expect(html).toContain('<meta property="og:image:width" content="1200">')
    expect(html).toContain('<meta property="og:image:height" content="630">')
    expect(html).toContain('<meta property="og:image:alt" content="agentgit — Git for AI agents">')
  })
})

/**
 * The mark on the page itself.
 *
 * It shipped as a favicon — sixteen pixels on a tab strip — and the page the
 * tab belongs to wore nothing. The masthead badge is where the name is said
 * first, so the mark is said with it, from the SAME geometry the favicon is
 * drawn from: two copies of a logo drift, and the one nobody looks at drifts
 * first.
 */
describe('the masthead wears the mark', () => {
  test('inline beside the wordmark, in the page’s own palette', () => {
    const html = renderLanding(HOST, caps(OPEN))
    const badge = /<span class="badge">([\s\S]*?)<\/span>\s*\n/.exec(html)?.[1]
    expect(badge).toBeTruthy()
    // Inline SVG, not a fetch: the mark must be there on the first paint, and
    // a second request for 400 bytes is not worth the round trip.
    expect(badge).toContain('<svg')
    // The copper agent node — the one fill that is only in this mark.
    expect(badge).toContain('#c56a3e')
    expect(badge).toContain('agentgit')
    // Decorative: the wordmark beside it already says the name, so a screen
    // reader that announced the mark too would say it twice.
    expect(badge).toContain('aria-hidden="true"')
  })

  /**
   * The page's copy of the mark against the source file the card is rendered
   * from. Without this the geometry lives in two files — `assets/
   * agentgit-mark.svg` and `MARK_GEOMETRY` — and only one of them is looked at
   * when the mark is redrawn, so the tab, the masthead and the link preview
   * can quietly stop being the same logo.
   */
  test('and is exactly the source mark, not a transcription of it', async () => {
    const svg = await Bun.file(
      path.join(import.meta.dir, '..', 'assets', 'agentgit-mark.svg'),
    ).text()
    const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg.trim())?.[1]
    expect(inner).toBeTruthy()
    expect(renderLanding(HOST, caps(OPEN))).toContain(inner as string)
  })

  test('and is the same geometry the favicon is drawn from', () => {
    const html = renderLanding(HOST, caps(OPEN))
    // The agent node, at the coordinates the source mark
    // (`assets/agentgit-mark.svg`) places it on its 32-unit grid.
    const node = '<rect fill="#c56a3e" x="17.5" y="18.5" width="11" height="11" rx="2"/>'
    expect(html).toContain(node)
    expect(html).toContain(encodeURIComponent(node))
  })
})

/**
 * The objection is the hero now.
 *
 * "You have GitHub. Your agent does not." was a section of its own — a heading
 * and a paragraph on the cost of an account, a scoped token and somewhere to
 * keep it. As the lede it is two sentences: the objection, then the promise,
 * and the cost is left to the reader who already knows it. The section leaves
 * with it, so the same argument is not made twice three inches apart.
 */
describe('the GitHub objection', () => {
  test('is the hero, and no longer a section', () => {
    const html = renderLanding(HOST, caps(OPEN))
    const hero = html.split('<div class="cta">')[0] ?? ''
    expect(hero).toContain(
      'You have GitHub.<br>Your agent does not.<br><em>Push to a name and the repository exists.</em>',
    )
    expect(html).not.toContain('<h2>You have GitHub. Your agent does not.</h2>')
    expect(html).not.toContain('three things a sandbox starts without')
    expect(html).not.toContain('no per-agent identity to provision')
  })
})

/**
 * The last block on the page, which used to be a takedown address.
 *
 * The page's whole asset is two commands that work, and they appeared once,
 * above the fold, and never again — so a reader who read the argument to its
 * end was returned nothing to do.
 */
describe('the closing call to action', () => {
  test('the page ends on the command rather than on the abuse contact', () => {
    const html = renderLanding(HOST, caps(OPEN), operatorFrom({ WALGIT_CONTACT: 'a@b.com' }))
    expect(html).toContain('<h2>Push something.</h2>')
    expect(html.indexOf('Push something.')).toBeGreaterThan(html.indexOf('Who runs this.'))
    expect(html.indexOf('Push something.')).toBeLessThan(html.indexOf('</main>'))
  })

  /**
   * The hero's command, not a second copy of it. One field feeds both echoes,
   * so the page can never show two different names — the same reason the copy
   * buttons read their text out of the block beside them.
   */
  test('it repeats the hero command, fed by the same name field', () => {
    const html = renderLanding('walgit.zabaca.com', caps(OPEN))
    expect(html).toContain(
      'git remote add agentgit https://walgit.zabaca.com/<span id="repo-echo-end">my-thing</span>.git',
    )
    expect(html).toContain('id="copy-end"')
    expect(html).toContain('copy(document.getElementById("copy-end"));')
    // Both echoes are driven, so neither can go stale against the field.
    expect(html).toContain('document.getElementById("repo-echo-end")')
  })

  test('and points at the manual, with the client only where there is one', () => {
    expect(renderLanding(HOST, caps({ ...OPEN, ...EVENTS }))).toContain(
      'keep a clone current with <a href="https://www.npmjs.com/package/@zabaca/agentgit">',
    )
    const quiet = renderLanding(HOST, caps(OPEN))
    expect(quiet).toContain('The whole manual is <a href="/llms.txt">/llms.txt</a>')
    expect(quiet).not.toContain('keep a clone current')
  })
})

/**
 * Per-source limits, stated for the same reason every other limit on this page
 * is: a visitor about to push should not learn the rule from the refusal.
 */
describe('renderLanding: per-source limits', () => {
  test('says nothing at all when the deployment bounds nothing per source', () => {
    const page = renderLanding(HOST, caps(OPEN))
    expect(page).not.toContain('per client')
  })

  test('names the counts and the window when they are on', () => {
    const page = renderLanding(
      HOST,
      caps({
        ...OPEN,
        WALGIT_MAX_NEW_REPOS_PER_SOURCE: '20',
        WALGIT_MAX_PUSHES_PER_SOURCE: '300',
        WALGIT_RATE_WINDOW_SECONDS: '3600',
      }),
    )
    expect(page).toContain('20 new repositories')
    expect(page).toContain('300 pushes')
    expect(page).toContain('per client per hour')
    expect(page).not.toContain('<span class="k">Throughput</span>')
  })

  test('states only the limits that are set', () => {
    const page = renderLanding(HOST, caps({ ...OPEN, WALGIT_MAX_PUSHES_PER_SOURCE: '300' }))
    expect(page).toContain('300 pushes')
    expect(page).not.toContain('new repositories')
  })
})
