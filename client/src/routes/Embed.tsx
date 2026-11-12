import { EMBED_BASE_PATH, setEmbedMode } from 'librechat-data-provider';
import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { EmbedCallback, EmbedEntry, EmbedRoot, readEmbedSelection } from '~/components/Embed';
import { AuthContextProvider } from '~/hooks/AuthContext';
import RouteErrorBoundary from './RouteErrorBoundary';
import { ApiErrorWatcher } from '~/components/Auth';
import ChatRoute from './ChatRoute';

/** The embed view has its own sign-in screen, so a missing session never navigates to /login. */
const embedAuthConfig = { loginRedirect: EMBED_BASE_PATH, optional: true };

const trimSlash = (path: string) => (path.endsWith('/') ? path.slice(0, -1) : path);

/** Whether this page load is the embed view, given the app's `<base href>`. */
export function isEmbedPathname(pathname: string, baseHref: string): boolean {
  const embedPath = `${trimSlash(baseHref)}${EMBED_BASE_PATH}`;
  return pathname === embedPath || pathname.startsWith(`${embedPath}/`);
}

const EmbedAuthLayout = () => (
  <AuthContextProvider authConfig={embedAuthConfig}>
    <Outlet />
    <ApiErrorWatcher />
  </AuthContextProvider>
);

/**
 * The chat-only router used when the app is framed at `/embed`. Its basename is `/embed`, so the
 * chat's own `/c/new` and `/c/:id` navigations stay inside the embed view, and none of the full
 * app's routes (history, settings, agents marketplace) exist here.
 */
export function createEmbedRouter(baseHref: string) {
  setEmbedMode(true);
  const selection = readEmbedSelection(window.location.search);

  return createBrowserRouter(
    [
      {
        path: 'callback',
        element: <EmbedCallback />,
        errorElement: <RouteErrorBoundary />,
      },
      {
        element: <EmbedAuthLayout />,
        errorElement: <RouteErrorBoundary />,
        children: [
          {
            element: <EmbedRoot selection={selection} />,
            children: [
              { index: true, element: <EmbedEntry /> },
              { path: 'c/:conversationId?', element: <ChatRoute /> },
              { path: '*', element: <Navigate to="/" replace={true} /> },
            ],
          },
        ],
      },
    ],
    { basename: `${trimSlash(baseHref)}${EMBED_BASE_PATH}` },
  );
}
