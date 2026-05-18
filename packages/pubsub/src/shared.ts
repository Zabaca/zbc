export interface JWTPermissions {
  pub?: { allow: string[] }
  sub?: { allow: string[] }
}

export interface MintedCreds {
  url: string
  jwt: string
  seed: string
  expiresAt: number
}
