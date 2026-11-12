import { memo } from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import { Button, Dropdown, NewChatIcon, TooltipAnchor } from '@librechat/client';
import { useChatContext } from '~/Providers';
import { useEmbedContext } from './context';
import { useLocalize } from '~/hooks';

/**
 * The embed view's header: the agent in use (a picker when the embed offers several), a new
 * chat, and sign out. It stands in for the full header, whose model selector, history and
 * sharing controls the embed view leaves out.
 */
function Header() {
  const localize = useLocalize();
  const embed = useEmbedContext();
  const { conversation, newConversation } = useChatContext();
  const agents = embed?.agents ?? [];
  const agentId = conversation?.agent_id ?? agents[0]?.id;
  const current = agents.find((agent) => agent.id === agentId);

  const startChat = (id: string | undefined) => {
    if (!id) {
      return;
    }
    newConversation({ preset: { endpoint: EModelEndpoint.agents, agent_id: id } });
  };

  return (
    <div className="absolute top-0 z-20 flex h-[52px] w-full items-center gap-2 bg-presentation p-2 text-text-primary">
      <div className="flex min-w-0 flex-1 items-center md:pl-1">
        {agents.length > 1 ? (
          <Dropdown
            value={agentId ?? ''}
            onChange={startChat}
            options={agents.map((agent) => ({ value: agent.id, label: agent.name ?? agent.id }))}
            ariaLabel={localize('com_embed_select_agent')}
            searchable={agents.length > 8}
          />
        ) : (
          <span className="truncate px-2 font-semibold">{current?.name ?? ''}</span>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        <TooltipAnchor
          description={localize('com_ui_new_chat')}
          render={
            <Button
              size="icon"
              variant="outline"
              className="size-9 rounded-xl bg-presentation hover:bg-surface-active-alt"
              aria-label={localize('com_ui_new_chat')}
              onClick={() => startChat(agentId)}
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
