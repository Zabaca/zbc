/**
 * The page a browser gets at `/`.
 *
 * The same URL answers two audiences. git and curl send an `Accept` that never
 * names HTML, and get src/instructions.ts — plain text, the whole protocol, no
 * markup to parse. A browser sends `Accept: text/html` and gets this. One
 * hostname, one route, and the pitch is never a second deployment to keep in
 * sync with the service it describes.
 *
 * It is answered HERE, in the Worker, rather than proxied. That is the whole
 * point of the placement: a link on an aggregator sends thousands of people to
 * `/`, and not one of those requests should wake the container or queue behind
 * a clone. The container serves git; the edge serves the argument.
 *
 * ── one argument, not three ───────────────────────────────────────────────
 *
 * The page used to walk three walls — no account, no way to share, no way to
 * know something moved — as a scrolling story with a terminal that changed
 * scene. The first two are settled by the two commands in the hero: whoever
 * has run them has already seen that there was no signup and that a URL is the
 * whole handoff, and reading an argument for what just happened is a page
 * arguing with somebody who already agreed. So the body keeps the one thing
 * the commands do NOT show — that finding out a ref moved needs no webhook —
 * and everything else is a fact stated once.
 *
 * ── why the limits are arguments, not copy ────────────────────────────────
 *
 * Every claim about a limit is rendered from the same environment variables
 * the push path enforces and `GET /` states. A page that promised a 24-hour
 * window an unset `WALGIT_RETENTION_HOURS` never collects would be a lie told
 * at the top of the funnel, and the only reliable way to not tell it is to
 * have no copy that can outlive the config. So an unset limit removes its
 * claim rather than defaulting to one.
 *
 * The cap the page prints and the cap `pre-receive` refuses on are formatted by
 * one function (`shared/policy.ts`), so they cannot look like two different
 * numbers. That used to be a copy of `describeBytes` with a comment promising
 * the two were kept identical.
 */

import { describeBytes } from './policy'
import { EVENTS_PATH } from './protocol'

export interface LandingFacts {
  /** The hostname the request arrived on — every command on the page uses it. */
  host: string
  /** `null` when this deployment collects nothing, and the page then says so. */
  retentionHours: number | null
  maxPushBytes: number | null
  maxRepoBytes: number | null
  /**
   * Does this deployment accept a signed push and record who made it?
   *
   * Rendered from `WALGIT_PUSH_CERT_SEED` through the same predicate the push
   * path uses, because git refuses `--signed` client-side against a host that
   * has not set the seed: a page inviting somebody to sign would be sending
   * them to a refusal it caused.
   */
  signedPushes: boolean
  /**
   * Does this deployment serve the ref-event stream?
   *
   * Rendered from `WALGIT_EVENTS_TOKEN` — the variable that decides whether the
   * Worker claims the socket path at all — for exactly the reason the limits
   * are rendered from theirs: a page describing a socket that answers 404 is
   * the same lie as a page promising a window nothing collects.
   */
  events: boolean
  /**
   * May a repository here hold a Signer List, and be defended by it?
   *
   * From `WALGIT_SIGNER_LISTS`, and read at two different strengths.
   *
   * **Alone** it corrects the `Public` term, because that term states what
   * `pre-receive` refuses and `pre-receive` refuses on this flag by itself: a
   * deployment that sets it with no nonce seed refuses EVERY push to a claimed
   * name, so "world-writable" is more wrong there, not less.
   *
   * **With `signedPushes`** it renders the ownership section and rewrites the
   * roadmap, because both of those tell a visitor to go and claim a name — and
   * without a seed nothing can sign, so they would be sending them to claim it
   * with an unsigned push, after which every push to it is refused. It also
   * changes one sentence in the signing claim, which otherwise promises that
   * nothing is refused for being unsigned.
   */
  signerLists: boolean
}

/**
 * Does this request want the page rather than the protocol?
 *
 * Only GET/HEAD on `/`, and only for a client that asked for HTML. git never
 * sends `text/html` in its `Accept`, so the negotiation cannot misfire on a
 * clone — and a client that asks for neither keeps the plain-text instructions,
 * which is the safer default for anything automated.
 */
export function wantsLanding(method: string, pathname: string, accept: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  if (pathname !== '/') return false
  return accept.toLowerCase().includes('text/html')
}

function describeHours(hours: number): string {
  if (hours === 1) return '1 hour'
  return `${hours} hours`
}

const claim = (key: string, value: string) =>
  `        <li><span class="k">${key}</span><span class="v">${value}</span></li>`

/**
 * The fourth term.
 *
 * With retention on it is the window, because a window is the most surprising
 * thing about the service and the one nobody must learn only after pushing.
 * With retention off there is no window to state, so the slot goes to the size
 * caps — and when a deployment enforces nothing at all, the claim is absent
 * rather than replaced by a reassuring sentence nothing backs.
 */
function thirdClaim(facts: LandingFacts): string {
  if (facts.retentionHours !== null) {
    const window = describeHours(facts.retentionHours)
    return claim(
      window,
      `<b>A repository lives ${window} from its last push.</b> This is scratch space, on purpose.`,
    )
  }
  if (facts.maxPushBytes !== null || facts.maxRepoBytes !== null) {
    const parts: string[] = []
    if (facts.maxPushBytes !== null) parts.push(`${describeBytes(facts.maxPushBytes)} per push`)
    if (facts.maxRepoBytes !== null) {
      parts.push(`${describeBytes(facts.maxRepoBytes)} per repository`)
    }
    return claim(
      'Bounded',
      `<b>${parts.join(', ')}.</b> Refused in <code>pre-receive</code>, by a message that names which cap and what to do instead.`,
    )
  }
  return ''
}

/** The permanence sentence, which turns on the same variable as the claim. */
function permanence(facts: LandingFacts): string {
  return facts.retentionHours === null
    ? 'Not an archive: a repository here is a working surface, and nothing about this service is a promise to keep your history.'
    : `Not permanent: ${describeHours(facts.retentionHours)} from the last push, a repository is collected.`
}

/**
 * The one argument the two commands in the hero do not already make.
 *
 * One section and one illustration, and both were arrived at by deleting. The
 * client used to be a section of its own — but "there is no webhook" and "here
 * is the command that needs no webhook" are the same claim, and splitting them
 * made a reader finish the argument, scroll, and start again.
 *
 * Then the illustration was two panels: the JSON on the wire, and a terminal
 * running the client. Also one too many. A reader who is going to run the
 * command does not need to see the frames it exchanges, and a reader who wants
 * the frames wants `/llms.txt`, not a homepage. So the panel shows the command
 * and the socket it opens, together, and the wire lives in the manual.
 *
 * Absent entirely when the deployment serves no stream, for the same reason
 * every limit on this page is rendered rather than written: a section
 * describing a socket that answers 404 is a lie told at the top of the funnel.
 */
function eventsSection(facts: LandingFacts): string {
  if (!facts.events) return ''
  const socket = `wss://${facts.host}${EVENTS_PATH}`

  return `
    <section class="split">
      <div class="split-say">
        <h2>Stop asking whether main moved.</h2>
        <p>Every check costs a fetch, a tool call and a slice of context, and almost every answer is <em>nothing changed</em>. A webhook would fix it, except an agent in a sandbox has no address to deliver one to.</p>
        <p><strong>So the agent opens the socket instead:</strong> current state on connect, then one message per ref that moves.</p>
        <p><strong>One command.</strong> It fetches, and flags what collides with your uncommitted work.</p>
      </div>

      <div class="split-show">
        <div>
          <div class="term term-solo">
            <pre id="watch-cmd"><span class="p">$</span> bunx @zabaca/agentgit watch</pre>
            <button class="copy" id="copy-watch" type="button" aria-live="polite" aria-label="Copy the watch command">Copy</button>
          </div>
          <p class="under"><span>npx</span> too · <span>--once</span> waits for the handoff</p>
        </div>

        <div class="panel wire" id="wire">
          <div class="panel-head">
            <span><span class="pulse"></span>${socket}</span>
          </div>
          <pre class="tx" id="wire-tx"><span class="ln" style="--d:0ms"><span class="p">$</span> bunx @zabaca/agentgit watch
</span><span class="ln" style="--d:220ms"><span class="c">watching study-42 for refs/heads/main</span>
</span><span class="ln" style="--d:400ms"><span class="ok">study-42 main: origin/main is 809eb587</span>
</span><span class="ln" style="--d:1150ms">
<span class="c"># the other agent pushes. no webhook, no polling.</span>
</span><span class="ln" style="--d:2050ms">
<span class="ok">study-42 main: origin/main is ef759899</span>
</span><span class="ln" style="--d:2400ms"><span class="no">study-42 main: COLLIDES with your work in src/index.ts</span><span class="caret"></span></span></pre>
          <div class="panel-foot">Opened from the inside, so a sandbox needs no address.</div>
        </div>
      </div>
    </section>
`
}

/**
 * What anyone may do to a repository here, which the gate changes.
 *
 * Rendered rather than written for the reason every limit on this page is: the
 * sentence it replaces — *"Every repository is world-readable and
 * world-writable"* — is a promise `pre-receive` stopped keeping the moment a
 * name could hold a Signer List, and a claim the page cannot back is the same
 * defect as a window nothing collects.
 *
 * Read from `signerLists` ALONE, unlike the section below it and unlike the
 * roadmap: those two teach an agent to claim a name and must not do it where
 * no push can be signed, whereas this states what is refused — and the hook
 * refuses on this flag by itself. A deployment that sets it with no nonce seed
 * refuses EVERY push to a claimed name, which makes unconditional writability
 * more wrong, not less.
 *
 * Reads are untouched and the card still says so, because ADR-0012 is emphatic
 * that none of this is a step toward private repositories: *"Privacy is not
 * free yet"* was true before the gate and is true after it.
 */
function publicClaim(facts: LandingFacts): string {
  return claim(
    'Public',
    facts.signerLists
      ? '<b>Every repository is world-readable, and world-writable until its name is claimed.</b> Sharing is a URL, not an invitation. Privacy is not free yet.'
      : '<b>Every repository is world-readable and world-writable.</b> Sharing is a URL, not an invitation. Privacy is not free yet.',
  )
}

/**
 * Holding a name, argued as a section rather than stated as a term.
 *
 * It is the second argument on this page, and it is here for the same reason
 * the events section is: the two commands in the hero already show that there
 * was no signup and that a URL is the whole handoff, and neither shows the
 * thing append-only creates. *Nothing you push can be destroyed* is the term a
 * reader meets in `The rules.` as a protection; this section is the half of it
 * that is a cost — a stranger's branch in your name is as permanent as your
 * own — and the answer to it. A term could state the rule; only a section can
 * make the case, and the case is what a reader needs before they will spend a
 * push on it.
 *
 * Placed BEFORE `The rules.`, beside the events argument rather than after the
 * summary of it, so the two arguments read together and the terms below read as
 * what both of them settle.
 *
 * The right column is the claim and then its consequence, in the order they
 * happen: the commands that write the list, then the refusal a stranger reads.
 *
 * **The recipe is the whole of it, not the last line of it.** A Signer List is
 * a commit whose tree is one file, so the push has to come from a repository
 * that has one — and the obvious abbreviation, showing only the `git push`,
 * hands a reader a command that pushes their PROJECT's `HEAD` at
 * `refs/walgit/signers` and is refused as an unreadable list. It is the same
 * recipe `/llms.txt` gives (`shared/llms.ts`), compressed; `set -e` and the
 * second key live there, because this panel is the argument and that document
 * is the manual.
 *
 * **The transcript is an excerpt, and says so.** Every line of it is a line
 * `heldMessage` (`src/signers.ts`) actually writes, and `landing.test.ts`
 * checks them against the real refusal rather than against themselves — the
 * page and the hook describing two different refusals is the drift every
 * rendered claim here exists to prevent, and this one is worse than a wrong cap
 * because the refusal is the only documentation the agent hitting it has. The
 * elision is marked with a `…` line so nobody reads the panel as the whole
 * message: what it cuts is the remedy block, which is long, and which the
 * section beside it has already given.
 *
 * Gated on `signedPushes` as well as `signerLists`, exactly as the roadmap rows
 * are and for the same reason: the flag without a nonce seed is a
 * misconfiguration in which nothing can sign, so inviting a visitor to claim a
 * name there would be sending them to claim it with an unsigned push — after
 * which every push to it, theirs included, is refused for carrying no
 * certificate.
 */
function ownershipSection(facts: LandingFacts): string {
  if (!(facts.signedPushes && facts.signerLists)) return ''

  return `
    <section class="split">
      <div class="split-say">
        <h2>A name a stranger cannot take.</h2>
        <p>Nothing you push can be destroyed — and that cuts both ways. Anyone who knows the name can add a branch to the repository your agent is working in, and then <em>neither of you can ever remove it</em>. Append-only defends their write as carefully as it defends yours.</p>
        <p><strong>So a name can refuse a stranger.</strong> Write the fingerprints you trust to <code>refs/walgit/signers</code>. From the next push on, the repository takes pushes signed by those keys and refuses everything else — and every name nobody has claimed still takes anyone's.</p>
        <p><strong>List two keys.</strong> There is no escrow here and no support address: one key, lost, is the end of the name.</p>
      </div>

      <div class="split-show">
        <div>
          <div class="term term-solo">
            <pre><span class="c"># a repository whose tree is one file: signers.</span>
<span class="p">$</span> git init -q claim &amp;&amp; cd claim
<span class="p">$</span> ssh-keygen -lf ~/.ssh/id_ed25519.pub \\
      | awk '{print $2}' > signers
<span class="p">$</span> git add signers &amp;&amp; git commit -qm claim
<span class="p">$</span> git push --signed=if-asked \\
      https://${facts.host}/$NAME.git \\
      HEAD:refs/walgit/signers</pre>
          </div>
          <p class="under">List a second key · the full recipe is in <span>/llms.txt</span></p>
        </div>

        <div class="panel">
          <div class="panel-head">
            <span>what a stranger reads</span>
          </div>
          <pre class="tx"><span class="ln"><span class="p">$</span> git push agentgit HEAD:refs/heads/main
</span><span class="ln"><span class="no">walgit: refused — study-42 is held by a Signer List.</span>
</span><span class="ln"><span class="c">Your push carries no signature, so walgit cannot tell</span>
</span><span class="ln"><span class="c">whose it is. A name that holds a Signer List takes</span>
</span><span class="ln"><span class="c">signed pushes only:</span>
</span><span class="ln"><span class="c">    git push --signed=yes origin HEAD:refs/heads/&lt;branch&gt;</span>
</span><span class="ln"><span class="c">…</span>
</span><span class="ln"><span class="ok">Nothing was uploaded; the repository is unchanged.</span></span></pre>
          <div class="panel-foot">Refused in <code>pre-receive</code>, before anything is uploaded. The message names a free name to use instead, and how to be added to this one.</div>
        </div>
      </div>
    </section>
`
}

/**
 * The signing term, present only where a push can actually be signed.
 *
 * Stated as a term rather than argued as a section: it changes nothing about
 * how anyone uses the service — an unsigned push is accepted exactly as it was
 * — so it belongs in the list of what is true here, not in the body.
 */
function signingClaim(facts: LandingFacts): string {
  if (!facts.signedPushes) return ''
  return (
    '\n' +
    claim(
      'Attributed',
      "<b>A push signed with your key records that key's fingerprint.</b> " +
        (facts.signerLists
          ? 'Unsigned is fine unless a name has written a Signer List, which takes pushes from its own keys only. There is still no account: the fingerprint is the whole identity.'
          : 'Nothing is refused for being unsigned, and there is still no account: the fingerprint is the whole identity.') +
        ' <code>git push --signed=if-asked</code>.',
    )
  )
}

/**
 * The first two roadmap rows, which are the two the gate makes untrue.
 *
 * The roadmap is "what is missing, in the order it unblocks itself", so a
 * deployment where a name can already refuse a stranger must not go on calling
 * ownership Next. Same rule as every limit on this page, applied to a promise
 * instead of a cap.
 *
 * Where it shipped the row does not become a `Shipped` row — it LEAVES. This
 * list is what is missing, and a section above now states ownership as a rule
 * of the host; carrying it in both places would be the page describing one
 * capability twice, once as a fact and once as an achievement. Only Private
 * stays, because Private is genuinely still missing and the row was wrong about
 * what it is blocked on: what a read would be gated on is the Signer List a
 * name holds, not the fingerprint Provenance records. It is not next either —
 * ADR-0012 is explicit that nothing here is a step toward private repositories
 * — so the row keeps `data-next` off itself and hands it to nobody.
 *
 * Read with `signedPushes`, never alone, exactly as the section above is: the
 * flag without a nonce seed is a misconfiguration in which nothing can sign, so
 * a page telling a visitor to write fingerprints there would be sending them to
 * claim a name with an unsigned push — after which every push to it, including
 * theirs, is refused for carrying no certificate.
 */
function roadmapOwnership(facts: LandingFacts): string {
  if (!(facts.signedPushes && facts.signerLists)) {
    return `        <li data-next>
          <span class="when">Next</span>
          <h3>Ownership</h3>
          <p>Claiming a name. Who pushed is already recorded; what is missing is the policy that says the first key to push a name keeps it — and un-claiming is a decision nobody will agree on, so it is the one row here that is hard to take back.</p>
        </li>
        <li>
          <span class="when">After ownership</span>
          <h3>Private</h3>
          <p>There is nobody to be private from until a name has an owner. Reads gated on the same fingerprint that already gets recorded, and not before ownership means something.</p>
        </li>`
  }
  return `        <li>
          <span class="when">Unblocked, unplanned</span>
          <h3>Private</h3>
          <p>A name that holds a Signer List is the first thing here anyone could be private <em>from</em>. Reads are still gated on nothing: a claimed repository, its list and its history are as readable as everything else, and holding a name is not a step toward closing it.</p>
        </li>`
}

/**
 * The live client, shipped only where there is a socket to open.
 *
 * It sits behind the same gate as every other claim on this page: a deployment
 * that serves no stream must not ship a client for one, or the page would carry
 * code describing a capability its own Worker answers 404 for.
 */
function wireScript(): string {
  return `${WIRE_CLIENT}`
}

/**
 * Every substitution passes a FUNCTION, never the string itself.
 *
 * `String.replace` reads `$` sequences in a replacement STRING as capture-group
 * references, and these fragments are full of them: a shell prompt is
 * `<span class="p">$</span>`, the claim recipe carries `awk '{print $2}'` and
 * `$NAME`. Today every one of those is left literal — there are no capture
 * groups in a string pattern — but that is a rule about what the fragments
 * happen to contain, re-checked on every copy edit, and the failure it guards
 * is silent: a command on the page that quietly differs from the one anybody
 * runs. A function replacer is not interpreted at all, so the question stops
 * being asked.
 */
export function renderLanding(facts: LandingFacts): string {
  return PAGE.replaceAll('{{HOST}}', () => facts.host)
    .replace('{{PUBLIC_CLAIM}}', () => publicClaim(facts))
    .replace('{{SIGNING_CLAIM}}', () => signingClaim(facts))
    .replace('{{THIRD_CLAIM}}', () => thirdClaim(facts))
    .replace('{{ROADMAP_OWNERSHIP}}', () => roadmapOwnership(facts))
    .replace('{{EVENTS}}', () => eventsSection(facts))
    .replace('{{OWNERSHIP}}', () => ownershipSection(facts))
    .replace('{{WIRE_SCRIPT}}', () => (facts.events ? wireScript() : ''))
    .replace('{{PERMANENCE}}', () => permanence(facts))
}

const WIRE_CLIENT = `
    // ── the transcript plays itself ────────────────────────────────────
    //
    // A recording rather than a live socket, and that was a deliberate
    // retreat. The panel DID open a real WebSocket to this host and stream
    // genuine pushes — verified, a push landed here four seconds after git
    // returned — but a repository nobody is pushing to sits silent for
    // exactly as long as anyone is reading it. The honest live version proved
    // the connection was open and nothing else, and what a visitor needs to
    // see is the thing ARRIVE.
    //
    // So the timing is the content: three lines land together, then a wait
    // while the comment says another agent is pushing, then the new sha and
    // the collision. The pause is the argument, because nothing polled during
    // it.
    //
    // The lines are in the HTML and visible before this runs. Script only
    // takes them away to give them back in order, so no JavaScript, a script
    // that fails, or a request for less motion all leave the whole transcript
    // on screen.
    var tx = document.getElementById("wire-tx");
    if (!tx || !("IntersectionObserver" in window)) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    tx.classList.add("armed");
    var io = new IntersectionObserver(function (entries) {
      if (!entries[0] || !entries[0].isIntersecting) return;
      io.disconnect();
      // Played once. A transcript that restarted every time it came back into
      // view would read as a loop rather than as something that happened.
      tx.classList.add("play");
    }, { threshold: 0.35 });
    io.observe(tx);
`

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentgit — Git for AI agents</title>
<meta name="description" content="A public git host for AI agents. No account, no token, no key: push to a name and the repository exists.">
<style>
  /* Deliberately single-theme: a launch page with a fixed identity.
     Every colour is painted explicitly so it holds on either host ground. */
  :root {
    --ground: #14100e;      /* warm off-black — brown, not blue */
    --raised: #1c1815;
    --sunk:   #0e0b0a;
    --rule:   #2e2723;
    --rule-2: #423831;
    --bone:   #ede6de;
    --muted:  #a79b90;
    --faint:  #8f847a;   /* AA on all three grounds: 5.18 / 4.83 / 5.37 */
    --copper: #c56a3e;      /* fresh metal */
    --verdi:  #4e9e8b;      /* what copper becomes with age */

    --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
    --serif: "Newsreader", Georgia, "Times New Roman", serif;
  }

  * { box-sizing: border-box; }

  html { -webkit-text-size-adjust: 100%; }

  /* Surfaces the browser would otherwise paint from no design system at all. */
  ::selection { background: var(--copper); color: var(--sunk); }

  body {
    background: var(--ground);
    color: var(--bone);
    font-family: var(--mono);
    font-size: 16px;
    line-height: 1.6;
    margin: 0;
    -webkit-font-smoothing: antialiased;
  }

  .wrap {
    max-width: 62rem;
    margin: 0 auto;
    padding: clamp(2.5rem, 7vw, 6rem) clamp(1.15rem, 5vw, 2rem) 4rem;
  }

  a { color: var(--verdi); text-decoration-thickness: 1px; text-underline-offset: 3px; }
  a:hover { color: var(--copper); }

  :focus-visible {
    outline: 2px solid var(--copper);
    outline-offset: 3px;
    border-radius: 1px;
  }

  /* ── hero ─────────────────────────────────────────────── */

  /* Visible only once focused. Three focusables and one landmark make this
     cheap rather than essential, but a keyboard user should never have to tab
     through the page furniture to reach the command. */
  .skip {
    position: absolute;
    clip-path: inset(50%);
    left: 0;
    top: 0;
    background: var(--copper);
    color: var(--sunk);
    font-size: .72rem;
    letter-spacing: .1em;
    text-transform: uppercase;
    text-decoration: none;
    padding: .8rem 1.1rem;
    z-index: 2;
  }
  .skip:focus { clip-path: none; color: var(--sunk); }

  .badge {
    display: inline-block;
    font-size: .68rem;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--muted);
    border: 1px solid var(--rule-2);
    padding: .32rem .6rem;
    margin-bottom: 2rem;
  }

  h1 {
    font-family: var(--mono);
    font-weight: 700;
    font-size: clamp(2.1rem, 7.6vw, 4rem);
    line-height: 1;
    letter-spacing: -.045em;
    margin: 0 0 1.5rem;
    text-wrap: balance;
  }
  h1 .dot { color: var(--copper); }

  .lede {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(1.15rem, 2.9vw, 1.5rem);
    line-height: 1.5;
    color: var(--bone);
    max-width: 38ch;
    margin: 0 0 2.75rem;
  }
  .lede em { font-style: normal; color: var(--copper); }

  /* ── the command, which is the CTA ────────────────────── */

  .cta { margin: 0 0 1rem; max-width: 44rem; }

  /* The name is the only thing about the first push a visitor gets to decide,
     so it is the only editable thing on the page. Typing here rewrites the
     command below it, and the copy button reads the command rather than this
     field, so what lands on the clipboard is what is on screen.
     
     It stands where "give this to your agent" used to: naming the repository
     IS creating it, so that instruction was a caption on the one step that
     already explains itself. */
  .repo-field {
    display: inline-flex;
    align-items: center;
    gap: .6rem;
    margin: 0 0 .75rem;
    font-size: .68rem;
    letter-spacing: .13em;
    text-transform: uppercase;
    color: var(--muted);
    cursor: text;
  }

  /* A box, not an underline. The first version of this was a bottom rule and a
     small copper word, which read as a label rather than as something to type
     in — the one control on the page has to look like one. */
  .repo-field input {
    caret-color: var(--copper);
    font-family: var(--mono);
    font-size: .86rem;
    letter-spacing: 0;
    text-transform: none;
    color: var(--copper);
    background: var(--sunk);
    border: 1px solid var(--rule-2);
    border-left: 2px solid var(--copper);
    padding: .5rem .7rem;
    width: 15rem;
    max-width: 48vw;
    min-height: 44px;
  }
  .repo-field input::placeholder { color: var(--faint); }

  /* Why a character disappeared. The field filters as you type rather than
     refusing on submit — there is no submit — so the only place left to say
     what happened is beside the field, at the moment it happens. */
  .repo-note {
    font-size: .66rem;
    letter-spacing: .08em;
    text-transform: none;
    color: var(--copper);
    opacity: 0;
    transition: opacity .18s ease;
  }
  .repo-note[data-shown] { opacity: 1; }
  .repo-field input:hover { border-color: var(--faint); border-left-color: var(--copper); }
  /* The border shift is the resting-to-active cue; the outline is the
     accessible one. An earlier version set outline:0 here, which also
     defeated the global :focus-visible rule and left the page's only text
     input invisible to the keyboard. */
  .repo-field input:focus { border-color: var(--copper); background: var(--ground); }

  /* The one token in the command that the field above rewrites, coloured so
     the connection between the two is visible before anybody types. */
  #repo-echo {
    color: var(--copper);
    border-bottom: 1px dashed var(--rule-2);
  }

  .term {
    background: var(--sunk);
    border: 1px solid var(--rule-2);
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: stretch;
  }
  .term-solo { max-width: 34rem; margin-bottom: .75rem; }

  .term pre {
    margin: 0;
    padding: 1.1rem 1.2rem;
    overflow-x: auto;
    font-size: .82rem;
    line-height: 1.85;
    color: var(--bone);
  }
  .term .p { color: var(--copper); user-select: none; }
  .term .c { color: var(--faint); }

  .copy {
    font-family: var(--mono);
    font-size: .66rem;
    letter-spacing: .12em;
    text-transform: uppercase;
    color: var(--bone);
    background: var(--raised);
    border: 0;
    border-left: 1px solid var(--rule-2);
    padding: 0 1.15rem;
    min-width: 5.5rem;
    min-height: 44px;
    cursor: pointer;
  }
  .copy:hover { background: var(--copper); color: var(--sunk); }
  .copy[data-done="1"] { background: var(--verdi); color: var(--sunk); }

  .under {
    font-family: var(--mono);
    font-size: .72rem;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--faint);
    margin: 0 0 .6rem;
    max-width: none;
  }
  .under span { color: var(--muted); }

  /* ── panels ───────────────────────────────────────────── */

  .panel { border: 1px solid var(--rule-2); background: var(--raised); }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    /* The socket URL is one token with no space to break at, and uppercase
       plus tracking makes it longer than a 320px screen. Without this the
       whole page pans rather than the header wrapping. */
    overflow-wrap: anywhere;
    padding: .7rem 1rem;
    border-bottom: 1px solid var(--rule-2);
    font-size: .66rem;
    letter-spacing: .13em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .pulse {
    display: inline-block;
    width: .42rem; height: .42rem;
    border-radius: 50%;
    background: var(--verdi);
    margin-right: .5rem;
    vertical-align: baseline;
  }
  /* The socket's address is a URL, not a label. Uppercasing it was both wrong
     — the path is case-sensitive — and wide enough that tracking broke it
     mid-token. Set as itself it fits on one line. */
  .wire .panel-head > span:first-child {
    text-transform: none;
    letter-spacing: .02em;
    font-size: .7rem;
    color: var(--muted);
  }

  /* The transcript arrives a line at a time, on a schedule the markup carries
     as --d. The long gap before the last two lines is the point of the whole
     panel: nothing polled during it, and then the push simply showed up.

     Lines are visible until script arms them, so the no-JavaScript reading is
     the complete transcript rather than an empty box. */
  .tx .ln { display: block; }
  .tx.armed > .ln { opacity: 0; }
  .tx.play > .ln {
    animation: land .34s cubic-bezier(.2, .7, .3, 1) both;
    animation-delay: var(--d, 0ms);
  }
  @keyframes land {
    from { opacity: 0; transform: translateY(.3rem); }
    to   { opacity: 1; transform: none; }
  }

  .panel-foot {
    border-top: 1px solid var(--rule-2);
    padding: .85rem 1rem;
    font-size: .74rem;
    line-height: 1.55;
    color: var(--faint);
  }
  .panel-foot code { color: var(--verdi); font-size: .78rem; }

  .tx {
    margin: 0;
    padding: 1rem 1.15rem;
    font-size: .74rem;
    line-height: 1.65;
    white-space: pre;
    overflow-x: auto;
    color: var(--muted);
  }
  .tx .p  { color: var(--copper); }
  .tx .c  { color: var(--faint); }
  .tx .ok { color: var(--verdi); }
  .tx .no { color: var(--copper); }
  .tx .caret {
    display: inline-block;
    width: .52em; height: 1em;
    background: var(--copper);
    vertical-align: -.14em;
    animation: blink 1.05s steps(1) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }

  /* ── prose sections ───────────────────────────────────── */

  section { margin-top: 5rem; }

  h2 {
    font-family: var(--mono);
    font-weight: 700;
    font-size: clamp(1.35rem, 4vw, 1.85rem);
    letter-spacing: -.03em;
    margin: 0 0 1rem;
    text-wrap: balance;
  }

  section p {
    font-family: var(--serif);
    font-weight: 300;
    font-size: 1.08rem;
    line-height: 1.62;
    color: var(--muted);
    max-width: 58ch;
    margin: 0 0 1.25rem;
  }
  section p strong { color: var(--bone); font-weight: 400; }
  /* The answer the reader keeps paying for and keeps not needing. Italic
     rather than quoted: it is the thing the tool says, not a thing anyone said. */
  section p em { font-style: italic; color: var(--faint); }

  /* The one argument, and the wire beside it rather than under it: the prose
     and the thing it describes are read together or not at all. */
  .split {
    display: grid;
    grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
    gap: 0 2.5rem;
    align-items: start;
  }
  /* A grid item defaults to min-width:auto, so a track cannot shrink below its
     content's min-content width — and .tx is white-space:pre with 53-character
     lines. Without this the TRACK grew instead of the pre scrolling, and the
     whole page panned sideways on every phone. */
  .split > *,
  .split-show > *,
  .term > * { min-width: 0; }
  .claims li, .road li { min-width: 0; }
  .split-say p { max-width: 46ch; margin-bottom: 1rem; }
  /* The command and the socket it opens are one column: the argument reads
     down the left, and everything a reader would actually run or watch happens
     on the right, in the order it happens. */
  .split-show { display: grid; gap: 1.75rem; align-content: start; }
  .split-show .term-solo { margin: 0 0 .5rem; max-width: 100%; }
  .split-show .under { margin: 0; letter-spacing: .07em; }
  .split-show .tx { font-size: .7rem; }

  /* ── the terms ────────────────────────────────────────── */

  .claims {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0;
    border-top: 1px solid var(--rule);
  }
  .claims li {
    border-bottom: 1px solid var(--rule);
    padding: 1.05rem 0;
    display: grid;
    grid-template-columns: 9.5rem 1fr;
    gap: 0 1.5rem;
    align-items: baseline;
  }
  .claims .k {
    font-size: .68rem;
    letter-spacing: .13em;
    text-transform: uppercase;
    color: var(--verdi);
  }
  .claims .v { color: var(--muted); font-size: .95rem; font-family: var(--serif); font-size: 1rem; }
  .claims .v b { color: var(--bone); font-weight: 400; }
  .claims .v code { font-family: var(--mono); font-size: .82rem; color: var(--verdi); }

  /* ── the roadmap ──────────────────────────────────────── */

  .road {
    list-style: none;
    margin: 0 0 1.5rem;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1px;
    background: var(--rule);
    border: 1px solid var(--rule);
  }
  .road li {
    background: var(--ground);
    padding: 1.35rem 1.5rem;
    display: grid;
    gap: .5rem;
    align-content: start;
  }
  /* The rules are drawn by the container's background showing through a 1px
     gap, so a half-empty final row is not blank — it paints a solid --rule
     block beside the last card. The list is rendered from policy and is three
     rows on a deployment that has shipped ownership, four on one that has not,
     so an odd count is an ordinary state rather than an editing mistake. */
  .road li:last-child:nth-child(odd) { grid-column: 1 / -1; }
  .road h3 {
    font-family: var(--mono);
    font-size: .95rem;
    font-weight: 700;
    letter-spacing: -.01em;
    margin: 0;
    color: var(--bone);
  }
  .road .when {
    font-size: .62rem;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--faint);
  }
  .road li[data-next] .when { color: var(--copper); }
  .road p {
    font-family: var(--serif);
    font-size: 1rem;
    line-height: 1.55;
    color: var(--muted);
    margin: 0;
    max-width: 40ch;
  }

  .caveat {
    font-family: var(--serif);
    font-size: 1rem;
    color: var(--muted);
    max-width: 58ch;
    margin: 0;
  }

  footer {
    margin-top: 5rem;
    padding-top: 1.4rem;
    border-top: 1px solid var(--rule);
    display: flex;
    flex-wrap: wrap;
    gap: .6rem 1.6rem;
    font-size: .7rem;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--faint);
  }
  footer code { text-transform: none; color: var(--verdi); }

  @media (max-width: 62rem) {
    .split { grid-template-columns: minmax(0, 1fr); gap: 2rem 0; }
    .split-say p { max-width: 58ch; }
  }

  @media (max-width: 34rem) {
    .claims li { grid-template-columns: 1fr; gap: .25rem; }
    .road { grid-template-columns: 1fr; }
    .term { grid-template-columns: 1fr; }
    .copy { border-left: 0; border-top: 1px solid var(--rule-2); padding: .8rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .tx .caret, .pulse, .tx .ln { animation: none; }
    .tx.armed > .ln, .tx.play > .ln { opacity: 1; transform: none; }
    * { transition: none !important; }
  }
</style>
</head>
<body>
<a class="skip" href="#start">Skip to the command</a>
<div class="wrap">

  <main id="start">
    <span class="badge">Open source — run your own</span>

    <h1>Git for AI agents<span class="dot">.</span></h1>

    <p class="lede">Your agent writes code all day and has nowhere of its own to put it. <em>Push to a name and the repository exists</em> — no account, no key, no API besides git itself.</p>

    <div class="cta">
      <label class="repo-field" for="repo">
        <span>Name it</span>
        <input id="repo" name="repo" type="text" value="my-thing" placeholder="my-thing"
               spellcheck="false"
               autocomplete="off" autocapitalize="off" maxlength="64"
               aria-describedby="repo-help">
        <span class="repo-note" id="repo-note" role="status" aria-live="polite"></span>
      </label>
      <div class="term">
        <pre id="cmd"><span class="c"># there is no signup.</span>
<span class="p">$</span> git remote add agentgit https://{{HOST}}/<span id="repo-echo">my-thing</span>.git
<span class="p">$</span> git push agentgit main</pre>
        <button class="copy" id="copy" type="button" aria-live="polite" aria-label="Copy the two commands">Copy</button>
      </div>
    </div>
    <p class="under" id="repo-help">No account · <span>No token</span> · No key · <span>The name is the repository</span></p>
{{EVENTS}}{{OWNERSHIP}}
    <section>
      <h2>The rules.</h2>
      <ul class="claims">
        <li><span class="k">Append-only</span><span class="v"><b>Nothing you push can be destroyed.</b> Anyone may add; no one may rewrite or delete. A push that would rewrite history is refused in <code>pre-receive</code>, before anything is uploaded, by a message naming what to do instead.</span></li>
{{PUBLIC_CLAIM}}
{{THIRD_CLAIM}}{{SIGNING_CLAIM}}
      </ul>
    </section>

    <section>
      <h2>On the way.</h2>
      <p>What is missing, in the order it unblocks itself. Nothing here is a date, and each one is written down before it is built.</p>
      <ul class="road">
{{ROADMAP_OWNERSHIP}}
        <li>
          <span class="when">Under design</span>
          <h3>Pull requests</h3>
          <p>Append-only already makes a proposal safe to push. What is missing is a way to say a branch is one, and a way to say it landed — not a review UI.</p>
        </li>
        <li>
          <span class="when">Half built</span>
          <h3>CI</h3>
          <p>A ref moving is already an event, and the client already runs a command on it. The missing half is somewhere to run it that is not your machine.</p>
        </li>
      </ul>
      <p class="caveat">{{PERMANENCE}} Not a place for anything you cannot lose.</p>
    </section>
  </main>

  <footer>
    <span>agentgit</span>
    <span>Open source</span>
    <span>Run your own: <code>zbc add walgit</code></span>
  </footer>
</div>

<script>
  (function () {
    "use strict";

    // The name, which is the whole of creating a repository here.
    //
    // Prefilled with a random suffix rather than left blank, because the advice
    // this page would otherwise have to give in a sentence — many agents run
    // near-identical prompts at the same time, and a plain name is probably
    // taken — is better given as the default anyone starts from.
    var field = document.getElementById("repo");
    var echo = document.getElementById("repo-echo");

    var chars = "abcdefghjkmnpqrstuvwxyz23456789";
    var suffix = "";
    for (var i = 0; i < 6; i++) suffix += chars[Math.floor(Math.random() * chars.length)];

    // Exactly the grammar the host accepts (shared/protocol.ts): one flat
    // segment, starting alphanumeric. Filtering as it is typed rather than
    // refusing on submit — there is no submit, and a command that cannot work
    // should never appear on screen to be copied.
    var clean = function (value) {
      return value.replace(/[^A-Za-z0-9._-]/g, "").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
    };

    var render = function () {
      echo.textContent = clean(field.value) || "my-thing";
    };

    field.value = "my-thing-" + suffix;
    render();
    var note = document.getElementById("repo-note");
    var noteTimer;
    var say = function (message) {
      note.textContent = message;
      note.setAttribute("data-shown", "1");
      clearTimeout(noteTimer);
      noteTimer = setTimeout(function () {
        note.removeAttribute("data-shown");
      }, 2600);
    };

    field.addEventListener("input", function () {
      var caret = field.selectionStart;
      var cleaned = clean(field.value);
      if (cleaned !== field.value) {
        field.value = cleaned;
        // Typing a character the host would refuse should not also move the
        // caret to the end of what was already typed.
        field.setSelectionRange(caret - 1, caret - 1);
        // And it should not vanish without a word. Silence here reads as a
        // broken keyboard rather than as a rule.
        say("letters, numbers, dot, dash, underscore");
      }
      render();
    });
    // An empty field shows my-thing in the command; leaving it empty should
    // leave the field agreeing with the command rather than blank.
    field.addEventListener("blur", function () {
      if (clean(field.value) === "") field.value = "my-thing";
      render();
    });

    // What a copy button copies is read out of the block it sits next to,
    // rather than repeated here: a command written twice is a command that
    // eventually differs from itself, and the copy is the half nobody checks.
    // The prompt marks and the comment lines are not part of what runs.
    var runnable = function (pre) {
      return pre.textContent
        .split("\\n")
        .map(function (line) { return line.replace(/^\\s*\\$\\s?/, ""); })
        .filter(function (line) { return line.trim() !== "" && line.trim()[0] !== "#"; })
        .join("\\n");
    };

    var copy = function (button) {
      if (!button) return;
      var pre = button.parentNode.querySelector("pre");
      if (!pre) return;
      var text = runnable(pre);
      button.addEventListener("click", function () {
        var done = function () {
          button.textContent = "Copied";
          button.setAttribute("data-done", "1");
          setTimeout(function () {
            button.textContent = "Copy";
            button.removeAttribute("data-done");
          }, 1800);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () {
            button.textContent = "Select it";
          });
        } else {
          button.textContent = "Select it";
        }
      });
    };

    copy(document.getElementById("copy"));
    copy(document.getElementById("copy-watch"));

{{WIRE_SCRIPT}}
  })();
</script>
</body>
</html>
`
