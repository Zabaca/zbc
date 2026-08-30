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

/**
 * The third headline claim.
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

const claim = (key: string, value: string) =>
  `      <li><span class="k">${key}</span><span class="v">${value}</span></li>`

/** The permanence sentence, which turns on the same variable as the claim. */
function permanence(facts: LandingFacts): string {
  return facts.retentionHours === null
    ? 'Not an archive: a repository here is a working surface, and nothing about this service is a promise to keep your history.'
    : `Not permanent: ${describeHours(facts.retentionHours)} from the last push, a repository is collected.`
}

/**
 * The stream, on the page.
 *
 * The same capability `GET /` describes in plain text, argued rather than
 * specified: a person landing here wants to know that the polling loop goes
 * away, and the protocol detail is one line of JSON below it. Absent entirely
 * when the deployment serves no stream, so nobody writes a client against a
 * section rather than against a socket.
 */
/**
 * The three acts, and the one terminal that plays them.
 *
 * It is one story, so it gets one illustration: the argument scrolls on the
 * left, a terminal holds its place on the right, and what it is showing
 * changes as each act is reached. The agent cannot sign up, so it pushes; it
 * has to hand work over, so it sends a URL; it has to know when that moved, so
 * it opens a socket.
 *
 * The third act exists only where the deployment serves the stream, for the
 * same reason every limit on this page is rendered rather than written: an act
 * describing a socket that answers 404 is a lie told at the top of the funnel.
 * Assembled here rather than in the template because a static block cannot drop
 * its middle third.
 */
function storySection(facts: LandingFacts): string {
  const socket = `wss://${facts.host}${EVENTS_PATH}`

  const webhookAct = `
        <section class="act">
          <h2>And nobody configures a webhook.</h2>
          <p>The last wall is finding out that something moved. On a forge that is a webhook: repository admin, a public HTTPS endpoint, a secret, a handler to keep running. An agent in a sandbox has no address to deliver one to — no ingress, no stable hostname, often nothing listening at all — so it is not a setup problem, it is a direction problem.</p>
          <p><strong>So the connection goes the other way.</strong> The agent opens a socket outbound and names the refs it cares about. The reply is the current sha of every one of them, and after that one message per ref that moves and nothing in between — no cursor, no replay, no timer.</p>
        </section>`

  const wireScene = `
          <div class="scene panel" data-scene="2">
            <div class="panel-head">
              <span><span class="pulse"></span>${socket}</span>
              <span>on the wire</span>
            </div>
            <pre class="tx" data-play><span class="ln" style="--i:0"><span class="p">-&gt;</span> {"watch":[{"repo":"study-42","refs":["refs/heads/main"]}]}
</span><span class="ln" style="--i:1"><span class="ok">&lt;- {"ok":true,"refs":[{"repo":"study-42","ref":"refs/heads/main","sha":"a1b2c3…"}]}</span>
</span><span class="ln" style="--i:2">
<span class="c"># the other agent pushes. no webhook, no polling.</span>
</span><span class="ln" style="--i:3"><span class="ok">&lt;- {"repo":"study-42","ref":"refs/heads/main","sha":"d4e5f6…"}</span><span class="caret"></span></span></pre>
            <div class="panel-foot">Opened from the inside, so a sandbox needs no address.</div>
          </div>`

  const client = `
    <section>
      <h2>The whole client.</h2>
      <p>The useful thing to do with each message is fetch, which is a background process small enough to paste. No cursor, no state file, no keepalive — if it drops, the reply to its next <code>watch</code> is current state.</p>
      <div class="panel">
        <div class="panel-head">
          <span>keep a clone current</span>
          <span>four lines</span>
        </div>
        <pre class="tx">bun -e 'const w=new WebSocket("${socket}")
  w.onopen=()=&gt;w.send(JSON.stringify({watch:[{repo:"my-thing"}]}))
  w.onmessage=e=&gt;JSON.parse(e.data).ok||Bun.spawnSync(["git","fetch"])
  w.onclose=()=&gt;process.exit(75)' &amp;</pre>
      </div>
      <p>And the question worth asking once it lands: <strong>does what just arrived collide with what you are in the middle of?</strong> git answers that without touching your working tree — <code>stash create</code> is what makes it see uncommitted work, since <code>merge-tree</code> compares commits and mid-task edits are invisible to it otherwise.</p>
      <div class="panel">
        <div class="panel-head">
          <span>did it land on top of me</span>
          <span>exit 1 = yes, and which files</span>
        </div>
        <pre class="tx">WIP=$(git stash create)
git merge-tree --write-tree --name-only \${WIP:-HEAD} origin/main</pre>
      </div>
    </section>
`

  return `    <div class="story">
      <div class="acts">
        <section class="act">
          <h2>Your agent cannot sign up.</h2>
          <p>Every forge starts with an account: an email, a password, a second factor, a key to generate and register. All of it assumes a person, and an agent has none of it — so the work stops and waits for a human, or it stays on a disk that gets thrown away with the sandbox.</p>
          <p>Agents are getting their own identities everywhere else. They have their own inboxes now, and it turned out that mattered more than anyone expected. <strong>Here, the push is the signup.</strong> The first push to a name creates the repository, and the agent's remote is its own from the first second.</p>
        </section>

        <section class="act">
          <h2>A handoff is a URL.</h2>
          <p>Agents work in parallel and hand things to each other. On a forge that means an owner, an invitation, a permission model and a review before anything can move — machinery built so people can safely disagree about a shared branch.</p>
          <p>This is built the other way: <strong>anyone can push, and refs only move forward.</strong> One agent pushes, sends another the URL, and the second is working. Nothing to grant, nobody to add. Append-only is what makes that safe to do — a rewrite or a deletion is refused, so nothing anyone builds on can be pulled out from under them.</p>
        </section>
${facts.events ? webhookAct : ''}
      </div>

      <div class="stage">
        <div class="scenes">
          <div class="scene panel on" data-scene="0">
            <div class="panel-head">
              <span>the part where it stops</span>
              <span>every time</span>
            </div>
            <pre class="tx" data-play><span class="ln" style="--i:0"><span class="you">&gt;</span> <span class="say">save this somewhere I won't lose it</span>
</span><span class="ln" style="--i:1">
<span class="p">●</span> Bash(git push -u origin main)
</span><span class="ln" style="--i:2">  <span class="no">remote: Repository not found.
  fatal: repository 'https://github.com/you/thing.git/' not found</span>
</span><span class="ln" style="--i:3">
<span class="p">●</span> I can't create the repository myself — that needs a
  GitHub account, and signing up needs an email and a
  second factor I don't have.
</span><span class="ln" style="--i:4">
  Can you create it and add me? I'll wait.<span class="caret"></span></span></pre>
            <div class="panel-foot">Here, instead: <code>git push https://${facts.host}/thing.git main</code></div>
          </div>

          <div class="scene panel" data-scene="1">
            <div class="panel-head">
              <span>two agents, no accounts</span>
              <span>the whole ceremony</span>
            </div>
            <pre class="tx" data-play><span class="ln" style="--i:0"><span class="c"># agent one, on some machine</span>
<span class="p">$</span> git push https://${facts.host}/study-42.git main
<span class="ok"> * [new branch]      main -&gt; main</span>
</span><span class="ln" style="--i:1">
<span class="c"># the handoff. this is the entire handoff.</span>
<span class="say">  https://${facts.host}/study-42.git</span>
</span><span class="ln" style="--i:2">
<span class="c"># agent two, somewhere else, ten seconds later</span>
<span class="p">$</span> git clone https://${facts.host}/study-42.git
<span class="ok">Cloning into 'study-42'... done.</span>
</span><span class="ln" style="--i:3"><span class="p">$</span> git push origin HEAD:refs/heads/review
<span class="ok"> * [new branch]      review -&gt; review</span><span class="caret"></span></span></pre>
            <div class="panel-foot">No owner, no invitation, nothing to grant.</div>
          </div>
${facts.events ? wireScene : ''}
        </div>
        <ul class="stage-mark" aria-hidden="true">
          <li class="on"></li><li></li>${facts.events ? '<li></li>' : ''}
        </ul>
      </div>
    </div>
${facts.events ? client : ''}`
}

export function renderLanding(facts: LandingFacts): string {
  return PAGE.replaceAll('{{HOST}}', facts.host)
    .replace('{{THIRD_CLAIM}}', thirdClaim(facts))
    .replace('{{EVENTS}}', storySection(facts))
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
    max-width: 54rem;
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
    max-width: 34ch;
    margin: 0 0 2.75rem;
  }
  .lede em { font-style: normal; color: var(--copper); }

  /* ── the three claims ─────────────────────────────────── */

  .claims {
    list-style: none;
    margin: 0 0 4.5rem;
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
  .claims dt, .claims .k {
    font-size: .68rem;
    letter-spacing: .13em;
    text-transform: uppercase;
    color: var(--verdi);
  }
  .claims .v { color: var(--muted); font-size: .95rem; }
  .claims .v b { color: var(--bone); font-weight: 500; }

  /* ── the command, which is the CTA ────────────────────── */

  .cta { margin: 0 0 1rem; }

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
    font-size: .72rem;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--faint);
    margin: 0 0 3.25rem;
  }
  .under span { color: var(--muted); }

  /* ── the log ──────────────────────────────────────────── */

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

  .log { margin: 0; padding: .4rem 0; list-style: none; max-height: 19rem; overflow: hidden; }
  .log li {
    display: grid;
    grid-template-columns: 4.6rem 1fr auto;
    gap: 0 1rem;
    align-items: baseline;
    padding: .42rem 1rem;
    font-size: .78rem;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    animation: land .34s ease-out both;
  }
  .log .seq { color: var(--faint); }
  .log .repo { color: var(--bone); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .log .ago { color: var(--faint); font-size: .72rem; }
  .log li.fresh .repo { color: var(--copper); }

  @keyframes land {
    from { opacity: 0; transform: translateY(-.4rem); }
    to   { opacity: 1; transform: none; }
  }

  .panel-foot {
    border-top: 1px solid var(--rule-2);
    padding: .85rem 1rem;
    font-size: .74rem;
    color: var(--faint);
  }
  .panel-foot code { color: var(--verdi); font-size: .78rem; }

  /* ── prose sections ───────────────────────────────────── */

  section { margin-top: 4.5rem; }

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
    margin: 0 0 1rem;
  }
  section p strong { color: var(--bone); font-weight: 400; }

  /* ── the three acts, and the one terminal that plays them ─────────────── */

  .story {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.08fr);
    gap: 0 3rem;
    align-items: start;
    margin-top: 4.5rem;
  }
  .acts .act { margin-top: 0; padding: 4.5rem 0; }
  .acts .act:first-child { padding-top: 0; }
  .acts .act p { max-width: 46ch; }

  .stage { position: sticky; top: 5rem; }
  /* One grid cell for every scene, so the frame is as tall as the tallest and
     never resizes under the reader when the act changes. */
  .scenes { display: grid; }
  .scenes > .scene { grid-area: 1 / 1; }

  .scene {
    opacity: 0;
    visibility: hidden;
    transform: translateY(.5rem);
    transition: opacity .35s ease, transform .35s ease, visibility 0s linear .35s;
  }
  .scene.on {
    opacity: 1;
    visibility: visible;
    transform: none;
    transition: opacity .35s ease, transform .35s ease, visibility 0s;
  }

  .stage-mark { display: flex; gap: .4rem; margin: .9rem 0 0; padding: 0; list-style: none; }
  .stage-mark li { height: 2px; width: 2.2rem; background: var(--rule-2); transition: background .3s ease; }
  .stage-mark li.on { background: var(--copper); }

  /* A transcript arrives a line at a time when its scene does, because a
     terminal is something that happens rather than something that is. Lines
     are visible until script arms them, so no-JS reads the whole thing. */
  .tx.armed > span.ln { opacity: 0; }
  .tx.play > span.ln { animation: ln .26s ease-out both; animation-delay: calc(var(--i) * 220ms); }
  @keyframes ln {
    from { opacity: 0; transform: translateY(.28rem); }
    to   { opacity: 1; transform: none; }
  }
  .tx .caret {
    display: inline-block;
    width: .52em; height: 1em;
    background: var(--copper);
    vertical-align: -.14em;
    animation: blink 1.05s steps(1) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
  .tx .you { color: var(--copper); }
  .tx .say { color: var(--bone); }

  @media (max-width: 62rem) {
    /* No room for two columns, so the terminal stops holding its place: every
       scene is simply shown, in order, under the acts. */
    .story { grid-template-columns: 1fr; gap: 0; }
    .acts .act { padding: 2.75rem 0 1.25rem; }
    .acts .act p { max-width: 58ch; }
    .stage { position: static; }
    .scenes { display: block; }
    .scenes > .scene { opacity: 1; visibility: visible; transform: none; margin-bottom: 1.5rem; }
    .stage-mark { display: none; }
  }

  .not {
    border-left: 2px solid var(--copper);
    padding-left: 1.2rem;
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

  @media (prefers-reduced-motion: reduce) {
    .log li { animation: none; }
    .tx.armed > span.ln, .tx.play > span.ln { opacity: 1; animation: none; }
    .tx .caret { animation: none; }
    .scene { transition: none; }
    * { transition: none !important; }
  }

  @media (max-width: 34rem) {
    .claims li { grid-template-columns: 1fr; gap: .25rem; }
    .log li { grid-template-columns: 3.4rem 1fr; }
    .log .ago { display: none; }
    .term { grid-template-columns: 1fr; }
    .copy { border-left: 0; border-top: 1px solid var(--rule-2); padding: .8rem; }
  }

  /* The transcript panel — replaces the artifact's animated log. Real output,
     so it is a <pre> that scrolls rather than a list that moves. */
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
  .tx .no { color: var(--bone); }
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
    <p class="under">No account · <span>No token</span> · No key</p>

    <div class="panel">
      <div class="panel-head">
        <span>What append-only looks like</span>
        <span>real output</span>
      </div>
      <pre class="tx"><span class="p">$</span> git push agentgit main
<span class="ok">To https://{{HOST}}/my-thing.git
 * [new branch]      main -&gt; main</span>

<span class="c"># now try to rewrite what you just pushed</span>
<span class="p">$</span> git commit --amend -m "rewritten" &amp;&amp; git push agentgit +main
<span class="no">remote: walgit: refused — my-thing is append-only.
remote:
remote: This push would rewrite refs/heads/main: its current commits are not in
remote: what you pushed.
remote: Anyone can push here, so nothing that has landed can be removed or replaced.
remote:
remote: What you can do instead:
remote:   - push to a new branch:      git push origin HEAD:refs/heads/&lt;new-branch&gt;
remote:   - or use a fresh repository: git remote set-url origin &lt;same-host&gt;/my-thing-3f9c2a71.git
remote:
remote: Nothing was uploaded; the repository is unchanged.
 ! [remote rejected] main -&gt; main (pre-receive hook declined)</span></pre>
      <div class="panel-foot">
        Yours for the taking: <code id="mine">{{HOST}}/visitor-…</code>
      </div>
    </div>

{{EVENTS}}    <section>
      <h2>The terms, in full.</h2>
      <ul class="claims">
        <li><span class="k">Append-only</span><span class="v"><b>Nothing you push can be destroyed.</b> Anyone may add; no one may rewrite or delete.</span></li>
        <li><span class="k">Public</span><span class="v"><b>Every repository is world-readable and world-writable.</b> Sharing is a URL, not an invitation. Privacy is not free yet.</span></li>
        <li><span class="k">Durable</span><span class="v"><b>A push is in object storage before it is acknowledged.</b> The server's disks are a cache; losing the machine loses nothing.</span></li>
{{THIRD_CLAIM}}
      </ul>
    </section>

    <section class="not">
      <h2>What it is not.</h2>
      <p>Not a forge: no pull requests, no code review, no CI, no issues. Not private: everything here is readable by everyone, and that is the free tier's defining property rather than an oversight. {{PERMANENCE}}</p>
      <p>Not a place for anything you cannot lose.</p>
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

    // A repo name that is yours for this visit.
    var chars = "abcdefghjkmnpqrstuvwxyz23456789";
    var id = "";
    for (var i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
    document.getElementById("mine").textContent = "{{HOST}}/visitor-" + id + ".git";

    // The stage: whichever act is nearest the middle of the screen decides what
    // the terminal is showing. Nothing here changes what the page SAYS — with
    // no script, or with reduced motion asked for, every scene is visible and
    // every transcript is whole, which is why the CSS hides them only once this
    // has run.
    var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var acts = [].slice.call(document.querySelectorAll(".acts .act"));
    var scenes = [].slice.call(document.querySelectorAll(".scene"));
    var marks = [].slice.call(document.querySelectorAll(".stage-mark li"));
    var wide = window.matchMedia && window.matchMedia("(min-width: 62.01rem)").matches;

    if (!still && wide && acts.length && acts.length === scenes.length && "IntersectionObserver" in window) {
      document.querySelectorAll("[data-play]").forEach(function (el) { el.classList.add("armed"); });

      var show = function (i) {
        scenes.forEach(function (scene, n) { scene.classList.toggle("on", n === i); });
        marks.forEach(function (mark, n) { mark.classList.toggle("on", n === i); });
        var tx = scenes[i].querySelector("[data-play]");
        // Played once each: a transcript that restarted every time it came back
        // would read as a loop rather than as something that happened.
        if (tx) tx.classList.add("play");
      };
      show(0);

      var current = 0;
      var pick = function () {
        var middle = window.innerHeight / 2;
        var best = current;
        var bestGap = Infinity;
        acts.forEach(function (act, i) {
          var box = act.getBoundingClientRect();
          var gap = Math.abs(box.top + box.height / 2 - middle);
          if (gap < bestGap) { bestGap = gap; best = i; }
        });
        if (best !== current) { current = best; show(best); }
      };

      var ticking = false;
      var onScroll = function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(function () { pick(); ticking = false; });
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll, { passive: true });
      pick();
    }

    // Copy the two commands, without the prompt marks or the comment.
    var btn = document.getElementById("copy");
    btn.addEventListener("click", function () {
      var text = "git remote add agentgit https://{{HOST}}/my-thing.git\\ngit push agentgit main";
      var done = function () {
        btn.textContent = "Copied";
        btn.setAttribute("data-done", "1");
        setTimeout(function () {
          btn.textContent = "Copy";
          btn.removeAttribute("data-done");
        }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { btn.textContent = "Select it"; });
      } else {
        btn.textContent = "Select it";
      }
    });
  })();
</script>
</body>
</html>
`
