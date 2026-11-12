import type { Agent, TAgentsMap } from 'librechat-data-provider';

/** Which agents the page that framed the embed view asked for. */
export type EmbedSelection = {
  agentId?: string;
  category?: string;
};

const STORAGE_KEY = 'vantage.embed.selection';
const PARAM_PATTERN = /^[\w.-]{1,128}$/;

const readParam = (params: URLSearchParams, name: string): string | undefined => {
  const value = params.get(name)?.trim();
  return value && PARAM_PATTERN.test(value) ? value : undefined;
};

/**
 * The selection comes from the iframe's original URL (`/embed?category=…` or `?agent_id=…`).
 * Navigating inside the view drops that query string, so it is kept in session storage, which
 * the browser scopes to the framing site and to this tab.
 */
export function readEmbedSelection(search: string): EmbedSelection {
  const params = new URLSearchParams(search);
  const fromUrl: EmbedSelection = {
    agentId: readParam(params, 'agent_id'),
    category: readParam(params, 'category'),
  };
  if (fromUrl.agentId != null || fromUrl.category != null) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(fromUrl));
    } catch {
      /* Storage can be blocked in embedded contexts; the URL selection still applies. */
    }
    return fromUrl;
  }
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '{}') as EmbedSelection;
    return {
      agentId: typeof stored.agentId === 'string' ? stored.agentId : undefined,
      category: typeof stored.category === 'string' ? stored.category : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Narrows the agents the viewer may use (already filtered by the server's permission checks) to
 * the ones this embed shows, sorted by name. This only shapes the view: access itself is enforced
 * by the server on every request.
 */
export function selectEmbedAgents(
  agentsMap: TAgentsMap | undefined,
  { agentId, category }: EmbedSelection,
): Agent[] | undefined {
  if (agentsMap == null) {
    return undefined;
  }
  const agents: Agent[] = [];
  for (const agent of Object.values(agentsMap)) {
    if (agent == null) {
      continue;
    }
    if (agentId != null ? agent.id === agentId : category == null || agent.category === category) {
      agents.push(agent);
    }
  }
  return agents.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}

export const toAgentsMap = (agents: Agent[]): TAgentsMap =>
  Object.fromEntries(agents.map((agent) => [agent.id, agent]));
