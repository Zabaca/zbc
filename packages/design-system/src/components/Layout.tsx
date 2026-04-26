/**
 * Layout.tsx — five layout primitives for the Prose system.
 *
 *   <Section>      outer wrapper, vertical rhythm, paper tier
 *   <Container>    page max-width + gutter (lives inside Section)
 *   <Stack>        vertical spacing between blocks
 *   <Measure>      caps line-length to a measure token
 *   <Columns>      2 or 3 columns only — no bento, no four-up
 *
 * All accept `as` to change the underlying tag, plus arbitrary HTML attrs.
 */

import type { CSSProperties, ElementType, HTMLAttributes } from 'react'

// ---------- Shared polymorphic prop -----------------------------------------

type PolymorphicProps<E extends ElementType, P = object> = P &
  Omit<HTMLAttributes<HTMLElement>, keyof P> & {
    as?: E
    style?: CSSProperties
  }

// ---------- Section ----------------------------------------------------------
// Outer wrapper for any chunk of the page. Owns --section-gap and optionally
// the background tier.
//
//   <Section>                 paper-0, full section gap
//   <Section tone="quiet">    paper-1
//   <Section gap="md|sm">     override gap size

export type SectionTone = 'default' | 'quiet'
export type SectionGap = 'lg' | 'md' | 'sm'

export interface SectionProps {
  tone?: SectionTone
  gap?: SectionGap
}

export function Section<E extends ElementType = 'section'>({
  children,
  tone = 'default',
  gap = 'lg',
  as,
  style,
  ...rest
}: PolymorphicProps<E, SectionProps>) {
  const Tag = (as ?? 'section') as ElementType

  const padding: Record<SectionGap, string> = {
    lg: 'var(--section-gap) 0',
    md: 'calc(var(--section-gap) * 0.66) 0',
    sm: 'calc(var(--section-gap) * 0.33) 0',
  }

  return (
    <Tag
      style={{
        background: tone === 'quiet' ? 'var(--paper-1)' : 'var(--paper-0)',
        padding: padding[gap],
        ...style,
      }}
      {...rest}
    >
      {children}
    </Tag>
  )
}

// ---------- Container --------------------------------------------------------
// Caps content to --page-max with fluid gutters. Lives inside <Section>.

export function Container<E extends ElementType = 'div'>({
  children,
  as,
  style,
  ...rest
}: PolymorphicProps<E>) {
  const Tag = (as ?? 'div') as ElementType
  return (
    <Tag
      style={{
        maxWidth: 'var(--page-max)',
        margin: '0 auto',
        padding: '0 var(--page-gutter)',
        ...style,
      }}
      {...rest}
    >
      {children}
    </Tag>
  )
}

// ---------- Stack ------------------------------------------------------------
// Vertical spacing primitive. Children get even gaps from the spacing scale.
//
//   <Stack>                  default 24px (md)
//   <Stack gap="xs|sm|md|lg|xl|2xl|3xl">

export type StackGap = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl'

export interface StackProps {
  gap?: StackGap
  align?: 'start' | 'center' | 'end'
}

const stackGapMap: Record<StackGap, string> = {
  xs: 'var(--sp-2)' /*  8 */,
  sm: 'var(--sp-3)' /* 12 */,
  md: 'var(--sp-5)' /* 24 — default */,
  lg: 'var(--sp-6)' /* 32 */,
  xl: 'var(--sp-7)' /* 48 */,
  '2xl': 'var(--sp-8)' /* 64 */,
  '3xl': 'var(--sp-9)' /* 96 */,
}

export function Stack<E extends ElementType = 'div'>({
  children,
  gap = 'md',
  align,
  as,
  style,
  ...rest
}: PolymorphicProps<E, StackProps>) {
  const Tag = (as ?? 'div') as ElementType
  return (
    <Tag
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: stackGapMap[gap],
        alignItems: align,
        ...style,
      }}
      {...rest}
    >
      {children}
    </Tag>
  )
}

// ---------- Measure ----------------------------------------------------------
// Caps line-length. The single most important primitive.
//
//   <Measure>                 prose (62ch) — default
//   <Measure size="narrow">   42ch
//   <Measure size="wide">     78ch
//   <Measure size="display">  22ch

export type MeasureSize = 'narrow' | 'prose' | 'wide' | 'display'

export interface MeasureProps {
  size?: MeasureSize
}

const measureMap: Record<MeasureSize, string> = {
  narrow: 'var(--measure-narrow)',
  prose: 'var(--measure-prose)',
  wide: 'var(--measure-wide)',
  display: 'var(--measure-display)',
}

export function Measure<E extends ElementType = 'div'>({
  children,
  size = 'prose',
  as,
  style,
  ...rest
}: PolymorphicProps<E, MeasureProps>) {
  const Tag = (as ?? 'div') as ElementType
  return (
    <Tag style={{ maxWidth: measureMap[size], ...style }} {...rest}>
      {children}
    </Tag>
  )
}

// ---------- Columns ----------------------------------------------------------
// Two or three columns only. No bento. No four-up.
//
//   <Columns count={2}>                equal halves
//   <Columns count={3}>                thirds
//   <Columns count={2} ratio="1:2">    sidebar + main
//   <Columns count={2} ratio="2:1">    main + sidebar
//
// Responsive: Columns class names reference rules in globals.css.
//   ≤960px  3-col → 2-col
//   ≤720px  everything → 1-col

export type ColumnsCount = 2 | 3
export type ColumnsRatio = '1:1' | '1:2' | '2:1'
export type ColumnsGap = 'sm' | 'md' | 'lg' | 'xl' | '2xl'
export type ColumnsAlign = 'start' | 'center' | 'end' | 'baseline'

export interface ColumnsProps {
  count?: ColumnsCount
  ratio?: ColumnsRatio
  gap?: ColumnsGap
  align?: ColumnsAlign
  collapse?: boolean
}

export function Columns<E extends ElementType = 'div'>({
  children,
  count = 2,
  ratio,
  gap = 'lg',
  align = 'start',
  collapse = true,
  as,
  style,
  className = '',
  ...rest
}: PolymorphicProps<E, ColumnsProps>) {
  const Tag = (as ?? 'div') as ElementType

  const classes = ['prose-columns', `prose-columns--${count}`]
  if (ratio === '1:2') classes.push('prose-columns--1-2')
  if (ratio === '2:1') classes.push('prose-columns--2-1')
  if (!collapse) classes.push('prose-columns--no-collapse')
  classes.push(`prose-columns--gap-${gap}`)

  return (
    <Tag
      className={[...classes, className].filter(Boolean).join(' ')}
      style={{ alignItems: align, ...style }}
      {...rest}
    >
      {children}
    </Tag>
  )
}
