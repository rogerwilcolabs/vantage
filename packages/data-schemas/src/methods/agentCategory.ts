import {
  AccessRoleIds,
  PermissionBits,
  PrincipalModel,
  PrincipalType,
  ResourceType,
} from 'librechat-data-provider';
import type { AnyBulkWriteOperation, Model, Types } from 'mongoose';
import type {
  IAgent,
  IAclEntry,
  IAccessRole,
  IAgentCategory,
  AgentCategoryAccessEntry,
} from '~/types';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';

const DEFAULT_CATEGORIES = [
  {
    value: 'general',
    label: 'com_agents_category_general',
    description: 'com_agents_category_general_description',
    order: 0,
  },
  {
    value: 'hr',
    label: 'com_agents_category_hr',
    description: 'com_agents_category_hr_description',
    order: 1,
  },
  {
    value: 'rd',
    label: 'com_agents_category_rd',
    description: 'com_agents_category_rd_description',
    order: 2,
  },
  {
    value: 'finance',
    label: 'com_agents_category_finance',
    description: 'com_agents_category_finance_description',
    order: 3,
  },
  {
    value: 'it',
    label: 'com_agents_category_it',
    description: 'com_agents_category_it_description',
    order: 4,
  },
  {
    value: 'sales',
    label: 'com_agents_category_sales',
    description: 'com_agents_category_sales_description',
    order: 5,
  },
  {
    value: 'aftersales',
    label: 'com_agents_category_aftersales',
    description: 'com_agents_category_aftersales_description',
    order: 6,
  },
];

function toAclPrincipal(
  mongoose: typeof import('mongoose'),
  { principalType, principalId }: AgentCategoryAccessEntry,
) {
  if (principalType === PrincipalType.ROLE) {
    return { principalType, principalId, principalModel: PrincipalModel.ROLE };
  }
  return {
    principalType,
    principalId: new mongoose.Types.ObjectId(principalId),
    principalModel:
      principalType === PrincipalType.USER ? PrincipalModel.USER : PrincipalModel.GROUP,
  };
}

/**
 * Gives a category's principals view access to these agents. Every existing access check reads
 * these ACL entries, so category access needs no enforcement of its own. `$setOnInsert` leaves any
 * entry shared directly on the agent as it is, and `inheritedFrom` marks only the grants this
 * category made, so taking access away later can't remove a direct share.
 */
async function grantCategoryAccess(
  mongoose: typeof import('mongoose'),
  category: Pick<IAgentCategory, '_id' | 'access'>,
  agentIds: Types.ObjectId[],
  grantedBy?: Types.ObjectId | string,
): Promise<void> {
  const access = category.access ?? [];
  if (access.length === 0 || agentIds.length === 0) {
    return;
  }
  const AccessRole = mongoose.models.AccessRole as Model<IAccessRole>;
  const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
  const viewer = await AccessRole.findOne({ accessRoleId: AccessRoleIds.AGENT_VIEWER }).lean();
  if (!viewer) {
    throw new Error(`Access role ${AccessRoleIds.AGENT_VIEWER} not found`);
  }
  const grantedAt = new Date();
  const operations = agentIds.flatMap((resourceId) =>
    access.map((entry) => {
      const { principalType, principalId, principalModel } = toAclPrincipal(mongoose, entry);
      return {
        updateOne: {
          filter: { principalType, principalId, resourceType: ResourceType.AGENT, resourceId },
          update: {
            $setOnInsert: {
              principalModel,
              permBits: PermissionBits.VIEW,
              roleId: viewer._id,
              inheritedFrom: category._id,
              grantedAt,
              ...(grantedBy && { grantedBy }),
            },
          },
          upsert: true,
        },
      };
    }),
  );
  await tenantSafeBulkWrite(AclEntry, operations as AnyBulkWriteOperation[]);
}

/**
 * Brings one agent's category-based access in line with its current category: removes grants from
 * any other category and adds those of the current one. Called whenever an agent's category changes.
 */
export async function syncAgentCategoryAccess(
  mongoose: typeof import('mongoose'),
  agent: Pick<IAgent, '_id' | 'category' | 'author'>,
): Promise<void> {
  const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
  const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
  const category = agent.category
    ? await AgentCategory.findOne({ value: agent.category }).lean<IAgentCategory>()
    : null;
  await AclEntry.deleteMany({
    resourceType: ResourceType.AGENT,
    resourceId: agent._id,
    inheritedFrom: category ? { $exists: true, $ne: category._id } : { $exists: true },
  });
  if (category) {
    await grantCategoryAccess(mongoose, category, [agent._id], agent.author);
  }
}

export function createAgentCategoryMethods(mongoose: typeof import('mongoose')): {
  getActiveCategories: () => Promise<IAgentCategory[]>;
  getCategoriesWithCounts: (options?: {
    includeInactive?: boolean;
  }) => Promise<(IAgentCategory & { agentCount: number })[]>;
  getDefaultCategoryValues: () => string[];
  getCategoryAccess: (value: string) => Promise<{
    access: AgentCategoryAccessEntry[];
    agentCount: number;
    publicAgentCount: number;
  } | null>;
  setCategoryAccess: (
    value: string,
    access: AgentCategoryAccessEntry[],
    grantedBy?: Types.ObjectId | string,
  ) => Promise<boolean>;
  makeCategoryAgentsPrivate: (value: string) => Promise<number>;
  getValidCategoryValues: () => Promise<string[]>;
  seedCategories: (
    categories: Array<{
      value: string;
      label?: string;
      description?: string;
      order?: number;
      custom?: boolean;
    }>,
  ) => Promise<import('mongoose').mongo.BulkWriteResult>;
  findCategoryByValue: (value: string) => Promise<IAgentCategory | null>;
  createCategory: (categoryData: Partial<IAgentCategory>) => Promise<IAgentCategory>;
  getAllCategories: () => Promise<IAgentCategory[]>;
  ensureDefaultCategories: () => Promise<boolean>;
} {
  /**
   * Get all active categories sorted by order
   * @returns Array of active categories
   */
  async function getActiveCategories(): Promise<IAgentCategory[]> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    return await AgentCategory.find({ isActive: true })
      .sort({ order: 1, label: 1 })
      .lean<IAgentCategory[]>();
  }

  /**
   * Get categories with agent counts
   * @param options.includeInactive - Also return hidden categories, for management screens
   * @returns Categories with agent counts
   */
  async function getCategoriesWithCounts(
    options: { includeInactive?: boolean } = {},
  ): Promise<(IAgentCategory & { agentCount: number })[]> {
    const Agent = mongoose.models.Agent;

    const [categoryCounts, categories] = await Promise.all([
      Agent.aggregate([
        { $match: { category: { $exists: true, $ne: null } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]),
      options.includeInactive ? getAllCategories() : getActiveCategories(),
    ]);

    const countMap = new Map(categoryCounts.map((c) => [c._id, c.count]));

    return categories.map((category) => ({
      ...category,
      agentCount: countMap.get(category.value) || (0 as number),
    })) as (IAgentCategory & { agentCount: number })[];
  }

  /**
   * Create a new category
   * @param categoryData - The category data to create
   * @returns The created category
   */
  async function createCategory(categoryData: Partial<IAgentCategory>): Promise<IAgentCategory> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    const category = await AgentCategory.create(categoryData);
    return category.toObject() as IAgentCategory;
  }

  /**
   * Get all categories (active and inactive)
   * @returns Array of all categories
   */
  async function getAllCategories(): Promise<IAgentCategory[]> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    return await AgentCategory.find({}).sort({ order: 1, label: 1 }).lean<IAgentCategory[]>();
  }

  /**
   * Ensure default categories exist and update them if they don't have localization keys
   * @returns Promise<boolean> - true if categories were created/updated, false if no changes
   */
  async function ensureDefaultCategories(): Promise<boolean> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;

    const existingCategories = await getAllCategories();
    const existingCategoryMap = new Map(existingCategories.map((cat) => [cat.value, cat]));

    const updates = [];
    let created = 0;

    for (const defaultCategory of DEFAULT_CATEGORIES) {
      const existingCategory = existingCategoryMap.get(defaultCategory.value);

      if (existingCategory) {
        const isNotCustom = !existingCategory.custom;
        const needsLocalization = !existingCategory.label.startsWith('com_');

        if (isNotCustom && needsLocalization) {
          updates.push({
            value: defaultCategory.value,
            label: defaultCategory.label,
            description: defaultCategory.description,
          });
        }
      } else {
        await createCategory({
          ...defaultCategory,
          isActive: true,
          custom: false,
        });
        created++;
      }
    }

    if (updates.length > 0) {
      const bulkOps = updates.map((update) => ({
        updateOne: {
          filter: { value: update.value, custom: { $ne: true } },
          update: {
            $set: {
              label: update.label,
              description: update.description,
            },
          },
        },
      }));

      await tenantSafeBulkWrite(AgentCategory, bulkOps, { ordered: false });
    }

    return updates.length > 0 || created > 0;
  }

  /**
   * Values of the categories `ensureDefaultCategories` recreates on every startup
   * @returns Array of default category values
   */
  function getDefaultCategoryValues(): string[] {
    return DEFAULT_CATEGORIES.map((category) => category.value);
  }

  async function findCategoryAgentIds(value: string): Promise<Types.ObjectId[]> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const agents = await Agent.find({ category: value }, { _id: 1 }).lean();
    return agents.map((agent) => agent._id as Types.ObjectId);
  }

  /**
   * Who a category gives access to, and how many of its agents everyone can already see.
   * @returns The access summary, or null when the category doesn't exist
   */
  async function getCategoryAccess(value: string) {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const [category, agentIds] = await Promise.all([
      AgentCategory.findOne({ value }).lean<IAgentCategory>(),
      findCategoryAgentIds(value),
    ]);
    if (!category) {
      return null;
    }
    const publicAgents = await AclEntry.distinct('resourceId', {
      principalType: PrincipalType.PUBLIC,
      resourceType: ResourceType.AGENT,
      resourceId: { $in: agentIds },
    });
    return {
      access: category.access ?? [],
      agentCount: agentIds.length,
      publicAgentCount: publicAgents.length,
    };
  }

  /**
   * Replaces who a category gives access to and updates the ACL entries on all of its agents.
   * @returns Whether the category exists
   */
  async function setCategoryAccess(
    value: string,
    access: AgentCategoryAccessEntry[],
    grantedBy?: Types.ObjectId | string,
  ): Promise<boolean> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const category = await AgentCategory.findOneAndUpdate(
      { value },
      { $set: { access } },
      { new: true },
    ).lean<IAgentCategory>();
    if (!category) {
      return false;
    }
    const agentIds = await findCategoryAgentIds(value);
    const kept = access.map((entry) => {
      const { principalType, principalId } = toAclPrincipal(mongoose, entry);
      return { principalType, principalId };
    });
    const inherited = { resourceType: ResourceType.AGENT, inheritedFrom: category._id };
    await AclEntry.deleteMany({
      ...inherited,
      $or: [{ resourceId: { $nin: agentIds } }, ...(kept.length > 0 ? [{ $nor: kept }] : [{}])],
    });
    await grantCategoryAccess(mongoose, category, agentIds, grantedBy);
    return true;
  }

  /**
   * Stops sharing a category's agents with everyone.
   * @returns How many public shares were removed
   */
  async function makeCategoryAgentsPrivate(value: string): Promise<number> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const agentIds = await findCategoryAgentIds(value);
    const { deletedCount } = await AclEntry.deleteMany({
      principalType: PrincipalType.PUBLIC,
      resourceType: ResourceType.AGENT,
      resourceId: { $in: agentIds },
    });
    return deletedCount;
  }

  return {
    getActiveCategories,
    getCategoriesWithCounts,
    getDefaultCategoryValues,
    getCategoryAccess,
    setCategoryAccess,
    makeCategoryAgentsPrivate,
    getValidCategoryValues,
    seedCategories,
    findCategoryByValue,
    createCategory,
    getAllCategories,
    ensureDefaultCategories,
  };
}

export type AgentCategoryMethods = ReturnType<typeof createAgentCategoryMethods>;
