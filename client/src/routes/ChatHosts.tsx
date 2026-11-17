import type { ReactNode } from 'react';
import { ComposerHostProvider, appComposerHost } from '~/Providers/ComposerHostContext';
import { StreamHostProvider, appStreamHost } from '~/Providers/StreamHostContext';
import { SteerHostProvider, appSteerHost } from '~/Providers/SteerHostContext';
import { ChatHostProvider, appChatHost } from '~/Providers/ChatHostContext';
import ChatSettingsProvider from './ChatSettings';

/**
 * The app's hosts for the chat package: its settings, and the steer, chat, stream and composer
 * hosts the chat hooks read. Every shell that renders a chat route mounts this, inside the auth
 * provider, so the full app and the embed view cannot drift apart.
 */
export default function ChatHosts({ children }: { children: ReactNode }) {
  return (
    <ChatSettingsProvider>
      <SteerHostProvider host={appSteerHost}>
        <ChatHostProvider host={appChatHost}>
          <StreamHostProvider host={appStreamHost}>
            <ComposerHostProvider host={appComposerHost}>{children}</ComposerHostProvider>
          </StreamHostProvider>
        </ChatHostProvider>
      </SteerHostProvider>
    </ChatSettingsProvider>
  );
}
