// The admin's calls for the form path: forms and their versions, and reading what a filler answered. The same shape as
// api.ts (same-origin, Access's cookie rides along; a session that ended shows as `SignedOut`).
import type { FormDefinition } from '@space/forms/src/forms/definition'
import { ApiError, SignedOut, lostConnection } from './api'
import { API_BASE } from './session'

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
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
    const message = (parsed as { error?: string } | null)?.error
    if (res.status === 401 || (!message && res.redirected)) throw new SignedOut()
    throw new ApiError(message ?? `The request failed (${res.status})`, res.status)
  }
  if (parsed === null && text) throw new SignedOut()
  return parsed as T
}

export interface FormSummary {
  id: string
  client_id: string
  client_name: string
  title: string
  updated_at: string
  published: { id: string; version: number; published_at: string; roles: string[]; sensitive: boolean; questions: number } | null
  draft: { id: string; version: number } | null
}

export interface FormVersion {
  id: string
  version: number
  definition_hash: string
  published_at: string | null
  created_at: string
}

export interface FormDetail {
  form: { id: string; client_id: string; client_name: string; title: string; created_at: string; updated_at: string }
  versions: FormVersion[]
  /** The draft, or the newest published version when there is no draft: what the builder edits. */
  working: { versionId: string; version: number; published: boolean; definition: FormDefinition }
}

export interface AnswerItem {
  id: string
  label: string
  type: string
  sensitive: boolean
  answered: boolean
  value: string | null
}

export type AnswersView =
  | { form: false }
  | {
      form: true
      title: string
      version: { number: number; hash: string }
      items: AnswerItem[]
      uploads: { id: string; question_id: string; name: string; content_type: string; size: number; sha256: string }[]
      documentReady: boolean
    }

export const formsApi = {
  forms: (client?: string) => call<FormSummary[]>('GET', `/forms${client ? `?client=${encodeURIComponent(client)}` : ''}`),
  form: (id: string) => call<FormDetail>('GET', `/forms/${id}`),
  createForm: (clientId: string, title: string) => call<FormDetail>('POST', '/forms', { client_id: clientId, title }),
  saveDraft: (id: string, definition: FormDefinition) => call<FormDetail>('PUT', `/forms/${id}/draft`, { definition }),
  publish: (id: string) => call<FormDetail>('POST', `/forms/${id}/publish`, {}),
  version: (id: string) => call<{ id: string; version: number; definition: FormDefinition }>('GET', `/form-versions/${id}`),
  answers: (envelopeId: string) => call<AnswersView>('GET', `/envelopes/${envelopeId}/answers`),
  reveal: (envelopeId: string, questionId: string) => call<{ value: string }>('POST', `/envelopes/${envelopeId}/answers/${questionId}/reveal`, {}),
  uploadUrl: (envelopeId: string, uploadId: string) => `${API_BASE}/envelopes/${envelopeId}/uploads/${uploadId}`,
}
