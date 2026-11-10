// A throwaway seal for the tests: a root and a seal certificate made now, the way scripts/seal-certs.ts makes the real ones.
import { type SealCerts, makeSealCerts } from '../scripts/certs'
import { type Sealer, loadSealer } from '../src/seal/sealer'

let made: Promise<SealCerts> | null = null
/** One pair per test process (key generation is the slow part); RSA 2048 root, not the real 4096. */
export const testCerts = () => (made ??= makeSealCerts(new Date(), 2048))

export async function testSealEnv() {
  const c = await testCerts()
  return { FORMS_SEAL_KEY: c.seal.keyPem, FORMS_SEAL_CERT_CHAIN: c.seal.certPem + c.root.certPem }
}

export async function testSealer(): Promise<Sealer> {
  return loadSealer(await testSealEnv())
}
