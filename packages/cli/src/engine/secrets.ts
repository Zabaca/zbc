import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'

export async function loadSecrets(envDir: string): Promise<Record<string, string>> {
  const secretsPath = path.join(envDir, 'secrets.yaml')
  const file = Bun.file(secretsPath)

  if (!(await file.exists())) {
    return {}
  }

  const raw = await file.text()
  const parsed = parseYaml(raw)

  // Check if this is a SOPS-encrypted file (has a "sops" key)
  if (parsed?.sops) {
    const { decryptSops } = await import('sops-age')
    const decrypted = await decryptSops({ path: secretsPath })

    if (typeof decrypted !== 'object' || decrypted === null) {
      throw new Error(`secrets.yaml in ${envDir} did not decrypt to an object`)
    }

    return decrypted as Record<string, string>
  }

  // Plain YAML (unencrypted) — used in development
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`secrets.yaml in ${envDir} is not a valid object`)
  }

  return parsed as Record<string, string>
}
