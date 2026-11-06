import type { Endpoint, SelectedValues } from '~/common';
import type { useLocalize } from '~/hooks';
import { filterItems, groupAgentsByCategory, isEndpointMenuSelected } from '../utils';

const agentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: true,
  icon: null,
  showMarketplace: true,
  searchAliases: ['agent marketplace', 'marketplace'],
};

const disabledAgentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: false,
  icon: null,
};

describe('model selector utilities', () => {
  it('matches endpoint search aliases', () => {
    const results = filterItems([agentsEndpoint], 'marketplace', undefined, undefined);
    expect(results).toEqual([agentsEndpoint]);
  });

  it('matches localized Marketplace labels', () => {
    const localize = ((key: string) => {
      if (key === 'com_agents_marketplace') {
        return 'Tienda de Agentes';
      }
      if (key === 'com_ui_marketplace') {
        return 'Tienda';
      }
      return key;
    }) as ReturnType<typeof useLocalize>;

    const results = filterItems([agentsEndpoint], 'tienda', undefined, undefined, localize);
    expect(results).toEqual([agentsEndpoint]);
  });

  it('does not match agents when there are no selectable agent options', () => {
    const results = filterItems([disabledAgentsEndpoint], 'my agents', undefined, undefined);
    expect(results).toEqual([]);
  });
});

describe('groupAgentsByCategory', () => {
  const googleEndpoint: Endpoint = {
    value: 'google',
    label: 'Google',
    hasModels: true,
    icon: null,
  };
  const listedAgents: Endpoint = {
    ...agentsEndpoint,
    models: [{ name: 'payfast' }, { name: 'isuzu' }, { name: 'echo' }, { name: 'wonga' }],
    agentNames: { payfast: 'Payfast', isuzu: 'Isuzu', echo: 'Echo', wonga: 'Wonga' },
  };
  const agents = [
    { id: 'payfast', category: 'altitude' },
    { id: 'isuzu', category: 'altitude' },
    { id: 'echo', category: 'general' },
    { id: 'wonga', category: 'retired' },
  ];
  const categories = [
    { value: 'general', label: 'General' },
    { value: 'hr', label: 'HR' },
    { value: 'altitude', label: 'Altitude' },
  ];

  it('moves agents in a category into their own menu after My Agents', () => {
    const result = groupAgentsByCategory([listedAgents, googleEndpoint], agents, categories);

    expect(result.map((ep) => ep.label)).toEqual(['My Agents', 'Altitude', 'Google']);
    expect(result[0].models).toEqual([{ name: 'echo' }, { name: 'wonga' }]);
    expect(result[1]).toMatchObject({
      value: 'agents',
      agentCategory: 'altitude',
      models: [{ name: 'payfast' }, { name: 'isuzu' }],
      showMarketplace: false,
      agentNames: listedAgents.agentNames,
    });
  });

  it('leaves the endpoints alone when no agent is in a grouped category', () => {
    const endpoints = [listedAgents, googleEndpoint];
    const ungrouped = agents.map((agent) => ({ ...agent, category: 'general' }));

    expect(groupAgentsByCategory(endpoints, ungrouped, categories)).toBe(endpoints);
  });

  it('drops an empty My Agents menu that has no marketplace link', () => {
    const noMarketplace = { ...listedAgents, showMarketplace: false };
    const allAltitude = agents.map((agent) => ({ ...agent, category: 'altitude' }));

    const result = groupAgentsByCategory([noMarketplace], allAltitude, categories);

    expect(result.map((ep) => ep.label)).toEqual(['Altitude']);
  });
});

describe('isEndpointMenuSelected', () => {
  const myAgents: Endpoint = { ...agentsEndpoint, models: [{ name: 'echo' }] };
  const altitude: Endpoint = {
    ...agentsEndpoint,
    label: 'Altitude',
    agentCategory: 'altitude',
    models: [{ name: 'payfast' }],
  };
  const mapped = [myAgents, altitude];
  const select = (model: string): SelectedValues => ({ endpoint: 'agents', model, modelSpec: '' });

  it('checks only the group that lists the selected agent', () => {
    expect(isEndpointMenuSelected(altitude, select('payfast'), mapped)).toBe(true);
    expect(isEndpointMenuSelected(myAgents, select('payfast'), mapped)).toBe(false);
  });

  it('checks My Agents for agents outside every group', () => {
    expect(isEndpointMenuSelected(myAgents, select('echo'), mapped)).toBe(true);
    expect(isEndpointMenuSelected(myAgents, select('unlisted'), mapped)).toBe(true);
    expect(isEndpointMenuSelected(altitude, select('echo'), mapped)).toBe(false);
  });

  it('checks nothing while a model spec is selected', () => {
    const spec = { ...select('payfast'), modelSpec: 'payfast-spec' };
    expect(isEndpointMenuSelected(altitude, spec, mapped)).toBe(false);
  });
});
