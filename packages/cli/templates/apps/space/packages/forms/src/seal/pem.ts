import { fromBase64 } from '../bytes'

/** PEM blocks to DER, with no Buffer, so it runs in the Worker. */
export interface PemBlock {
  label: string
  der: Uint8Array
}

export function pemBlocks(text: string): PemBlock[] {
  const out: PemBlock[] = []
  const re = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ label: m[1]!, der: fromBase64(m[2]!.replace(/\s+/g, '')) })
  }
  return out
}
