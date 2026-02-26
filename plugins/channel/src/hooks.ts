/**
 * Minimal hook pipeline for channel message lifecycle.
 *
 * Provides two modes:
 * - fire(): void/observational — handlers are called but return values are ignored
 * - run(): modifying — handlers can return content overrides or cancel signals
 *
 * This is a lightweight implementation scoped to the channel plugin.
 * When drift-core gains a first-class HookPipeline, this can be replaced.
 */

export interface HookRegistration {
  pluginId: string
  hookName: string
  handler: (event: Record<string, unknown>) => unknown
  priority: number
  source: string
}

export class HookPipeline {
  private hooks = new Map<string, HookRegistration[]>()

  /**
   * Register a hook handler.
   */
  register(reg: HookRegistration): void {
    const list = this.hooks.get(reg.hookName) ?? []
    list.push(reg)
    // Sort by priority ascending (lower = runs first)
    list.sort((a, b) => a.priority - b.priority)
    this.hooks.set(reg.hookName, list)
  }

  /**
   * Fire a hook (observational / void). Handlers are called in priority order
   * but their return values are ignored.
   */
  async fire(
    hookName: string,
    event: Record<string, unknown>,
    _ctx?: Record<string, unknown>,
  ): Promise<void> {
    const list = this.hooks.get(hookName)
    if (!list) return
    for (const reg of list) {
      await reg.handler(event)
    }
  }

  /**
   * Run a hook (modifying). Handlers are called in priority order and
   * can return content overrides or cancel signals. The last non-undefined
   * result wins.
   */
  async run(
    hookName: string,
    event: Record<string, unknown>,
    _ctx?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const list = this.hooks.get(hookName)
    if (!list) return undefined
    let result: Record<string, unknown> | undefined
    for (const reg of list) {
      const ret = await reg.handler(event)
      if (ret !== undefined && ret !== null) {
        result = ret as Record<string, unknown>
      }
    }
    return result
  }
}
