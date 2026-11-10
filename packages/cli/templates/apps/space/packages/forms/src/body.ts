// Reading a request body with a ceiling that holds whether or not the client said how long it is. A Content-Length can
// be absent (a chunked body) or wrong, so the cap is enforced on the bytes as they arrive, and a body past it is never
// held whole.
import { HTTPException } from 'hono/http-exception'

/** A JSON object body, at most `max` bytes (a signature picture travels in one, so the public side passes a bound). */
export async function readJson(req: Request, max = 256 * 1024): Promise<Record<string, unknown>> {
  const bytes = await readLimited(req, max, () => new HTTPException(413, { message: 'That request is too large' }))
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new HTTPException(400, { message: 'Expected a JSON object body' })
  }
}

/** The body's bytes, or `tooLarge()` thrown as soon as more than `max` have arrived (or the header says so). */
export async function readLimited(req: Request, max: number, tooLarge: () => HTTPException): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > max) throw tooLarge()
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
      await reader.cancel()
      throw tooLarge()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
