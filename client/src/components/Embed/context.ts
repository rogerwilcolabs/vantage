import { createContext, useContext } from 'react';
import type { Agent } from 'librechat-data-provider';

export type EmbedContextValue = {
  /** The agents this embed offers, sorted by name. */
  agents: Agent[];
  signOut: () => void;
};

export const EmbedContext = createContext<EmbedContextValue | null>(null);

/** The embed view's state, or `null` when rendering inside the full app. */
export const useEmbedContext = (): EmbedContextValue | null => useContext(EmbedContext);
