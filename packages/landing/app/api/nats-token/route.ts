import { mintUserJWT } from '@zbc/pubsub/server'

export const dynamic = 'force-dynamic'

// Public demo endpoint — unauthenticated and unrate-limited on purpose.
// The minted JWT is scoped to `landing.demo.>` only, so worst case is
// counter-spam on the demo subject. Do NOT copy this pattern for routes
// that mint creds with broader subject scopes.
export async function GET() {
  const url = process.env.NATS_URL
  const accountSigningKey = process.env.NATS_ACCOUNT_SIGNING_KEY

  if (!url || !accountSigningKey) {
    return Response.json({ error: 'NATS env not configured' }, { status: 503 })
  }

  const creds = await mintUserJWT({
    url,
    accountSigningKey,
    pub: { allow: ['landing.demo.>'] },
    sub: { allow: ['landing.demo.>'] },
    expirySeconds: 3600,
  })

  return Response.json(creds)
}
