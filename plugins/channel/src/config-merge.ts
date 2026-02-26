import type { ChannelConfig, ChannelAuthConfig, AgentProfile, AgentRouteConfig } from './types.js'

export interface ResolvedChannelConfig {
  auth: ChannelAuthConfig | null
  agent: AgentProfile | AgentRouteConfig | null
}

function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result = { ...base }
  for (const key of Object.keys(override) as (keyof T)[]) {
    const val = override[key]
    if (val !== undefined) {
      result[key] = val as T[keyof T]
    }
  }
  return result
}

function resolveField<T extends object>(
  pluginDefault: T | undefined,
  userOverride: T | false | undefined,
  isBuiltin: boolean,
): T | null {
  if (userOverride === false) {
    return isBuiltin ? (pluginDefault ?? null) : null
  }
  if (userOverride !== undefined && pluginDefault) {
    return deepMerge(pluginDefault, userOverride as Partial<T>)
  }
  if (userOverride !== undefined) {
    return userOverride as T
  }
  return pluginDefault ?? null
}

export function resolveChannelConfig(
  defaults: ChannelConfig,
  userOverride: ChannelConfig | undefined,
  isBuiltin: boolean,
): ResolvedChannelConfig {
  return {
    auth: resolveField(
      defaults.auth as ChannelAuthConfig | undefined,
      userOverride?.auth as ChannelAuthConfig | false | undefined,
      isBuiltin,
    ),
    agent: resolveField(
      defaults.agent as (AgentProfile | AgentRouteConfig) | undefined,
      userOverride?.agent as (AgentProfile | AgentRouteConfig) | false | undefined,
      isBuiltin,
    ),
  }
}
