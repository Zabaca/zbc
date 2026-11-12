/**
 * Makes the seal's certificates: a root ("<service name> Root") and a seal certificate it issues. Used by
 * scripts/seal-certs.ts to put them in sops, and by the tests to seal with a throwaway pair. Not bundled into
 * the Worker, which only ever reads them (src/seal/pem.ts).
 *
 * The root's key stays in sops and never reaches the Worker. The seal certificate's key is a Worker secret.
 * Adobe shows the signature's validity as unknown, because the root is on no trust list, and shows whether the
 * document changed after sealing. A client that wants a green check can trust the root by hand.
 */
import * as asn1js from 'asn1js'
import * as pkijs from 'pkijs'
import { sha256Hex } from '../src/bytes'
import { type ServiceWords, sealRootName, sealSubject } from '../src/service'
import { bundledInstall, serviceWordsOf } from '../src/workspace'

const OID = {
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
} as const

// The names of the certificates are the install's: "<service name> Root" and "<service name> Seal" (src/service.ts), and the organisation they carry is who runs the service, as the law names it (`runBy.legalName`), so a pair
// made before this was declared is unchanged and a company's own are its own. The bundled install's are the default; an install the script is run for (`FORMS_DECLARATION`, scripts/seal-certs.ts) passes its own.
export interface SealNames {
  root: string
  seal: string
  organization: string
}

/** The names a seal's certificates carry for an install's signing service. */
export const sealNamesOf = (service: Pick<ServiceWords, 'name' | 'runBy'>): SealNames => ({ root: sealRootName(service), seal: sealSubject(service), organization: service.runBy.legalName })

/**
 * The names a renewal gives the new seal certificate: the ones the root certificate already carries ("<service name> Root" for its subject, whose "Root" gives the seal's "<service name> Seal", and its organisation), so a renewal
 * can never rename a company's seal, whatever declaration or install the script happens to be run beside.
 */
export function sealNamesFromRoot(rootCertPem: string): SealNames {
  const der = Uint8Array.from(Buffer.from(rootCertPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64'))
  const cert = pkijs.Certificate.fromBER(toArrayBuffer(der))
  const attr = (oid: string) => (cert.subject.typesAndValues.find((t) => t.type === oid)?.value as { valueBlock?: { value?: string } } | undefined)?.valueBlock?.value
  const cn = attr(OID.commonName)
  const organization = attr(OID.organization)
  if (!cn?.endsWith(' Root') || !organization) throw new Error(`The root certificate's subject is not "<service name> Root" with an organisation (it reads CN=${cn ?? '(none)'}, O=${organization ?? '(none)'}), so its seal's names cannot be taken from it.`)
  return { root: cn, seal: `${cn.slice(0, -' Root'.length)} Seal`, organization }
}

const BUNDLED = sealNamesOf(serviceWordsOf(bundledInstall))
export const ROOT_NAME = BUNDLED.root
export const SEAL_NAME = BUNDLED.seal
export const ROOT_YEARS = 10
export const SEAL_YEARS = 3

export interface KeyAndCert {
  /** PKCS#8 private key, PEM. */
  keyPem: string
  /** The certificate, PEM. */
  certPem: string
  certDer: Uint8Array
  /** SHA-256 of the certificate, lowercase hex: the "seal root's fingerprint" the certificate page prints. */
  fingerprint: string
  /** When the certificate ends. */
  notAfter: Date
}

const toArrayBuffer = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer

export function pem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}


const name = (target: pkijs.RelativeDistinguishedNames, cn: string, organization: string) => {
  target.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: OID.organization, value: new asn1js.Utf8String({ value: organization }) }))
  target.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: OID.commonName, value: new asn1js.Utf8String({ value: cn }) }))
}

const ext = (extnID: string, critical: boolean, value: asn1js.AsnType) =>
  new pkijs.Extension({ extnID, critical, extnValue: (value as asn1js.Sequence).toBER(false) })

async function keyIdOf(publicKey: CryptoKey): Promise<ArrayBuffer> {
  const spki = await crypto.subtle.exportKey('spki', publicKey)
  return crypto.subtle.digest('SHA-1', spki)
}

async function issue(opts: {
  organization: string
  subjectCn: string
  issuerCn: string
  years: number
  now: Date
  publicKey: CryptoKey
  signingKey: CryptoKey
  authorityKeyId?: ArrayBuffer
  /** The issuer's own end: a certificate never outlives the root that signed it. */
  notAfterCap?: Date
  ca: boolean
}): Promise<{ der: Uint8Array }> {
  // pkijs keeps its crypto engine in one of two places, chosen by whether a global `window` exists at the moment it is set or read,
  // and sets it once on import. A test that registers a DOM around that import (or around this call) leaves the engine where the
  // read will not look, so set it here, under the globals the reads below will see.
  pkijs.setEngine('webcrypto', new pkijs.CryptoEngine({ name: 'webcrypto', crypto: globalThis.crypto }))
  const cert = new pkijs.Certificate()
  cert.version = 2
  const serial = crypto.getRandomValues(new Uint8Array(16))
  // Positive (top bit clear) and never starting with a 0x00 byte: asn1js writes the bytes as given, and a leading 0x00 before a byte
  // below 0x80 is a non-minimal DER INTEGER, which pdfsig answers by calling the seal invalid (1 certificate in 256).
  serial[0] = (serial[0]! & 0x7f) || 1
  cert.serialNumber = new asn1js.Integer({ valueHex: toArrayBuffer(serial) })
  name(cert.issuer, opts.issuerCn, opts.organization)
  name(cert.subject, opts.subjectCn, opts.organization)
  cert.notBefore.value = new Date(opts.now.getTime() - 5 * 60_000)
  const end = new Date(opts.now)
  end.setUTCFullYear(end.getUTCFullYear() + opts.years)
  cert.notAfter.value = opts.notAfterCap && opts.notAfterCap < end ? opts.notAfterCap : end

  const ski = await keyIdOf(opts.publicKey)
  const extensions: pkijs.Extension[] = []
  extensions.push(
    ext(OID.basicConstraints, true, opts.ca ? new pkijs.BasicConstraints({ cA: true, pathLenConstraint: 0 }).toSchema() : new pkijs.BasicConstraints({ cA: false }).toSchema()),
  )
  // keyCertSign and cRLSign for the root; digitalSignature and nonRepudiation (content commitment) for the seal.
  const usage = opts.ca ? { byte: 0x06, unused: 1 } : { byte: 0xc0, unused: 6 }
  extensions.push(ext(OID.keyUsage, true, new asn1js.BitString({ valueHex: new Uint8Array([usage.byte]).buffer, unusedBits: usage.unused })))
  extensions.push(ext(OID.subjectKeyId, false, new asn1js.OctetString({ valueHex: ski })))
  if (opts.authorityKeyId) {
    extensions.push(
      ext(OID.authorityKeyId, false, new pkijs.AuthorityKeyIdentifier({ keyIdentifier: new asn1js.OctetString({ valueHex: opts.authorityKeyId }) }).toSchema()),
    )
  }
  cert.extensions = extensions
  await cert.subjectPublicKeyInfo.importKey(opts.publicKey)
  await cert.sign(opts.signingKey, 'SHA-256')
  return { der: new Uint8Array(cert.toSchema(true).toBER(false)) }
}

const rsa = (bits: number) =>
  crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>

async function packed(pair: CryptoKeyPair, der: Uint8Array): Promise<KeyAndCert> {
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  return { keyPem: pem('PRIVATE KEY', pkcs8), certPem: pem('CERTIFICATE', der), certDer: der, fingerprint: await sha256Hex(der), notAfter: pkijs.Certificate.fromBER(toArrayBuffer(der)).notAfter.value }
}

export interface SealCerts {
  root: KeyAndCert
  seal: KeyAndCert
}

/** A fresh root (RSA 4096, 10 years) and the seal certificate it issues (RSA 2048, 3 years). */
export async function makeSealCerts(now = new Date(), rootBits = 4096, names: SealNames = BUNDLED): Promise<SealCerts> {
  const rootPair = await rsa(rootBits)
  const rootCert = await issue({ organization: names.organization, subjectCn: names.root, issuerCn: names.root, years: ROOT_YEARS, now, publicKey: rootPair.publicKey, signingKey: rootPair.privateKey, ca: true })
  const root = await packed(rootPair, rootCert.der)
  const sealPair = await rsa(2048)
  const sealCert = await issue({
    organization: names.organization,
    subjectCn: names.seal,
    issuerCn: names.root,
    years: SEAL_YEARS,
    now,
    publicKey: sealPair.publicKey,
    signingKey: rootPair.privateKey,
    authorityKeyId: await keyIdOf(rootPair.publicKey),
    notAfterCap: pkijs.Certificate.fromBER(toArrayBuffer(rootCert.der)).notAfter.value,
    ca: false,
  })
  return { root, seal: await packed(sealPair, sealCert.der) }
}

/**
 * A new seal certificate under an existing root: the renewal recipe, before the current one expires. Its end is clamped to
 * the root's, so late in the root's life it is shorter than three years (the caller warns; see `daysValid`).
 */
export async function reissueSeal(rootKeyPem: string, rootCertPem: string, now = new Date(), names: SealNames = BUNDLED): Promise<KeyAndCert> {
  const der = (p: string) => new Uint8Array(Buffer.from(p.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64'))
  const rootKey = await crypto.subtle.importKey('pkcs8', toArrayBuffer(der(rootKeyPem)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const rootCert = pkijs.Certificate.fromBER(toArrayBuffer(der(rootCertPem)))
  const rootPublic = await rootCert.getPublicKey({ algorithm: { algorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, usages: ['verify'] } })
  const sealPair = await rsa(2048)
  const sealCert = await issue({
    organization: names.organization,
    subjectCn: names.seal,
    issuerCn: names.root,
    years: SEAL_YEARS,
    now,
    publicKey: sealPair.publicKey,
    signingKey: rootKey,
    authorityKeyId: await keyIdOf(rootPublic),
    notAfterCap: rootCert.notAfter.value,
    ca: false,
  })
  return packed(sealPair, sealCert.der)
}
