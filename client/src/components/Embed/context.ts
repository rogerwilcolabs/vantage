import { createContext, useContext } from 'react';
import type { Agent } from 'librechat-data-provider';

export type EmbedContextValue = {
  /** The one agent this embed offers; `undefined` while it loads or when it is unavailable. */
  agent?: Agent;
  /** The agent id the embed was opened with, which every chat in the view must use. */
  agentId?: string;
  /** The agent could not be loaded for this viewer: missing, not shared with them, or failing. */
  agentUnavailable: boolean;
  signOut: () => void;
};

export const EmbedContext = createContext<EmbedContextValue | null>(null);

/** The embed view's state, or `null` when rendering inside the full app. */
export const useEmbedContext = (): EmbedContextValue | null => useContext(EmbedContext);
