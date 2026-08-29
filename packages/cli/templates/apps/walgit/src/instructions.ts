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
 * policy rather than written once as a constant.
 */

export type InstructionsPolicy = {
  /** Reads and writes need no credential. */
  publicAccess?: boolean
  /** Refs only move forward; rewrites and deletions are refused. */
  appendOnly?: boolean
  /** A repository is collected this many hours after its last push. */
  retentionHours?: number
  /** Largest single push, in bytes. */
  maxPushBytes?: number
  /** Largest total size of one repository, in bytes. */
  maxRepoBytes?: number
}

/**
 * Rendered per request rather than baked at boot, because the host an agent
 * must type is the host it reached us on: a deployment behind a proxy, a
 * preview URL and a local test each need the example to work verbatim.
 */
export function renderInstructions(origin: string, policy: InstructionsPolicy = {}): string {
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

  for (const fact of facts(policy)) lines.push(...wrap(`- ${fact}`), '')

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
    'IF A PUSH IS REFUSED',
    '',
    ...wrap(
      'Read the message. A refusal names what it refused and what to do instead; it is not a transport failure, and retrying the same push will not change it. The usual cause is that the name is already held by an unrelated history — push to a new name.',
    ),
    '',
  )

  return `${lines.join('\n')}\n`
}

function facts(policy: InstructionsPolicy): string[] {
  const facts: string[] = [
    policy.publicAccess
      ? 'Everything here is public. Every repository is world-readable and world-writable, by anyone, with no credential. Do not push a secret, a token, or anything you would not publish.'
      : 'This instance requires a credential. Send it as the password of an HTTP basic credential or as a bearer token; the username is ignored.',
    'A repository is created by the first push to its name. Names are a single segment, claimed first-come, and never reassigned.',
  ]

  if (policy.appendOnly) {
    facts.push(
      'Refs are append-only. A push that would rewrite history or delete a ref is refused. You can always add a commit or a branch; nothing can ever be removed. That holds for everyone, so a stranger can build on your work but cannot destroy it.',
    )
  }
  if (policy.retentionHours !== undefined) {
    facts.push(
      `A repository is deleted ${describeHours(policy.retentionHours)} after its LAST PUSH. Cloning does not extend it; pushing does. This is scratch space — copy the work elsewhere if it must outlive that window.`,
    )
  }
  if (policy.maxPushBytes !== undefined) {
    facts.push(`A single push may not exceed ${describeBytes(policy.maxPushBytes)}.`)
  }
  if (policy.maxRepoBytes !== undefined) {
    facts.push(`One repository may not exceed ${describeBytes(policy.maxRepoBytes)} in total.`)
  }

  facts.push(
    'Put a random suffix on the name. Many agents run near-identical prompts at the same time; a plain name is probably taken already, and a taken name means your push is refused.',
  )
  return facts
}

function describeHours(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`
  return `${hours} hour${hours === 1 ? '' : 's'}`
}

/**
 * Both a unit and the raw byte count: an agent comparing its own pack size
 * against this number should never have to guess our rounding.
 */
function describeBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3
  const mib = bytes / 1024 ** 2
  if (gib >= 1) return `${round(gib)} GiB (${bytes} bytes)`
  if (mib >= 1) return `${round(mib)} MiB (${bytes} bytes)`
  return `${bytes} bytes`
}

const round = (n: number) => String(Math.round(n * 100) / 100)

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
