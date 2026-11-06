import { logger, isValidObjectIdString } from '@librechat/data-schemas';
import { MAX_AGENT_CATEGORY_LABEL_LENGTH, PrincipalType } from 'librechat-data-provider';
import type {
  TPrincipal,
  TAgentCategoryAccess,
  TManagedAgentCategory,
  AgentCategoryErrorCode,
} from 'librechat-data-provider';
import type { AgentCategory, AgentCategoryAccessEntry } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { getSafeErrorMetadata } from '~/utils/errors';

/** Agents in this category stay under My Agents, so it can't be renamed, moved or hidden. */
const DEFAULT_CATEGORY = 'general';
/** Marketplace tabs the categories route adds on top of the stored categories. */
const RESERVED_VALUES: ReadonlySet<string> = new Set(['promoted', 'all']);
const MAX_ACCESS_PRINCIPALS = 100;

type CategoryWithCount = AgentCategory & { agentCount: number };
type CategoryHandler = (req: Request, res: Response) => Promise<void>;

export interface AgentCategoryHandlerDeps {
  getCategoriesWithCounts: (options?: {
    includeInactive?: boolean;
  }) => Promise<CategoryWithCount[]>;
  getDefaultCategoryValues: () => string[];
  createCategory: (data: Partial<AgentCategory>) => Promise<AgentCategory>;
  updateCategory: (value: string, data: Partial<AgentCategory>) => Promise<AgentCategory | null>;
  deleteCategory: (value: string) => Promise<boolean>;
  getCategoryAccess: (value: string) => Promise<{
    access: AgentCategoryAccessEntry[];
    agentCount: number;
    publicAgentCount: number;
  } | null>;
  setCategoryAccess: (
    value: string,
    access: AgentCategoryAccessEntry[],
    grantedBy?: string,
  ) => Promise<boolean>;
  makeCategoryAgentsPrivate: (value: string) => Promise<number>;
  findUsers: (
    criteria: { _id: { $in: string[] } },
    fields: string,
  ) => Promise<
    Array<{ _id?: unknown; name?: string; username?: string; email?: string; avatar?: string }>
  >;
  findGroupById: (id: string) => Promise<{ name?: string; memberIds?: string[] } | null>;
  getRoleByName: (name: string) => Promise<{ name?: string } | null>;
}

const toCategoryValue = (label: string): string =>
  label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Ignores spacing and punctuation, so "After Sales" clashes with the built-in `aftersales`. */
const toNameKey = (text: string): string => toCategoryValue(text).replace(/-/g, '');

/** Labels starting with `com_` are read by the client as translation keys. */
function parseLabel(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  const label = input.trim();
  const isValid =
    label.length > 0 &&
    label.length <= MAX_AGENT_CATEGORY_LABEL_LENGTH &&
    !label.startsWith('com_') &&
    toCategoryValue(label).length > 0;
  return isValid ? label : null;
}

function isNameTaken(categories: CategoryWithCount[], label: string, ownValue?: string): boolean {
  const key = toNameKey(label);
  return categories.some(
    (category) =>
      category.value !== ownValue &&
      (toNameKey(category.value) === key || toNameKey(category.label) === key),
  );
}

/** Reads `[{ type, id }]` from a request body, or null when any entry is malformed. */
function parsePrincipals(input: unknown): AgentCategoryAccessEntry[] | null {
  if (!Array.isArray(input) || input.length > MAX_ACCESS_PRINCIPALS) {
    return null;
  }
  const entries = new Map<string, AgentCategoryAccessEntry>();
  for (const item of input) {
    const { type, id } = (item ?? {}) as { type?: unknown; id?: unknown };
    if (typeof id !== 'string' || id.length === 0) {
      return null;
    }
    const isRole = type === PrincipalType.ROLE;
    const isUserOrGroup = type === PrincipalType.USER || type === PrincipalType.GROUP;
    if (!isRole && !(isUserOrGroup && isValidObjectIdString(id))) {
      return null;
    }
    entries.set(`${type}:${id}`, {
      principalType: type as AgentCategoryAccessEntry['principalType'],
      principalId: id,
    });
  }
  return [...entries.values()];
}

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

const sendError = (res: Response, status: number, code: AgentCategoryErrorCode): void => {
  res.status(status).json({ code });
};

export function createAgentCategoryHandlers(
  deps: AgentCategoryHandlerDeps,
): Record<
  'list' | 'create' | 'update' | 'reorder' | 'remove' | 'getAccess' | 'setAccess' | 'makePrivate',
  CategoryHandler
> {
  const builtInValues = new Set(deps.getDefaultCategoryValues());

  const toManaged = (category: AgentCategory, count: number): TManagedAgentCategory => ({
    value: category.value,
    label: category.label,
    description: category.description,
    count,
    order: category.order,
    isActive: category.isActive,
    builtIn: builtInValues.has(category.value),
    accessCount: category.access?.length ?? 0,
  });

  const listAll = () => deps.getCategoriesWithCounts({ includeInactive: true });

  const respondWithList = async (res: Response): Promise<void> => {
    const categories = await listAll();
    res.status(200).json(categories.map((category) => toManaged(category, category.agentCount)));
  };

  /** Keeps stored order. Anyone since deleted is left out, so they vanish from the access list. */
  const resolvePrincipals = async (access: AgentCategoryAccessEntry[]): Promise<TPrincipal[]> => {
    const idsOf = (type: AgentCategoryAccessEntry['principalType']) =>
      access.filter((entry) => entry.principalType === type).map((entry) => entry.principalId);
    const userIds = idsOf('user');
    const groupIds = idsOf('group');
    const roleNames = idsOf('role');
    const [users, groups, roles] = await Promise.all([
      userIds.length > 0
        ? deps.findUsers({ _id: { $in: userIds } }, 'name username email avatar')
        : [],
      Promise.all(groupIds.map((id) => deps.findGroupById(id))),
      Promise.all(roleNames.map((name) => deps.getRoleByName(name))),
    ]);
    const usersById = new Map(users.map((user) => [String(user._id), user]));

    return access.flatMap((entry): TPrincipal[] => {
      const id = entry.principalId;
      if (entry.principalType === 'user') {
        const user = usersById.get(id);
        return user
          ? [
              {
                type: PrincipalType.USER,
                id,
                name: user.name || user.username,
                email: user.email,
                avatar: user.avatar,
                source: 'local',
              },
            ]
          : [];
      }
      if (entry.principalType === 'group') {
        const group = groups[groupIds.indexOf(id)];
        return group
          ? [
              {
                type: PrincipalType.GROUP,
                id,
                name: group.name,
                memberCount: group.memberIds?.length ?? 0,
                source: 'local',
              },
            ]
          : [];
      }
      return roles[roleNames.indexOf(id)] ? [{ type: PrincipalType.ROLE, id, name: id }] : [];
    });
  };

  const respondWithAccess = async (res: Response, value: string): Promise<void> => {
    const summary = await deps.getCategoryAccess(value);
    if (!summary) {
      sendError(res, 404, 'category_not_found');
      return;
    }
    const body: TAgentCategoryAccess = {
      principals: await resolvePrincipals(summary.access),
      agentCount: summary.agentCount,
      publicAgentCount: summary.publicAgentCount,
    };
    res.status(200).json(body);
  };

  const guarded =
    (name: string, handler: CategoryHandler): CategoryHandler =>
    async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          sendError(res, 409, 'category_exists');
          return;
        }
        logger.error(`[agentCategories] ${name} failed`, getSafeErrorMetadata(error));
        sendError(res, 500, 'internal_error');
      }
    };

  return {
    list: guarded('list', async (_req, res) => {
      await respondWithList(res);
    }),

    create: guarded('create', async (req, res) => {
      const label = parseLabel(req.body?.label);
      if (!label) {
        sendError(res, 400, 'invalid_label');
        return;
      }
      const value = toCategoryValue(label);
      if (RESERVED_VALUES.has(value)) {
        sendError(res, 400, 'reserved_name');
        return;
      }
      const categories = await listAll();
      if (isNameTaken(categories, label)) {
        sendError(res, 409, 'category_exists');
        return;
      }
      const order = Math.max(0, ...categories.map((category) => category.order)) + 1;
      const created = await deps.createCategory({
        value,
        label,
        description: '',
        order,
        isActive: true,
        custom: true,
      });
      res.status(201).json(toManaged(created, 0));
    }),

    update: guarded('update', async (req, res) => {
      const { value } = req.params;
      const categories = await listAll();
      const category = categories.find((item) => item.value === value);
      if (!category) {
        sendError(res, 404, 'category_not_found');
        return;
      }
      if (value === DEFAULT_CATEGORY) {
        sendError(res, 400, 'category_protected');
        return;
      }

      const updates: Partial<AgentCategory> = {};
      if (req.body?.label !== undefined) {
        const label = parseLabel(req.body.label);
        if (!label) {
          sendError(res, 400, 'invalid_label');
          return;
        }
        if (RESERVED_VALUES.has(toCategoryValue(label))) {
          sendError(res, 400, 'reserved_name');
          return;
        }
        if (isNameTaken(categories, label, value)) {
          sendError(res, 409, 'category_exists');
          return;
        }
        updates.label = label;
        /** Startup restores the translated label of any built-in not marked custom. */
        updates.custom = true;
      }
      if (req.body?.isActive !== undefined) {
        if (typeof req.body.isActive !== 'boolean') {
          sendError(res, 400, 'invalid_request');
          return;
        }
        updates.isActive = req.body.isActive;
      }
      if (Object.keys(updates).length === 0) {
        sendError(res, 400, 'invalid_request');
        return;
      }

      const updated = await deps.updateCategory(value, updates);
      if (!updated) {
        sendError(res, 404, 'category_not_found');
        return;
      }
      res.status(200).json(toManaged(updated, category.agentCount));
    }),

    /** `values` is every category except General, in the new order; General stays first. */
    reorder: guarded('reorder', async (req, res) => {
      const values: unknown = req.body?.values;
      const categories = await listAll();
      const movable = new Set(
        categories.map((category) => category.value).filter((value) => value !== DEFAULT_CATEGORY),
      );
      const isValid =
        Array.isArray(values) &&
        values.length === movable.size &&
        new Set(values).size === values.length &&
        values.every((value) => typeof value === 'string' && movable.has(value));
      if (!isValid) {
        sendError(res, 400, 'invalid_request');
        return;
      }
      await Promise.all(
        (values as string[]).map((value, index) =>
          deps.updateCategory(value, { order: index + 1 }),
        ),
      );
      await respondWithList(res);
    }),

    remove: guarded('remove', async (req, res) => {
      const { value } = req.params;
      const categories = await listAll();
      const category = categories.find((item) => item.value === value);
      if (!category) {
        sendError(res, 404, 'category_not_found');
        return;
      }
      if (builtInValues.has(value)) {
        sendError(res, 400, 'category_protected');
        return;
      }
      if (category.agentCount > 0) {
        sendError(res, 409, 'category_in_use');
        return;
      }
      await deps.deleteCategory(value);
      res.status(204).end();
    }),

    getAccess: guarded('getAccess', async (req, res) => {
      await respondWithAccess(res, req.params.value);
    }),

    /** Replaces who can use the category's agents. General stays open, since it's the default. */
    setAccess: guarded('setAccess', async (req, res) => {
      const { value } = req.params;
      if (value === DEFAULT_CATEGORY) {
        sendError(res, 400, 'category_protected');
        return;
      }
      const access = parsePrincipals(req.body?.principals);
      if (!access) {
        sendError(res, 400, 'invalid_principal');
        return;
      }
      const resolved = await resolvePrincipals(access);
      if (resolved.length !== access.length) {
        sendError(res, 400, 'invalid_principal');
        return;
      }
      const exists = await deps.setCategoryAccess(value, access, (req as ServerRequest).user?.id);
      if (!exists) {
        sendError(res, 404, 'category_not_found');
        return;
      }
      await respondWithAccess(res, value);
    }),

    makePrivate: guarded('makePrivate', async (req, res) => {
      await deps.makeCategoryAgentsPrivate(req.params.value);
      await respondWithAccess(res, req.params.value);
    }),
  };
}
