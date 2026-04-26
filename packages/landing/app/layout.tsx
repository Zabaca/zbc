import type { ReactNode } from 'react'
import './globals.css'

export const metadata = {
  title: 'zbc landing',
  description: 'Smoke-test consumer of @zbc/design-system',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
