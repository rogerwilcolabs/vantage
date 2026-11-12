import { useCallback, useMemo } from 'react';
import { Outlet } from 'react-router-dom';
import { Spinner } from '@librechat/client';
import { embedPage, setTokenHeader } from 'librechat-data-provider';
import type { EmbedContextValue } from './context';
import type { EmbedSelection } from './selection';
import {
  CodeHighlightThrottleContext,
  normalizeCodeHighlightThrottleMs,
} from '~/components/Chat/Messages/Content/Parts/useLazyHighlight';
import {
  PromptGroupsProvider,
  AssistantsMapContext,
  AgentsMapContext,
  SetConvoProvider,
  FileMapContext,
} from '~/Providers';
import {
  useAuthContext,
  useAssistantsMap,
  useCatalogWarmup,
  useAgentsMap,
  useFileMap,
  useLocalize,
} from '~/hooks';
import {
  useHealthCheck,
  useGetStartupConfig,
  useGetEndpointsQuery,
  useEmbedLogoutMutation,
} from '~/data-provider';
import { selectEmbedAgents, toAgentsMap } from './selection';
import { EmbedContext } from './context';
import SignIn from './SignIn';

/**
 * The embed view's shell: the providers the chat needs from the full app's root, without the
 * sidebar, history, search or keyboard shortcuts. Agents are narrowed to the embed's selection
 * before the chat sees them, so the chat route's agent checks and defaults stay inside it.
 */
export default function Root({ selection }: { selection: EmbedSelection }) {
  const localize = useLocalize();
  const { isAuthenticated, isAuthReady } = useAuthContext();
  const { mutate: logout } = useEmbedLogoutMutation();
  useCatalogWarmup(isAuthenticated);
  useHealthCheck(isAuthenticated);
  /* The agent list waits for the endpoints config, which the full app's chat route fetches.
   * The embed lands on its agent picker before any chat route, so the shell fetches it. */
  useGetEndpointsQuery({ enabled: isAuthenticated });

  const allAgents = useAgentsMap({ isAuthenticated });
  const assistantsMap = useAssistantsMap({ isAuthenticated });
  const fileMap = useFileMap({ isAuthenticated });
  const { data: config } = useGetStartupConfig();
  const highlightThrottleMs = normalizeCodeHighlightThrottleMs(
    config?.interface?.codeHighlightThrottleMs,
  );

  const agents = useMemo(() => selectEmbedAgents(allAgents, selection), [allAgents, selection]);
  const agentsMap = useMemo(() => (agents ? toAgentsMap(agents) : undefined), [agents]);

  const signOut = useCallback(() => {
    const backToSignIn = () => {
      setTokenHeader(undefined);
      window.location.replace(embedPage());
    };
    logout(undefined, { onSettled: backToSignIn });
  }, [logout]);

  const embed = useMemo<EmbedContextValue>(
    () => ({ agents: agents ?? [], signOut }),
    [agents, signOut],
  );

  if (!isAuthReady) {
    return (
      <div className="flex h-dvh items-center justify-center bg-presentation" role="status">
        <Spinner className="text-text-primary" aria-label={localize('com_ui_loading')} />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <SignIn />;
  }

  return (
    <EmbedContext.Provider value={embed}>
      <CodeHighlightThrottleContext.Provider value={highlightThrottleMs}>
        <SetConvoProvider>
          <FileMapContext.Provider value={fileMap}>
            <AssistantsMapContext.Provider value={assistantsMap}>
              <AgentsMapContext.Provider value={agentsMap}>
                <PromptGroupsProvider>
                  <div className="flex h-dvh w-full overflow-hidden">
                    <div className="relative flex h-full max-w-full flex-1 flex-col overflow-hidden">
                      <Outlet />
                    </div>
                  </div>
                </PromptGroupsProvider>
              </AgentsMapContext.Provider>
            </AssistantsMapContext.Provider>
          </FileMapContext.Provider>
        </SetConvoProvider>
      </CodeHighlightThrottleContext.Provider>
    </EmbedContext.Provider>
  );
}
