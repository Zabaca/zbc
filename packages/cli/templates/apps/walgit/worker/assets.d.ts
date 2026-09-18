/**
 * Binary assets the Worker bundles.
 *
 * `wrangler.jsonc`'s `rules` entry gives `**\/*.png` the `Data` loader, so the
 * bundler turns an import of one into the file's bytes. Only `worker/` may
 * reach a bundler like this — `shared/` is compiled by two programs and may
 * import no runtime (docs/adr/0010), which is why `shared/og-image.ts` holds
 * the route's decisions and none of its bytes.
 */
declare module '*.png' {
  const bytes: ArrayBuffer
  export default bytes
}
