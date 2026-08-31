/**
 * The landing page is answered at the edge, because a link on an aggregator
 * points at `/` and none of that traffic should reach the one container serving
 * git. Rendering it is pure, so the module lives in `shared/` and is tested
 * here with the rest of the suite rather than behind a Workers runtime — the
 * same arrangement as `telemetry.test.ts`.
 */

import { describe, expect, test } from 'bun:test'

import { ZERO_OID } from '../shared/protocol'
import { renderLanding, wantsLanding } from '../shared/landing'
import { checkSignerAllowed } from './signers'

const FACTS = {
  host: 'agentgit.zabaca.com',
  retentionHours: null,
  maxPushBytes: null,
  maxRepoBytes: null,
  events: false,
  signedPushes: false,
  signerLists: false,
}

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
  test('every command names the host the request arrived on', () => {
    const page = renderLanding({ ...FACTS, host: 'walgit.zabaca.com' })
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
    const page = renderLanding(FACTS)
    expect(page).toContain('id="repo"')
    expect(page).toContain('<span id="repo-echo">my-thing</span>')
    // Rendered rather than filled in by script, so a page with no JavaScript
    // still offers a command that works.
    expect(page).toContain('value="my-thing"')
  })

  test('no placeholder survives into the page', () => {
    const page = renderLanding({ ...FACTS, retentionHours: 24, maxPushBytes: 1024 ** 2 })
    expect(page).not.toContain('{{')
  })

  // The point of rendering from the env rather than from copy: a page that
  // promised a window nothing collects would be a lie told at the top of the
  // funnel.
  test('with no retention set, the page promises no window', () => {
    const page = renderLanding(FACTS)
    expect(page).not.toContain('24 hours')
    expect(page).not.toContain('is collected')
    expect(page).toContain('nothing about this service is a promise to keep your history')
  })

  test('with retention set, the window is stated twice and agrees with itself', () => {
    const page = renderLanding({ ...FACTS, retentionHours: 24 })
    expect(page).toContain('A repository lives 24 hours from its last push.')
    expect(page).toContain('Not permanent: 24 hours from the last push, a repository is collected.')
  })

  test('with no retention but caps set, the third claim becomes the caps', () => {
    const page = renderLanding({ ...FACTS, maxPushBytes: 99 * 1024 * 1024 })
    expect(page).toContain('99 MiB (103809024 bytes) per push')
  })

  test('a deployment that enforces nothing makes no third claim at all', () => {
    const page = renderLanding(FACTS)
    expect(page).not.toContain('per push')
    expect(page).not.toContain('per repository')
  })
})

describe('the ref-event stream on the page', () => {
  test('with events on, the page describes the same capability', () => {
    const page = renderLanding({ ...FACTS, events: true, host: 'agentgit.zabaca.com' })
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
    const page = renderLanding(FACTS)
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
    const html = renderLanding({ ...FACTS, events: true })
    expect(html).toContain('bunx @zabaca/agentgit watch')
    // Named, not spelled out twice: what a reader on node needs from this page
    // is that their runtime is not excluded.
    expect(html).toContain('npx')
  })

  // The page argues; it does not index. Every one of these earned its place
  // somewhere else — the manual, the README — and none of them earned it here.
  test('it sells nothing and links nowhere', () => {
    const html = renderLanding({ ...FACTS, events: true })
    expect(html).not.toContain('llms.txt')
    expect(html).not.toContain('SDK: ')
    expect(html).not.toContain('--json')
  })

  test('with events off, no client is shown', () => {
    const html = renderLanding({ ...FACTS, events: false })
    expect(html).not.toContain('_walgit/events')
    expect(html).not.toContain('@zabaca/agentgit')
  })
})

describe('the page says a push can land on work in progress', () => {
  // Not the git incantation any more — that is the client's job and the
  // manual's. What the page owes a reader is that the question is answered at
  // all, and what the answer looks like when it is yes.
  test('with events on, the collision the client reports is shown', () => {
    const html = renderLanding({ ...FACTS, events: true })
    expect(html).toContain('flags what collides with your uncommitted work')
    expect(html).toContain('COLLIDES with your work in')
  })

  test('with events off, it is absent with everything else', () => {
    const html = renderLanding({ ...FACTS, events: false })
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
    const page = renderLanding({ ...FACTS, signedPushes: true })
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
    const page = renderLanding({ ...FACTS, signedPushes: true, signerLists: true })
    expect(page).toContain('Signer List')
    expect(page).not.toContain('Nothing is refused for being unsigned')
    expect(page).not.toContain('{{')
  })

  test('with signing off, the page never mentions it', () => {
    const page = renderLanding(FACTS)
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
    const page = renderLanding({ ...FACTS, events: true, signedPushes: true })
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
    const html = renderLanding(FACTS)
    expect(html).toContain(
      '<b>Every repository is world-readable and world-writable.</b> Sharing is a URL',
    )
  })

  test('with them on, it stops promising a write nobody can make', () => {
    const html = renderLanding({ ...FACTS, signerLists: true })
    expect(html).not.toContain('world-readable and world-writable.')
    expect(html).toContain('world-writable until its name is claimed')
    // Reads are untouched, and ADR-0012 is emphatic that none of this is a step
    // toward private repositories — so the line that says so stays.
    expect(html).toContain('Privacy is not free yet')
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
    const html = renderLanding({ ...FACTS, signerLists: true, signedPushes: false })
    expect(html).toContain('world-writable until its name is claimed')
    // Still without inviting anyone to claim anything on a host where no push
    // can be signed: the correction names no ref and no command.
    expect(html).not.toContain('refs/walgit/signers')
    expect(html).not.toContain('--signed')
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
  const HELD = { ...FACTS, signedPushes: true, signerLists: true }

  test('it makes the case append-only creates, then answers it', () => {
    const html = renderLanding(HELD)
    expect(html).toContain('<h2>A name a stranger cannot take.</h2>')
    const flat = html.replace(/\s+/g, ' ')
    // The cost, which is the argument. Without it the section is a feature
    // announcement, and a reader has no reason to spend a push on one.
    expect(flat).toContain('neither of you can ever remove it')
    expect(flat).toContain('So a name can refuse a stranger.')
    // The two things a visitor must have before they act: where the list goes,
    // and the one piece of advice with no way back if it is ignored.
    expect(html).toContain('<code>refs/walgit/signers</code>')
    expect(flat).toContain('List two keys')
    // It renders before `The rules.`, beside the events argument rather than
    // after the summary of it, so the terms below read as what both settle.
    expect(html.indexOf('A name a stranger cannot take')).toBeLessThan(
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

    const page = renderLanding(HELD)
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
   * `String.replace` reads `$` in a replacement STRING as a capture-group
   * reference, and this section is the first fragment on the page to carry ones
   * that look like real references — `$2` inside `awk '{print $2}'`. A mangled
   * command would be a page showing something other than what a reader runs,
   * and it would be silent. `renderLanding` passes function replacers so the
   * question cannot arise; this is the assertion that says so out loud.
   */
  test('the recipe keeps its dollars, which replace() could have eaten', () => {
    const html = renderLanding(HELD)
    expect(html).toContain("| awk '{print $2}' > signers")
    expect(html).toContain('https://agentgit.zabaca.com/$NAME.git')
    // The recipe is the WHOLE of it. Showing only the push hands a reader a
    // command that pushes their project's HEAD at the signers ref, which is
    // refused as an unreadable list.
    expect(html).toContain('git init -q claim')
    expect(html).toContain('git add signers')
  })

  test('with Signer Lists off, the whole section is absent', () => {
    const html = renderLanding({ ...FACTS, signedPushes: true })
    expect(html).not.toContain('A name a stranger cannot take')
    expect(html).not.toContain('refs/walgit/signers')
    expect(html).not.toContain('{{')
  })

  // The flag without a nonce seed is a misconfiguration in which nothing can
  // sign, so a section telling a visitor to claim a name would be sending them
  // to claim it with an unsigned push — after which every push to it, theirs
  // included, is refused for carrying no certificate.
  test('and the flag alone does not earn it: with no seed, there is no section', () => {
    const html = renderLanding({ ...FACTS, signerLists: true })
    expect(html).not.toContain('A name a stranger cannot take')
    expect(html).not.toContain('{{')
  })
})

describe('the roadmap', () => {
  test('names what is missing, in every deployment', () => {
    const html = renderLanding({ ...FACTS, events: true })
    for (const row of ['Ownership', 'Private', 'Pull requests', 'CI']) {
      expect(html).toContain(row)
    }
  })

  // The one promise on the page that is not rendered from config, so it is the
  // one that has to say it is not a promise.
  test('promises no date', () => {
    expect(renderLanding(FACTS)).toContain('Nothing here is a date')
    expect(renderLanding({ ...FACTS, signedPushes: true, signerLists: true })).toContain(
      'Nothing here is a date',
    )
  })

  /**
   * The rows that describe ownership, which is now built on some deployments
   * and not on others — so they follow the same rule the limits do rather than
   * being copy. A page still calling ownership "Next" on a host where a name
   * already refuses a stranger is out of date about its own `pre-receive`.
   */
  test('with Signer Lists off, ownership is still the next thing', () => {
    const html = renderLanding({ ...FACTS, signedPushes: true })
    expect(html).toContain('<span class="when">Next</span>')
    expect(html).toContain('the first key to push a name keeps it')
    expect(html).not.toContain('Shipped')
  })

  test('with them on, the Ownership row leaves rather than turning Shipped', () => {
    const html = renderLanding({ ...FACTS, signedPushes: true, signerLists: true })
    // This list is what is MISSING, and a section above now states ownership as
    // a rule of the host. A `Shipped` row would be the page carrying one
    // capability twice — once as a fact and once as an achievement — so the row
    // leaves entirely and the lede goes back to its plain sentence.
    expect(html).not.toContain('<span class="when">Shipped</span>')
    expect(html).not.toContain('the one thing that no longer is')
    expect(html).toContain(
      'What is missing, in the order it unblocks itself. Nothing here is a date',
    )
    // And it stops describing a policy nobody built: the design that shipped is
    // a list a name writes, not first-key-wins.
    expect(html).not.toContain('the first key to push a name keeps it')
    expect(html).not.toContain('<h3>Ownership</h3>')
    // Nothing else in the roadmap moved.
    for (const row of ['Private', 'Pull requests', 'CI']) expect(html).toContain(row)
  })

  /**
   * Removing a row leaves an ODD number of them, and `.road` is a two-column
   * grid whose rules are its container background showing through a 1px gap —
   * so the missing fourth cell does not read as empty space, it paints a solid
   * `--rule` block beside the last card. The count is rendered from policy, so
   * both parities are ordinary and the last card spans when it is alone.
   */
  test('an odd roadmap does not leave a painted hole beside the last card', () => {
    const html = renderLanding({ ...FACTS, signedPushes: true, signerLists: true })
    expect(html.split('<h3>').length - 1).toBe(3)
    expect(html).toContain('.road li:last-child:nth-child(odd) { grid-column: 1 / -1; }')
    // With ownership unbuilt the list is four rows, and the rule is inert.
    expect(renderLanding({ ...FACTS, signedPushes: true }).split('<h3>').length - 1).toBe(4)
  })

  // The flag without a nonce seed is a misconfiguration in which nothing can
  // sign at all, so a page telling a visitor to write fingerprints would be
  // sending them to claim a name with an unsigned push — after which every
  // push to it, theirs included, is refused for carrying no certificate.
  test('and the flag alone does not ship it: with no seed, the row is unchanged', () => {
    const html = renderLanding({ ...FACTS, signerLists: true })
    expect(html).toContain('<span class="when">Next</span>')
    expect(html).not.toContain('Shipped')
    expect(html).not.toContain('refs/walgit/signers')
  })

  /**
   * Private was written as "gated on the same fingerprint that already gets
   * recorded", which is the wrong noun: what a read would be gated on is the
   * Signer List a name holds, and ADR-0012 is explicit that holding a name is
   * not a step toward closing reads. Both halves of that are the correction.
   */
  test('and the Private row names the list, not the fingerprint', () => {
    const html = renderLanding({ ...FACTS, signedPushes: true, signerLists: true })
    expect(html).not.toContain('same fingerprint that already gets recorded')
    expect(html).toContain('Signer List')
    expect(html).toContain('Reads are still gated on nothing')
    // Not promised, and not made next by ownership having shipped.
    expect(html).not.toContain('<span class="when">Next</span>')
  })
})
