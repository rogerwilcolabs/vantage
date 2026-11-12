import type { Agent, TAgentsMap } from 'librechat-data-provider';
import { readEmbedSelection, selectEmbedAgents } from '../selection';

const agent = (id: string, name: string, category?: string) =>
  ({ id, name, category }) as unknown as Agent;

const agentsMap: TAgentsMap = {
  a: agent('a', 'Zulu', 'acme'),
  b: agent('b', 'Alpha', 'acme'),
  c: agent('c', 'Bravo', 'globex'),
};

describe('selectEmbedAgents', () => {
  it('waits for the agent list before selecting anything', () => {
    expect(selectEmbedAgents(undefined, { category: 'acme' })).toBeUndefined();
  });

  it('keeps only the category the embed asked for, sorted by name', () => {
    expect(selectEmbedAgents(agentsMap, { category: 'acme' })?.map((a) => a.id)).toEqual([
      'b',
      'a',
    ]);
  });

  it('locks to one agent when the embed names it, and offers nothing it cannot use', () => {
    expect(selectEmbedAgents(agentsMap, { agentId: 'c' })?.map((a) => a.id)).toEqual(['c']);
    expect(selectEmbedAgents(agentsMap, { agentId: 'missing' })).toEqual([]);
    expect(selectEmbedAgents(agentsMap, { category: 'initech' })).toEqual([]);
  });
});

describe('readEmbedSelection', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('reads the selection from the URL and remembers it for navigations inside the view', () => {
    expect(readEmbedSelection('?category=acme')).toEqual({ category: 'acme', agentId: undefined });
    expect(readEmbedSelection('')).toEqual({ category: 'acme', agentId: undefined });
  });

  it('ignores values that are not plain identifiers', () => {
    expect(readEmbedSelection('?category=%3Cscript%3E&agent_id=agent_abc')).toEqual({
      agentId: 'agent_abc',
      category: undefined,
    });
  });
});
