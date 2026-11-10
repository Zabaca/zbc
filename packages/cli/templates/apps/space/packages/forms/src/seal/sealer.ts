/**
 * The Sealer: the signer, and later a timestamp authority, that put the seal on a finished PDF.
 *
 * TODAY the seal is a certificate the install made itself (scripts/seal-certs.ts). A root, "<service name> Root",
 * whose key lives in sops and never reaches the Worker, issued a seal certificate whose key is the Worker secret
 * FORMS_SEAL_KEY (its chain, seal certificate first and root second, is FORMS_SEAL_CERT_CHAIN). A reader shows the
 * signature's validity as unknown, because the root is on no trust list, and shows whether the document changed
 * after sealing. A client that wants a green check can trust the root by hand.
 *
 * LATER, if the owner decides to, an Adobe-trusted (AATL) certificate. Its rules require the private key in certified
 * hardware, or a remotely managed signing device with two-factor activation (AATL Technical Requirements v2.0,
 * EE4), so the swap is NOT a new secret: it is a different `Signer` here, one that calls a hardware-held key (a
 * cloud key service, or the certificate authority's remote signing; LibPDF ships a Google Cloud KMS signer and its
 * `Signer` interface is async for exactly this), plus a `TimestampAuthority` that makes the seal PAdES B-T. The
 * engine already takes both (src/pdf/engine.ts, SealSpec). Nothing stored changes, and documents sealed before
 * the swap keep their seal.
 */
import { CryptoKeySigner, type Signer, type TimestampAuthority } from '@libpdf/core'
import * as pkijs from 'pkijs'
import { sha256Hex } from '../bytes'
import { pemBlocks } from './pem'

export interface Sealer {
  signer: Signer
  /** Absent today; when present the seal is PAdES B-T. */
  timestampAuthority?: TimestampAuthority
  /** What the certificate page prints: the root's SHA-256, so a reader can tell which root sealed a copy. */
  rootFingerprint: string
  /** The seal certificate's SHA-256 and subject, for the seal check's report. */
  certFingerprint: string
  subject: string
  /** When the seal certificate stops being valid: renew before then (scripts/seal-certs.ts --renew). */
  notAfter: string
}

export interface SealEnv {
  FORMS_SEAL_KEY?: string
  FORMS_SEAL_CERT_CHAIN?: string
}

export class SealerUnconfigured extends Error {
  constructor(why: string) {
    super(`The seal is not configured: ${why}`)
  }
}


/** A secret pasted with literal \n (a .dev.vars line) reads the same as one with real newlines. */
const unescaped = (s: string) => s.replace(/\\n/g, '\n')

/** The seal certificate's subject common name and not-after, read with pkijs (already in the bundle through LibPDF). */
function certFacts(der: Uint8Array): { notAfter: string; subject: string } {
  const cert = pkijs.Certificate.fromBER(der as unknown as ArrayBuffer)
  const cn = cert.subject.typesAndValues.find((t) => t.type === '2.5.4.3')
  return { notAfter: cert.notAfter.value.toISOString(), subject: String((cn?.value as { valueBlock?: { value?: string } } | undefined)?.valueBlock?.value ?? 'unknown') }
}

/** The self-made seal, from the two Worker secrets. */
export async function loadSealer(env: SealEnv): Promise<Sealer> {
  if (!env.FORMS_SEAL_KEY) throw new SealerUnconfigured('FORMS_SEAL_KEY is missing')
  if (!env.FORMS_SEAL_CERT_CHAIN) throw new SealerUnconfigured('FORMS_SEAL_CERT_CHAIN is missing')
  const keyBlock = pemBlocks(unescaped(env.FORMS_SEAL_KEY)).find((b) => b.label === 'PRIVATE KEY')
  if (!keyBlock) throw new SealerUnconfigured('FORMS_SEAL_KEY holds no PKCS#8 private key')
  const certs = pemBlocks(unescaped(env.FORMS_SEAL_CERT_CHAIN)).filter((b) => b.label === 'CERTIFICATE')
  if (certs.length < 2) throw new SealerUnconfigured('FORMS_SEAL_CERT_CHAIN needs the seal certificate and then the root')
  const [leaf, ...chain] = certs as [(typeof certs)[number], ...typeof certs]
  const key = await crypto.subtle.importKey('pkcs8', keyBlock.der as unknown as ArrayBuffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const facts = certFacts(leaf.der)
  return {
    signer: new CryptoKeySigner(key, leaf.der, 'RSA', 'RSASSA-PKCS1-v1_5', chain.map((c) => c.der)),
    rootFingerprint: await sha256Hex(chain[chain.length - 1]!.der),
    certFingerprint: await sha256Hex(leaf.der),
    subject: facts.subject,
    notAfter: facts.notAfter,
  }
}
