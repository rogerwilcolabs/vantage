import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { AllMethods } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { AgentCategoryHandlerDeps } from './categories';
import { createAgentCategoryHandlers } from './categories';

let mongoServer: MongoMemoryServer;
let methods: AllMethods;
let handlers: ReturnType<typeof createAgentCategoryHandlers>;

type Handler = (req: Request, res: Response) => Promise<void>;

async function call(
  handler: Handler,
  input: { body?: object; params?: object; user?: object } = {},
) {
  const result: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      result.status = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
    end() {
      return this;
    },
  };
  await handler(input as unknown as Request, res as unknown as Response);
  return result;
}

const stored = (value: string) => methods.findCategoryByValue(value);

async function addAgentIn(category: string) {
  await mongoose.models.Agent.create({
    id: `agent_${category}`,
    name: category,
    provider: 'google',
    model: 'gemini',
    author: new mongoose.Types.ObjectId(),
    category,
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
  handlers = createAgentCategoryHandlers(methods as unknown as AgentCategoryHandlerDeps);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.AgentCategory.deleteMany({});
  await mongoose.models.Agent.deleteMany({});
  await methods.ensureDefaultCategories();
});

describe('create', () => {
  it('stores a custom category after the existing ones', async () => {
    const { status, body } = await call(handlers.create, { body: { label: '  Altitude ' } });

    expect(status).toBe(201);
    expect(body).toMatchObject({
      value: 'altitude',
      label: 'Altitude',
      count: 0,
      order: 7,
      isActive: true,
      builtIn: false,
    });
    expect((await stored('altitude'))?.custom).toBe(true);
  });

  it('builds the value from the label', async () => {
    const { body } = await call(handlers.create, { body: { label: 'Café & Bar: Group 2!' } });
    expect(body).toMatchObject({ value: 'cafe-bar-group-2', label: 'Café & Bar: Group 2!' });
  });

  it.each([['Finance'], ['FINANCE'], ['After Sales']])(
    'rejects %s as clashing with a built-in',
    async (label) => {
      const { status, body } = await call(handlers.create, { body: { label } });
      expect(status).toBe(409);
      expect(body).toEqual({ code: 'category_exists' });
    },
  );

  it('rejects a name already taken by a hidden category', async () => {
    await call(handlers.create, { body: { label: 'Altitude' } });
    await call(handlers.update, { params: { value: 'altitude' }, body: { isActive: false } });

    const { status } = await call(handlers.create, { body: { label: 'altitude' } });

    expect(status).toBe(409);
  });

  it.each([
    [undefined],
    [42],
    [{ $ne: null }],
    ['   '],
    ['!!!'],
    ['com_ui_agent'],
    ['x'.repeat(51)],
  ])('rejects %j as an invalid label', async (label) => {
    const { status, body } = await call(handlers.create, { body: { label } });
    expect(status).toBe(400);
    expect(body).toEqual({ code: 'invalid_label' });
  });

  it.each([['All'], ['Promoted']])('rejects the reserved name %s', async (label) => {
    const { status, body } = await call(handlers.create, { body: { label } });
    expect(status).toBe(400);
    expect(body).toEqual({ code: 'reserved_name' });
  });
});

describe('update', () => {
  it('renames a category without changing its value', async () => {
    await call(handlers.create, { body: { label: 'Altitude' } });

    const { status, body } = await call(handlers.update, {
      params: { value: 'altitude' },
      body: { label: 'Altitude Clients' },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ value: 'altitude', label: 'Altitude Clients' });
  });

  it('keeps a renamed built-in through the startup restore', async () => {
    await call(handlers.update, { params: { value: 'finance' }, body: { label: 'Money' } });

    await methods.ensureDefaultCategories();

    expect((await stored('finance'))?.label).toBe('Money');
  });

  it('lets a category keep its own name in a different case', async () => {
    await call(handlers.create, { body: { label: 'Altitude' } });

    const { status } = await call(handlers.update, {
      params: { value: 'altitude' },
      body: { label: 'ALTITUDE' },
    });

    expect(status).toBe(200);
  });

  it('rejects renaming to a name another category has', async () => {
    await call(handlers.create, { body: { label: 'Altitude' } });

    const { status, body } = await call(handlers.update, {
      params: { value: 'altitude' },
      body: { label: 'Finance' },
    });

    expect(status).toBe(409);
    expect(body).toEqual({ code: 'category_exists' });
  });

  it('hides and shows a category', async () => {
    await call(handlers.update, { params: { value: 'hr' }, body: { isActive: false } });
    expect((await stored('hr'))?.isActive).toBe(false);

    await call(handlers.update, { params: { value: 'hr' }, body: { isActive: true } });
    expect((await stored('hr'))?.isActive).toBe(true);
  });

  it('protects General', async () => {
    for (const body of [{ label: 'Everything' }, { isActive: false }]) {
      const result = await call(handlers.update, { params: { value: 'general' }, body });
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ code: 'category_protected' });
    }
    expect((await stored('general'))?.isActive).toBe(true);
  });

  it('ignores fields it does not manage', async () => {
    const { status, body } = await call(handlers.update, {
      params: { value: 'hr' },
      body: { value: 'other', order: 99 },
    });

    expect(status).toBe(400);
    expect(body).toEqual({ code: 'invalid_request' });
    expect((await stored('hr'))?.order).toBe(1);
  });

  it('rejects a non-boolean isActive', async () => {
    const { status } = await call(handlers.update, {
      params: { value: 'hr' },
      body: { isActive: 'false' },
    });
    expect(status).toBe(400);
  });

  it('returns 404 for an unknown category', async () => {
    const { status, body } = await call(handlers.update, {
      params: { value: 'nope' },
      body: { isActive: false },
    });
    expect(status).toBe(404);
    expect(body).toEqual({ code: 'category_not_found' });
  });
});

describe('reorder', () => {
  const movable = ['aftersales', 'sales', 'it', 'finance', 'rd', 'hr'];

  it('applies the new order and keeps General first', async () => {
    const { status, body } = await call(handlers.reorder, { body: { values: movable } });

    expect(status).toBe(200);
    expect((body as Array<{ value: string }>).map((category) => category.value)).toEqual([
      'general',
      ...movable,
    ]);
  });

  it.each([
    ['a missing category', movable.slice(1)],
    ['a duplicate', [...movable.slice(1), movable[1]]],
    ['an unknown category', [...movable.slice(1), 'nope']],
    ['General', [...movable.slice(1), 'general']],
    ['a non-array', 'hr'],
    ['a non-string', [...movable.slice(1), 1]],
  ])('rejects a list with %s', async (_name, values) => {
    const { status, body } = await call(handlers.reorder, { body: { values } });
    expect(status).toBe(400);
    expect(body).toEqual({ code: 'invalid_request' });
  });
});

describe('remove', () => {
  it('deletes an empty custom category', async () => {
    await call(handlers.create, { body: { label: 'Altitude' } });

    const { status } = await call(handlers.remove, { params: { value: 'altitude' } });

    expect(status).toBe(204);
    expect(await stored('altitude')).toBeNull();
  });

  it('refuses a category that still has agents', async () => {
    await call(handlers.create, { body: { label: 'Altitude' } });
    await addAgentIn('altitude');

    const { status, body } = await call(handlers.remove, { params: { value: 'altitude' } });

    expect(status).toBe(409);
    expect(body).toEqual({ code: 'category_in_use' });
    expect(await stored('altitude')).not.toBeNull();
  });

  it('refuses a built-in, even once renamed', async () => {
    await call(handlers.update, { params: { value: 'finance' }, body: { label: 'Money' } });

    const { status, body } = await call(handlers.remove, { params: { value: 'finance' } });

    expect(status).toBe(400);
    expect(body).toEqual({ code: 'category_protected' });
  });

  it('returns 404 for an unknown category', async () => {
    const { status } = await call(handlers.remove, { params: { value: 'nope' } });
    expect(status).toBe(404);
  });
});

describe('list', () => {
  it('includes hidden categories, agent counts and the built-in flag', async () => {
    await call(handlers.create, { body: { label: 'Altitude' } });
    await addAgentIn('altitude');
    await call(handlers.update, { params: { value: 'hr' }, body: { isActive: false } });

    const { status, body } = await call(handlers.list);
    const categories = body as Array<Record<string, unknown>>;

    expect(status).toBe(200);
    expect(categories.find((category) => category.value === 'altitude')).toMatchObject({
      count: 1,
      builtIn: false,
      isActive: true,
    });
    expect(categories.find((category) => category.value === 'hr')).toMatchObject({
      count: 0,
      builtIn: true,
      isActive: false,
    });
  });
});

describe('access', () => {
  const groupOf = () =>
    mongoose.models.Group.create({ name: 'Altitude team', source: 'local', memberIds: ['a', 'b'] });
  const userOf = () =>
    mongoose.models.User.create({
      name: 'Sam',
      email: 'sam@example.com',
      username: 'sam',
      provider: 'local',
    });

  beforeEach(async () => {
    await Promise.all([
      mongoose.models.User.deleteMany({}),
      mongoose.models.Group.deleteMany({}),
      mongoose.models.Role.deleteMany({}),
      mongoose.models.AccessRole.deleteMany({}),
      mongoose.models.AclEntry.deleteMany({}),
    ]);
    await mongoose.models.AccessRole.create({
      accessRoleId: 'agent_viewer',
      name: 'viewer',
      resourceType: 'agent',
      permBits: 1,
    });
    await mongoose.models.Role.create({ name: 'ALTITUDE' });
    await call(handlers.create, { body: { label: 'Altitude' } });
  });

  it('stores users, groups and roles and returns them with their names', async () => {
    const user = await userOf();
    const group = await groupOf();
    await addAgentIn('altitude');

    const { status, body } = await call(handlers.setAccess, {
      params: { value: 'altitude' },
      body: {
        principals: [
          { type: 'user', id: user._id.toString() },
          { type: 'group', id: group._id.toString() },
          { type: 'role', id: 'ALTITUDE' },
        ],
      },
      user: { id: new mongoose.Types.ObjectId().toString() },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      agentCount: 1,
      publicAgentCount: 0,
      principals: [
        { type: 'user', id: user._id.toString(), name: 'Sam', email: 'sam@example.com' },
        { type: 'group', id: group._id.toString(), name: 'Altitude team', memberCount: 2 },
        { type: 'role', id: 'ALTITUDE', name: 'ALTITUDE' },
      ],
    });
    expect(await mongoose.models.AclEntry.countDocuments({ resourceType: 'agent' })).toBe(3);

    const listed = await call(handlers.list);
    expect(
      (listed.body as Array<{ value: string; accessCount: number }>).find(
        (category) => category.value === 'altitude',
      )?.accessCount,
    ).toBe(3);
  });

  it('drops a deleted group from what it returns', async () => {
    const group = await groupOf();
    await call(handlers.setAccess, {
      params: { value: 'altitude' },
      body: { principals: [{ type: 'group', id: group._id.toString() }] },
    });
    await mongoose.models.Group.deleteOne({ _id: group._id });

    const { body } = await call(handlers.getAccess, { params: { value: 'altitude' } });

    expect(body).toMatchObject({ principals: [] });
  });

  it.each([
    ['not a list', 'everyone'],
    ['a public principal', [{ type: 'public', id: 'x' }]],
    ['a malformed user id', [{ type: 'user', id: 'not-an-id' }]],
    ['an operator as an id', [{ type: 'user', id: { $ne: null } }]],
    ['a missing id', [{ type: 'role' }]],
    ['too many entries', Array.from({ length: 101 }, (_, i) => ({ type: 'role', id: `r${i}` }))],
    ['a user who does not exist', [{ type: 'user', id: new mongoose.Types.ObjectId().toString() }]],
    [
      'a group that does not exist',
      [{ type: 'group', id: new mongoose.Types.ObjectId().toString() }],
    ],
    ['a role that does not exist', [{ type: 'role', id: 'NOPE' }]],
  ])('rejects %s', async (_name, principals) => {
    const { status, body } = await call(handlers.setAccess, {
      params: { value: 'altitude' },
      body: { principals },
    });

    expect(status).toBe(400);
    expect(body).toEqual({ code: 'invalid_principal' });
    expect((await stored('altitude'))?.access ?? []).toHaveLength(0);
  });

  it('keeps General open to everyone', async () => {
    const { status, body } = await call(handlers.setAccess, {
      params: { value: 'general' },
      body: { principals: [{ type: 'role', id: 'ALTITUDE' }] },
    });

    expect(status).toBe(400);
    expect(body).toEqual({ code: 'category_protected' });
  });

  it('returns 404 for an unknown category', async () => {
    const set = await call(handlers.setAccess, {
      params: { value: 'nope' },
      body: { principals: [] },
    });
    const get = await call(handlers.getAccess, { params: { value: 'nope' } });

    expect(set.status).toBe(404);
    expect(get.status).toBe(404);
  });

  it('reports public agents and makes them private', async () => {
    await addAgentIn('altitude');
    const agent = await mongoose.models.Agent.findOne({ category: 'altitude' });
    const viewer = await mongoose.models.AccessRole.findOne({ accessRoleId: 'agent_viewer' });
    await mongoose.models.AclEntry.create({
      principalType: 'public',
      resourceType: 'agent',
      resourceId: agent._id,
      permBits: 1,
      roleId: viewer._id,
    });

    const before = await call(handlers.getAccess, { params: { value: 'altitude' } });
    expect(before.body).toMatchObject({ publicAgentCount: 1 });

    const after = await call(handlers.makePrivate, { params: { value: 'altitude' } });
    expect(after.body).toMatchObject({ publicAgentCount: 0 });
  });
});

describe('failures', () => {
  it('returns a safe code and no details when the database fails', async () => {
    const failing = createAgentCategoryHandlers({
      ...(methods as unknown as AgentCategoryHandlerDeps),
      getCategoriesWithCounts: () => Promise.reject(new Error('secret connection string')),
    });

    const { status, body } = await call(failing.list);

    expect(status).toBe(500);
    expect(body).toEqual({ code: 'internal_error' });
  });

  it('maps a duplicate created in a race to category_exists', async () => {
    const racing = createAgentCategoryHandlers({
      ...(methods as unknown as AgentCategoryHandlerDeps),
      createCategory: () => Promise.reject(Object.assign(new Error('dup'), { code: 11000 })),
    });

    const { status, body } = await call(racing.create, { body: { label: 'Altitude' } });

    expect(status).toBe(409);
    expect(body).toEqual({ code: 'category_exists' });
  });
});
