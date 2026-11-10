// How the page talks to the Worker: a read that tells a sign-in that ended from the network, and a write that gives back what came, whatever it was.

export type Problem = 'signin' | 'network'

export type Fetched<T> = { ok: true; value: T } | { ok: false; problem: Problem; status?: number; message?: string }

/**
 * A read of the Worker. A sign-in that ended arrives as a 401 or as Access's redirect (opaque, with `redirect: 'manual'`), and is told apart from
 * the network. A refusal the Worker made in words (`{ error }`) is carried, so the page can say it.
 */
export async function read<T>(url: string, signal?: AbortSignal): Promise<Fetched<T>> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'manual', cache: 'no-store', ...(signal && { signal }) })
    if (res.type === 'opaqueredirect' || res.status === 401) return { ok: false, problem: 'signin' }
    if (!res.ok) {
      let message: string | undefined
      try {
        const body = (await res.json()) as { error?: unknown }
        if (typeof body.error === 'string') message = body.error
      } catch {
        // not JSON: the status is all there is
      }
      return { ok: false, problem: 'network', status: res.status, ...(message !== undefined && { message }) }
    }
    return { ok: true, value: (await res.json()) as T }
  } catch {
    return { ok: false, problem: 'network' }
  }
}

/**
 * A write. What came back is returned as it is, for compose.ts to classify (`outcomeOf`): a write the page cannot tell the end of must not be
 * made to look like a failure that can be tried again. Never follows a redirect (Access's sign-in is one), never reads the cache.
 */
export async function writeForm(url: string, body: unknown, files: readonly File[]): Promise<{ status: number; type: string; body: unknown } | 'network'> {
  const form = new FormData()
  form.set('json', JSON.stringify(body))
  for (const f of files) form.append('file', f, f.name)
  try {
    const res = await fetch(url, { method: 'POST', headers: { accept: 'application/json', 'x-space-write': '1' }, body: form, redirect: 'manual', cache: 'no-store' })
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      // an answer that is not JSON is read by the caller as what it is: not an outcome
    }
    return { status: res.status, type: res.type, body: parsed }
  } catch {
    return 'network'
  }
}

export async function write(url: string, body: unknown): Promise<{ status: number; type: string; body: unknown } | 'network'> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), redirect: 'manual', cache: 'no-store' })
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      // an answer that is not JSON is read by the caller as what it is: not an outcome
    }
    return { status: res.status, type: res.type, body: parsed }
  } catch {
    return 'network'
  }
}
