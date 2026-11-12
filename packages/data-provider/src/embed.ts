import axios from 'axios';
import type { TUser } from './types';

/** Sent on every request from the embed view; the embed auth endpoints require it. */
export const EMBED_REQUEST_HEADER = 'X-Vantage-Embed';

/** Path the embed view is served under, relative to the app's base URL. */
export const EMBED_BASE_PATH = '/embed';

/** Stable codes the embed auth endpoints return, for the UI to map to localized copy. */
export enum EmbedAuthErrorCode {
  DISABLED = 'EMBED_DISABLED',
  INVALID_REQUEST = 'EMBED_INVALID_REQUEST',
  HANDOFF_PENDING = 'EMBED_HANDOFF_PENDING',
  HANDOFF_INVALID = 'EMBED_HANDOFF_INVALID',
  SESSION_INVALID = 'EMBED_SESSION_INVALID',
}

export type TEmbedAuthResponse = { token: string; user: TUser };

export type TEmbedAuthError = { code: EmbedAuthErrorCode };

let embedMode = false;

/**
 * Switches this page's auth plumbing to the embed endpoints: token refresh goes to the embed
 * session (a partitioned cookie the framed page owns) and a lost session returns to the embed
 * sign-in screen instead of the full app's login page, which cannot be framed.
 */
export function setEmbedMode(enabled: boolean): void {
  embedMode = enabled;
  if (enabled) {
    axios.defaults.headers.common[EMBED_REQUEST_HEADER] = '1';
  } else {
    delete axios.defaults.headers.common[EMBED_REQUEST_HEADER];
  }
}

export const isEmbedMode = (): boolean => embedMode;
