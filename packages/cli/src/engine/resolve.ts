import type { ModuleInstance } from '../../templates/infra/src/types'

export interface ResolveOptions {
  /** Apply/destroy only this instance (plus, for apply, its transitive imports). */
  target?: string
  /** Where the instances came from, for error messages. */
  envLabel?: string
  /**
   * Refuse an import naming an instance the environment does not contain.
   * Default true — and false on the destroy path, which is a CLEANUP path: an
   * environment whose graph has gone bad is exactly the one you need to be able
   * to tear down, and refusing strands every resource in it. Destroy never
   * needed the missing instance's outputs; the edge is simply skipped, which is
   * what the whole engine used to do.
   */
  assertImports?: boolean
}

export function resolveOrder(
  instances: ModuleInstance[],
  opts: ResolveOptions = {},
): ModuleInstance[] {
  if (opts.assertImports !== false) assertImportsDiscovered(instances, opts.envLabel)

  let toProcess = instances

  if (opts.target) {
    const targetInstance = instances.find((i) => i.name === opts.target)
    if (!targetInstance) {
      throw new Error(
        `Instance "${opts.target}" not found. Available: ${instances.map((i) => i.name).join(', ')}`,
      )
    }
    toProcess = collectTransitiveDeps(targetInstance)
  }

  return topologicalSort(toProcess)
}

/**
 * An import naming an instance the environment does not contain is a hard
 * error, not a shrug.
 *
 * It used to be two silent ones that compounded: the sort skipped the edge, so
 * the importer could run first, and the apply loop then wrote `undefined` into
 * `ctx.imports` under that name. The module downstream reported a missing
 * OUTPUT — "instance X doesn't emit Y" — for an instance that was never there
 * at all, which sends the reader to the wrong file.
 */
function assertImportsDiscovered(instances: ModuleInstance[], envLabel?: string): void {
  const known = new Set(instances.map((i) => i.name))
  const where = envLabel ?? 'this environment'
  for (const inst of instances) {
    for (const dep of inst.imports) {
      if (!known.has(dep.name)) {
        throw new Error(`Instance "${inst.name}" imports "${dep.name}", which is not in ${where}`)
      }
    }
  }
}

function collectTransitiveDeps(instance: ModuleInstance): ModuleInstance[] {
  const collected = new Set<string>()
  const result: ModuleInstance[] = []

  function walk(inst: ModuleInstance) {
    if (collected.has(inst.name)) return
    collected.add(inst.name)
    for (const dep of inst.imports) {
      walk(dep)
    }
    result.push(inst)
  }

  walk(instance)
  return result
}

function topologicalSort(instances: ModuleInstance[]): ModuleInstance[] {
  const nameToInstance = new Map<string, ModuleInstance>()
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()

  for (const inst of instances) {
    nameToInstance.set(inst.name, inst)
    inDegree.set(inst.name, 0)
    adjacency.set(inst.name, [])
  }

  for (const inst of instances) {
    for (const dep of inst.imports) {
      // On the apply path every edge is present — `assertImportsDiscovered`
      // covers the whole environment, and a targeted run carries the transitive
      // closure. The skip is for the destroy path, which does not assert.
      if (!nameToInstance.has(dep.name)) continue
      adjacency.get(dep.name)!.push(inst.name)
      inDegree.set(inst.name, (inDegree.get(inst.name) ?? 0) + 1)
    }
  }

  const queue: string[] = []
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name)
  }

  const sorted: ModuleInstance[] = []
  while (queue.length > 0) {
    const name = queue.shift()!
    sorted.push(nameToInstance.get(name)!)

    for (const dependent of adjacency.get(name) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 1) - 1
      inDegree.set(dependent, newDegree)
      if (newDegree === 0) queue.push(dependent)
    }
  }

  if (sorted.length !== instances.length) {
    throw new Error('Circular dependency detected between module instances')
  }

  return sorted
}
