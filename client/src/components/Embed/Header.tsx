import { memo, useCallback, useEffect } from 'react';
import { Button, NewChatIcon, TooltipAnchor } from '@librechat/client';
import { EModelEndpoint, isAgentsEndpoint } from 'librechat-data-provider';
import { useChatContext } from '~/Providers';
import { useEmbedContext } from './context';
import { useLocalize } from '~/hooks';

/**
 * The embed view's header: the agent's name, a new chat, and sign out. It stands in for the full
 * header, whose model selector, history and sharing controls the embed view leaves out. There is
 * no agent picker: the view only ever offers the agent its URL names, so any conversation that
 * arrives with another target (an edited URL, a stored setup, an old conversation link) is
 * replaced by a new chat with that agent.
 */
function Header() {
  const localize = useLocalize();
  const embed = useEmbedContext();
  const { conversation, newConversation } = useChatContext();
  const agentId = embed?.agentId;

  const startChat = useCallback(() => {
    if (!agentId) {
      return;
    }
    newConversation({ preset: { endpoint: EModelEndpoint.agents, agent_id: agentId } });
  }, [agentId, newConversation]);

  const endpoint = conversation?.endpoint;
  const conversationAgentId = conversation?.agent_id;
  const offTarget =
    agentId != null &&
    endpoint != null &&
    (!isAgentsEndpoint(endpoint) ||
      (conversationAgentId != null && conversationAgentId !== agentId));

  useEffect(() => {
    if (offTarget) {
      startChat();
    }
  }, [offTarget, startChat]);

  return (
    <div className="bg-presentation text-text-primary absolute top-0 z-20 flex h-[52px] w-full items-center gap-2 p-2">
      <div className="flex min-w-0 flex-1 items-center md:pl-1">
        <span className="truncate px-2 font-semibold">{embed?.agent?.name ?? ''}</span>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        <TooltipAnchor
          description={localize('com_ui_new_chat')}
          render={
            <Button
              size="icon"
              variant="header-action"
              className="size-9 shrink-0"
              aria-label={localize('com_ui_new_chat')}
              onClick={startChat}
            >
              <NewChatIcon className="icon-md" aria-hidden="true" />
            </Button>
          }
        />
        <Button variant="ghost" onClick={embed?.signOut}>
          {localize('com_nav_log_out')}
        </Button>
      </div>
    </div>
  );
}

const MemoizedHeader = memo(Header);
MemoizedHeader.displayName = 'EmbedHeader';

export default MemoizedHeader;
