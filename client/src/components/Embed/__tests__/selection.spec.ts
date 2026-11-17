import { embedPageFor, readEmbedSelection } from '../selection';

describe('readEmbedSelection', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('reads the agent from the URL and remembers it for navigations inside the view', () => {
    expect(readEmbedSelection('?agent_id=agent_abc')).toEqual({ agentId: 'agent_abc' });
    expect(readEmbedSelection('')).toEqual({ agentId: 'agent_abc' });
  });

  it('ignores values that are not plain identifiers, and the retired category parameter', () => {
    expect(readEmbedSelection('?agent_id=%3Cscript%3E')).toEqual({});
    expect(readEmbedSelection('?category=acme')).toEqual({});
  });

  it('ignores a tampered stored selection', () => {
    window.sessionStorage.setItem('vantage.embed.selection', JSON.stringify({ agentId: '<x>' }));
    expect(readEmbedSelection('')).toEqual({});
  });
});

describe('embedPageFor', () => {
  it('keeps the agent on the page signing out returns to', () => {
    expect(embedPageFor('/embed', { agentId: 'agent_a b' })).toBe('/embed?agent_id=agent_a%20b');
    expect(embedPageFor('/embed', {})).toBe('/embed');
  });
});
