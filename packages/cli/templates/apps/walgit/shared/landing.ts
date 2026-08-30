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
 * The one argument the two commands in the hero do not already make, and the
 * client that acts on it.
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
        <h2>And nobody configures a webhook.</h2>
        <p>The last wall is finding out that something moved. On a forge that is a webhook: repository admin, a public HTTPS endpoint, a secret, a handler to keep running. An agent in a sandbox has no address to deliver one to — no ingress, no stable hostname, often nothing listening at all — so it is not a setup problem, it is a direction problem.</p>
        <p><strong>So the connection goes the other way.</strong> The agent opens a socket outbound and names the refs it cares about. The reply is the current sha of every one of them, and after that one message per ref that moves and nothing in between — no cursor, no replay, no timer.</p>
      </div>
      <div class="split-show panel">
        <div class="panel-head">
          <span><span class="pulse"></span>${socket}</span>
        </div>
        <pre class="tx"><span class="p">-&gt;</span> {"watch":[{"repo":"study-42",
        "refs":["refs/heads/main"]}]}

<span class="ok">&lt;- {"ok":true,"refs":[{"repo":"study-42",
        "ref":"refs/heads/main","sha":"a1b2c3…"}]}</span>

<span class="c"># the other agent pushes. no webhook, no polling.</span>

<span class="ok">&lt;- {"repo":"study-42","ref":"refs/heads/main",
        "sha":"d4e5f6…"}</span><span class="caret"></span></pre>
        <div class="panel-foot">Opened from the inside, so a sandbox needs no address.</div>
      </div>
    </section>

    <section>
      <h2>The whole client.</h2>
      <p>Run it in a clone and there is nothing left to decide: the remote names the host and the repository, and the branch you are on names the ref. It fetches, and nothing else — your branch, your working tree and any work in progress are left alone.</p>
      <div class="term term-solo">
        <pre id="watch-cmd"><span class="p">$</span> bunx @zabaca/agentgit watch</pre>
        <button class="copy" id="copy-watch" type="button" aria-label="Copy the watch command">Copy</button>
      </div>
      <p class="under">Or <span>npx @zabaca/agentgit watch</span> · no dependencies · <span>--once</span> exits when the handoff lands</p>
      <p>And the question it answers that a fetch alone does not: <strong>does what just arrived collide with what you are in the middle of?</strong> Uncommitted work is exactly the case worth warning about, and it is the case a plain merge check cannot see — so it is checked against your working tree, and reported when it changes rather than on every push.</p>
      <div class="panel">
        <div class="panel-head">
          <span>a push lands on work in progress</span>
          <span>real output</span>
        </div>
        <pre class="tx"><span class="p">$</span> bunx @zabaca/agentgit watch --json
<span class="c">{"event":"watching","host":"${facts.host}","repos":["study-42"]}</span>
<span class="ok">{"event":"fetched","ref":"refs/heads/main","sha":"d4e5f6…","current":true}</span>
<span class="no">{"event":"collides","ref":"refs/heads/main","paths":["src/index.ts"]}</span></pre>
        <div class="panel-foot">
          There is still no SDK: the protocol is one socket and one message, and
          this is a convenience over it. The four lines it replaces are on
          <a href="/llms.txt">/llms.txt</a>, along with <code>git merge-tree</code>
          and <code>git stash create</code>, which are what it runs.
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
      "<b>A push signed with your key records that key's fingerprint.</b> Nothing is refused for being unsigned, and there is still no account: the fingerprint is the whole identity. <code>git push --signed=if-asked</code>.",
    )
  )
}

export function renderLanding(facts: LandingFacts): string {
  return PAGE.replaceAll('{{HOST}}', facts.host)
    .replace('{{SIGNING_CLAIM}}', signingClaim(facts))
    .replace('{{THIRD_CLAIM}}', thirdClaim(facts))
    .replace('{{EVENTS}}', eventsSection(facts))
    .replace('{{PERMANENCE}}', permanence(facts))
}

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
    --faint:  #756a62;
    --copper: #c56a3e;      /* fresh metal */
    --verdi:  #4e9e8b;      /* what copper becomes with age */

    --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
    --serif: "Newsreader", Georgia, "Times New Roman", serif;
  }

  * { box-sizing: border-box; }

  html { -webkit-text-size-adjust: 100%; }

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

  .cta-label {
    font-size: .68rem;
    letter-spacing: .13em;
    text-transform: uppercase;
    color: var(--faint);
    margin: 0 0 .6rem;
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

  .yours {
    font-size: .74rem;
    color: var(--faint);
    margin: 0;
  }
  .yours code { color: var(--verdi); }

  /* ── panels ───────────────────────────────────────────── */

  .panel { border: 1px solid var(--rule-2); background: var(--raised); }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
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

  /* The one argument, and the wire beside it rather than under it: the prose
     and the thing it describes are read together or not at all. */
  .split {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0 2.5rem;
    align-items: start;
  }
  .split-say p { max-width: 44ch; margin-bottom: 1rem; }
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
    .split { grid-template-columns: 1fr; gap: 2rem 0; }
    .split-say p { max-width: 58ch; }
  }

  @media (max-width: 34rem) {
    .claims li { grid-template-columns: 1fr; gap: .25rem; }
    .road { grid-template-columns: 1fr; }
    .term { grid-template-columns: 1fr; }
    .copy { border-left: 0; border-top: 1px solid var(--rule-2); padding: .8rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .tx .caret { animation: none; }
    * { transition: none !important; }
  }
</style>
</head>
<body>
<div class="wrap">

  <main>
    <span class="badge">Open source — run your own</span>

    <h1>Git for AI agents<span class="dot">.</span></h1>

    <p class="lede">Your agent writes code all day and has nowhere of its own to put it. <em>Push to a name and the repository exists</em> — no account, no key, no API besides git itself.</p>

    <div class="cta">
      <p class="cta-label">Give this to your agent</p>
      <div class="term">
        <pre id="cmd"><span class="c"># there is no SDK. there is no signup.</span>
<span class="p">$</span> git remote add agentgit https://{{HOST}}/my-thing.git
<span class="p">$</span> git push agentgit main</pre>
        <button class="copy" id="copy" type="button" aria-label="Copy the two commands">Copy</button>
      </div>
    </div>
    <p class="under">No account · <span>No token</span> · No key · <span>Handing work over is the URL</span></p>
    <p class="yours">Yours for the taking: <code id="mine">{{HOST}}/visitor-…</code></p>
{{EVENTS}}
    <section>
      <h2>The terms, in full.</h2>
      <ul class="claims">
        <li><span class="k">Append-only</span><span class="v"><b>Nothing you push can be destroyed.</b> Anyone may add; no one may rewrite or delete. A push that would rewrite history is refused in <code>pre-receive</code>, before anything is uploaded, by a message naming what to do instead.</span></li>
        <li><span class="k">Public</span><span class="v"><b>Every repository is world-readable and world-writable.</b> Sharing is a URL, not an invitation. Privacy is not free yet.</span></li>
        <li><span class="k">Durable</span><span class="v"><b>A push is in object storage before it is acknowledged.</b> The server's disks are a cache; losing the machine loses nothing.</span></li>
{{THIRD_CLAIM}}{{SIGNING_CLAIM}}
      </ul>
    </section>

    <section>
      <h2>On the way.</h2>
      <p>What is missing, in the order it unblocks itself. Nothing here is a date, and each one is written down before it is built.</p>
      <ul class="road">
        <li data-next>
          <span class="when">Next</span>
          <h3>Ownership</h3>
          <p>Claiming a name. Who pushed is already recorded; what is missing is the policy that says the first key to push a name keeps it — and un-claiming is a decision nobody will agree on, so it is the one row here that is hard to take back.</p>
        </li>
        <li>
          <span class="when">After ownership</span>
          <h3>Private</h3>
          <p>There is nobody to be private from until a name has an owner. Reads gated on the same fingerprint that already gets recorded, and not before ownership means something.</p>
        </li>
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
    <span>Agents: <code>/llms.txt</code></span>
    <span>Run your own: <code>zbc add walgit</code></span>
  </footer>
</div>

<script>
  (function () {
    "use strict";

    // A repo name that is yours for this visit.
    var chars = "abcdefghjkmnpqrstuvwxyz23456789";
    var id = "";
    for (var i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
    document.getElementById("mine").textContent = "{{HOST}}/visitor-" + id + ".git";

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
  })();
</script>
</body>
</html>
`
