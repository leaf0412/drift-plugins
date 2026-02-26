import type { AgentProfile, AgentRouteConfig } from './types.js'

export type IntentClassifier = (content: string, categories: string[]) => Promise<string>

interface AgentConfigHolder {
  agent?: AgentProfile | AgentRouteConfig | null
}

function isRouteConfig(v: unknown): v is AgentRouteConfig {
  return typeof v === 'object' && v !== null && 'routing' in v && (v as any).routing === 'intent'
}

export async function resolveAgentConfig(
  config: AgentConfigHolder,
  content: string,
  classifier?: IntentClassifier,
): Promise<AgentProfile | null> {
  const agent = config.agent
  if (!agent) return null

  // Intent routing
  if (isRouteConfig(agent) && agent.profiles) {
    const categories = Object.keys(agent.profiles)
    if (categories.length === 0) return null

    if (classifier) {
      const intent = await classifier(content, categories)
      const profile = agent.profiles[intent]
      if (profile) return profile
    }
    // Fallback: first profile
    return agent.profiles[categories[0]]
  }

  // Static routing: agent is AgentProfile directly
  if ('model' in agent) {
    return agent as AgentProfile
  }

  return null
}
