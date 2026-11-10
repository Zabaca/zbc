import { expect, test } from 'bun:test'
import { type PageGeometry, applyMatrix, fractionToShown, shownSize, shownToUser, userRectToFraction, visibleBox } from '../src/pdf/geometry'

const letter = { x0: 0, y0: 0, x1: 612, y1: 792 }
const g = (rotation: 0 | 90 | 180 | 270, extra: Partial<PageGeometry> = {}): PageGeometry => ({ mediaBox: letter, rotation, ...extra })

/** Where the corners of the shown page land in the file's user space: the four facts a rotation must satisfy. */
function corners(geo: PageGeometry) {
  const { width, height } = shownSize(geo)
  const m = shownToUser(geo)
  return {
    shownBottomLeft: applyMatrix(m, 0, 0),
    shownBottomRight: applyMatrix(m, width, 0),
    shownTopLeft: applyMatrix(m, 0, height),
    shownTopRight: applyMatrix(m, width, height),
  }
}

test('rotation 0 is the file as drawn', () => {
  const c = corners(g(0))
  expect(c.shownBottomLeft).toEqual({ x: 0, y: 0 })
  expect(c.shownTopRight).toEqual({ x: 612, y: 792 })
})

test('rotation 90: the shown top-left is the file bottom-left, and the shown page is 792 wide', () => {
  expect(shownSize(g(90))).toEqual({ width: 792, height: 612 })
  const c = corners(g(90))
  expect(c.shownTopLeft).toEqual({ x: 0, y: 0 })
  expect(c.shownTopRight).toEqual({ x: 0, y: 792 })
  expect(c.shownBottomLeft).toEqual({ x: 612, y: 0 })
  expect(c.shownBottomRight).toEqual({ x: 612, y: 792 })
})

test('rotation 180: the shown top-left is the file bottom-right', () => {
  const c = corners(g(180))
  expect(c.shownTopLeft).toEqual({ x: 612, y: 0 })
  expect(c.shownBottomRight).toEqual({ x: 0, y: 792 })
})

test('rotation 270: the shown top-left is the file top-right turned the other way', () => {
  const c = corners(g(270))
  expect(c.shownTopLeft).toEqual({ x: 612, y: 792 })
  expect(c.shownTopRight).toEqual({ x: 612, y: 0 })
  expect(c.shownBottomLeft).toEqual({ x: 0, y: 792 })
})

test('a crop box that does not start at zero moves everything by its origin', () => {
  const geo = g(0, { cropBox: { x0: 36, y0: 72, x1: 540, y1: 700 } })
  expect(shownSize(geo)).toEqual({ width: 504, height: 628 })
  expect(applyMatrix(shownToUser(geo), 0, 0)).toEqual({ x: 36, y: 72 })
  expect(applyMatrix(shownToUser(geo), 504, 628)).toEqual({ x: 540, y: 700 })
})

test('a crop box and a media box that both start away from zero, turned 90', () => {
  const geo: PageGeometry = { mediaBox: { x0: 10, y0: 20, x1: 622, y1: 812 }, cropBox: { x0: 60, y0: 100, x1: 500, y1: 700 }, rotation: 90 }
  expect(shownSize(geo)).toEqual({ width: 600, height: 440 })
  // Shown top-left is the visible box's bottom-left.
  expect(applyMatrix(shownToUser(geo), 0, 440)).toEqual({ x: 60, y: 100 })
  expect(applyMatrix(shownToUser(geo), 600, 0)).toEqual({ x: 500, y: 700 })
})

test('a crop box larger than the media box shows the media box', () => {
  expect(visibleBox(g(0, { cropBox: { x0: -50, y0: -50, x1: 900, y1: 900 } }))).toEqual(letter)
})

test('fractions are measured from the shown top-left', () => {
  expect(fractionToShown(g(0), { x: 0.5, y: 0.25, width: 0.1, height: 0.1 })).toEqual({ x: 306, y: 792 - 0.35 * 792, width: 61.2, height: 79.2 })
})

test('a user-space rectangle comes back to the same fractions on every rotation', () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    const geo = g(rotation, { cropBox: { x0: 20, y0: 30, x1: 580, y1: 760 } })
    const f = { x: 0.2, y: 0.3, width: 0.25, height: 0.1 }
    const s = fractionToShown(geo, f)
    const m = shownToUser(geo)
    const a = applyMatrix(m, s.x, s.y)
    const b = applyMatrix(m, s.x + s.width, s.y + s.height)
    const back = userRectToFraction(geo, { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) })
    expect(back.x).toBeCloseTo(f.x, 9)
    expect(back.y).toBeCloseTo(f.y, 9)
    expect(back.width).toBeCloseTo(f.width, 9)
    expect(back.height).toBeCloseTo(f.height, 9)
  }
})
