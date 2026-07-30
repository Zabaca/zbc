// Ink writes SGR escape codes into the frame; a browser needs spans. This
// handles exactly the subset ink emits (basic + bright fg/bg, bold, dim,
// inverse) — not a general terminal emulator.
const FG: Record<number, string> = {
  30: '#000000',
  31: '#f14c4c',
  32: '#23d18b',
  33: '#f5f543',
  34: '#3b8eea',
  35: '#d670d6',
  36: '#29b8db',
  37: '#e5e5e5',
  90: '#666666',
  91: '#f14c4c',
  92: '#23d18b',
  93: '#f5f543',
  94: '#3b8eea',
  95: '#d670d6',
  96: '#29b8db',
  97: '#ffffff',
}
const BG: Record<number, string> = Object.fromEntries(
  Object.entries(FG).map(([k, v]) => [Number(k) + 10, v]),
)

type State = { fg?: string; bg?: string; bold?: boolean; dim?: boolean }

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function open(s: State): string {
  const css: string[] = []
  if (s.fg) css.push(`color:${s.fg}`)
  if (s.bg) css.push(`background:${s.bg}`)
  if (s.bold) css.push('font-weight:700')
  if (s.dim) css.push('opacity:.55')
  return css.length ? `<span style="${css.join(';')}">` : '<span>'
}

/** Turn one ANSI-bearing terminal frame into an HTML fragment. */
export function ansiToHtml(frame: string): string {
  let state: State = {}
  let out = ''
  // oxlint-disable-next-line no-control-regex -- ESC is the SGR introducer; matching it is the point.
  const parts = frame.split(/\x1b\[([0-9;]*)m/)

  for (const [i, part] of parts.entries()) {
    if (i % 2 === 0) {
      if (!part) continue
      out += open(state) + escapeHtml(part) + `</span>`
      continue
    }
    for (const raw of part.split(';')) {
      const n = Number(raw || '0')
      if (n === 0) state = {}
      else if (n === 1) state.bold = true
      else if (n === 2) state.dim = true
      else if (n === 7) state = { ...state, fg: state.bg ?? '#000', bg: state.fg ?? '#fff' }
      else if (n === 22) {
        state.bold = false
        state.dim = false
      } else if (n === 39) state.fg = undefined
      else if (n === 49) state.bg = undefined
      else if (FG[n]) state.fg = FG[n]
      else if (BG[n]) state.bg = BG[n]
    }
  }
  return out
}

/** Wrap frames in a page styled to look like the terminal c9s runs in. */
export function framesPage(frames: { name: string; html: string }[]): string {
  const blocks = frames
    .map(
      (f) => `<section>
  <h2>${escapeHtml(f.name)}</h2>
  <pre>${f.html}</pre>
</section>`,
    )
    .join('\n')

  return `<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark }
  body {
    margin: 0; padding: 24px; background: #0d1117;
    font: 15px/1.35 "SF Mono", "JetBrains Mono", Menlo, monospace;
    color: #e5e5e5;
  }
  section { margin-bottom: 28px }
  h2 { margin: 0 0 8px; font: 600 12px/1 inherit; color: #7d8590; letter-spacing: .08em; text-transform: uppercase }
  /* line-height must be 1: box-drawing glyphs only join edge-to-edge when the
     line box is exactly the glyph height. Anything looser gaps the borders. */
  pre { margin: 0; line-height: 1; white-space: pre; display: inline-block; padding: 14px 16px; background: #010409; border: 1px solid #21262d; border-radius: 8px }
</style>
${blocks}
`
}
