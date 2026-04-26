/**
 * PrimaryButton.tsx — the one button style in Prose.
 * Dark ink background; darkens to true black on hover.
 * No border-radius beyond the system 2px token.
 */

import type { ButtonHTMLAttributes } from 'react'

export type PrimaryButtonProps = ButtonHTMLAttributes<HTMLButtonElement>

export function PrimaryButton({ children, className = '', ...rest }: PrimaryButtonProps) {
  return (
    <button
      className={
        'font-ui text-sm font-medium px-[1.5em] py-[0.85em] ' +
        'bg-ink-0 text-paper-0 border-0 rounded-1 ' +
        'self-start cursor-pointer ' +
        'transition-colors duration-fast ease-prose hover:bg-accent ' +
        className
      }
      {...rest}
    >
      {children}
    </button>
  )
}
