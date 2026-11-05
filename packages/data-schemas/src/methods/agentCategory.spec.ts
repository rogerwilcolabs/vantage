import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IAgentCategory } from '..';
import { createAgentCategoryMethods } from './agentCategory';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let AgentCategory: mongoose.Model<IAgentCategory>;
let methods: ReturnType<typeof createAgentCategoryMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  AgentCategory = mongoose.models.AgentCategory as mongoose.Model<IAgentCategory>;
  methods = createAgentCategoryMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await AgentCategory.deleteMany({});
});

describe('getCategoriesWithCounts', () => {
  beforeEach(async () => {
    await AgentCategory.create([
      { value: 'shown', label: 'Shown', order: 1, isActive: true },
      { value: 'hidden', label: 'Hidden', order: 2, isActive: false },
    ]);
  });

  it('leaves hidden categories out by default', async () => {
    const categories = await methods.getCategoriesWithCounts();
    expect(categories.map((category) => category.value)).toEqual(['shown']);
  });

  it('returns hidden categories with includeInactive', async () => {
    const categories = await methods.getCategoriesWithCounts({ includeInactive: true });
    expect(categories.map((category) => category.value)).toEqual(['shown', 'hidden']);
  });
});

describe('ensureDefaultCategories', () => {
  it('creates every default category', async () => {
    await methods.ensureDefaultCategories();
    const categories = await methods.getAllCategories();
    expect(categories.map((category) => category.value).sort()).toEqual(
      methods.getDefaultCategoryValues().sort(),
    );
  });

  it('keeps a renamed built-in marked custom across restarts', async () => {
    await methods.ensureDefaultCategories();
    await methods.updateCategory('finance', { label: 'Money', custom: true });

    await methods.ensureDefaultCategories();

    const finance = await methods.findCategoryByValue('finance');
    expect(finance?.label).toBe('Money');
  });

  it('keeps a hidden built-in hidden across restarts', async () => {
    await methods.ensureDefaultCategories();
    await methods.updateCategory('sales', { isActive: false });

    await methods.ensureDefaultCategories();

    const sales = await methods.findCategoryByValue('sales');
    expect(sales?.isActive).toBe(false);
  });
});
