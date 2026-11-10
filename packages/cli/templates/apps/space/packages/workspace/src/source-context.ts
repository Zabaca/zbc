/**
 * What each character of a file is: code, a string, or a comment (prose, in a Markdown file). The public check reads a line differently by that: `this.app` in code is a property, `"portal.example.com"` in a string,
 * `<p>Visit portal.example.com</p>` in JSX text and `// the portal is portal.example.com` in a comment are hosts; a date in a comment says when the line was written, a date in a string is data.
 *
 * This is a small scanner and not a parser. It follows quotes, comments, template strings (and the code inside their `${}`), regular expression literals, JSX tags and their text and `{}` expressions, and Markdown
 * fences (each read by its language). A quote inside a regular expression or an apostrophe in JSX text does not start a string. What it cannot tell it reads as prose, which makes the check look harder, not less:
 * a regular expression or a JSX tag that it takes for something else can mislabel the code after it until the next string or tag ends.
 */

export const CODE = 0
export const STRING = 1
export const COMMENT = 2

/**
 * `code`: C-style source, where a name is a host only inside a string, a comment or JSX text. `markdown`: prose, with each fenced block read by its language and inline code as a string. Every other kind is data or
 * script (JSON, YAML, TOML, shell, SQL, HTML, a file with no extension), where a name is a host wherever it is written and a comment is whatever the kind's comment mark begins.
 */
export type FileKind = 'code' | 'markdown' | 'hash' | 'sql' | 'json' | 'html' | 'other'

const EXTENSIONS: Record<string, FileKind> = {
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code', mts: 'code', cts: 'code', astro: 'code', svelte: 'code', vue: 'code', css: 'code', scss: 'code',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown', txt: 'markdown',
  yml: 'hash', yaml: 'hash', toml: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', py: 'hash', rb: 'hash', env: 'hash', conf: 'hash', ini: 'hash', cfg: 'hash', properties: 'hash', gitignore: 'hash', dockerfile: 'hash',
  sql: 'sql',
  json: 'json', jsonc: 'json', json5: 'json',
  html: 'html', htm: 'html', xml: 'html', svg: 'html',
}

const HTML_COMMENT_IN_CODE = new Set(['astro', 'svelte', 'vue'])
const JSX_EXTENSIONS = new Set(['tsx', 'jsx'])

export const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return (dot === -1 ? name : name.slice(dot + 1)).toLowerCase()
}

export const kindOf = (path: string): FileKind => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (!name.includes('.', 1)) return /^(?:readme|license|licence|notice|changelog|copying|contributing)$/i.test(name) ? 'markdown' : EXTENSIONS[name.toLowerCase().replace(/^\./, '')] ?? 'other'
  return EXTENSIONS[extensionOf(path)] ?? 'other'
}

type Style = { line: '//' | '#' | '--'; block: boolean; template: boolean; html: boolean; jsx: boolean }

const C_STYLE: Style = { line: '//', block: true, template: true, html: false, jsx: false }
const STYLES: Partial<Record<FileKind, Style>> = {
  code: C_STYLE,
  json: { line: '//', block: true, template: false, html: false, jsx: false },
  hash: { line: '#', block: false, template: false, html: false, jsx: false },
  sql: { line: '--', block: true, template: false, html: false, jsx: false },
  html: { line: '//', block: false, template: false, html: true, jsx: false },
}

/** Words after which an expression begins, so a `/` starts a regular expression and a `<` starts a JSX tag. */
const EXPRESSION_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await', 'default', 'instanceof'])

/** Whether an expression can begin at `index`: after an operator, an opening bracket, a separator, an arrow, a keyword such as `return`, or at the start of the file. */
const expressionStarts = (text: string, index: number): boolean => {
  let at = index - 1
  while (at >= 0 && /\s/.test(text[at]!)) at--
  if (at < 0) return true
  const previous = text[at]!
  if ((previous === '+' || previous === '-') && text[at - 1] === previous) return false // `a++ / 2`: a postfix operator ends an operand, so the slash divides
  if ('(,=:[!&|?{};>+-*%<~^'.includes(previous)) return true
  if (/[A-Za-z_$]/.test(previous)) {
    let start = at
    while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1]!)) start--
    return EXPRESSION_KEYWORDS.has(text.slice(start, at + 1))
  }
  return false
}

/** The start of a generic parameter list rather than a tag: `<T extends Element = HTMLElement>(`, `<T,>(`, `<T = string>(`. A tag never has `extends`, a comma or an equals sign straight after its name. */
const GENERIC_PARAMETERS = /^<[A-Za-z_$][\w$]*\s*(?:extends\b|,|=)/

/** The end of a regular expression literal that begins at `start` (a slash), or -1 when the line ends first (then it was a division). Flags are included. */
const regexEnd = (text: string, start: number): number => {
  let inClass = false
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]!
    if (c === '\n') return -1
    if (c === '\\') {
      i++
      continue
    }
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) {
      let end = i + 1
      while (end < text.length && /[a-z]/.test(text[end]!)) end++
      return end
    }
  }
  return -1
}

type Mode = 'code' | 'line' | 'block' | 'html' | 'string' | 'tag' | 'jsx'
type Frame = { returnTo: Mode; quote: string; braces: number; jsxDepth: number }

/** The mask of a C-like or script file: strings, comments and the rest. */
const scan = (text: string, style: Style, htmlInCode: boolean): Uint8Array => {
  const mask = new Uint8Array(text.length)
  let mode: Mode = 'code'
  let quote = '' // the quote that opened the string being read
  let afterString: Mode = 'code' // where to go when it closes: the code, or the tag whose attribute it is
  const frames: Frame[] = [] // an open `${` in a template string, or `{` in a JSX tag or text, with the braces its code holds
  let jsxDepth = 0
  let closingTag = false
  let lineStart = true
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const next = text[i + 1]
    if (c === '\n') {
      if (mode === 'line') mode = 'code'
      else if (mode === 'string' && (quote !== '`' || !style.template)) mode = afterString
      mask[i] = mode === 'block' || mode === 'html' ? COMMENT : mode === 'string' && quote === '`' ? STRING : mode === 'jsx' ? STRING : CODE
      lineStart = true
      continue
    }
    if (!/\s/.test(c)) {
      if (mode === 'code' && lineStart) {
        // A line that begins with `*` and is not inside a comment is the stray middle of one (a snippet of a doc comment); read it as a comment.
        if (style.line === '//' && c === '*' && (next === undefined || next === ' ' || next === '/' || next === '\n')) {
          const end = text.indexOf('\n', i)
          const stop = end === -1 ? text.length : end
          mask.fill(COMMENT, i, stop)
          i = stop - 1
          lineStart = false
          continue
        }
      }
      lineStart = false
    }

    if (mode === 'line') {
      mask[i] = COMMENT
      continue
    }
    if (mode === 'block') {
      mask[i] = COMMENT
      if (c === '*' && next === '/') {
        mask[i + 1] = COMMENT
        i++
        mode = 'code'
      }
      continue
    }
    if (mode === 'html') {
      mask[i] = COMMENT
      if (c === '-' && text.startsWith('-->', i)) {
        mask.fill(COMMENT, i, i + 3)
        i += 2
        mode = 'code'
      }
      continue
    }
    if (mode === 'string') {
      mask[i] = STRING
      if (c === '\\' && next !== undefined && next !== '\n') {
        mask[i + 1] = STRING
        i++
      } else if (quote === '`' && style.template && c === '$' && next === '{') {
        mask[i + 1] = STRING
        i++
        frames.push({ returnTo: 'string', quote: '`', braces: 0, jsxDepth })
        jsxDepth = 0
        mode = 'code'
      } else if (c === quote) mode = afterString
      continue
    }
    if (mode === 'jsx') {
      // Text between tags: prose, apostrophes and slashes included, until a tag or an expression begins.
      if (c === '<') {
        mode = 'tag'
        closingTag = next === '/'
        mask[i] = CODE
      } else if (c === '{') {
        frames.push({ returnTo: 'jsx', quote: '', braces: 0, jsxDepth })
        jsxDepth = 0
        mode = 'code'
        mask[i] = CODE
      } else mask[i] = STRING
      continue
    }
    if (mode === 'tag') {
      mask[i] = CODE
      if (c === '"' || c === "'") {
        mode = 'string'
        quote = c
        afterString = 'tag'
        mask[i] = STRING
      } else if (c === '{') {
        frames.push({ returnTo: 'tag', quote: '', braces: 0, jsxDepth })
        jsxDepth = 0
        mode = 'code'
      } else if (c === '>') {
        if (closingTag) jsxDepth = Math.max(0, jsxDepth - 1)
        else if (text[i - 1] !== '/') jsxDepth++
        mode = jsxDepth > 0 ? 'jsx' : 'code'
      }
      continue
    }

    // Code.
    if (style.line === '//' && c === '/' && next === '/' && text[i - 1] !== ':') {
      mode = 'line'
      mask[i] = COMMENT
      continue
    }
    if (style.line === '--' && c === '-' && next === '-') {
      mode = 'line'
      mask[i] = COMMENT
      continue
    }
    if (style.line === '#' && c === '#' && (i === 0 || /\s/.test(text[i - 1]!))) {
      mode = 'line'
      mask[i] = COMMENT
      continue
    }
    if (style.block && c === '/' && next === '*') {
      mode = 'block'
      mask[i] = COMMENT
      continue
    }
    if ((style.html || htmlInCode) && c === '<' && text.startsWith('<!--', i)) {
      mode = 'html'
      mask[i] = COMMENT
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      mode = 'string'
      quote = c
      afterString = 'code'
      mask[i] = STRING
      continue
    }
    if (style.line === '//') {
      if (c === '\\') {
        i++ // a stray backslash escapes the next character
        continue
      }
      if (c === '/' && expressionStarts(text, i)) {
        const end = regexEnd(text, i)
        if (end !== -1) {
          i = end - 1
          continue
        }
      }
      if (style.jsx && c === '<' && /[A-Za-z>]/.test(next ?? '') && expressionStarts(text, i) && !GENERIC_PARAMETERS.test(text.slice(i, i + 200))) {
        mode = 'tag'
        closingTag = false
        continue
      }
    }
    if (frames.length > 0) {
      const top = frames[frames.length - 1]!
      if (c === '{') top.braces++
      else if (c === '}') {
        if (top.braces === 0) {
          frames.pop()
          mode = top.returnTo
          quote = top.quote
          jsxDepth = top.jsxDepth
          if (mode === 'string') {
            afterString = 'code'
            mask[i] = STRING
          }
        } else top.braces--
      }
    }
  }
  return mask
}

/** The mask of a fenced block, by the language on its opening line. The data and script languages are read as strings throughout (a name in them is a host wherever it is written). */
const scanFence = (body: string, language: string): Uint8Array => {
  const lang = language.toLowerCase()
  if (/^(?:md|mdx|markdown)$/.test(lang)) return scanMarkdown(body)
  if (/^(?:ts|typescript|js|javascript|mjs|cjs|css|scss)$/.test(lang)) return scan(body, C_STYLE, false)
  if (/^(?:tsx|jsx)$/.test(lang)) return scan(body, { ...C_STYLE, jsx: true }, false)
  const data = (style: Style) => scan(body, style, false).map((value) => (value === CODE ? STRING : value))
  if (/^(?:json|jsonc|json5)$/.test(lang)) return data(STYLES.json!)
  if (/^(?:sh|bash|zsh|shell|console|yaml|yml|toml|py|python|rb|ruby|ini|env|dockerfile|conf)$/.test(lang)) return data(STYLES.hash!)
  if (lang === 'sql') return data(STYLES.sql!)
  if (/^(?:html|xml|svg)$/.test(lang)) return data(STYLES.html!)
  return new Uint8Array(body.length).fill(STRING)
}

/**
 * A Markdown file: prose is the comment kind, inline code is a string (a host is often written in backticks, and a date in backticks is an example, not provenance), and a fenced block is read by its language.
 * A fence closes on a line of at least as many of the same mark as opened it, so a longer fence can hold a shorter one.
 */
const scanMarkdown = (text: string): Uint8Array => {
  const mask = new Uint8Array(text.length).fill(COMMENT)
  let fence: { mark: string; length: number; language: string; bodyStart: number } | null = null
  let offset = 0
  const lines = text.split('\n')
  const closeFence = (bodyEnd: number) => {
    if (!fence) return
    const body = text.slice(fence.bodyStart, bodyEnd)
    mask.set(scanFence(body, fence.language), fence.bodyStart)
    fence = null
  }
  for (const line of lines) {
    const end = offset + line.length
    const marker = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(line)
    if (fence) {
      const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(line)
      if (closing && closing[1]![0] === fence.mark && closing[1]!.length >= fence.length) {
        closeFence(offset)
        mask.fill(CODE, offset, end)
      }
    } else if (marker) {
      fence = { mark: marker[1]![0]!, length: marker[1]!.length, language: marker[2] ?? '', bodyStart: Math.min(end + 1, text.length) }
      mask.fill(CODE, offset, end)
    } else {
      for (const span of line.matchAll(/(`+)(?:(?!\1)[^]*?)\1/g)) mask.fill(STRING, offset + (span.index ?? 0), offset + (span.index ?? 0) + span[0].length)
    }
    offset = end + 1
  }
  closeFence(text.length)
  return mask
}

/** For each character of the file, whether it is code, a string or a comment, and what kind of file it is. */
export const classify = (path: string, text: string): { kind: FileKind; mask: Uint8Array } => {
  const kind = kindOf(path)
  if (kind === 'markdown') return { kind, mask: scanMarkdown(text) }
  const style = STYLES[kind]
  if (!style) return { kind, mask: new Uint8Array(text.length).fill(STRING) }
  const extension = extensionOf(path)
  return { kind, mask: scan(text, kind === 'code' ? { ...style, jsx: JSX_EXTENSIONS.has(extension) } : style, HTML_COMMENT_IN_CODE.has(extension)) }
}
