/**
 * Layout.tsx — five layout primitives for the Prose system.
 *
 *   <Section>      outer wrapper, vertical rhythm, paper tier
 *   <Container>    page max-width + gutter (lives inside Section)
 *   <Stack>        vertical spacing between blocks
 *   <Measure>      caps line-length to a measure token
 *   <Columns>      2 or 3 columns only — no bento, no four-up
 *
 * Internally these emit Tailwind v4 utility classes via lookup tables.
 * Class strings are kept literal in source so Tailwind's content scanner
 * picks them up — never compose with template-literal interpolation of
 * fragments.
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

function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ')
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

const sectionToneClass: Record<SectionTone, string> = {
  default: 'bg-paper-0',
  quiet: 'bg-paper-1',
}

const sectionGapClass: Record<SectionGap, string> = {
  lg: 'py-[var(--section-gap)]',
  md: 'py-[calc(var(--section-gap)*0.66)]',
  sm: 'py-[calc(var(--section-gap)*0.33)]',
}

export function Section<E extends ElementType = 'section'>({
  children,
  tone = 'default',
  gap = 'lg',
  as,
  className,
  ...rest
}: PolymorphicProps<E, SectionProps>) {
  const Tag = (as ?? 'section') as ElementType
  return (
    <Tag className={cx(sectionToneClass[tone], sectionGapClass[gap], className)} {...rest}>
      {children}
    </Tag>
  )
}

// ---------- Container --------------------------------------------------------
// Caps content to --container-page with fluid gutters. Lives inside <Section>.

export function Container<E extends ElementType = 'div'>({
  children,
  as,
  className,
  ...rest
}: PolymorphicProps<E>) {
  const Tag = (as ?? 'div') as ElementType
  return (
    <Tag className={cx('mx-auto max-w-page px-[var(--page-gutter)]', className)} {...rest}>
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

const stackGapClass: Record<StackGap, string> = {
  xs: 'gap-2' /*  8px */,
  sm: 'gap-3' /* 12px */,
  md: 'gap-5' /* 24px — default */,
  lg: 'gap-6' /* 32px */,
  xl: 'gap-7' /* 48px */,
  '2xl': 'gap-8' /* 64px */,
  '3xl': 'gap-9' /* 96px */,
}

const stackAlignClass: Record<NonNullable<StackProps['align']>, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
}

export function Stack<E extends ElementType = 'div'>({
  children,
  gap = 'md',
  align,
  as,
  className,
  ...rest
}: PolymorphicProps<E, StackProps>) {
  const Tag = (as ?? 'div') as ElementType
  return (
    <Tag
      className={cx(
        'flex flex-col',
        stackGapClass[gap],
        align && stackAlignClass[align],
        className,
      )}
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

const measureClass: Record<MeasureSize, string> = {
  narrow: 'max-w-narrow',
  prose: 'max-w-prose',
  wide: 'max-w-wide',
  display: 'max-w-display',
}

export function Measure<E extends ElementType = 'div'>({
  children,
  size = 'prose',
  as,
  className,
  ...rest
}: PolymorphicProps<E, MeasureProps>) {
  const Tag = (as ?? 'div') as ElementType
  return (
    <Tag className={cx(measureClass[size], className)} {...rest}>
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
// Mobile-first responsive collapse. `collapseAt` sets the breakpoint above
// which the columns split (default `mid` = 720px). Editorial uses `wide`
// (960px) so its meta column collapses to a horizontal eyebrow earlier.
// `collapse={false}` disables responsive behaviour entirely.

export type ColumnsCount = 2 | 3
export type ColumnsRatio = '1:1' | '1:2' | '2:1'
export type ColumnsGap = 'sm' | 'md' | 'lg' | 'xl' | '2xl'
export type ColumnsAlign = 'start' | 'center' | 'end' | 'baseline'
export type ColumnsCollapseAt = 'mid' | 'wide'

export interface ColumnsProps {
  count?: ColumnsCount
  ratio?: ColumnsRatio
  gap?: ColumnsGap
  align?: ColumnsAlign
  collapse?: boolean
  collapseAt?: ColumnsCollapseAt
}

// Gap shrinks one step at narrow widths (matches the previous CSS rules).
const columnsGapClass: Record<ColumnsGap, string> = {
  sm: 'gap-4 mid:gap-5',
  md: 'gap-5 mid:gap-6',
  lg: 'gap-6 mid:gap-7',
  xl: 'gap-7 mid:gap-8',
  '2xl': 'gap-9',
}

const columnsAlignClass: Record<ColumnsAlign, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  baseline: 'items-baseline',
}

// Lookup keyed by `${count}-${ratio ?? 'eq'}-${collapseAt}`.
// Each value is a complete literal class string so Tailwind can detect it.
const columnsLayoutClass = {
  // count=2, equal, mobile-first
  '2-eq-mid': 'grid-cols-1 mid:grid-cols-2',
  '2-eq-wide': 'grid-cols-1 wide:grid-cols-2',
  // count=2, 1:2 ratio
  '2-1:2-mid': 'grid-cols-1 mid:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]',
  '2-1:2-wide': 'grid-cols-1 wide:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]',
  // count=2, 2:1 ratio
  '2-2:1-mid': 'grid-cols-1 mid:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]',
  '2-2:1-wide': 'grid-cols-1 wide:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]',
  // count=3 — collapses through 2-col before single
  '3-eq-mid': 'grid-cols-1 mid:grid-cols-2 wide:grid-cols-3',
  '3-eq-wide': 'grid-cols-1 wide:grid-cols-3',
} as const

// Non-collapsing variants — just the desktop grid, no breakpoints.
const columnsLayoutClassFixed = {
  '2-eq': 'grid-cols-2',
  '3-eq': 'grid-cols-3',
  '2-1:2': 'grid-cols-[minmax(0,1fr)_minmax(0,2fr)]',
  '2-2:1': 'grid-cols-[minmax(0,2fr)_minmax(0,1fr)]',
} as const

export function Columns<E extends ElementType = 'div'>({
  children,
  count = 2,
  ratio,
  gap = 'lg',
  align = 'start',
  collapse = true,
  collapseAt = 'mid',
  as,
  className,
  ...rest
}: PolymorphicProps<E, ColumnsProps>) {
  const Tag = (as ?? 'div') as ElementType
  const ratioKey = ratio === '1:2' || ratio === '2:1' ? ratio : 'eq'

  const layoutClass = collapse
    ? columnsLayoutClass[`${count}-${ratioKey}-${collapseAt}` as keyof typeof columnsLayoutClass]
    : columnsLayoutClassFixed[`${count}-${ratioKey}` as keyof typeof columnsLayoutClassFixed]

  return (
    <Tag
      className={cx('grid', layoutClass, columnsGapClass[gap], columnsAlignClass[align], className)}
      {...rest}
    >
      {children}
    </Tag>
  )
}
