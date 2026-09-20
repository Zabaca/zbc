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
 * enforced limit in both is rendered from one `Capabilities`
 * (`shared/capabilities.ts`), derived from the environment the push path reads
 * and never written as prose. A cap this deployment does not enforce cannot
 * appear in either document, because neither has a constant to state it with.
 *
 * Markdown rather than plain text, following the llms.txt convention: the
 * headings are the index, and a model can skim them without parsing anything.
 */

import type { Capabilities } from './capabilities'
import type { Operator } from './operator'
import { MAX_REFS_PER_ENTRY, MAX_WATCH_ENTRIES } from './events'
import { describeBytes, describeWindow } from './policy'
import { CONTENT_SIGNAL } from './robots'
import {
  CHALLENGE_PATH,
  EVENTS_PATH,
  MCP_PATH,
  PROVENANCE_PATH,
  READ_CHALLENGE_NAMESPACE,
  REPOS_PATH,
  SIGNERS_REF,
} from './protocol'

/** Only GET or HEAD on the one path. Nothing else is this document. */
export function wantsLlms(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  return pathname === '/llms.txt'
}

const hours = (n: number) => (n === 1 ? '1 hour' : `${n} hours`)

export function renderLlms(
  host: string,
  caps: Capabilities,
  /**
   * Who runs this deployment (`shared/operator.ts`), passed beside the
   * capabilities for the reason the host is: nothing here branches on it and
   * the push path never sees it. `null` — nobody named — renders the document
   * this host rendered before there was anywhere to name one.
   */
  operator: Operator | null = null,
): string {
  const ws = `wss://${host}${EVENTS_PATH}`

  const limits: string[] = []
  if (caps.publicAccess) {
    /**
     * The first thing an agent reads about write access, so it is the first
     * thing the gate makes false. It is read from `namesCanRefuse` — the gate
     * alone — unlike `## Hold a name` below, which asks for
     * `namesCanBeClaimed`: the section teaches an agent to claim a name and
     * must not do so where nothing can sign, whereas this sentence only says
     * what `pre-receive` refuses, and `pre-receive` refuses on the flag by
     * itself. On a deployment that sets it without a seed, a claimed name
     * refuses every push, which makes unconditional writability more wrong
     * rather than less.
     */
    limits.push(
      caps.namesCanBePrivate
        ? // The same bullet, corrected in the one place read gating makes it
          // false. Nothing else about it changes: a name with no Reader List
          // is world-readable, which is every name until someone writes one,
          // and the secret warning is the reason the bullet exists.
          '- **No credential.** Reads and writes take no token, no key and no account. Everything here is world-readable unless a name has written a **Reader List**, and a name that has not written a **Signer List** takes a push from anyone — which is every name until someone writes one. Do not push a secret.'
        : caps.namesCanRefuse
          ? '- **No credential.** Reads and writes take no token, no key and no account. Everything here is world-readable, and a name that has not written a **Signer List** takes a push from anyone — which is every name until someone writes one. Do not push a secret.'
          : '- **No credential.** Reads and writes take no token, no key and no account. Everything here is world-readable and world-writable. Do not push a secret.',
    )
  } else {
    limits.push(
      '- **A credential is required.** Send it as the Basic-auth password: `git clone https://walgit:$TOKEN@' +
        host +
        '/my-thing.git`.',
    )
  }
  limits.push(
    '- **A repository is created by its first push.** Names are one segment and first-come. Put a random suffix on the name: many agents run near-identical prompts at the same time, and a taken name means a refused push.',
  )
  if (caps.appendOnly) {
    // The second half is gated for the same reason the bullet above it is:
    // "safe to hand a repository to a stranger: they can build on it" is the
    // same promise of unconditional writability one bullet later, and a list
    // that corrects one entry and leaves the next one contradicting it has not
    // been corrected. What append-only guarantees does not change — who may
    // push at all is what the gate narrows.
    limits.push(
      `- **Refs only move forward.** A push that would rewrite history or delete a ref is refused. Adding a commit or a branch is always allowed. ${
        caps.namesCanRefuse
          ? 'This is what makes it safe to hand an unclaimed name to a stranger: they can build on it and cannot take anything away.'
          : 'This is what makes it safe to hand a repository to a stranger: they can build on it and cannot take anything away.'
      }`,
    )
  }
  if (caps.retentionHours !== null) {
    limits.push(
      `- **A repository is deleted ${hours(caps.retentionHours)} after its LAST push.** Cloning does not extend it; pushing does. This is scratch space. Copy anything that must outlive that window.`,
    )
  }
  if (caps.maxPushBytes !== null) {
    limits.push(
      `- **A single push may not exceed ${describeBytes(caps.maxPushBytes)}.** Refused in \`pre-receive\`, before anything is uploaded.`,
    )
  }
  if (caps.maxRepoBytes !== null) {
    limits.push(`- **One repository may not exceed ${describeBytes(caps.maxRepoBytes)}** in total.`)
  }
  // What one client may spend, as opposed to how big one thing may be
  // (`src/rate-limit.ts`). Stated here because the reader of this document is
  // exactly the client the limit is about: an agent loop reads it once and then
  // pushes in a pattern it has already decided on, and a limit it learns from a
  // refusal is one it learns halfway through that pattern. Each half is stated
  // only where it is enforced, like every bullet above.
  if (caps.sourceLimited) {
    const window = describeWindow(caps.rateWindowSeconds)
    if (caps.maxNewReposPerSource !== null) {
      limits.push(
        `- **You may create ${caps.maxNewReposPerSource} new repositories per client per ${window}.** Pushing to a name you already created does not count against it.`,
      )
    }
    if (caps.maxPushesPerSource !== null) {
      limits.push(
        `- **You may make ${caps.maxPushesPerSource} pushes per client per ${window}.** Commit locally and push once rather than pushing every commit.`,
      )
    }
    if (caps.maxPushBytesPerSource !== null) {
      limits.push(
        `- **You may push ${describeBytes(caps.maxPushBytesPerSource)} per client per ${window}.**`,
      )
    }
    limits.push(
      `- Each of those is refused in \`pre-receive\`, by a message naming the limit — not a transport failure. Waiting out the ${window} is the remedy; retrying immediately is not.`,
    )
  }

  /**
   * The answer to the question the bullet above raises and does not settle: a
   * random suffix is a guess, and `ls-remote` is the one read that turns it
   * into a fact before the push. Prose rather than a list because the outcomes
   * are the shell's, and an agent reads them as a sequence of cases.
   *
   * The 401 case is gated on read gating alone. On a deployment where nothing
   * is private a 401 from this URL is not "taken", and teaching that reading
   * would send an agent to a new name over a transport failure.
   */
  // On a credentialed deployment every unauthenticated read is a 401, so the
  // check has to carry the same credential a clone does or it answers "taken"
  // about every name on the host.
  const lsRemoteUrl = caps.publicAccess ? `https://${host}` : `https://walgit:$TOKEN@${host}`

  const freeNameOutcomes = [
    'Refs listed means the name is taken by a history that is not yours.',
    caps.namesCanBePrivate
      ? 'A `401` is also an answer: taken, and kept private by a **Reader List**.'
      : null,
    `It is not a reservation. Nothing holds a name${
      caps.namesCanRefuse ? ' but a **Signer List**' : ''
    }, and the answer can go stale between the read and the push, so keep the random suffix rather than trusting it.`,
  ]
    .filter((s): s is string => s !== null)
    .join(' ')

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
  const signing = caps.signedPushes
    ? `
## Say who pushed

A push here can carry a **push certificate**: a small signed document naming
the refs it moves and a nonce this host issued. walgit verifies the signature
itself and records the fingerprint of the key that made it.${
        caps.namesCanRefuse
          ? ` A name that has
written a **Signer List** takes pushes from the keys that list names and refuses
everything else; a name nobody has written one for refuses nothing, which is
every name until someone does. *Hold a name*, below, is how one is written.`
          : ' Nothing is refused on the strength of it.'
      }

\`\`\`sh
git -c gpg.format=ssh -c user.signingkey=$HOME/.ssh/id_ed25519.pub \\
    push --signed=if-asked https://${host}/$NAME.git HEAD:refs/heads/main
\`\`\`

Use \`--signed=if-asked\`, not \`--signed=yes\`. It signs where the host takes a
certificate and pushes normally where it does not, so one command is correct
everywhere and an agent never has to branch on which host it is talking to.
\`--signed=yes\` against a host without the capability is refused by your own git
before anything reaches the network.

A sandbox that sets \`gpg.ssh.program\` to a managed signer signs with *its* key
whatever \`user.signingkey\` says, so if the provenance comes back naming a
fingerprint you do not recognise, run
\`git config --show-origin gpg.ssh.program\` before concluding anything worse.

The key costs nothing to provision: if you already push to GitHub over SSH, the
key you push with is the key that signs. There is nothing to register here${
        caps.namesCanRefuse
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
  caps.namesCanRefuse
    ? `**Unsigned pushes are ordinary, until a name says otherwise.** Signing is not
authentication and buys no access by itself: an unsigned push lands exactly as a
signed one does, to the same names, with the same rules, on every name nobody
has claimed — which is every name until someone writes a Signer List for one. A
name that has written one takes pushes from the keys that list names and refuses
everything else, saying so in the refusal.${
        caps.namesCanBePrivate
          ? ` Reads are gated only where a name
has written a **Reader List** — *Keep a name private*, below — and`
          : ` Reads are never gated, a claimed
repository stays world-readable, and`
      } no name is owned by the key that merely
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
    caps.retentionHours === null
      ? 'A lost key ends the name: nobody can push to it again.'
      : `Where a key is lost, ${hours(caps.retentionHours)} without a push collects the repository
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
   *
   * `namesCanBeClaimed`, never the gate alone: with no nonce seed nothing can
   * sign, so every push to a claimed name is refused as unsigned and no client
   * can sign its way out. Teaching an agent to claim a name there would hand it
   * a command that cannot work — the same defect as a cap nothing enforces.
   */
  const ownership = caps.namesCanBeClaimed
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
ssh-keygen -lf $HOME/.ssh/id_ed25519.pub | awk '{print $2}'  > signers
ssh-keygen -lf $HOME/.ssh/id_backup.pub  | awk '{print $2}' >> signers
git add signers
git -c user.email=agent@localhost -c user.name=agent commit -qm claim
git -c gpg.format=ssh -c user.signingkey=$HOME/.ssh/id_ed25519.pub \\
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
        caps.appendOnly
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

${
  caps.namesCanBePrivate
    ? `Holding a name is what makes it possible to close, and closing it is a second
file. *Keep a name private*, below.`
    : `Reads are gated by none of this. A claimed repository, its list and its
provenance stay as readable as they were, to anyone who can read the rest.`
}

### Two lists that are refused

An **empty** list, and one walgit **cannot read**, are refused on claimed and
unclaimed names alike — deleting the ref is the empty case spelled differently.
An empty list would hand the name to the next stranger, which is a way to lose
it rather than a way to release it; an unreadable one would leave you believing
you hold a name the host still thinks is free. To hand a name on, push a list
naming the other key. To stop using it, stop pushing.
`
    : ''

  /**
   * Privacy, taught where an agent went looking for it (docs/adr/0013).
   *
   * The same arrangement ownership got, for the same two reasons: `GET /` is
   * read mid-task against a byte budget and takes nothing, and the refusal —
   * `renderReadChallenge` (`src/private.ts`) — teaches whoever hit it, in our
   * words, at the moment it is relevant. This teaches whoever came looking
   * first, and it is the only place an agent can learn a name is CLOSABLE
   * before it is refused for reading somebody else's.
   *
   * Placed after `## Hold a name` because it depends on it in the strong sense:
   * a Reader List lives in the Signer List's tree and is written by a push that
   * list judged, so the section above is a prerequisite rather than a
   * neighbour. `namesCanBePrivate` encodes exactly that dependency, which is
   * why it is the only flag read here.
   *
   * Every spelling is one the gate actually uses — `readers`, the namespace,
   * the challenge path, the helper's config line — so an agent that reads this
   * and an agent that reads a 401 are not being told about two different
   * mechanisms.
   *
   * The by-hand exchange is shown as well as the helper, and that is not
   * redundancy: a reader who cannot install `@zabaca/agentgit` has no other way
   * in, and the exchange is short enough to be the documentation of the
   * mechanism as well as a fallback.
   */
  const privacy = caps.namesCanBePrivate
    ? `
## Keep a name private

A name that holds a Signer List can also hold a **Reader List**. It is
a file called \`readers\`, beside \`signers\`, on the same \`${SIGNERS_REF}\` commit
chain and in the same format — one fingerprint per line, blank lines and \`#\`
ignored. While that file exists the repository is **Private**: every read of it
— clone, fetch, the provenance read and the event stream — is refused unless
the reader proves a listed key.

Two rules differ from the Signer List, and both are the ones an agent gets
wrong:

- **An empty Reader List is valid.** It is the spelling of *private, and only I
  read it*, and it is the shape most agents want. (An empty Signer List is
  refused, because it hands the name to the next stranger.)
- **Signers read without being listed.** \`readers\` names who may read and not
  write — so to hand work to another agent, list them in \`readers\` and not in
  \`signers\`: they clone and fetch, and they cannot push.

And one thing surprises every agent that does this: **your own pushes are gated
too.** A push begins by asking for \`info/refs?service=git-receive-pack\`, which
hands over every ref name and oid — a read, whatever you meant to do next — so
it is refused like any other. Pushing to a Private name therefore needs the same
credential helper reading it does, and git does not say so: it asks for a
username instead, and with prompts disabled dies with
\`could not read Username for 'https://${host}'\`.

So configure the helper — *Read one*, below — **before** you write \`readers\`,
not after:

\`\`\`sh
git config --global credential.https://${host}.helper '!agentgit credential'
\`\`\`

Write one exactly as you wrote the Signer List — a signed push, judged by the
list that stood before it:

\`\`\`sh
set -e -o pipefail
git fetch -q https://${host}/$NAME.git ${SIGNERS_REF}
git checkout -q FETCH_HEAD
: > readers                                 # empty: only the Signers read
ssh-keygen -lf $HOME/.ssh/id_reader.pub | awk '{print $2}' >> readers
git add readers
git -c user.email=agent@localhost -c user.name=agent commit -qm private
git -c gpg.format=ssh -c user.signingkey=$HOME/.ssh/id_ed25519.pub \\
    push --signed=if-asked https://${host}/$NAME.git HEAD:${SIGNERS_REF}
\`\`\`

Going back is a commit that removes the file. Nothing is retroactive in either
direction: a clone somebody took while the name was world-readable is a clone,
and opening a name again re-publishes nothing that was not already pushed.

### Read one

git signs nothing on a fetch, so the key is proved by a challenge instead. Do it
once per machine and git needs nothing typed afterwards — no account, no token:

\`\`\`sh
bun add -g @zabaca/agentgit   # or npm i -g
git config --global credential.https://${host}.helper '!agentgit credential'
\`\`\`

After that \`git clone\`, \`git fetch\`, \`git push\` and \`agentgit watch\` work on a
Private repository with the key you already sign your pushes with. By hand, if you would
rather see the exchange:

\`\`\`sh
nonce=$(curl -fsS https://${host}${CHALLENGE_PATH} | sed 's/.*"nonce":"\\([^"]*\\)".*/\\1/')
sig=$(printf %s "$nonce" | ssh-keygen -Y sign -n ${READ_CHALLENGE_NAMESPACE} -f ~/.ssh/id_ed25519 -)
fp=$(ssh-keygen -lf $HOME/.ssh/id_ed25519.pub | awk '{print $2}')
git -c http.extraHeader="Authorization: Basic $(printf %s "$fp:$sig" | base64 -w0)" \\
    clone https://${host}/$NAME.git
\`\`\`

The credential is Basic, with the fingerprint as the user and the signature as
the password. The nonce is an HMAC of this host and the clock: it stands for
five minutes, the one before it is still accepted, and nothing is stored — so a
captured signature is good for at most ten minutes and there is no session to
end.

A read that cannot prove a listed key is answered **401 with the challenge**,
never 404. The name is not the secret: a Private repository says it exists, says
it is Private, and says what to run.

### What it does not do

A revoked reader keeps the clone they already have — git has no way to reach
into somebody's working tree, and walgit does not pretend otherwise. Revoking is
a commit removing the line, it takes from the next read onward, and an event
stream reading on the strength of the old list is closed when the push lands.
`
    : ''

  /**
   * Proposals, taught where an agent that has work for a name it may not push
   * to goes looking (docs/adr/0018).
   *
   * Placed after ownership and privacy because it depends on both in the strong
   * sense: a Proposal is the one push a CLAIMED name takes from someone not on
   * its Signer List, and who may propose is exactly who may read — which is
   * everyone on a world-readable name and the Reader List on a Private one.
   * `proposals` encodes that dependency, which is why it is the only flag read
   * here.
   *
   * Every spelling is one the push path actually enforces — the namespace, the
   * target in the ref name, the fast-forward that updates one — so an agent
   * that reads this and an agent that reads the refusal are not being told
   * about two different mechanisms.
   */
  const proposing = caps.proposals
    ? `
## Propose a change

A name that holds a Signer List takes one push from someone it does not name: a
**Proposal**. It is a ref and its signature, and nothing else.

\`\`\`sh
git push --signed=yes https://${host}/$NAME.git HEAD:refs/walgit/proposals/main/fix-auth
\`\`\`

\`main\` is the branch you want it in and must already exist there; \`fix-auth\` is
your own word for the change. The host assigns nothing and stores nothing else:
there is no number to wait for and no record beyond the ref.

- **Whoever may read may propose.** On a world-readable name that is anyone
  whose push is signed; on a Private one it is the Reader List and the Signers.
  There is no third list to be added to.
- **Update it with a fast-forward** to the same ref. A taken id belongs to
  whoever pushed it first — a second pusher is refused as a non-fast-forward,
  and picks another id.
- **Merged is ancestry.** It is merged when the branch's history contains its
  commit, computed when somebody asks and never recorded. A squash or a rebase
  of your commits is a different commit, so it never marks one merged.
- **Nobody accepts it but a Signer.** There is no merge button and no endpoint:
  a Signer fetches it, merges or fast-forwards it in their own tree, and pushes.
  Conflicts are resolved where git resolves them.

Read what is open with \`curl https://${host}/$NAME.git/proposals\` — a JSON array
of \`{ id, target, tip, pusher, merged }\`, behind the same credential a clone of
that name needs. \`git ls-remote https://${host}/$NAME.git 'refs/walgit/proposals/*'\`
lists the same refs without the verdict: the target is in the ref name, so
nothing has to be fetched either way.

${
  caps.events
    ? `If you are watching the branch (below), you do not have to ask twice: the event
for a branch that moved carries \`merged\` — the ids of the Proposals that move
landed — and leaves the field out when it landed none.

`
    : ''
}### Ask to be added to a name

The Signer List is a target like a branch, and it is the only way to ask for a
name you are not listed on. Propose the list itself, with your fingerprint line
added to its \`signers\` file:

\`\`\`sh
git fetch -q https://${host}/$NAME.git refs/walgit/signers
git checkout -q -B ask FETCH_HEAD
ssh-keygen -lf $HOME/.ssh/id_ed25519.pub | awk '{print $2}' >> signers
git add signers && git -c user.email=agent@localhost -c user.name=agent commit -qm ask
git push --signed=yes https://${host}/$NAME.git HEAD:refs/walgit/proposals/walgit/signers/add-me
\`\`\`

\`walgit/signers\` is the target — the ref with \`refs/\` dropped — and \`add-me\` is
your own word for the request, as an id always is. It is the one target that is
not a branch, and every other rule above is unchanged: it is held under
\`refs/walgit/proposals/\` and moves nothing. \`refs/walgit/signers\` is still
written only by a key the list already names, so the list changes when a Signer
accepts your Proposal and not before — and once it has, your next push is judged
by the list it installed.

A Proposal is a push like any other: it is signed, it is append-only, it counts
against the name's size caps, and it cannot be deleted or withdrawn. A target
that does not exist, a target that is neither a branch nor the Signer List, and
a tip that is not a commit are refused before anything is stored.
`
    : ''

  /**
   * Who runs this, in the same place and the same order the page states it
   * (`operatorSection`, `shared/landing.ts`): who, then where to write, then
   * what expires on its own.
   *
   * It is the one fact in this document that is not a capability, and an agent
   * asking who is answerable for a host it is about to push somebody else's
   * work to has nowhere else to read it — the page is HTML and this is the
   * document a harness fetches. Absent whole where nothing is configured, like
   * every other section here.
   */
  const whoRuns =
    operator === null
      ? ''
      : `
## Who runs this

${[
  operator.name === null ? null : `- **Operator.** ${operator.name} runs this deployment.`,
  operator.contact === null
    ? null
    : `- **Contact.** ${operator.contact} — takedowns, abuse and anything else about this host.`,
  caps.retentionHours === null
    ? null
    : `- **Expiry.** A repository is collected ${hours(caps.retentionHours)} after its last push, whether or not anybody asks. Nothing here is archived.`,
]
  .filter((line): line is string => line !== null)
  .join('\n')}
`

  const events = caps.events
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

Use the same credential a clone needs.${
        caps.namesCanBePrivate
          ? ` A watch on a Private repository takes the
same proof a clone of it takes, and is refused whole rather than silently
narrowed — a subscriber left waiting on a repository it will never hear from is
the worse failure. Everything else on this host has a public stream.`
          : ' A public deployment has a public stream.'
      }
`
    : ''

  return `# ${host}

agentgit — a git host for AI agents. Push to a name and the repository exists. There is no account to create, no repository to create first, and no API besides git itself.

Scratch repositories, and the handoff between two agents: handing work to another agent is the URL, and there is nothing else to send.

Smart-HTTP is the only transport.

\`/robots.txt\` says so explicitly: \`Allow: /\` for every agent, and \`Content-Signal: ${CONTENT_SIGNAL}\`. Nothing here asks a crawler to stay away.

## Before you push

${limits.join('\n')}

Whether a name is taken is one read, and it costs nothing to ask:

\`\`\`sh
git ls-remote ${lsRemoteUrl}/$NAME.git    # no output, exit 0: free
\`\`\`

${freeNameOutcomes}

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
${
  // The web view (`shared/repo-list.ts`), named only where it is served.
  // One line, because an agent wants the URL and its shape rather than a
  // tour: the JSON is what a tool reads, and the page is for the person it
  // hands the link to.
  caps.web
    ? `
## See what this host holds

\`\`\`sh
curl https://${host}${REPOS_PATH}${caps.publicAccess ? '' : ' -u walgit:$TOKEN'}
\`\`\`

Every name this host holds, newest push first, a hundred per page (\`?page=2\`) — as JSON here, and as a page in a browser. It names what each one is: last push, refs, size, whether it is claimed${caps.namesCanBePrivate ? ', whether it is Private' : ''} and whether it is being removed.

\`\`\`sh
curl -H 'accept: application/json' https://${host}/$NAME${caps.publicAccess ? '' : ' -u walgit:$TOKEN'}
\`\`\`

One repository: its refs, its default branch and one level of the default branch's tree. \`/$NAME/tree/<ref>/<path>\` is any directory at any ref — a branch name containing slashes resolves, because the host splits the ref from the path against its own Index. Same gate as a clone${caps.namesCanBePrivate ? ', so a Private name is refused here exactly as `info/refs` is' : ''}.

Three more reads on the same split: \`/$NAME/blob/<ref>/<path>\` is one file (up to 1 MiB, otherwise its size alone), \`/$NAME/raw/<ref>/<path>\` is its bytes — always \`text/plain\` or an \`application/octet-stream\` attachment, chosen by content and never by extension — and \`/$NAME/commits/<ref>\` is fifty commits per page with \`?before=<full oid>\` as the cursor.
`
    : ''
}
## Ask this host directly

This host speaks the Model Context Protocol at \`https://${host}${MCP_PATH}\` (Streamable HTTP). There is nothing to install and nothing to spawn — point a client at the URL:

\`\`\`sh
claude mcp add --transport http agentgit https://${host}${MCP_PATH}
\`\`\`

It carries what this host can answer without your disk: \`agentgit_status\` (does a name exist, is it claimed, is it private, what are its refs), \`agentgit_watch\` (block until a ref moves — the handoff primitive, capped at five minutes per call)${
    // Named only where a signature can be made. On a deployment with no nonce
    // seed the tool answers `signer: null` for every ref, which is the honest
    // answer and a useless one to send an agent after.
    caps.signedPushes ? ', `agentgit_provenance` (which key signed the push that moved a ref)' : ''
  }, and this document as the resource \`agentgit://manual\`. Everything that touches a clone stays a shell command, because this host cannot see your tree.
${signing}${ownership}${privacy}${proposing}${events}
## If a push is refused

Read the message. A refusal names what it refused and what to do instead — it is not a transport failure, and retrying the same push unchanged will not help. The usual cause is a name already held by an unrelated history: push to a new one.
${
  caps.namesCanBePrivate
    ? `
One refusal does not reach you as a message, because git eats it:
\`fatal: could not read Username for 'https://${host}'\` — or an interactive
username prompt — means **this name is Private and you have no credential helper
configured**. The push was refused with a 401 on its \`info/refs\` advertisement;
the body names the helper, and git prints none of it. Fix it with the one config
line from *Keep a name private*, above, and push again.
`
    : ''
}${whoRuns}
## What this is not

Not a forge: no pull requests, no code review, no CI, no issues.${
    caps.publicAccess && !caps.namesCanBePrivate
      ? ' Not private: everything here is readable by everyone.'
      : ''
  }${caps.retentionHours !== null ? ` Not permanent: ${hours(caps.retentionHours)} from the last push, a repository is collected.` : ' Not an archive: nothing here is a promise to keep your history.'} Not a place for anything you cannot lose.
`
}
