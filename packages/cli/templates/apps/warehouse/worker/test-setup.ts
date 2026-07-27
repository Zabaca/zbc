// bun:test preload (wired via bunfig.toml's [test].preload). Bun's SubtleCrypto does not
// implement `timingSafeEqual` — verified against this package's own Bun (`'timingSafeEqual'
// in crypto.subtle` is false; calling it throws "is not a function"). It's a workerd-runtime
// extension to SubtleCrypto, not part of the Web Crypto standard, so it's only real under
// wrangler dev/deploy. router.ts's `authorized()` calls it exactly as the inbox app
// template's worker/index.ts does — this shim exists purely so `bun test worker` can
// exercise authorized()'s true/false outcomes locally; it changes nothing about the code
// under test, and is never loaded outside the test runner.
import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto'

if (typeof (crypto.subtle as { timingSafeEqual?: unknown }).timingSafeEqual !== 'function') {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    value: (a: ArrayBuffer, b: ArrayBuffer): boolean => {
      const ua = new Uint8Array(a)
      const ub = new Uint8Array(b)
      // Matches workerd's documented behavior: mismatched lengths -> false, not a throw
      // (node:crypto's timingSafeEqual throws on length mismatch instead).
      return ua.byteLength === ub.byteLength && nodeTimingSafeEqual(ua, ub)
    },
    writable: true,
    configurable: true,
  })
}
