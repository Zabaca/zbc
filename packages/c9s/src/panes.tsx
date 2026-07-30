// Full-screen panes pushed on top of the table: describe (enter) and logs (l).
import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'
import type { Instance } from './wrangler'

const cell = (v: string, w: number) => v.slice(0, w - 2).padEnd(w)

export function Describe({
  title,
  raw,
  instances,
  height,
  scroll,
}: {
  title: string
  raw: string
  instances?: Instance[] | 'loading' | { error: string }
  height: number
  scroll: number
}) {
  const lines = raw.split('\n')
  const body = lines.slice(scroll, scroll + Math.max(height - 4, 1))
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      height={height}
    >
      <Text color="yellow" bold>{` ${title} `}</Text>
      {instances !== undefined && <Instances instances={instances} />}
      {body.map((l, i) => (
        <Text key={`${scroll + i}`} dimColor={l.trim().endsWith(': {') || l.trim() === '}'}>
          {l}
        </Text>
      ))}
      {lines.length > body.length && (
        <Text dimColor>{` … ${scroll + body.length}/${lines.length} lines, j/k to scroll `}</Text>
      )}
    </Box>
  )
}

/**
 * Returns bare <Text> siblings, not a nested Box: a Box inside the fixed-height
 * describe pane lays out independently and overlaps the lines around it (the
 * header rendered as `-OCATION` on top of the first row).
 */
function Instances({ instances }: { instances: Instance[] | 'loading' | { error: string } }) {
  if (instances === 'loading') return <Text dimColor>instances: loading…</Text>
  if (!Array.isArray(instances)) return <Text color="red">{`instances: ${instances.error}`}</Text>
  if (instances.length === 0) return <Text dimColor>instances: none running</Text>
  return (
    <>
      <Text color="cyan" bold>
        {cell('INSTANCE', 18) + cell('NAME', 16) + cell('STATE', 12) + 'LOCATION'}
      </Text>
      {instances.map((i) => (
        <Text key={i.id}>
          {cell(i.id, 18) + cell(i.name, 16)}
          <Text color={i.state === 'running' ? 'green' : 'yellow'}>{cell(i.state, 12)}</Text>
          {i.location}
        </Text>
      ))}
      <Text> </Text>
    </>
  )
}

/**
 * Live `wrangler tail` output. Keeps a bounded ring of lines: an unbounded log
 * buffer in a long-lived TUI is a memory leak with extra steps.
 */
const MAX_LINES = 2000

export function Logs({
  worker,
  subscribe,
  height,
}: {
  worker: string
  subscribe: (onLine: (line: string) => void) => () => void
  height: number
}) {
  const [lines, setLines] = useState<string[]>([])

  useEffect(() => {
    const stop = subscribe((line) => setLines((ls) => [...ls, line].slice(-MAX_LINES)))
    return stop
  }, [subscribe])

  const capacity = Math.max(height - 3, 1)
  const body = lines.slice(-capacity)
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="green"
      paddingX={1}
      height={height}
    >
      <Text color="green" bold>
        {` tail ${worker} `}
        <Text dimColor>{`[${lines.length}]`}</Text>
      </Text>
      {body.length === 0 ? (
        <Text dimColor>waiting for requests… (esc to close)</Text>
      ) : (
        body.map((l, i) => <Text key={`${lines.length - body.length + i}`}>{l}</Text>)
      )}
    </Box>
  )
}
