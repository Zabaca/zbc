// A client for the end-to-end suites: a Client made in the local Worker's stand-in for the Clients part (dev/clients.ts, `POST /admin/api/dev-clients`), then signing set up for its number, which is what the space's screens do against
// the real part. The names are the Client's (`display_name`, `legal_name` here); the rest are the signing settings.
//
// With `via.space` (the Forms tab's suites, where the local Worker reads its Clients from a space's preview: `PUT /admin/api/dev-clients-from`) the Client is made in that preview, through Settings' own write, so both agree on it.
export interface MadeClient {
  id: string
  slug: string
  client_number: number
  display_name: string
}

export async function setUpClient(base: string, fields: Record<string, unknown>, via: { space?: string } = {}): Promise<MadeClient> {
  const { display_name = 'Pinecrest', legal_name = 'Pinecrest Roofing, CPAs', ...settings } = fields
  const made = via.space
    ? await fetch(`${via.space}/api/clients/make`, { method: 'POST', headers: { 'content-type': 'application/json', origin: via.space }, body: JSON.stringify({ name: display_name, legalName: legal_name }) })
    : await fetch(`${base}/admin/api/dev-clients`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: display_name, legalName: legal_name }) })
  if (!made.ok) throw new Error(`a Client could not be made: ${made.status} ${await made.text()}`)
  const body = (await made.json()) as { number?: number; value?: { number: number } }
  const client = { number: via.space ? (body.value?.number as number) : (body.number as number) }
  const res = await fetch(`${base}/admin/api/clients`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_number: client.number, ...settings }) })
  const text = await res.text()
  if (!res.ok) throw new Error(`signing could not be set up: ${res.status} ${text}`)
  return JSON.parse(text) as MadeClient
}
