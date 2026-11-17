import { useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Spinner } from '@librechat/client';
import { embedPage, setTokenHeader } from 'librechat-data-provider';
import type { TAgentsMap } from 'librechat-data-provider';
import type { EmbedContextValue } from './context';
import type { EmbedSelection } from './selection';
import {
  useHealthCheck,
  useUserTermsQuery,
  useGetStartupConfig,
  useGetAgentByIdQuery,
  useGetEndpointsQuery,
  useEmbedLogoutMutation,
} from '~/data-provider';
import {
  MCPAppsPolicyProvider,
  PromptGroupsProvider,
  AssistantsMapContext,
  AgentsMapContext,
  SetConvoProvider,
  FileMapContext,
} from '~/Providers';
import {
  CodeHighlightThrottleContext,
  normalizeCodeHighlightThrottleMs,
} from '~/components/Chat/Messages/Content/Parts/useLazyHighlight';
import {
  useAuthContext,
  useAssistantsMap,
  useCatalogWarmup,
  useFileMap,
  useLocalize,
  useMessagesRetention,
} from '~/hooks';
import { useDeploymentThemeOverride } from '~/Providers/DeploymentTheme';
import { TermsAndConditionsModal } from '~/components/ui';
import { embedPageFor } from './selection';
import { EmbedContext } from './context';
import SignIn from './SignIn';

/** Keeps the routed conversation's history cached, as the full app's shell does. */
function MessagesRetention() {
  useMessagesRetention();
  return null;
}

/**
 * The embed view's shell: the providers the chat needs from the full app's root, without the
 * sidebar, history, search or keyboard shortcuts. The view offers only the agent its URL names:
 * that one agent is loaded on its own and is the only one the chat sees, whatever else the
 * viewer may use. Access itself is still decided by the server on every request.
 */
export default function Root({ selection }: { selection: EmbedSelection }) {
  const localize = useLocalize();
  const { isAuthenticated, isAuthReady, user } = useAuthContext();
  const { mutate: logout } = useEmbedLogoutMutation();
  useCatalogWarmup(isAuthenticated);
  useHealthCheck(isAuthenticated);
  /* The chat route needs the endpoints config before it starts a conversation, and the embed
   * lands on its entry route first, so the shell fetches it. */
  useGetEndpointsQuery({ enabled: isAuthenticated });

  const { agentId } = selection;
  const agentQuery = useGetAgentByIdQuery(agentId, { enabled: isAuthenticated });
  const assistantsMap = useAssistantsMap({ isAuthenticated });
  const fileMap = useFileMap({ isAuthenticated });
  const { data: config, isSuccess: isConfigReady, error: configError } = useGetStartupConfig();
  /* The deployment's terms gate the embed view too: the server refuses chats until they are
   * accepted, so the view asks for them the way the full app does. Declining signs out. */
  const termsOfService = config?.interface?.termsOfService;
  const termsRequired = termsOfService?.modalAcceptance === true;
  const { data: termsData } = useUserTermsQuery({ enabled: isAuthenticated && termsRequired });
  const [showTerms, setShowTerms] = useState(false);
  useEffect(() => {
    if (termsData) {
      setShowTerms(!termsData.termsAccepted);
    }
  }, [termsData]);
  const highlightThrottleMs = normalizeCodeHighlightThrottleMs(
    config?.interface?.codeHighlightThrottleMs,
  );
  useDeploymentThemeOverride(
    config != null,
    config?.embed?.theme ?? config?.interface?.theme,
    config?.embed?.colorMode,
  );

  const agent = agentQuery.data?.id === agentId ? agentQuery.data : undefined;
  /** `undefined` while the agent loads; empty when the URL names none or it is unavailable. */
  const agentsMap = useMemo<TAgentsMap | undefined>(() => {
    if (agent) {
      return { [agent.id]: agent };
    }
    return !agentId || agentQuery.isError ? {} : undefined;
  }, [agent, agentId, agentQuery.isError]);

  const signOut = useCallback(() => {
    const backToSignIn = () => {
      setTokenHeader(undefined);
      window.location.replace(embedPageFor(embedPage(), selection));
    };
    logout(undefined, { onSettled: backToSignIn });
  }, [logout, selection]);

  const agentUnavailable = agent == null && agentQuery.isError;
  const embed = useMemo<EmbedContextValue>(
    () => ({ agent, agentId, agentUnavailable, signOut }),
    [agent, agentId, agentUnavailable, signOut],
  );

  if (!isAuthReady) {
    return (
      <div className="bg-presentation flex h-dvh items-center justify-center" role="status">
        <Spinner tone="primary" aria-label={localize('com_ui_loading')} />
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
                      <MCPAppsPolicyProvider
                        startupConfig={config}
                        ready={isConfigReady && configError == null}
                        userId={user?.id}
                      >
                        <Outlet />
                      </MCPAppsPolicyProvider>
                    </div>
                  </div>
                </PromptGroupsProvider>
                <MessagesRetention />
              </AgentsMapContext.Provider>
              {termsRequired && termsOfService && (
                <TermsAndConditionsModal
                  open={showTerms}
                  onOpenChange={setShowTerms}
                  onAccept={() => setShowTerms(false)}
                  onDecline={() => {
                    setShowTerms(false);
                    signOut();
                  }}
                  title={termsOfService.modalTitle}
                  modalContent={termsOfService.modalContent}
                />
              )}
            </AssistantsMapContext.Provider>
          </FileMapContext.Provider>
        </SetConvoProvider>
      </CodeHighlightThrottleContext.Provider>
    </EmbedContext.Provider>
  );
}
