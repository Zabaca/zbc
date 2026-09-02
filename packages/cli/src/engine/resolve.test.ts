import { describe, expect, test } from 'bun:test'
import type { ModuleInstance } from '../../templates/infra/src/types'
import { fakeInstance, names } from './fixtures'
import { resolveOrder } from './resolve'

/** Index of an instance in a resolved order, for "before" assertions. */
const at = (order: ModuleInstance[], name: string) => names(order).indexOf(name)

describe('resolveOrder', () => {
  test('a diamond runs dependencies before dependents', () => {
    const a = fakeInstance('a')
    const b = fakeInstance('b', { imports: [a] })
    const c = fakeInstance('c', { imports: [a] })
    const d = fakeInstance('d', { imports: [b, c] })

    // Declaration order deliberately scrambled: the edges decide, not the file
    // listing, and a sort that happened to agree with the input would hide it.
    const order = resolveOrder([d, b, a, c])

    expect(names(order).toSorted()).toEqual(['a', 'b', 'c', 'd'])
    expect(at(order, 'a')).toBeLessThan(at(order, 'b'))
    expect(at(order, 'a')).toBeLessThan(at(order, 'c'))
    expect(at(order, 'b')).toBeLessThan(at(order, 'd'))
    expect(at(order, 'c')).toBeLessThan(at(order, 'd'))
  })

  test('a cycle throws rather than dropping an instance', () => {
    const a = fakeInstance('a')
    const b = fakeInstance('b', { imports: [a] })
    // Only reachable by mutation — an instance file cannot spell a cycle,
    // since `imports` holds the other instance's value. The sort must still
    // refuse it: the failure mode without this check is a silently SHORT run.
    a.imports.push(b)

    expect(() => resolveOrder([a, b])).toThrow(/Circular dependency/)
  })

  test('a target pulls its transitive closure and nothing else', () => {
    const a = fakeInstance('a')
    const b = fakeInstance('b', { imports: [a] })
    const c = fakeInstance('c', { imports: [b] })
    const unrelated = fakeInstance('unrelated')

    expect(names(resolveOrder([a, b, c, unrelated], { target: 'c' }))).toEqual(['a', 'b', 'c'])
  })

  test('two targets sharing a dependency run it once, before both', () => {
    const shared = fakeInstance('shared')
    const a = fakeInstance('a', { imports: [shared] })
    const b = fakeInstance('b', { imports: [shared] })
    const unrelated = fakeInstance('unrelated')

    const order = resolveOrder([shared, a, b, unrelated], { target: ['a', 'b'] })

    // Deduplication is the point. Concatenating the two closures would list
    // `shared` twice, and the sort counts an instance's in-edges once — the
    // second copy would never reach in-degree zero, and the run would throw
    // "Circular dependency" for a graph that has none.
    expect(names(order).toSorted()).toEqual(['a', 'b', 'shared'])
    expect(at(order, 'shared')).toBeLessThan(at(order, 'a'))
    expect(at(order, 'shared')).toBeLessThan(at(order, 'b'))
  })

  test('a single-element target list is the bare string', () => {
    const a = fakeInstance('a')
    const b = fakeInstance('b', { imports: [a] })

    expect(names(resolveOrder([a, b], { target: ['b'] }))).toEqual(
      names(resolveOrder([a, b], { target: 'b' })),
    )
  })

  test('one unknown name among known ones still throws', () => {
    const a = fakeInstance('a')

    expect(() => resolveOrder([a], { target: ['a', 'ghost'] })).toThrow(
      /Instance "ghost" not found\. Available: a/,
    )
  })

  test('an unknown target names what was available', () => {
    expect(() => resolveOrder([fakeInstance('a')], { target: 'ghost' })).toThrow(
      /Instance "ghost" not found\. Available: a/,
    )
  })

  test('an import that is not in the environment is a hard error naming both', () => {
    const missing = fakeInstance('main-db')
    const web = fakeInstance('web', { imports: [missing] })

    // `main-db` is imported but never discovered — its file is absent, or it
    // is not the default export. This used to be two silent shrugs: the edge
    // was skipped and `undefined` was written into ctx.imports under that name.
    expect(() => resolveOrder([web], { envLabel: 'environments/production' })).toThrow(
      'Instance "web" imports "main-db", which is not in environments/production',
    )
  })

  test('the same error without an envLabel still says where to look', () => {
    const web = fakeInstance('web', { imports: [fakeInstance('main-db')] })
    expect(() => resolveOrder([web])).toThrow(/which is not in this environment/)
  })

  test('the destroy path tolerates it instead — a cleanup path must still clean up', () => {
    // `assertImports: false` is what `destroyInstances` passes. An environment
    // whose graph has gone bad is exactly the one you need to tear down, and a
    // hard error there strands every resource in it. The edge is skipped, which
    // is what the whole engine did before this change.
    const web = fakeInstance('web', { imports: [fakeInstance('main-db')] })
    const other = fakeInstance('other')
    expect(names(resolveOrder([web, other], { assertImports: false })).toSorted()).toEqual([
      'other',
      'web',
    ])
  })

  test('a broken import elsewhere in the environment fails a targeted run too', () => {
    // The check runs over everything discovered, not just the target's closure:
    // a targeted apply that silently ignores a broken instance file is how the
    // break survives to the next full apply.
    const broken = fakeInstance('broken', { imports: [fakeInstance('ghost')] })
    const fine = fakeInstance('fine')
    expect(() => resolveOrder([broken, fine], { target: 'fine' })).toThrow(/"ghost"/)
  })
})
