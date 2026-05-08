export const dynamic = 'force-dynamic'

export async function GET() {
  const url = process.env.NATS_URL
  const user = process.env.NATS_USER
  const password = process.env.NATS_PASSWORD

  if (!url || !user || !password) {
    return Response.json({ error: 'NATS env not configured' }, { status: 503 })
  }

  // Demo-only: returning the shared NATS cred to the browser is fine for a
  // single-tenant pub/sub demo. For real workloads, proxy via SSE/WS through
  // this server, or mint a scoped JWT per session.
  return Response.json({ url, user, password })
}
