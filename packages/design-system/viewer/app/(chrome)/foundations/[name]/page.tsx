/**
 * /foundations/[name] — design-system foundation showcase pages.
 * Header block: label + description.
 * Below hairline: showcase, split into subsections with VariantLabel strips.
 *
 * Colors    → paper / ink / accent / dark mode / semantic
 * Typography → families / scale / display / headings / body / ui
 * Spacing   → scale / measure / rules / primitives
 * Brand     → wordmark / in use
 * Motion    → duration / easing / tokens
 */

import { Fragment } from 'react'
import { notFound } from 'next/navigation'
import { Section, Container, Stack, Measure } from '@ds/index'

// ---- Shared sub-components --------------------------------------------------

/** Hairline-bordered strip that separates showcase subsections. */
function VariantLabel({ label }: { label: string }) {
  return (
    <div
      style={{
        borderTop: '1px solid var(--paper-3)',
        borderBottom: '1px solid var(--paper-3)',
        padding: 'var(--sp-3) var(--page-gutter)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-xs)',
        letterSpacing: 'var(--tr-wide)',
        color: 'var(--ink-3)',
      }}
    >
      {label}
    </div>
  )
}

/** Colour swatch: chip + token name + hex + role. */
interface SwatchProps {
  color: string
  name: string
  hex: string
  role: string
  /** Set true inside the dark panel so text uses hardcoded dark-mode values. */
  onDark?: boolean
}
function Swatch({ color, name, hex, role, onDark = false }: SwatchProps) {
  const txt0 = onDark ? '#DDD8C9' : 'var(--ink-1)'
  const txt1 = onDark ? '#A8A290' : 'var(--ink-2)'
  const txt2 = onDark ? '#75705F' : 'var(--ink-3)'
  const bdr = onDark ? 'rgba(255,255,255,0.1)' : 'var(--paper-3)'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', flexShrink: 0 }}>
      <div
        style={{
          width: 80,
          height: 80,
          background: color,
          border: `1px solid ${bdr}`,
          borderRadius: 'var(--radius-1)',
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-3xs)',
            fontWeight: 500,
            color: txt0,
          }}
        >
          {name}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-3xs)',
            letterSpacing: 'var(--tr-wide)',
            color: txt1,
          }}
        >
          {hex}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-text)',
            fontSize: 'var(--fs-xs)',
            color: txt2,
            fontStyle: 'italic',
          }}
        >
          {role}
        </span>
      </div>
    </div>
  )
}

/** Horizontal row of swatches. */
function SwatchRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 'var(--sp-6)', flexWrap: 'wrap' }}>{children}</div>
}

/** Dark-background panel for the dark-mode swatch section. */
function DarkPanel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: '#14130E',
        padding: 'calc(var(--section-gap) * 0.33) 0',
      }}
    >
      <div
        style={{
          maxWidth: 'var(--page-max)',
          margin: '0 auto',
          padding: '0 var(--page-gutter)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--sp-6)',
        }}
      >
        {children}
      </div>
    </div>
  )
}

// ---- Foundation registry ---------------------------------------------------

interface Entry {
  label: string
  description: string
  Showcase: () => React.ReactNode
}

const REGISTRY: Record<string, Entry> = {
  // --------------------------------------------------------------------------
  // Colors
  // --------------------------------------------------------------------------

  colors: {
    label: 'Colors',
    description:
      'A warm neutral palette — paper (backgrounds), ink (foregrounds), and one burnt-sienna accent. Never more than three accent uses per page.',
    Showcase: () => (
      <>
        {/* ---- Paper ---- */}
        <VariantLabel label="paper" />
        <Section gap="sm">
          <Container>
            <SwatchRow>
              <Swatch color="#FBFAF7" name="--paper-0" hex="#FBFAF7" role="Page background" />
              <Swatch color="#F4F2EC" name="--paper-1" hex="#F4F2EC" role="Quiet sections" />
              <Swatch color="#EAE6DC" name="--paper-2" hex="#EAE6DC" role="Hover, divider fill" />
              <Swatch color="#DCD6C7" name="--paper-3" hex="#DCD6C7" role="Keyline on light" />
            </SwatchRow>
          </Container>
        </Section>

        {/* ---- Ink ---- */}
        <VariantLabel label="ink" />
        <Section tone="quiet" gap="sm">
          <Container>
            <SwatchRow>
              <Swatch color="#14140F" name="--ink-0" hex="#14140F" role="Headlines, primary text" />
              <Swatch color="#2D2C25" name="--ink-1" hex="#2D2C25" role="Body text" />
              <Swatch color="#5A584C" name="--ink-2" hex="#5A584C" role="Secondary, captions" />
              <Swatch color="#8A8676" name="--ink-3" hex="#8A8676" role="Tertiary, placeholders" />
              <Swatch color="#B8B3A1" name="--ink-4" hex="#B8B3A1" role="Faint rules, disabled" />
            </SwatchRow>
          </Container>
        </Section>

        {/* ---- Accent ---- */}
        <VariantLabel label="accent" />
        <Section gap="sm">
          <Container>
            <Stack gap="lg">
              <SwatchRow>
                <Swatch
                  color="#B8410E"
                  name="--accent"
                  hex="#B8410E"
                  role="Burnt sienna · the only colour"
                />
                <Swatch
                  color="#E8D5C4"
                  name="--accent-soft"
                  hex="#E8D5C4"
                  role="Tinted background"
                />
                <Swatch
                  color="#6B2308"
                  name="--accent-ink"
                  hex="#6B2308"
                  role="On-light text, hover"
                />
              </SwatchRow>
              <p
                style={{
                  margin: 0,
                  fontFamily: 'var(--font-text)',
                  fontSize: 'var(--fs-sm)',
                  fontStyle: 'italic',
                  color: 'var(--ink-2)',
                  maxWidth: 'var(--measure-prose)',
                }}
              >
                Used sparingly: link underlines, the one rule on a blockquote, the period at the end
                of a closing line. If you reach for it more than three times on a page, remove two.
              </p>
            </Stack>
          </Container>
        </Section>

        {/* ---- Dark mode ---- */}
        <VariantLabel label="dark mode" />
        <DarkPanel>
          <SwatchRow>
            <Swatch onDark color="#14130E" name="--paper-0" hex="#14130E" role="Page background" />
            <Swatch onDark color="#1C1B16" name="--paper-1" hex="#1C1B16" role="Quiet sections" />
            <Swatch
              onDark
              color="#F2EFE6"
              name="--ink-0"
              hex="#F2EFE6"
              role="Headlines, primary text"
            />
            <Swatch onDark color="#DDD8C9" name="--ink-1" hex="#DDD8C9" role="Body text" />
            <Swatch
              onDark
              color="#E26B3A"
              name="--accent"
              hex="#E26B3A"
              role="Warmer + brighter signal"
            />
          </SwatchRow>
          <p
            style={{
              margin: 0,
              fontFamily: 'var(--font-text)',
              fontSize: 'var(--fs-sm)',
              fontStyle: 'italic',
              color: '#75705F',
            }}
          >
            .dark on &lt;html&gt; — paper inverts to ink-black, ink inverts to warm off-white.
            Toggle with the Dark / Light button in the sidebar.
          </p>
        </DarkPanel>

        {/* ---- Semantic ---- */}
        <VariantLabel label="semantic" />
        <Section tone="quiet" gap="sm">
          <Container>
            <Stack gap="lg">
              <SwatchRow>
                <Swatch color="#2F6B3C" name="--positive" hex="#2F6B3C" role="Form success only" />
                <Swatch color="#A8321A" name="--critical" hex="#A8321A" role="Form error only" />
              </SwatchRow>
              <p
                style={{
                  margin: 0,
                  fontFamily: 'var(--font-text)',
                  fontSize: 'var(--fs-sm)',
                  fontStyle: 'italic',
                  color: 'var(--ink-2)',
                  maxWidth: 'var(--measure-prose)',
                }}
              >
                Functional UI only. Never appears in editorial copy — a green sentence reads as a
                notification, not as writing.
              </p>
            </Stack>
          </Container>
        </Section>
      </>
    ),
  },

  // --------------------------------------------------------------------------
  // Typography
  // --------------------------------------------------------------------------

  typography: {
    label: 'Typography',
    description:
      'Three families — Newsreader for reading and display, Inter Tight for UI, JetBrains Mono for code and micro-labels. Modular scale at ratio 1.333, base 18 px.',
    Showcase: () => (
      <>
        {/* ---- Families ---- */}
        <VariantLabel label="families" />
        <Section gap="sm">
          <Container>
            <Stack gap="lg">
              {/* Newsreader */}
              <div style={{ display: 'flex', gap: 'var(--sp-7)', alignItems: 'baseline' }}>
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.75rem, 4vw, 2.125rem)',
                    lineHeight: 1,
                    color: 'var(--ink-0)',
                  }}
                >
                  Aa Bb Cc
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-ui)',
                      fontSize: 'var(--fs-2xs)',
                      fontWeight: 600,
                      letterSpacing: 'var(--tr-wide)',
                      textTransform: 'uppercase',
                      color: 'var(--ink-0)',
                    }}
                  >
                    Newsreader
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-3xs)',
                      color: 'var(--ink-2)',
                    }}
                  >
                    display + reading · 300 / 400 / 500 / 600 / 700 + italic · opsz
                  </span>
                </div>
              </div>
              {/* Inter Tight */}
              <div style={{ display: 'flex', gap: 'var(--sp-7)', alignItems: 'baseline' }}>
                <span
                  style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 'clamp(1.5rem, 3vw, 1.875rem)',
                    lineHeight: 1,
                    fontWeight: 500,
                    color: 'var(--ink-0)',
                  }}
                >
                  Aa Bb Cc
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-ui)',
                      fontSize: 'var(--fs-2xs)',
                      fontWeight: 600,
                      letterSpacing: 'var(--tr-wide)',
                      textTransform: 'uppercase',
                      color: 'var(--ink-0)',
                    }}
                  >
                    Inter Tight
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-3xs)',
                      color: 'var(--ink-2)',
                    }}
                  >
                    UI · 400 / 500 / 600 / 700
                  </span>
                </div>
              </div>
              {/* JetBrains Mono */}
              <div style={{ display: 'flex', gap: 'var(--sp-7)', alignItems: 'baseline' }}>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'clamp(1.25rem, 2.5vw, 1.625rem)',
                    lineHeight: 1,
                    color: 'var(--ink-0)',
                  }}
                >
                  Aa Bb Cc
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-ui)',
                      fontSize: 'var(--fs-2xs)',
                      fontWeight: 600,
                      letterSpacing: 'var(--tr-wide)',
                      textTransform: 'uppercase',
                      color: 'var(--ink-0)',
                    }}
                  >
                    JetBrains Mono
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-3xs)',
                      color: 'var(--ink-2)',
                    }}
                  >
                    code · micro-labels · 400 / 500 / 600
                  </span>
                </div>
              </div>
            </Stack>
          </Container>
        </Section>

        {/* ---- Scale ---- */}
        <VariantLabel label="scale" />
        <Section tone="quiet" gap="sm">
          <Container>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '9rem 4rem 1fr',
                rowGap: 'var(--sp-4)',
                alignItems: 'baseline',
              }}
            >
              {[
                {
                  token: '--fs-6xl',
                  px: '136',
                  size: 'clamp(4rem, 12vw, var(--fs-6xl))',
                  family: 'var(--font-display)',
                  tracking: 'var(--tr-tightest)',
                },
                {
                  token: '--fs-5xl',
                  px: '96',
                  size: 'clamp(3rem, 8vw,  var(--fs-5xl))',
                  family: 'var(--font-display)',
                  tracking: 'var(--tr-tightest)',
                },
                {
                  token: '--fs-4xl',
                  px: '68',
                  size: 'clamp(2.5rem, 6vw, var(--fs-4xl))',
                  family: 'var(--font-display)',
                  tracking: 'var(--tr-tighter)',
                },
                {
                  token: '--fs-3xl',
                  px: '48',
                  size: 'var(--fs-3xl)',
                  family: 'var(--font-display)',
                  tracking: 'var(--tr-tighter)',
                },
                {
                  token: '--fs-2xl',
                  px: '36',
                  size: 'var(--fs-2xl)',
                  family: 'var(--font-display)',
                  tracking: 'var(--tr-tight)',
                },
                {
                  token: '--fs-xl',
                  px: '28',
                  size: 'var(--fs-xl)',
                  family: 'var(--font-display)',
                  tracking: 'var(--tr-tight)',
                },
                {
                  token: '--fs-lg',
                  px: '22',
                  size: 'var(--fs-lg)',
                  family: 'var(--font-text)',
                  tracking: 'var(--tr-normal)',
                },
                {
                  token: '--fs-md',
                  px: '18',
                  size: 'var(--fs-md)',
                  family: 'var(--font-text)',
                  tracking: 'var(--tr-normal)',
                },
                {
                  token: '--fs-sm',
                  px: '15',
                  size: 'var(--fs-sm)',
                  family: 'var(--font-ui)',
                  tracking: 'var(--tr-normal)',
                },
                {
                  token: '--fs-xs',
                  px: '13',
                  size: 'var(--fs-xs)',
                  family: 'var(--font-mono)',
                  tracking: 'var(--tr-normal)',
                },
                {
                  token: '--fs-2xs',
                  px: '12',
                  size: 'var(--fs-2xs)',
                  family: 'var(--font-ui)',
                  tracking: 'var(--tr-normal)',
                },
                {
                  token: '--fs-3xs',
                  px: '11',
                  size: 'var(--fs-3xs)',
                  family: 'var(--font-mono)',
                  tracking: 'var(--tr-normal)',
                },
              ].map(({ token, px, size, family, tracking }) => (
                <Fragment key={token}>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-3xs)',
                      color: 'var(--ink-2)',
                    }}
                  >
                    {token}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-3xs)',
                      color: 'var(--ink-3)',
                    }}
                  >
                    {px}
                  </span>
                  <span
                    style={{
                      fontFamily: family,
                      fontSize: size,
                      lineHeight: 1,
                      color: 'var(--ink-0)',
                      letterSpacing: tracking,
                    }}
                  >
                    Aa
                  </span>
                </Fragment>
              ))}
            </div>
            <p
              style={{
                margin: 'var(--sp-6) 0 0',
                fontFamily: 'var(--font-text)',
                fontSize: 'var(--fs-xs)',
                fontStyle: 'italic',
                color: 'var(--ink-2)',
              }}
            >
              Modular, ratio 1.333 · base 18 px · display steps break the ratio for editorial drama.
            </p>
          </Container>
        </Section>

        {/* ---- Display ---- */}
        <VariantLabel label="display" />
        <Section gap="sm">
          <Container>
            <Stack gap="md">
              <div>
                <div
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(2.5rem, 6vw, var(--fs-4xl))',
                    lineHeight: 'var(--lh-display)',
                    letterSpacing: 'var(--tr-tightest)',
                    color: 'var(--ink-0)',
                    fontWeight: 400,
                  }}
                >
                  A landing page
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(2.5rem, 6vw, var(--fs-4xl))',
                    lineHeight: 'var(--lh-display)',
                    letterSpacing: 'var(--tr-tightest)',
                    color: 'var(--ink-0)',
                    fontStyle: 'italic',
                    fontWeight: 400,
                  }}
                >
                  is a piece of writing.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 'var(--sp-6)' }}>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-3xs)',
                    color: 'var(--ink-3)',
                  }}
                >
                  Newsreader · display size
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-3xs)',
                    color: 'var(--ink-3)',
                  }}
                >
                  tracking −0.04em
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-3xs)',
                    color: 'var(--ink-3)',
                  }}
                >
                  opsz auto
                </span>
              </div>
            </Stack>
          </Container>
        </Section>

        {/* ---- Headings ---- */}
        <VariantLabel label="headings" />
        <Section tone="quiet" gap="sm">
          <Container>
            <Stack gap="md">
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'var(--fs-3xl)',
                  lineHeight: 'var(--lh-tight)',
                  letterSpacing: 'var(--tr-tighter)',
                  color: 'var(--ink-0)',
                }}
              >
                Heading two
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'var(--fs-2xl)',
                  lineHeight: 'var(--lh-tight)',
                  letterSpacing: 'var(--tr-tight)',
                  color: 'var(--ink-0)',
                }}
              >
                Heading three
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'var(--fs-xl)',
                  lineHeight: 'var(--lh-snug)',
                  letterSpacing: 'var(--tr-tight)',
                  color: 'var(--ink-0)',
                }}
              >
                Heading four
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'var(--fs-lg)',
                  lineHeight: 'var(--lh-snug)',
                  color: 'var(--ink-0)',
                  fontWeight: 500,
                }}
              >
                Heading five
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-ui)',
                  fontSize: 'var(--fs-2xs)',
                  lineHeight: 'var(--lh-normal)',
                  letterSpacing: 'var(--tr-widest)',
                  textTransform: 'uppercase',
                  color: 'var(--ink-2)',
                  fontWeight: 600,
                }}
              >
                Heading six — eyebrow
              </div>
            </Stack>
          </Container>
        </Section>

        {/* ---- Body ---- */}
        <VariantLabel label="body" />
        <Section gap="sm">
          <Container>
            <Stack gap="md">
              <div
                style={{
                  fontFamily: 'var(--font-text)',
                  fontSize: 'var(--fs-lg)',
                  lineHeight: 'var(--lh-normal)',
                  color: 'var(--ink-1)',
                  maxWidth: 'var(--measure-prose)',
                }}
              >
                Lede paragraph. Slightly larger than body, sits one notch warmer in tone, runs a bit
                wider.
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-text)',
                  fontSize: 'var(--fs-md)',
                  lineHeight: 'var(--lh-prose)',
                  color: 'var(--ink-1)',
                  maxWidth: 'var(--measure-prose)',
                }}
              >
                Body paragraph. Set in Newsreader at 18 over 30, optical-sized for reading, with a
                measure of 62 ch — the comfortable line length for long-form prose. Tracking sits at
                zero; the typeface does the work.
              </div>
              <div style={{ display: 'flex', gap: 'var(--sp-6)' }}>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-3xs)',
                    color: 'var(--ink-3)',
                  }}
                >
                  Lede 22 / 33
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-3xs)',
                    color: 'var(--ink-3)',
                  }}
                >
                  Body 18 / 30
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-3xs)',
                    color: 'var(--ink-3)',
                  }}
                >
                  measure 62 ch
                </span>
              </div>
            </Stack>
          </Container>
        </Section>

        {/* ---- UI ---- */}
        <VariantLabel label="ui" />
        <Section tone="quiet" gap="sm">
          <Container>
            <Stack gap="md">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-5)' }}>
                <span
                  style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 'var(--fs-2xs)',
                    fontWeight: 600,
                    letterSpacing: 'var(--tr-widest)',
                    textTransform: 'uppercase',
                    color: 'var(--ink-2)',
                  }}
                >
                  Eyebrow label
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-3xs)',
                    color: 'var(--ink-3)',
                  }}
                >
                  Inter Tight 12 · +0.16em · upper
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-5)' }}>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-xs)',
                    color: 'var(--ink-2)',
                    letterSpacing: 'var(--tr-wide)',
                  }}
                >
                  label / mono — 04 of 12
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-3xs)',
                    color: 'var(--ink-3)',
                  }}
                >
                  JetBrains Mono 13
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-5)' }}>
                <span
                  style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 'var(--fs-sm)',
                    color: 'var(--ink-1)',
                  }}
                >
                  Small UI / button text
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-3xs)',
                    color: 'var(--ink-3)',
                  }}
                >
                  Inter Tight 15
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-5)' }}>
                <span
                  style={{
                    fontFamily: 'var(--font-text)',
                    fontSize: 'var(--fs-xs)',
                    color: 'var(--ink-2)',
                  }}
                >
                  Caption · small. Used under figures and below dense lists.
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-3xs)',
                    color: 'var(--ink-3)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Newsreader 13
                </span>
              </div>
            </Stack>
          </Container>
        </Section>
      </>
    ),
  },

  // --------------------------------------------------------------------------
  // Spacing
  // --------------------------------------------------------------------------

  spacing: {
    label: 'Spacing',
    description:
      'An 8 px base scale with 11 steps. sp-11 (192 px) is the default section gap. Measure tokens cap prose line length; rule tokens define hairlines.',
    Showcase: () => (
      <>
        {/* ---- Scale ---- */}
        <VariantLabel label="scale" />
        <Section gap="sm">
          <Container>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
              {[
                { token: '--sp-1', px: '4' },
                { token: '--sp-2', px: '8' },
                { token: '--sp-3', px: '12' },
                { token: '--sp-4', px: '16' },
                { token: '--sp-5', px: '24' },
                { token: '--sp-6', px: '32' },
                { token: '--sp-7', px: '48' },
                { token: '--sp-8', px: '64' },
                { token: '--sp-9', px: '96' },
                { token: '--sp-10', px: '128' },
                { token: '--sp-11', px: '192' },
              ].map(({ token, px }) => (
                <div
                  key={token}
                  style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-4)' }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-3xs)',
                      color: 'var(--ink-2)',
                      width: '5rem',
                      flexShrink: 0,
                    }}
                  >
                    {token}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-3xs)',
                      color: 'var(--ink-3)',
                      width: '2.5rem',
                      flexShrink: 0,
                    }}
                  >
                    {px}
                  </span>
                  <div
                    style={{
                      height: 10,
                      width: `${px}px`,
                      background: 'var(--ink-0)',
                      flexShrink: 0,
                    }}
                  />
                </div>
              ))}
            </div>
            <p
              style={{
                margin: 'var(--sp-6) 0 0',
                fontFamily: 'var(--font-text)',
                fontSize: 'var(--fs-xs)',
                fontStyle: 'italic',
                color: 'var(--ink-2)',
              }}
            >
              8 px base · sp-11 (192) is the default section gap.
            </p>
          </Container>
        </Section>

        {/* ---- Measure ---- */}
        <VariantLabel label="measure" />
        <Section tone="quiet" gap="sm">
          <Container>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--sp-6)',
                overflow: 'hidden',
              }}
            >
              {[
                {
                  token: '--measure-display',
                  ch: '22ch',
                  role: 'headlines wrap here',
                  accent: true,
                },
                {
                  token: '--measure-narrow',
                  ch: '42ch',
                  role: 'pull quotes, poetry',
                  accent: false,
                },
                {
                  token: '--measure-prose',
                  ch: '62ch',
                  role: 'long-form reading · default',
                  accent: false,
                },
                {
                  token: '--measure-wide',
                  ch: '78ch',
                  role: 'lede / standfirst · maximum',
                  accent: false,
                },
              ].map(({ token, ch, role, accent }) => (
                <div key={token}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 'var(--sp-3)',
                      marginBottom: 'var(--sp-2)',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--fs-3xs)',
                        color: 'var(--ink-2)',
                      }}
                    >
                      {token}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--fs-3xs)',
                        color: 'var(--ink-3)',
                      }}
                    >
                      {ch} · {role}
                    </span>
                  </div>
                  <div
                    style={{
                      height: 6,
                      width: ch,
                      maxWidth: '100%',
                      background: accent ? 'var(--accent)' : 'var(--ink-0)',
                    }}
                  />
                </div>
              ))}
            </div>
            <p
              style={{
                margin: 'var(--sp-6) 0 0',
                fontFamily: 'var(--font-text)',
                fontSize: 'var(--fs-xs)',
                fontStyle: 'italic',
                color: 'var(--ink-2)',
              }}
            >
              The single most important variable in this system.
            </p>
          </Container>
        </Section>

        {/* ---- Rules ---- */}
        <VariantLabel label="rules" />
        <Section gap="sm">
          <Container>
            <Stack gap="lg">
              {/* Hairline */}
              <div>
                <div
                  style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 'var(--fs-2xs)',
                    fontWeight: 600,
                    letterSpacing: 'var(--tr-widest)',
                    textTransform: 'uppercase',
                    color: 'var(--ink-2)',
                    marginBottom: 'var(--sp-3)',
                  }}
                >
                  Hairline · 1 px
                </div>
                <div
                  style={{ borderTop: '1px solid var(--ink-4)', maxWidth: 'var(--measure-prose)' }}
                />
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-3xs)',
                    color: 'var(--ink-3)',
                    marginTop: 'var(--sp-2)',
                  }}
                >
                  --rule-hair · keylines, &lt;hr&gt;
                </div>
              </div>
              {/* Soft */}
              <div>
                <div
                  style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 'var(--fs-2xs)',
                    fontWeight: 600,
                    letterSpacing: 'var(--tr-widest)',
                    textTransform: 'uppercase',
                    color: 'var(--ink-2)',
                    marginBottom: 'var(--sp-3)',
                  }}
                >
                  Soft · 1 px paper
                </div>
                <div
                  style={{
                    borderTop: '1px solid var(--paper-3)',
                    maxWidth: 'var(--measure-prose)',
                  }}
                />
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-3xs)',
                    color: 'var(--ink-3)',
                    marginTop: 'var(--sp-2)',
                  }}
                >
                  --rule-soft · subtle dividers
                </div>
              </div>
              {/* Accent */}
              <div>
                <div
                  style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 'var(--fs-2xs)',
                    fontWeight: 600,
                    letterSpacing: 'var(--tr-widest)',
                    textTransform: 'uppercase',
                    color: 'var(--ink-2)',
                    marginBottom: 'var(--sp-3)',
                  }}
                >
                  Accent · 2 px
                </div>
                <div
                  style={{ borderTop: '2px solid var(--accent)', maxWidth: 'var(--measure-prose)' }}
                />
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-3xs)',
                    color: 'var(--ink-3)',
                    marginTop: 'var(--sp-2)',
                  }}
                >
                  --rule-accent · blockquote left edge — used once per page
                </div>
              </div>
            </Stack>
            <p
              style={{
                margin: 'var(--sp-7) 0 0',
                fontFamily: 'var(--font-text)',
                fontSize: 'var(--fs-xs)',
                fontStyle: 'italic',
                color: 'var(--ink-2)',
              }}
            >
              No shadows, no elevation, no glow. Hierarchy is type and space.
            </p>
          </Container>
        </Section>

        {/* ---- Primitives ---- */}
        <VariantLabel label="primitives" />
        <Section tone="quiet" gap="sm">
          <Container>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '7rem 1fr',
                rowGap: 'var(--sp-5)',
                columnGap: 'var(--sp-6)',
                alignItems: 'baseline',
                maxWidth: 'var(--measure-wide)',
              }}
            >
              {[
                {
                  name: 'Section',
                  desc: 'Outer wrapper · vertical rhythm + paper tier',
                  detail: 'tone="quiet"',
                },
                {
                  name: 'Container',
                  desc: 'Page max-width + gutter · sits inside Section',
                  detail: null,
                },
                {
                  name: 'Stack',
                  desc: 'Vertical spacing between blocks',
                  detail: 'gap="xs|sm|md|lg|xl|2xl|3xl"',
                },
                {
                  name: 'Measure',
                  desc: 'Caps line-length',
                  detail: 'size="narrow|prose|wide|display"',
                },
                { name: 'Columns', desc: '2 or 3 columns only', detail: 'ratio="1:1|1:2|2:1"' },
              ].map(({ name, desc, detail }) => (
                <Fragment key={name}>
                  <code
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-xs)',
                      color: 'var(--accent)',
                      background: 'transparent',
                      padding: 0,
                    }}
                  >
                    {name}
                  </code>
                  <span
                    style={{
                      fontFamily: 'var(--font-text)',
                      fontSize: 'var(--fs-sm)',
                      color: 'var(--ink-1)',
                    }}
                  >
                    {desc}
                    {detail && (
                      <>
                        {' '}
                        ·{' '}
                        <code
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 'var(--fs-3xs)',
                            color: 'var(--ink-3)',
                            background: 'transparent',
                            padding: 0,
                          }}
                        >
                          {detail}
                        </code>
                      </>
                    )}
                  </span>
                </Fragment>
              ))}
            </div>
            <p
              style={{
                margin: 'var(--sp-6) 0 0',
                fontFamily: 'var(--font-text)',
                fontSize: 'var(--fs-xs)',
                fontStyle: 'italic',
                color: 'var(--ink-2)',
              }}
            >
              Five primitives. The layout rules from the README, encoded as components.
            </p>
          </Container>
        </Section>
      </>
    ),
  },

  // --------------------------------------------------------------------------
  // Brand
  // --------------------------------------------------------------------------

  brand: {
    label: 'Brand',
    description:
      'The Prose wordmark — Newsreader serif with a burnt-sienna period. Three usage sizes. Identity is expressed through typography, not through a logomark.',
    Showcase: () => (
      <>
        {/* ---- Wordmark ---- */}
        <VariantLabel label="wordmark" />
        <Section gap="sm">
          <Container>
            <Stack gap="lg">
              {/* 64 px */}
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'clamp(2.5rem, 6vw, 4rem)',
                  lineHeight: 1,
                  letterSpacing: 'var(--tr-tightest)',
                  color: 'var(--ink-0)',
                  fontWeight: 500,
                }}
              >
                Prose<span style={{ color: 'var(--accent)' }}>.</span>
              </div>
              {/* 30 px and 18 px side by side */}
              <div style={{ display: 'flex', gap: 'var(--sp-7)', alignItems: 'baseline' }}>
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'var(--fs-2xl)',
                    letterSpacing: 'var(--tr-tighter)',
                    color: 'var(--ink-0)',
                    fontWeight: 500,
                  }}
                >
                  Prose<span style={{ color: 'var(--accent)' }}>.</span>
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'var(--fs-md)',
                    letterSpacing: 'var(--tr-tight)',
                    color: 'var(--ink-0)',
                    fontWeight: 500,
                  }}
                >
                  Prose<span style={{ color: 'var(--accent)' }}>.</span>
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-3xs)',
                    color: 'var(--ink-3)',
                    letterSpacing: 'var(--tr-wide)',
                  }}
                >
                  — wordmark · serif + accent period
                </span>
              </div>
            </Stack>
          </Container>
        </Section>

        {/* ---- In use ---- */}
        <VariantLabel label="in use" />
        <Section tone="quiet" gap="sm">
          <Container>
            <Stack gap="md">
              <span
                style={{
                  fontFamily: 'var(--font-ui)',
                  fontSize: 'var(--fs-2xs)',
                  fontWeight: 600,
                  letterSpacing: 'var(--tr-widest)',
                  textTransform: 'uppercase',
                  color: 'var(--ink-2)',
                }}
              >
                No. 04 · A landing page in 80 words
              </span>
              <h1
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'clamp(2rem, 5vw, var(--fs-4xl))',
                  lineHeight: 'var(--lh-display)',
                  letterSpacing: 'var(--tr-tightest)',
                  color: 'var(--ink-0)',
                  fontWeight: 400,
                  maxWidth: 'var(--measure-display)',
                  margin: 0,
                }}
              >
                Send an invoice. Get paid.
              </h1>
              <p
                style={{
                  fontFamily: 'var(--font-text)',
                  fontSize: 'var(--fs-md)',
                  lineHeight: 'var(--lh-normal)',
                  color: 'var(--ink-1)',
                  maxWidth: '52ch',
                  margin: 0,
                }}
              >
                We made the simplest tool we could and stopped there.{' '}
                <a
                  href="#"
                  style={{
                    color: 'var(--ink-0)',
                    textDecoration: 'underline',
                    textDecorationColor: 'var(--accent)',
                    textUnderlineOffset: '0.18em',
                    textDecorationThickness: '1px',
                  }}
                >
                  Read the rest →
                </a>
              </p>
            </Stack>
          </Container>
        </Section>
      </>
    ),
  },

  // --------------------------------------------------------------------------
  // Motion
  // --------------------------------------------------------------------------

  motion: {
    label: 'Motion',
    description:
      'Three durations and two easing curves. Everything transitions — nothing animates for its own sake. If removing the transition is unnoticeable, remove it.',
    Showcase: () => (
      <>
        <style>{`
          @keyframes ds-motion-slide {
            from { transform: translateX(0); }
            to   { transform: translateX(200px); }
          }
        `}</style>

        {/* ---- Duration ---- */}
        <VariantLabel label="duration" />
        <Section gap="sm">
          <Container>
            <Stack gap="lg">
              {[
                { token: '--dur-fast', ms: '140ms', label: 'fast' },
                { token: '--dur-base', ms: '240ms', label: 'base' },
                { token: '--dur-slow', ms: '420ms', label: 'slow' },
              ].map(({ token, ms, label }) => (
                <div
                  key={token}
                  style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-5)' }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-3xs)',
                      color: 'var(--ink-2)',
                      width: '6rem',
                      flexShrink: 0,
                    }}
                  >
                    {token}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-3xs)',
                      color: 'var(--ink-3)',
                      width: '3rem',
                      flexShrink: 0,
                    }}
                  >
                    {ms}
                  </span>
                  {/* Track */}
                  <div
                    style={{
                      position: 'relative',
                      width: 248,
                      height: 20,
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                    }}
                  >
                    <div
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 99,
                        background: 'var(--ink-0)',
                        position: 'absolute',
                        animation: `ds-motion-slide ${ms} cubic-bezier(0.2, 0.6, 0.2, 1) alternate infinite both`,
                      }}
                    />
                  </div>
                  <span
                    style={{
                      fontFamily: 'var(--font-text)',
                      fontSize: 'var(--fs-xs)',
                      color: 'var(--ink-3)',
                      fontStyle: 'italic',
                    }}
                  >
                    {label}
                  </span>
                </div>
              ))}
            </Stack>
          </Container>
        </Section>

        {/* ---- Easing ---- */}
        <VariantLabel label="easing" />
        <Section tone="quiet" gap="sm">
          <Container>
            <Stack gap="lg">
              {[
                {
                  token: '--ease',
                  curve: 'cubic-bezier(0.2, 0.6, 0.2, 1)',
                  label: 'standard — smooth deceleration',
                },
                {
                  token: '--ease-out',
                  curve: 'cubic-bezier(0.16, 1, 0.3, 1)',
                  label: 'ease-out — snappy, spring-like',
                },
              ].map(({ token, curve, label }) => (
                <div
                  key={token}
                  style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-5)' }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-3xs)',
                      color: 'var(--ink-2)',
                      width: '6rem',
                      flexShrink: 0,
                    }}
                  >
                    {token}
                  </span>
                  {/* Track */}
                  <div
                    style={{
                      position: 'relative',
                      width: 248,
                      height: 20,
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                    }}
                  >
                    <div
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 99,
                        background: 'var(--ink-0)',
                        position: 'absolute',
                        animation: `ds-motion-slide 600ms ${curve} alternate infinite both`,
                      }}
                    />
                  </div>
                  <span
                    style={{
                      fontFamily: 'var(--font-text)',
                      fontSize: 'var(--fs-xs)',
                      color: 'var(--ink-3)',
                      fontStyle: 'italic',
                    }}
                  >
                    {label}
                  </span>
                </div>
              ))}
            </Stack>
          </Container>
        </Section>

        {/* ---- Tokens ---- */}
        <VariantLabel label="tokens" />
        <Section gap="sm">
          <Container>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '7rem 8rem 1fr',
                rowGap: 'var(--sp-4)',
                columnGap: 'var(--sp-5)',
                alignItems: 'baseline',
                maxWidth: 'var(--measure-wide)',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--fs-3xs)',
                  color: 'var(--ink-3)',
                  fontWeight: 600,
                  letterSpacing: 'var(--tr-wide)',
                  textTransform: 'uppercase',
                }}
              >
                token
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--fs-3xs)',
                  color: 'var(--ink-3)',
                  fontWeight: 600,
                  letterSpacing: 'var(--tr-wide)',
                  textTransform: 'uppercase',
                }}
              >
                value
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--fs-3xs)',
                  color: 'var(--ink-3)',
                  fontWeight: 600,
                  letterSpacing: 'var(--tr-wide)',
                  textTransform: 'uppercase',
                }}
              >
                use
              </span>

              {[
                { token: '--dur-fast', value: '140ms', use: 'hover state transitions' },
                { token: '--dur-base', value: '240ms', use: 'panels, drawers, reveals' },
                {
                  token: '--dur-slow',
                  value: '420ms',
                  use: 'page transitions, large layout shifts',
                },
                {
                  token: '--ease',
                  value: 'cubic-bezier(0.2, 0.6, 0.2, 1)',
                  use: 'all transitions by default',
                },
                {
                  token: '--ease-out',
                  value: 'cubic-bezier(0.16, 1, 0.3, 1)',
                  use: 'elements entering the screen',
                },
              ].map(({ token, value, use }) => (
                <Fragment key={token}>
                  <code
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-xs)',
                      color: 'var(--accent)',
                      background: 'transparent',
                      padding: 0,
                    }}
                  >
                    {token}
                  </code>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-3xs)',
                      color: 'var(--ink-2)',
                    }}
                  >
                    {value}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-text)',
                      fontSize: 'var(--fs-sm)',
                      color: 'var(--ink-2)',
                      fontStyle: 'italic',
                    }}
                  >
                    {use}
                  </span>
                </Fragment>
              ))}
            </div>
          </Container>
        </Section>
      </>
    ),
  },
}

// ---- Static params + metadata + page ----------------------------------------

interface Props {
  params: Promise<{ name: string }>
}

export function generateStaticParams() {
  return Object.keys(REGISTRY).map((name) => ({ name }))
}

export async function generateMetadata({ params }: Props) {
  const { name } = await params
  const entry = REGISTRY[name]
  return {
    title: entry ? `${entry.label} — Prose DS` : 'Not found — Prose DS',
  }
}

export default async function FoundationPage({ params }: Props) {
  const { name } = await params
  const entry = REGISTRY[name]
  if (!entry) notFound()

  return (
    <>
      {/* ---- Foundation header ---- */}
      <Section style={{ paddingBottom: 'var(--sp-9)' }}>
        <Container>
          <Stack gap="md">
            <Measure
              size="display"
              as="h1"
              style={{
                fontSize: 'clamp(2rem, 5vw, var(--fs-3xl))',
                lineHeight: 'var(--lh-tight)',
                letterSpacing: 'var(--tr-tighter)',
                fontWeight: 400,
              }}
            >
              {entry.label}
            </Measure>
            <Measure as="p" style={{ margin: 0 }}>
              {entry.description}
            </Measure>
          </Stack>
        </Container>
      </Section>

      {/* ---- Showcase ---- */}
      <div style={{ borderTop: '1px solid var(--paper-3)' }}>
        <entry.Showcase />
      </div>
    </>
  )
}
