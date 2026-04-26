'use client'

/**
 * Newsletter.tsx — email signup as a sentence, with inline form.
 * Bordered top/bottom. Success state replaces the form.
 */

import { useState } from 'react'
import { Section } from './Layout'
import { Container } from './Layout'
import { Stack } from './Layout'
import { Measure } from './Layout'

export function Newsletter() {
  const [email, setEmail] = useState('')
  const [done, setDone] = useState(false)

  return (
    <Section
      id="start"
      gap="lg"
      style={{
        borderTop: '1px solid var(--paper-3)',
        borderBottom: '1px solid var(--paper-3)',
      }}
    >
      <Container>
        <Measure size="wide">
          <Stack gap="md">
            <Measure size="display" as="h2">
              A short letter, once a month, on writing for screens.
            </Measure>
            <Measure as="p">
              Two thousand readers; one editor; no tracking. We send when we have something to say,
              which is usually less often than we'd like.
            </Measure>

            {done ? (
              <p
                style={{
                  color: 'var(--positive)',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 'var(--fs-sm)',
                  margin: 0,
                }}
              >
                Thank you. The next letter goes out on the first of the month.
              </p>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (email) setDone(true)
                }}
                style={{
                  display: 'flex',
                  gap: 'var(--sp-3)',
                  flexWrap: 'wrap',
                  alignItems: 'stretch',
                }}
              >
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@studio.com"
                  style={{
                    fontFamily: 'var(--font-text)',
                    fontSize: 'var(--fs-md)',
                    padding: '0.7em 0.9em',
                    border: '1px solid var(--ink-4)',
                    borderRadius: 'var(--radius-1)',
                    background: 'var(--paper-0)',
                    color: 'var(--ink-0)',
                    minWidth: '260px',
                    flex: '1 1 260px',
                    outline: 'none',
                  }}
                />
                <button
                  type="submit"
                  style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 'var(--fs-sm)',
                    fontWeight: 500,
                    padding: '0.7em 1.6em',
                    background: 'var(--ink-0)',
                    color: 'var(--paper-0)',
                    border: 0,
                    borderRadius: 'var(--radius-1)',
                    cursor: 'pointer',
                  }}
                >
                  Subscribe
                </button>
              </form>
            )}
          </Stack>
        </Measure>
      </Container>
    </Section>
  )
}
