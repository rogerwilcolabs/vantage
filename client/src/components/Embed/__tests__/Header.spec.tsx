import { render, screen } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { Agent, TConversation } from 'librechat-data-provider';
import type { EmbedContextValue } from '../context';
import { EmbedContext } from '../context';
import Header from '../Header';

const mockNewConversation = jest.fn();
let mockConversation: Partial<TConversation> | null = null;

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  useChatContext: () => ({
    conversation: mockConversation,
    newConversation: mockNewConversation,
  }),
}));

const agent = { id: 'agent_client1', name: 'Client One' } as Agent;

const renderHeader = (value: Partial<EmbedContextValue> = {}) =>
  render(
    <EmbedContext.Provider
      value={{ agent, agentId: agent.id, agentUnavailable: false, signOut: jest.fn(), ...value }}
    >
      <Header />
    </EmbedContext.Provider>,
  );

const lockedPreset = { preset: { endpoint: EModelEndpoint.agents, agent_id: 'agent_client1' } };

describe('Embed Header', () => {
  beforeEach(() => {
    mockNewConversation.mockReset();
    mockConversation = null;
  });

  it('names the agent and offers no picker', () => {
    mockConversation = { endpoint: EModelEndpoint.agents, agent_id: agent.id };
    renderHeader();
    expect(screen.getByText('Client One')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(mockNewConversation).not.toHaveBeenCalled();
  });

  it('replaces a conversation with another agent by a new chat with the embed agent', () => {
    mockConversation = { endpoint: EModelEndpoint.agents, agent_id: 'agent_client2' };
    renderHeader();
    expect(mockNewConversation).toHaveBeenCalledWith(lockedPreset);
  });

  it('replaces a conversation on another endpoint', () => {
    mockConversation = { endpoint: EModelEndpoint.openAI, model: 'gpt-4o' };
    renderHeader();
    expect(mockNewConversation).toHaveBeenCalledWith(lockedPreset);
  });

  it('waits while the conversation has no target yet', () => {
    mockConversation = { endpoint: EModelEndpoint.agents };
    renderHeader();
    mockConversation = null;
    renderHeader();
    expect(mockNewConversation).not.toHaveBeenCalled();
  });

  it('starts a new chat with the embed agent from the new chat button', () => {
    mockConversation = { endpoint: EModelEndpoint.agents, agent_id: agent.id };
    renderHeader();
    screen.getByRole('button', { name: 'com_ui_new_chat' }).click();
    expect(mockNewConversation).toHaveBeenCalledWith(lockedPreset);
  });
});
