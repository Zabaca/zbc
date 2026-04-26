import type { NextConfig } from 'next'
import path from 'node:path'

const config: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(process.cwd(), '../..'),
  devIndicators: false,
}

export default config
