// The k9s furniture: logo, info panel, key hints, and the command prompt.
// Kept out of app.tsx so the app file stays about state, not decoration.
import { Box, Text } from 'ink'
import { KINDS } from './resources'

const LOGO = [' ___ ___  ', '/ __/ _ \\ ', '| (_| (_) |', ' \\___\\___/s']

export function Logo() {
  return (
    <Box flexDirection="column" marginLeft={2}>
      {LOGO.map((line) => (
        <Text key={line} color="cyan" bold>
          {line}
        </Text>
      ))}
    </Box>
  )
}

const field = (label: string, value: string, color?: string) => (
  <Text key={label}>
    <Text color="cyan" bold>
      {label.padEnd(10)}
    </Text>
    <Text color={color}>{value}</Text>
  </Text>
)

export function InfoPanel({
  account,
  project,
  count,
  refreshSecs,
  rates,
}: {
  account: string
  project: string
  count: number
  refreshSecs: number
  /** Rate-card date. Only the cost view sets it: elsewhere it would be noise. */
  rates?: string
}) {
  return (
    <Box flexDirection="column" width={30}>
      {field('Account:', account)}
      {/* Scope is the one field that changes what you are looking at, so it is coloured. */}
      {field('Project:', project || 'all', project ? 'yellow' : undefined)}
      {field('Resources:', String(count))}
      {field('Refresh:', `${refreshSecs}s`)}
      {field('Rev:', 'v0.0.1')}
      {rates ? field('Rates:', rates, 'yellow') : null}
    </Box>
  )
}

/** Only the first nine kinds get a number key, because `10` is not one keypress. */
const NUMBERED = 9

const HINTS: [string, string][] = [
  ...KINDS.slice(0, NUMBERED).map((k, i) => [String(i + 1), k.key] as [string, string]),
  ...KINDS.slice(NUMBERED).map((k) => [`:${k.aliases[0] ?? k.key}`, k.key] as [string, string]),
  ['0', 'all projects'],
  [':', 'command'],
  ['/', 'filter'],
  ['↵', 'describe'],
  ['l', 'logs'],
  ['s', 'shell'],
  ['r', 'refresh'],
  ['q', 'quit'],
]

/**
 * Height of the whole top strip. Derived, not a literal: adding a resource kind
 * grows the hint list, and a stale constant here silently overflows the terminal.
 */
export const HEADER_ROWS = Math.max(4, Math.ceil(HINTS.length / 2))

const col = (items: [string, string][]) => (
  <Box flexDirection="column">
    {items.map(([k, label]) => (
      <Text key={k}>
        <Text color="cyan">{`<${k}>`.padEnd(5)}</Text>
        <Text dimColor>{label.padEnd(12)}</Text>
      </Text>
    ))}
  </Box>
)

/** Two columns of `<key> action`, k9s-style, so the hints never scroll off. */
export function KeyHints() {
  return (
    <Box>
      {col(HINTS.slice(0, HEADER_ROWS))}
      {col(HINTS.slice(HEADER_ROWS))}
    </Box>
  )
}

/**
 * `:` command mode. Shows the inline completion as ghost text the way k9s does,
 * plus the remaining candidates, so tab-completion is discoverable rather than
 * something you have to already know the vocabulary for.
 */
export function Prompt({
  mode,
  value,
  completion,
  candidates,
}: {
  mode: 'command' | 'filter'
  value: string
  completion: string
  candidates: string[]
}) {
  const color = mode === 'command' ? 'magenta' : 'yellow'
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Text>
        <Text color={color} bold>
          {mode === 'command' ? '> ' : '/ '}
        </Text>
        <Text>{value}</Text>
        <Text dimColor>{completion}</Text>
        <Text color={color}>▌</Text>
      </Text>
      {candidates.length > 0 && <Text dimColor>{candidates.join('  ')}</Text>}
    </Box>
  )
}
