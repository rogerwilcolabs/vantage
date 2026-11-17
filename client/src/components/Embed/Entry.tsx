import { Bot } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { Button, EmptyState, Spinner } from '@librechat/client';
import { useEmbedContext } from './context';
import { useLocalize } from '~/hooks';

/**
 * Landing route: opens a new chat with the agent this embed names. The agent goes in the URL
 * the way the full app's deep links do, so the chat route sets up the conversation as usual.
 * When the URL names no agent, or the viewer cannot use it, the view says so and offers sign
 * out, so a viewer signed in with the wrong account is not stuck.
 */
export default function Entry() {
  const localize = useLocalize();
  const embed = useEmbedContext();
  const agent = embed?.agent;
  const unavailable = embed != null && (!embed.agentId || embed.agentUnavailable === true);

  if (agent) {
    return <Navigate to={`/c/new?agent_id=${encodeURIComponent(agent.id)}`} replace={true} />;
  }

  if (!unavailable) {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-live="polite">
        <Spinner tone="primary" aria-label={localize('com_ui_loading')} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-4">
      <EmptyState
        icon={Bot}
        title={localize('com_embed_no_agents')}
        description={localize('com_embed_no_agents_description')}
      />
      <Button variant="outline" onClick={embed?.signOut}>
        {localize('com_nav_log_out')}
      </Button>
    </div>
  );
}
