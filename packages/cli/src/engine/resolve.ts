import { legacyConfigEphemeral } from '../../templates/infra/src/define-module'
import type { ModuleInstance } from '../../templates/infra/src/types'

export interface ResolveOptions {
  /**
   * Apply/destroy only these instances (plus, for apply, their transitive
   * imports). A bare string is one of them.
   *
   * Plural because CI scopes a production apply to what a push actually
   * touched, and a push routinely touches two — running the CLI once per name
   * would re-decrypt the environment and re-apply the shared dependencies of
   * each, turning a saving into a slower, noisier deploy.
   */
  target?: string | string[]
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

  const targets = typeof opts.target === 'string' ? [opts.target] : (opts.target ?? [])

  if (targets.length > 0) {
    const selected = new Map<string, ModuleInstance>()
    for (const target of targets) {
      const targetInstance = instances.find((i) => i.name === target)
      if (!targetInstance) {
        throw new Error(
          `Instance "${target}" not found. Available: ${instances.map((i) => i.name).join(', ')}`,
        )
      }
      // Union, not concatenation: two targets that share a dependency would
      // otherwise list it twice, and the sort counts an instance's edges once.
      for (const dep of collectTransitiveDeps(targetInstance)) selected.set(dep.name, dep)
    }
    toProcess = Array.from(selected.values())
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

/**
 * Whether this instance is ephemeral.
 *
 * `ephemeral` is WRITTEN by `defineModule` — which a subtree consumer vendors at
 * `vendor/zbc/src/` and moves with `zbc update` — and READ here, in the engine
 * the npm CLI ships. The two version independently, so an instance built by a
 * `define-module.ts` older than this CLI has no `ephemeral` property at all. The
 * engine repeats the legacy fallback rather than reading `undefined` as "no",
 * which would silently make every preview resource permanent.
 *
 * The reverse skew — a newer vendored subtree under an older CLI, whose engine
 * knows nothing of instance-level `ephemeral` — cannot be fixed from here; `zbc
 * update` moving ahead of the CLI is what the version pin in `zbc init
 * --subtree` exists to prevent.
 */
export function isEphemeral(instance: ModuleInstance): boolean {
  const declared = (instance as { ephemeral?: boolean }).ephemeral
  return declared ?? legacyConfigEphemeral(instance.moduleName, instance.config)
}

/**
 * An ephemeral instance of a module with no `destroy` is a contradiction, and
 * the engine refuses it before it applies anything — including the instances
 * that sort ahead of it. Silently applying an "ephemeral" resource that is
 * never torn down is exactly what `cloudflare-token` did for as long as it
 * declared the flag and never read it.
 */
export function assertEphemeralDestroyable(instances: ModuleInstance[]): void {
  for (const inst of instances) {
    if (isEphemeral(inst) && !inst._definition.destroy) {
      throw new Error(
        `Instance "${inst.name}" is ephemeral but module "${inst.moduleName}" has no destroy`,
      )
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
