import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type { DriftChannel } from '@drift/plugins'
import { getChannelRouter } from '../../channel/src/index.js'

const manifest = {
  name: 'cli-channel',
  version: '1.0.0',
  type: 'code',
  capabilities: {},
  depends: ['channel'],
}

/**
 * CLI Channel plugin.
 *
 * Registers itself as a DriftChannel so the system knows CLI exists
 * as a named channel. The CLI client uses the same POST /api/chat endpoint
 * as web (handled by web-channel plugin). The distinction is in capabilities
 * and channel identity.
 */
export function createCliChannelPlugin(): DriftPlugin {
  return {
    name: 'cli-channel',
    manifest,

    async init(ctx: PluginContext) {
      const router = getChannelRouter(ctx)

      const cliChannel: DriftChannel = {
        id: 'cli',
        meta: { name: 'CLI', icon: 'terminal', description: 'Command-line channel' },
        capabilities: { text: true, streaming: true, files: false },
        messaging: {
          listen: () => () => {},
          send: async () => {},
        },
      }
      router.register(cliChannel)

      ctx.logger.info('CLI channel plugin initialized')
    },
  }
}

export default createCliChannelPlugin
