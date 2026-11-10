// The phone's requests, from the space's page: meet's own phone screen asks for its status, a login for the browser phone, the approval for each call, the log, the 911
// address and the line's settings (meet/src/web/phone/usePhone.ts), and here they go to this Worker at /api/phone, which hands them to meet (src/phone.ts). Meet
// decides everything: who has a phone, what a call may be, the minutes. A voicemail's sound plays from `voicemailSrc`, which is meet's own door through this one.
import type { PhoneApi } from '@space/meet/src/web/phone/usePhone'
import { ApiError } from '@space/meet/src/web/api'
import type { CallLogRow, E911Address, LineSettings, PhoneStatus } from '@space/meet/src/phone-model'

const BASE = '/api/phone'

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      redirect: 'manual',
      cache: 'no-store',
      // The Worker takes a JSON body for a POST or a PUT, and none for a DELETE.
      headers: method === 'GET' || method === 'DELETE' ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body ?? {}) }),
    })
  } catch {
    throw new ApiError(0, 'You seem to be offline.')
  }
  if (res.type === 'opaqueredirect') throw new ApiError(401, 'Your sign-in ended.')
  const json = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new ApiError(res.status, json.error ?? `Request failed (${res.status}).`)
  return json as T
}

export const spacePhoneApi: PhoneApi & { phoneDelete(messageId: number): Promise<{ ok: true }>; voicemailSrc(messageId: number): string } = {
  phone: () => request<PhoneStatus | { available: false }>('GET', ''),
  phoneAck: () => request<PhoneStatus>('POST', '/ack'),
  phoneAddress: (address: E911Address) => request<PhoneStatus>('PUT', '/address', address),
  phoneConfirmAddress: () => request<PhoneStatus>('POST', '/address/confirm'),
  phoneToken: () => request<{ token: string; sdk: 'telnyx' | 'fake'; who: string }>('POST', '/token'),
  phoneCall: (to: string) => request<{ to: string; display: string; emergency: boolean; ticket: string | null }>('POST', '/call', { to }),
  phoneEmergency: () => request<{ ok: true }>('POST', '/emergency', { to: '911' }),
  phoneCalls: () => request<{ calls: CallLogRow[] }>('GET', '/calls'),
  phoneSettings: (patch: Partial<Pick<LineSettings, 'cell' | 'ringSeconds'>>) => request<PhoneStatus>('PUT', '/settings', patch),
  /** Delete a voicemail (its sound at Telnyx too) or a missed call's line. */
  phoneDelete: (messageId: number) => request<{ ok: true }>('DELETE', `/messages/${messageId}`),
  /** Where a voicemail plays from: meet's own door through this Worker, which passes the sound on. Never an address of Telnyx's. */
  voicemailSrc: (messageId: number) => `${BASE}/voicemail/${messageId}/audio`,
}
