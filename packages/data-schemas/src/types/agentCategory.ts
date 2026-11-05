import type { Document, Types } from 'mongoose';

/** A user, group or role allowed to see and use every agent in a category. */
export type AgentCategoryAccessEntry = {
  principalType: 'user' | 'group' | 'role';
  /** Stored as a string: an ObjectId for users and groups, the role name for roles. */
  principalId: string;
};

export type AgentCategory = {
  /** Unique identifier for the category (e.g., 'general', 'hr', 'finance') */
  value: string;
  /** Display label for the category */
  label: string;
  /** Description of the category */
  description?: string;
  /** Display order for sorting categories */
  order: number;
  /** Whether the category is active and should be displayed */
  isActive: boolean;
  /** Whether this is a custom user-created category */
  custom?: boolean;
  /** Who gets view access to the category's agents, applied as ACL entries on each agent */
  access?: AgentCategoryAccessEntry[];
  tenantId?: string;
};

export type IAgentCategory = AgentCategory &
  Document & {
    _id: Types.ObjectId;
  };
