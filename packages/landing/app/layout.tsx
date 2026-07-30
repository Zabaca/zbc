import type { ReactNode } from 'react'
import './globals.css'

const SITE = 'https://zbc-landing.james-99a.workers.dev'
const TITLE = 'zbc: declarative infrastructure for Bun'
const DESCRIPTION =
  'Describe your database and your workers in TypeScript. One command provisions what is missing, converges what drifted, and deploys your code, locally and in CI, the same way. No state file.'

export const metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE,
    siteName: 'zbc',
    type: 'website',
  },
  // `summary`, not `summary_large_image`: there is no OG image to show yet, and
  // a large-image card without one degrades to a broken-looking summary anyway.
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
}

// Applies the theme before first paint so a dark-mode visitor never sees a flash
// of the light page. An explicit choice wins; otherwise fall back to the OS.
const NO_FLASH = `try{var t=localStorage.getItem('zbc-theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch{}`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* biome-ignore lint: pre-paint theme application must be inline and synchronous */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,300..700;1,300..700&family=Inter+Tight:wght@400..700&family=JetBrains+Mono:wght@400..600&display=swap"
        />
      </head>
      <body className="bg-paper-0 text-ink-1">{children}</body>
    </html>
  )
}
