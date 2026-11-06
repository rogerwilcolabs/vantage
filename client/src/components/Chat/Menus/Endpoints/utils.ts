import React from 'react';
import { Bot } from 'lucide-react';
import { isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type {
  Agent,
  TModelSpec,
  TAgentsMap,
  TAssistantsMap,
  TEndpointsConfig,
} from 'librechat-data-provider';
import type { useLocalize } from '~/hooks';
import SpecIcon from '~/components/Chat/Menus/Endpoints/components/SpecIcon';
import { Endpoint, SelectedValues } from '~/common';
import { getSpecAgentAvatarURL } from '~/utils';

export function filterItems<
  T extends {
    label: string;
    name?: string;
    value?: string;
    hasModels?: boolean;
    models?: Array<{ name: string; isGlobal?: boolean }>;
    searchAliases?: string[];
    showMarketplace?: boolean;
  },
>(
  items: T[],
  searchValue: string,
  agentsMap: TAgentsMap | undefined,
  assistantsMap: TAssistantsMap | undefined,
  localize?: ReturnType<typeof useLocalize>,
): T[] | null {
  const searchTermLower = searchValue.trim().toLowerCase();
  if (!searchTermLower) {
    return null;
  }

  return items.filter((item) => {
    if (!shouldRenderEndpointOption(item)) {
      return false;
    }

    const itemMatches =
      item.label.toLowerCase().includes(searchTermLower) ||
      (item.name && item.name.toLowerCase().includes(searchTermLower)) ||
      (item.value && item.value.toLowerCase().includes(searchTermLower)) ||
      item.searchAliases?.some((alias) => alias.toLowerCase().includes(searchTermLower)) ||
      (item.showMarketplace === true &&
        localize != null &&
        [localize('com_agents_marketplace'), localize('com_ui_marketplace')].some((label) =>
          label.toLowerCase().includes(searchTermLower),
        ));

    if (itemMatches) {
      return true;
    }

    if (item.models && item.models.length > 0) {
      return item.models.some((modelId) => {
        if (modelId.name.toLowerCase().includes(searchTermLower)) {
          return true;
        }

        if (isAgentsEndpoint(item.value) && agentsMap && modelId.name in agentsMap) {
          const agentName = agentsMap[modelId.name]?.name;
          return typeof agentName === 'string' && agentName.toLowerCase().includes(searchTermLower);
        }

        if (isAssistantsEndpoint(item.value) && assistantsMap) {
          const endpoint = item.value ?? '';
          const assistant = assistantsMap[endpoint][modelId.name];
          if (assistant && typeof assistant.name === 'string') {
            return assistant.name.toLowerCase().includes(searchTermLower);
          }
          return false;
        }

        return false;
      });
    }

    return false;
  });
}

export function shouldRenderEndpointOption(endpoint: {
  value?: string;
  hasModels?: boolean;
}): boolean {
  return !isAgentsEndpoint(endpoint.value) || endpoint.hasModels === true;
}

/** Agents in the default category stay under My Agents instead of getting a group. */
export const DEFAULT_AGENT_CATEGORY = 'general';

/** Unique key for an endpoint's menu: agent category groups share the agents endpoint value. */
export function getEndpointMenuKey(endpoint: Pick<Endpoint, 'value' | 'agentCategory'>): string {
  return endpoint.agentCategory ? `${endpoint.value}-${endpoint.agentCategory}` : endpoint.value;
}

/**
 * Splits the agents endpoint into one menu per agent category, placed right after My Agents
 * in category order. Agents in General, or in a category that no longer exists, stay in My
 * Agents. Every group keeps the full name and icon maps, so the header can still resolve the
 * selected agent from the first agents endpoint.
 */
export function groupAgentsByCategory(
  endpoints: Endpoint[],
  agents: Array<Pick<Agent, 'id' | 'category'>> | null | undefined,
  categories: Array<{ value: string; label: string }>,
): Endpoint[] {
  const index = endpoints.findIndex((ep) => isAgentsEndpoint(ep.value) && !ep.agentCategory);
  if (index === -1 || !agents?.length) {
    return endpoints;
  }

  const agentsEndpoint = endpoints[index];
  const models = agentsEndpoint.models ?? [];
  const groups = categories
    .filter((category) => category.value !== DEFAULT_AGENT_CATEGORY)
    .map((category) => {
      const ids = new Set(
        agents.filter((agent) => agent.category === category.value).map((agent) => agent.id),
      );
      return { category, models: models.filter((model) => ids.has(model.name)) };
    })
    .filter((group) => group.models.length > 0);

  if (!groups.length) {
    return endpoints;
  }

  const grouped = new Set(groups.flatMap((group) => group.models.map((model) => model.name)));
  const myAgents: Endpoint = {
    ...agentsEndpoint,
    models: models.filter((model) => !grouped.has(model.name)),
  };
  const groupEndpoints = groups.map<Endpoint>(({ category, models }) => ({
    ...agentsEndpoint,
    label: category.label,
    models,
    agentCategory: category.value,
    showMarketplace: false,
    searchAliases: undefined,
  }));
  const keepMyAgents = (myAgents.models?.length ?? 0) > 0 || myAgents.showMarketplace === true;

  return [
    ...endpoints.slice(0, index),
    ...(keepMyAgents ? [myAgents] : []),
    ...groupEndpoints,
    ...endpoints.slice(index + 1),
  ];
}

/**
 * Whether this menu holds the current selection. Agent category groups share the agents
 * endpoint value, so the group that lists the selected agent shows the check, and My Agents
 * shows it for any other agent.
 */
export function isEndpointMenuSelected(
  endpoint: Endpoint,
  selectedValues: SelectedValues,
  mappedEndpoints: Endpoint[],
): boolean {
  const { endpoint: selectedEndpoint, model, modelSpec } = selectedValues;
  if (modelSpec || selectedEndpoint !== endpoint.value) {
    return false;
  }
  if (!isAgentsEndpoint(endpoint.value)) {
    return true;
  }
  const owner = mappedEndpoints.find(
    (ep) =>
      ep.value === endpoint.value &&
      ep.agentCategory != null &&
      ep.models?.some((item) => item.name === model),
  );
  return owner?.agentCategory === endpoint.agentCategory;
}

export function filterModels(
  endpoint: Endpoint,
  models: string[],
  searchValue: string,
  agentsMap: TAgentsMap | undefined,
  assistantsMap: TAssistantsMap | undefined,
): string[] {
  const searchTermLower = searchValue.trim().toLowerCase();
  if (!searchTermLower) {
    return models;
  }

  return models.filter((modelId) => {
    let modelName = modelId;

    if (isAgentsEndpoint(endpoint.value) && agentsMap && agentsMap[modelId]) {
      modelName = agentsMap[modelId]?.name || modelId;
    } else if (
      isAssistantsEndpoint(endpoint.value) &&
      assistantsMap &&
      assistantsMap[endpoint.value]
    ) {
      const assistant = assistantsMap[endpoint.value][modelId];
      modelName =
        typeof assistant.name === 'string' && assistant.name ? (assistant.name as string) : modelId;
    }

    return modelName.toLowerCase().includes(searchTermLower);
  });
}

export function getSelectedIcon({
  mappedEndpoints,
  selectedValues,
  modelSpecs,
  endpointsConfig,
  agentsMap,
}: {
  mappedEndpoints: Endpoint[];
  selectedValues: SelectedValues;
  modelSpecs: TModelSpec[];
  endpointsConfig: TEndpointsConfig;
  agentsMap?: TAgentsMap;
}): React.ReactNode | null {
  const { endpoint, model, modelSpec } = selectedValues;

  if (modelSpec) {
    const spec = modelSpecs.find((s) => s.name === modelSpec);
    if (!spec) {
      return null;
    }
    const { showIconInHeader = true } = spec;
    if (!showIconInHeader) {
      return null;
    }
    return React.createElement(SpecIcon, {
      currentSpec: spec,
      endpointsConfig,
      agentAvatarURL: getSpecAgentAvatarURL(spec, agentsMap),
    });
  }

  if (endpoint && model) {
    const selectedEndpoint = mappedEndpoints.find((e) => e.value === endpoint);
    if (!selectedEndpoint) {
      return null;
    }

    if (selectedEndpoint.modelIcons?.[model]) {
      const iconUrl = selectedEndpoint.modelIcons[model];
      return React.createElement(
        'div',
        { className: 'h-5 w-5 overflow-hidden rounded-full' },
        React.createElement('img', {
          src: iconUrl,
          alt: model,
          className: 'h-full w-full object-cover',
        }),
      );
    }

    return (
      selectedEndpoint.icon ||
      React.createElement(Bot, {
        size: 20,
        className: 'icon-md shrink-0 text-text-primary',
      })
    );
  }

  if (endpoint) {
    const selectedEndpoint = mappedEndpoints.find((e) => e.value === endpoint);
    return selectedEndpoint?.icon || null;
  }

  return null;
}

export const getDisplayValue = ({
  localize,
  mappedEndpoints,
  selectedValues,
  modelSpecs,
  agentsMap,
}: {
  localize: ReturnType<typeof useLocalize>;
  selectedValues: SelectedValues;
  mappedEndpoints: Endpoint[];
  modelSpecs: TModelSpec[];
  agentsMap?: TAgentsMap;
}) => {
  if (selectedValues.modelSpec) {
    const spec = modelSpecs.find((s) => s.name === selectedValues.modelSpec);
    return spec?.label || spec?.name || localize('com_ui_select_model');
  }

  if (selectedValues.model && selectedValues.endpoint) {
    const endpoint = mappedEndpoints.find((e) => e.value === selectedValues.endpoint);
    if (!endpoint) {
      return localize('com_ui_select_model');
    }

    if (
      isAgentsEndpoint(endpoint.value) &&
      endpoint.agentNames &&
      endpoint.agentNames[selectedValues.model]
    ) {
      return endpoint.agentNames[selectedValues.model];
    } else if (isAgentsEndpoint(endpoint.value) && agentsMap) {
      const agent = agentsMap[selectedValues.model];
      return agent?.name || selectedValues.model;
    }

    if (
      isAssistantsEndpoint(endpoint.value) &&
      endpoint.assistantNames &&
      endpoint.assistantNames[selectedValues.model]
    ) {
      return endpoint.assistantNames[selectedValues.model];
    }

    return selectedValues.model;
  }

  if (selectedValues.endpoint) {
    const endpoint = mappedEndpoints.find((e) => e.value === selectedValues.endpoint);
    return endpoint?.label || localize('com_ui_select_model');
  }

  return localize('com_ui_select_model');
};
