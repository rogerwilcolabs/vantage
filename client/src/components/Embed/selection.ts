/** The agent the page that framed the embed view asked for. */
export type EmbedSelection = {
  agentId?: string;
};

const STORAGE_KEY = 'vantage.embed.selection';
const PARAM_PATTERN = /^[\w.-]{1,128}$/;

const isAgentId = (value: unknown): value is string =>
  typeof value === 'string' && PARAM_PATTERN.test(value);

/**
 * The selection comes from the iframe's original URL (`/embed?agent_id=…`). Navigating inside the
 * view drops that query string, so it is kept in session storage, which the browser scopes to the
 * framing site and to this tab.
 */
export function readEmbedSelection(search: string): EmbedSelection {
  const fromUrl = new URLSearchParams(search).get('agent_id')?.trim();
  if (isAgentId(fromUrl)) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ agentId: fromUrl }));
    } catch {
      /* Storage can be blocked in embedded contexts; the URL selection still applies. */
    }
    return { agentId: fromUrl };
  }
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '{}') as {
      agentId?: unknown;
    };
    return isAgentId(stored.agentId) ? { agentId: stored.agentId } : {};
  } catch {
    return {};
  }
}

/** The embed page for this selection, so signing out comes back to the same agent. */
export const embedPageFor = (page: string, { agentId }: EmbedSelection): string =>
  agentId ? `${page}?agent_id=${encodeURIComponent(agentId)}` : page;
