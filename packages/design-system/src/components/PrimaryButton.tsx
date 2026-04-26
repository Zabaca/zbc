/**
 * PrimaryButton.tsx — the one button style in Prose.
 * Dark ink background; darkens to true black on hover.
 * No border-radius beyond the system 2px token.
 */

import type { ButtonHTMLAttributes } from 'react'

export type PrimaryButtonProps = ButtonHTMLAttributes<HTMLButtonElement>

export function PrimaryButton({ children, className = '', ...rest }: PrimaryButtonProps) {
  return (
    <button className={`prose-primary-button ${className}`.trim()} {...rest}>
      {children}
    </button>
  )
}
