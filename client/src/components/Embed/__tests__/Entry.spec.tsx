import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Agent } from 'librechat-data-provider';
import type { EmbedContextValue } from '../context';
import { EmbedContext } from '../context';
import Entry from '../Entry';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const signOut = jest.fn();

const renderEntry = (value: Partial<EmbedContextValue>) =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <EmbedContext.Provider value={{ agentUnavailable: false, signOut, ...value }}>
        <Routes>
          <Route path="/" element={<Entry />} />
          <Route path="/c/new" element={<p data-testid="chat" />} />
        </Routes>
      </EmbedContext.Provider>
    </MemoryRouter>,
  );

describe('Embed Entry', () => {
  beforeEach(() => signOut.mockReset());

  it('opens a chat with the embed agent', () => {
    renderEntry({ agentId: 'a', agent: { id: 'a', name: 'A' } as Agent });
    expect(screen.getByTestId('chat')).toBeInTheDocument();
  });

  it('shows loading while the agent loads', () => {
    renderEntry({ agentId: 'a' });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('says no agent is available, with sign out, when the agent cannot be used', () => {
    renderEntry({ agentId: 'a', agentUnavailable: true });
    expect(screen.getByText('com_embed_no_agents')).toBeInTheDocument();
    screen.getByRole('button', { name: 'com_nav_log_out' }).click();
    expect(signOut).toHaveBeenCalled();
  });

  it('says no agent is available when the URL names none', () => {
    renderEntry({});
    expect(screen.getByText('com_embed_no_agents')).toBeInTheDocument();
  });
});
