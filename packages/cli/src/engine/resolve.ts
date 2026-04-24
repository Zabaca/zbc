import type { ModuleInstance } from '@zbc/infra'

export function resolveOrder(
  instances: ModuleInstance[],
  target?: string,
): ModuleInstance[] {
  let toProcess = instances

  if (target) {
    const targetInstance = instances.find((i) => i.name === target)
    if (!targetInstance) {
      throw new Error(
        `Instance "${target}" not found. Available: ${instances.map((i) => i.name).join(', ')}`,
      )
    }
    toProcess = collectTransitiveDeps(targetInstance, instances)
  }

  return topologicalSort(toProcess)
}

function collectTransitiveDeps(
  instance: ModuleInstance,
  all: ModuleInstance[],
): ModuleInstance[] {
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
      if (nameToInstance.has(dep.name)) {
        adjacency.get(dep.name)!.push(inst.name)
        inDegree.set(inst.name, (inDegree.get(inst.name) ?? 0) + 1)
      }
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
