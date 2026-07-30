'use client'

/**
 * The page's primary call to action: the install command, copied in one click.
 * Falls back to selecting the text when the clipboard API is unavailable
 * (older browsers, or any non-secure origin).
 */

import { useEffect, useRef, useState } from 'react'

type CopyState = 'idle' | 'copied' | 'failed'

export function InstallCommand({ command }: { command: string }) {
  const [state, setState] = useState<CopyState>('idle')
  const codeRef = useRef<HTMLElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  async function copy() {
    if (timer.current) clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(command)
      setState('copied')
    } catch {
      // No clipboard permission, so select it and ⌘C still works.
      const node = codeRef.current
      if (node) {
        const range = document.createRange()
        range.selectNodeContents(node)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
      setState('failed')
    }
    timer.current = setTimeout(() => setState('idle'), 2000)
  }

  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Press ⌘C' : 'Copy'

  return (
    <div className="flex max-w-full items-stretch overflow-hidden rounded-1 border border-ink-4 bg-paper-0">
      {/* Wraps rather than scrolls. On a phone every command on this page is
          wider than the chip, and a horizontal scroll inside a code chip is a
          scroll nobody finds: the CTA just reads as a truncated command. */}
      <code
        ref={codeRef}
        className="whitespace-pre-wrap break-words px-[1.5em] py-[0.85em] font-mono text-sm text-ink-0"
      >
        <span className="text-ink-3">$ </span>
        {command}
      </code>
      {/* The accessible name tracks `state`, so a screen reader hears the
          result of the copy instead of a name frozen at "Copy". */}
      <button
        type="button"
        onClick={copy}
        aria-label={
          state === 'copied'
            ? `Copied "${command}" to the clipboard`
            : state === 'failed'
              ? `Could not copy automatically. "${command}" is selected, press Command-C`
              : `Copy "${command}" to the clipboard`
        }
        className="shrink-0 cursor-pointer border-0 bg-ink-0 px-5 font-ui text-xs font-medium text-paper-0 transition-colors duration-fast ease-prose hover:bg-accent"
      >
        <span aria-hidden="true">{label}</span>
      </button>
    </div>
  )
}
