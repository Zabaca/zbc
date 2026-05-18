import { mintUserJWT } from '@zbc/pubsub/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  const url = process.env.NATS_URL
  const accountPublicKey = process.env.NATS_ACCOUNT_PUBLIC_KEY
  const accountSigningKey = process.env.NATS_ACCOUNT_SIGNING_KEY

  if (!url || !accountPublicKey || !accountSigningKey) {
    return Response.json({ error: 'NATS env not configured' }, { status: 503 })
  }

  const creds = await mintUserJWT({
    url,
    accountPublicKey,
    accountSigningKey,
    pub: { allow: ['landing.demo.>'] },
    sub: { allow: ['landing.demo.>'] },
    expirySeconds: 3600,
  })

  return Response.json(creds)
}
