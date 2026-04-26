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
    <Section id="start" gap="lg" className="border-t border-b border-paper-3">
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
              <p className="font-ui text-sm text-positive m-0">
                Thank you. The next letter goes out on the first of the month.
              </p>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (email) setDone(true)
                }}
                className="flex flex-wrap gap-3 items-stretch"
              >
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@studio.com"
                  className={
                    'font-text text-md px-[0.9em] py-[0.7em] ' +
                    'border border-ink-4 rounded-1 ' +
                    'bg-paper-0 text-ink-0 ' +
                    'min-w-[260px] flex-[1_1_260px] outline-none'
                  }
                />
                <button
                  type="submit"
                  className={
                    'font-ui text-sm font-medium px-[1.6em] py-[0.7em] ' +
                    'bg-ink-0 text-paper-0 border-0 rounded-1 cursor-pointer'
                  }
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
