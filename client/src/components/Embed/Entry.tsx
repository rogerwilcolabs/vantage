import { Bot } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { EmptyState, Spinner } from '@librechat/client';
import { useAgentsMapContext } from '~/Providers';
import { useLocalize } from '~/hooks';

/**
 * Landing route: opens a new chat with the first agent this embed offers. The agent goes in the
 * URL the way the full app's deep links do, so the chat route sets up the conversation as usual.
 */
export default function Entry() {
  const localize = useLocalize();
  const agentsMap = useAgentsMapContext();

  if (agentsMap == null) {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-live="polite">
        <Spinner className="text-text-primary" aria-label={localize('com_ui_loading')} />
      </div>
    );
  }

  const first = Object.values(agentsMap)[0];
  if (first == null) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <EmptyState
          icon={Bot}
          title={localize('com_embed_no_agents')}
          description={localize('com_embed_no_agents_description')}
        />
      </div>
    );
  }

  return <Navigate to={`/c/new?agent_id=${encodeURIComponent(first.id)}`} replace={true} />;
}
