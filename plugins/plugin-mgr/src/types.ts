export interface PluginMgrOptions {
  pluginsDir: string              // ~/.drift/plugins
  builtinNames: string[]          // names of builtin plugins that cannot be modified
}

export interface PluginInfo {
  name: string
  version: string
  type: 'declarative' | 'code'
  builtin: boolean
  dir?: string
  toolCount?: number
}
