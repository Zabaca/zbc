/**
 * Where a field sits, in the two coordinate systems that must agree: the page AS SHOWN (what a signer sees,
 * what the browser's page viewer draws, what a field's box is stored in) and the file's own user space (what a
 * content stream draws in). They differ by the page's /Rotate and by where its crop box sits.
 *
 * A field's box is stored as FRACTIONS of the shown page measured from its top-left corner, so placement does
 * not depend on how a file stores rotation or crop (Documenso stores page percentages too). This is the only
 * place that converts, and the conversion is one matrix: the engine draws a stamp in "shown space" (origin at
 * the shown page's bottom-left, y up, upright for the viewer) inside a `cm` that carries it into user space.
 * It is pure so it can be tested to the pixel without a PDF (test/geometry.test.ts); messy PDFs break most
 * often right here.
 */

export type Rotation = 0 | 90 | 180 | 270

/** A page box in the file's user space. */
export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The two boxes and the rotation that decide how a page is shown. */
export interface PageGeometry {
  mediaBox: Box
  /** Absent means the media box. */
  cropBox?: Box
  rotation: Rotation
}

/** A fraction box from the shown page's top-left corner. */
export interface FractionBox {
  x: number
  y: number
  width: number
  height: number
}

/** The visible region: the crop box clipped to the media box (a reader shows the intersection). */
export function visibleBox(g: PageGeometry): Box {
  const m = g.mediaBox
  const c = g.cropBox ?? m
  const box = { x0: Math.max(Math.min(m.x0, m.x1), Math.min(c.x0, c.x1)), y0: Math.max(Math.min(m.y0, m.y1), Math.min(c.y0, c.y1)), x1: Math.min(Math.max(m.x1, m.x0), Math.max(c.x1, c.x0)), y1: Math.min(Math.max(m.y1, m.y0), Math.max(c.y1, c.y0)) }
  // A crop box wholly outside the media box shows nothing; fall back to the media box rather than a zero page.
  return box.x1 > box.x0 && box.y1 > box.y0 ? box : { x0: Math.min(m.x0, m.x1), y0: Math.min(m.y0, m.y1), x1: Math.max(m.x0, m.x1), y1: Math.max(m.y0, m.y1) }
}

/** The page's size as shown, in points: the visible box, swapped when the page is turned sideways. */
export function shownSize(g: PageGeometry): { width: number; height: number } {
  const v = visibleBox(g)
  const w = v.x1 - v.x0
  const h = v.y1 - v.y0
  return g.rotation === 90 || g.rotation === 270 ? { width: h, height: w } : { width: w, height: h }
}

/** [a, b, c, d, e, f] as a PDF `cm` takes them: X = a x + c y + e, Y = b x + d y + f. */
export type Matrix = [number, number, number, number, number, number]

/**
 * The matrix that carries "shown space" (origin at the shown page's bottom-left, x right, y up, in points)
 * into the file's user space.
 */
export function shownToUser(g: PageGeometry): Matrix {
  const v = visibleBox(g)
  const { width: ws, height: hs } = shownSize(g)
  switch (g.rotation) {
    case 0:
      return [1, 0, 0, 1, v.x0, v.y0]
    case 90:
      // The shown page's top-left is the file page's bottom-left, so shown x runs up the file's left edge.
      return [0, 1, -1, 0, v.x0 + hs, v.y0]
    case 180:
      return [-1, 0, 0, -1, v.x0 + ws, v.y0 + hs]
    case 270:
      return [0, -1, 1, 0, v.x0, v.y0 + ws]
  }
}

/** A field's fraction box in shown space: left, bottom, width and height in points, y up. */
export function fractionToShown(g: PageGeometry, f: FractionBox): { x: number; y: number; width: number; height: number } {
  const { width: ws, height: hs } = shownSize(g)
  return { x: f.x * ws, y: hs - (f.y + f.height) * hs, width: f.width * ws, height: f.height * hs }
}

/** A point in shown space to the file's user space (for tests and for placing a detected field). */
export function applyMatrix(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

/**
 * The inverse, for a detected field: a widget's rectangle is in user space, and a field's box is a fraction
 * of the shown page. Returns the fraction box of the axis-aligned rectangle (x0, y0, x1, y1) in user space.
 */
export function userRectToFraction(g: PageGeometry, rect: Box): FractionBox {
  const { width: ws, height: hs } = shownSize(g)
  const m = shownToUser(g)
  // The matrix is a rotation by a multiple of 90 degrees, so its inverse is its transpose.
  const det = m[0] * m[3] - m[1] * m[2]
  const inv = (x: number, y: number) => {
    const dx = x - m[4]
    const dy = y - m[5]
    return { x: (m[3] * dx - m[2] * dy) / det, y: (-m[1] * dx + m[0] * dy) / det }
  }
  const a = inv(rect.x0, rect.y0)
  const b = inv(rect.x1, rect.y1)
  const left = Math.min(a.x, b.x)
  const right = Math.max(a.x, b.x)
  const bottom = Math.min(a.y, b.y)
  const top = Math.max(a.y, b.y)
  // Each edge is clamped to the page on its own, so a rectangle that hangs off one side is cut at the page's edge and not moved.
  const clamp = (n: number) => Math.min(1, Math.max(0, n))
  const x = clamp(left / ws)
  const y = clamp((hs - top) / hs)
  return { x, y, width: clamp(right / ws) - x, height: clamp((hs - bottom) / hs) - y }
}
