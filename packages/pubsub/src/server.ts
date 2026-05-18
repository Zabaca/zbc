import { createUser, fromSeed } from '@nats-io/nkeys'
import { encodeUser } from '@nats-io/jwt'
import type { MintedCreds } from './shared'

export interface MintInput {
  url: string
  accountPublicKey: string
  accountSigningKey: string
  pub: { allow: string[] }
  sub: { allow: string[] }
  expirySeconds?: number
}

export async function mintUserJWT(input: MintInput): Promise<MintedCreds> {
  const expirySeconds = input.expirySeconds ?? 3600
  const expSeconds = Math.floor(Date.now() / 1000) + expirySeconds

  const accountKP = fromSeed(new TextEncoder().encode(input.accountSigningKey))
  const userKP = createUser()

  const jwt = await encodeUser(
    'zbc-user',
    userKP,
    accountKP,
    {
      pub: { allow: input.pub.allow },
      sub: { allow: input.sub.allow },
    },
    { exp: expSeconds },
  )

  const seed = new TextDecoder().decode(userKP.getSeed())

  return {
    url: input.url,
    jwt,
    seed,
    expiresAt: expSeconds * 1000,
  }
}
