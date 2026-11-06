import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  AccessRoleIds,
  PermissionBits,
  PrincipalType,
  ResourceType,
} from 'librechat-data-provider';
import type { IAclEntry, IAgent, IAgentCategory, IAccessRole } from '..';
import type { AgentDeps } from './agent';
import { createAgentCategoryMethods } from './agentCategory';
import { createAclEntryMethods } from './aclEntry';
import { createAgentMethods } from './agent';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let Agent: mongoose.Model<IAgent>;
let AclEntry: mongoose.Model<IAclEntry>;
let AgentCategory: mongoose.Model<IAgentCategory>;
let AccessRole: mongoose.Model<IAccessRole>;
let categories: ReturnType<typeof createAgentCategoryMethods>;
let acl: ReturnType<typeof createAclEntryMethods>;
let agents: ReturnType<typeof createAgentMethods>;

const author = new Types.ObjectId();
const userId = new Types.ObjectId();
const groupId = new Types.ObjectId();
const outsiderId = new Types.ObjectId();
const access = [
  { principalType: 'user' as const, principalId: userId.toString() },
  { principalType: 'group' as const, principalId: groupId.toString() },
  { principalType: 'role' as const, principalId: 'ALTITUDE' },
];

const principalsOf = (principalType: PrincipalType, principalId?: Types.ObjectId | string) => [
  { principalType, ...(principalId !== undefined && { principalId }) },
];

const canView = (
  principals: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
  agent: { _id: Types.ObjectId },
) => acl.hasPermission(principals, ResourceType.AGENT, agent._id, PermissionBits.VIEW);

const addAgent = async (id: string, category: string) =>
  (await agents.createAgent({
    id,
    name: id,
    provider: 'google',
    model: 'gemini',
    author,
    category,
  })) as IAgent & { _id: Types.ObjectId };

const sharePublicly = (agent: { _id: Types.ObjectId }, roleId: Types.ObjectId) =>
  AclEntry.create({
    principalType: PrincipalType.PUBLIC,
    resourceType: ResourceType.AGENT,
    resourceId: agent._id,
    permBits: PermissionBits.VIEW,
    roleId,
  });

let viewerRoleId: Types.ObjectId;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  Agent = mongoose.models.Agent as mongoose.Model<IAgent>;
  AclEntry = mongoose.models.AclEntry as mongoose.Model<IAclEntry>;
  AgentCategory = mongoose.models.AgentCategory as mongoose.Model<IAgentCategory>;
  AccessRole = mongoose.models.AccessRole as mongoose.Model<IAccessRole>;
  categories = createAgentCategoryMethods(mongoose);
  acl = createAclEntryMethods(mongoose);
  agents = createAgentMethods(mongoose, {
    removeAllPermissions: jest.fn(),
  } as unknown as AgentDeps);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all([
    Agent.deleteMany({}),
    AclEntry.deleteMany({}),
    AgentCategory.deleteMany({}),
    AccessRole.deleteMany({}),
  ]);
  const viewer = await AccessRole.create({
    accessRoleId: AccessRoleIds.AGENT_VIEWER,
    name: 'viewer',
    resourceType: ResourceType.AGENT,
    permBits: PermissionBits.VIEW,
  });
  viewerRoleId = viewer._id as Types.ObjectId;
  await AgentCategory.create([
    { value: 'general', label: 'General', order: 0, isActive: true },
    { value: 'altitude', label: 'Altitude', order: 1, isActive: true },
    { value: 'echo', label: 'Echo', order: 2, isActive: true },
  ]);
});

describe('setCategoryAccess', () => {
  it('gives users, groups and roles view access to every agent in the category', async () => {
    const first = await addAgent('agent_one', 'altitude');
    const second = await addAgent('agent_two', 'altitude');

    await categories.setCategoryAccess('altitude', access, author);

    for (const agent of [first, second]) {
      expect(await canView(principalsOf(PrincipalType.USER, userId), agent)).toBe(true);
      expect(await canView(principalsOf(PrincipalType.GROUP, groupId), agent)).toBe(true);
      expect(await canView(principalsOf(PrincipalType.ROLE, 'ALTITUDE'), agent)).toBe(true);
    }
  });

  it('grants view access only, not edit', async () => {
    const agent = await addAgent('agent_one', 'altitude');

    await categories.setCategoryAccess('altitude', access, author);

    const bits = await acl.getEffectivePermissions(
      principalsOf(PrincipalType.USER, userId),
      ResourceType.AGENT,
      agent._id,
    );
    expect(bits).toBe(PermissionBits.VIEW);
  });

  it('gives nobody else access', async () => {
    const agent = await addAgent('agent_one', 'altitude');
    const other = await addAgent('agent_two', 'echo');

    await categories.setCategoryAccess('altitude', access, author);

    expect(await canView(principalsOf(PrincipalType.USER, outsiderId), agent)).toBe(false);
    expect(await canView(principalsOf(PrincipalType.PUBLIC), agent)).toBe(false);
    expect(await canView(principalsOf(PrincipalType.USER, userId), other)).toBe(false);
  });

  it('takes access away from someone removed from the list', async () => {
    const agent = await addAgent('agent_one', 'altitude');
    await categories.setCategoryAccess('altitude', access, author);

    await categories.setCategoryAccess('altitude', [access[1]], author);

    expect(await canView(principalsOf(PrincipalType.USER, userId), agent)).toBe(false);
    expect(await canView(principalsOf(PrincipalType.ROLE, 'ALTITUDE'), agent)).toBe(false);
    expect(await canView(principalsOf(PrincipalType.GROUP, groupId), agent)).toBe(true);
  });

  it('takes all access away when the list is emptied', async () => {
    const agent = await addAgent('agent_one', 'altitude');
    await categories.setCategoryAccess('altitude', access, author);

    await categories.setCategoryAccess('altitude', [], author);

    expect(await AclEntry.countDocuments({ resourceId: agent._id })).toBe(0);
  });

  it('never overwrites or removes something shared directly on the agent', async () => {
    const agent = await addAgent('agent_one', 'altitude');
    const direct = await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: userId,
      principalModel: 'User',
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      permBits: PermissionBits.VIEW | PermissionBits.EDIT,
      roleId: viewerRoleId,
    });

    await categories.setCategoryAccess('altitude', access, author);
    let entry = await AclEntry.findById(direct._id).lean();
    expect(entry?.permBits).toBe(PermissionBits.VIEW | PermissionBits.EDIT);
    expect(entry?.inheritedFrom).toBeUndefined();

    await categories.setCategoryAccess('altitude', [], author);
    entry = await AclEntry.findById(direct._id).lean();
    expect(entry?.permBits).toBe(PermissionBits.VIEW | PermissionBits.EDIT);
  });

  it('can be repeated without duplicating entries', async () => {
    const agent = await addAgent('agent_one', 'altitude');

    await categories.setCategoryAccess('altitude', access, author);
    await categories.setCategoryAccess('altitude', access, author);

    expect(await AclEntry.countDocuments({ resourceId: agent._id })).toBe(access.length);
  });

  it('reports a missing category', async () => {
    expect(await categories.setCategoryAccess('missing', access, author)).toBe(false);
  });
});

describe('when an agent changes category', () => {
  beforeEach(async () => {
    await categories.setCategoryAccess('altitude', access, author);
  });

  it('a new agent picks up its category access', async () => {
    const agent = await addAgent('agent_new', 'altitude');

    expect(await canView(principalsOf(PrincipalType.GROUP, groupId), agent)).toBe(true);
  });

  it('moving in grants access and moving out removes it', async () => {
    const agent = await addAgent('agent_one', 'echo');
    expect(await canView(principalsOf(PrincipalType.GROUP, groupId), agent)).toBe(false);

    await agents.updateAgent({ id: 'agent_one' }, { category: 'altitude' });
    expect(await canView(principalsOf(PrincipalType.GROUP, groupId), agent)).toBe(true);

    await agents.updateAgent({ id: 'agent_one' }, { category: 'echo' });
    expect(await canView(principalsOf(PrincipalType.GROUP, groupId), agent)).toBe(false);
  });

  it('other updates leave access alone', async () => {
    const agent = await addAgent('agent_one', 'altitude');
    const before = await AclEntry.countDocuments({ resourceId: agent._id });

    await agents.updateAgent({ id: 'agent_one' }, { name: 'Renamed' });

    expect(await AclEntry.countDocuments({ resourceId: agent._id })).toBe(before);
    expect(await canView(principalsOf(PrincipalType.GROUP, groupId), agent)).toBe(true);
  });

  it('moving out keeps direct shares', async () => {
    const agent = await addAgent('agent_one', 'altitude');
    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: outsiderId,
      principalModel: 'User',
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      permBits: PermissionBits.VIEW,
      roleId: viewerRoleId,
    });

    await agents.updateAgent({ id: 'agent_one' }, { category: 'general' });

    expect(await canView(principalsOf(PrincipalType.USER, outsiderId), agent)).toBe(true);
    expect(await canView(principalsOf(PrincipalType.GROUP, groupId), agent)).toBe(false);
  });

  it('reverting to a version in another category moves access with it', async () => {
    const agent = await addAgent('agent_one', 'echo');
    await agents.updateAgent({ id: 'agent_one' }, { category: 'altitude' });
    expect(await canView(principalsOf(PrincipalType.GROUP, groupId), agent)).toBe(true);

    await agents.revertAgentVersion({ id: 'agent_one' }, 0);

    expect(await canView(principalsOf(PrincipalType.GROUP, groupId), agent)).toBe(false);
  });
});

describe('public agents', () => {
  it('counts them and can make them private, leaving other shares alone', async () => {
    const shared = await addAgent('agent_one', 'altitude');
    await addAgent('agent_two', 'altitude');
    const elsewhere = await addAgent('agent_three', 'echo');
    await sharePublicly(shared, viewerRoleId);
    await sharePublicly(elsewhere, viewerRoleId);
    await categories.setCategoryAccess('altitude', access, author);

    expect(await categories.getCategoryAccess('altitude')).toMatchObject({
      agentCount: 2,
      publicAgentCount: 1,
    });

    expect(await categories.makeCategoryAgentsPrivate('altitude')).toBe(1);

    expect(await canView(principalsOf(PrincipalType.PUBLIC), shared)).toBe(false);
    expect(await canView(principalsOf(PrincipalType.GROUP, groupId), shared)).toBe(true);
    expect(await canView(principalsOf(PrincipalType.PUBLIC), elsewhere)).toBe(true);
  });
});
