/** @type {import('next').NextConfig} */
export default {
  // Pre-bundle the workspace package so Next can statically analyze it.
  transpilePackages: ['@zbc/design-system'],
}
