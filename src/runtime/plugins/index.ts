import type { Context } from '@deepseek-ai/cordis'
import type { MydshPluginServicesConfig } from './contracts.ts'
import { MydshPluginConverter } from './converter.ts'
import { MydshPluginManager } from './manager.ts'

export * from './contracts.ts'
export { MydshPluginManager, MydshPluginConverter }

/** 宿主直接使用工厂便于在 Remote 适配器中注册方法；Cordis 入口沿用同一实现。 */
export function createMydshPluginServices(ctx: Context, config: MydshPluginServicesConfig) {
  const manager = new MydshPluginManager(ctx, config)
  const converter = new MydshPluginConverter(manager, config)
  return {
    manager,
    converter,
    initialize: () => manager.initialize(),
    dispose: async () => {
      await converter.dispose()
      await manager.dispose()
    },
  }
}

export const name = 'mydsh-plugin-services'

export async function apply(ctx: Context, config: MydshPluginServicesConfig): Promise<void> {
  const services = createMydshPluginServices(ctx, config)
  ctx.provide('mydshPlugins', services.manager)
  ctx.provide('mydshConverter', services.converter)
  ctx.effect(() => () => services.dispose())
  await services.initialize()
}
