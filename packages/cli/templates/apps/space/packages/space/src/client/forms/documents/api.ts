// The admin's side of the document routes (src/routes/documents.ts). Its own file, so the shared api.ts is not touched; it reuses
// that file's two errors, so a screen treats a sign-in that has ended the same way everywhere.
import type { PreparedField } from '@space/forms/src/fields'
import type { DocumentDetail, DocumentSummary } from '@space/forms/src/documents/shared'
import { ApiError, SignedOut, lostConnection } from '../api'
import { API_BASE } from '../session'

/** An upload the server asked a question about: `code` says what, and `confirm` which confirmations are still wanted. */
export class UploadRefused extends ApiError {
  constructor(
    message: string,
    status: number,
    readonly code: string,
    readonly confirm: ('restrictions' | 'signatures')[],
  ) {
    super(message, status)
  }
}

async function call<T>(method: string, path: string, init: { json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<T> {
  // A header that cannot be built (a character past Latin-1) throws a TypeError, which is also how a dead sign-in looks to fetch, so it is
  // caught here and said as what it is.
  let headers: Headers
  try {
    headers = new Headers({ ...(init.json === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers })
  } catch {
    throw new Error('That request could not be sent: one of its headers holds a character a header cannot carry.')
  }
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers, body: init.json === undefined ? init.body : JSON.stringify(init.json) })
  } catch {
    throw await lostConnection()
  }
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    // Not JSON: Access's own page, most likely.
  }
  if (!res.ok) {
    const body = parsed as { error?: string; code?: string; confirm?: ('restrictions' | 'signatures')[] } | null
    if (res.status === 401 || (!body?.error && res.redirected)) throw new SignedOut()
    if (body?.code) throw new UploadRefused(body.error ?? `The request failed (${res.status})`, res.status, body.code, body.confirm ?? [])
    throw new ApiError(body?.error ?? `The request failed (${res.status})`, res.status)
  }
  if (parsed === null && text) throw new SignedOut()
  return parsed as T
}

export interface DocumentList {
  documents: DocumentSummary[]
  /** The engine's own limits, so a screen says the same numbers the server holds. */
  limits: { maxBytes: number; maxPages: number }
}

export interface UploadInput {
  clientId: string
  file: File
  name: string
  password?: string
  confirm?: string[]
}

export const documents = {
  list: (client?: string) => call<DocumentList>('GET', `/documents${client ? `?client=${encodeURIComponent(client)}` : ''}`),
  get: (id: string) => call<DocumentDetail>('GET', `/documents/${id}`),
  upload: (i: UploadInput) =>
    call<DocumentDetail>('POST', `/documents?client=${encodeURIComponent(i.clientId)}`, {
      body: i.file,
      headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(i.name), ...(i.password ? { 'x-pdf-password': encodeURIComponent(i.password) } : {}), ...(i.confirm?.length ? { 'x-confirm': i.confirm.join(',') } : {}) },
    }),
  place: (id: string, fields: PreparedField[]) => call<DocumentDetail>('PUT', `/documents/${id}/fields`, { json: { fields } }),
  rename: (id: string, name: string) => call<DocumentDetail>('PATCH', `/documents/${id}`, { json: { name } }),
  remove: (id: string) => call<{ deleted: true }>('DELETE', `/documents/${id}`),
  pdfUrl: (id: string) => `${API_BASE}/documents/${id}/pdf`,
}
