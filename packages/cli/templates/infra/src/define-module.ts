import type { z } from 'zod'
import { ensureApplyContext } from './context'
import type { ApplyFn, DestroyFn, ModuleDefinition, ModuleInstance, InstanceOptions } from './types'

interface DefineModuleOptions<TConfig extends z.ZodType, TOutputs extends z.ZodType> {
  name: string
  configSchema: TConfig
  outputs: TOutputs
  apply: ApplyFn<z.infer<TConfig>, z.infer<TOutputs>>
  destroy?: DestroyFn<z.infer<TConfig>>
}

/**
 * The pre-0.14 spelling: `ephemeral` as a field of a module's own config
 * schema. Four modules carried it, three of them acting on it inline with three
 * different failure policies. The engine owns the rule now, but a consumer's
 * checked-in preview instance files still say `config: { ephemeral: true }`, and
 * `zbc update` must not break them — so that spelling keeps working, with a
 * deprecation line printed by `zbc apply`.
 */
export function configEphemeral(config: unknown): boolean {
  return (
    typeof config === 'object' &&
    config !== null &&
    (config as Record<string, unknown>).ephemeral === true
  )
}

export function defineModule<TConfig extends z.ZodType, TOutputs extends z.ZodType>(
  opts: DefineModuleOptions<TConfig, TOutputs>,
): ModuleDefinition<TConfig, TOutputs> {
  const definition: ModuleDefinition<TConfig, TOutputs> = {
    name: opts.name,
    configSchema: opts.configSchema,
    outputsSchema: opts.outputs,
    // The context is normalized HERE rather than in the engine, so a module
    // body may assume `ctx.secret`/`ctx.output` exist whoever called it — the
    // engine, another module's test, a consumer's script. A caller that
    // already holds a full context (the destroy path's on-demand one) is
    // passed through untouched.
    apply: (config, ctx) => opts.apply(config, ensureApplyContext(ctx)),
    destroy: opts.destroy && ((config, ctx) => opts.destroy!(config, ensureApplyContext(ctx))),
    instance(instanceOpts: InstanceOptions<TConfig>): ModuleInstance<TOutputs> {
      return {
        name: instanceOpts.name,
        moduleName: opts.name,
        config: instanceOpts.config,
        imports: instanceOpts.imports ?? [],
        ephemeral: instanceOpts.ephemeral ?? configEphemeral(instanceOpts.config),
        _outputsSchema: opts.outputs,
        _definition: definition as ModuleDefinition<any, TOutputs>,
      }
    },
  }

  return definition
}
