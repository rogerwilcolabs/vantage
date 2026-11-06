const express = require('express');
const request = require('supertest');

const mockHandler = (name) => jest.fn((_req, res) => res.status(200).json({ handler: name }));

const mockCategories = {
  list: mockHandler('list'),
  create: mockHandler('create'),
  update: mockHandler('update'),
  reorder: mockHandler('reorder'),
  remove: mockHandler('remove'),
  getAccess: mockHandler('getAccess'),
  setAccess: mockHandler('setAccess'),
  makePrivate: mockHandler('makePrivate'),
};

jest.mock('@librechat/api', () => ({
  generateCheckAccess: jest.fn(() => (_req, _res, next) => next()),
  createAgentCategoryHandlers: jest.fn(() => mockCategories),
}));

jest.mock('~/server/middleware', () => ({
  configMiddleware: (_req, _res, next) => next(),
  canAccessAgentResource: jest.fn(() => (_req, _res, next) => next()),
}));

jest.mock(
  '~/server/controllers/agents/v1',
  () =>
    new Proxy(
      {},
      {
        get: (_target, name) => (_req, res) => res.status(200).json({ handler: String(name) }),
      },
    ),
);

jest.mock('~/models', () => ({
  getRoleByName: jest.fn(),
  createCategory: jest.fn(),
  updateCategory: jest.fn(),
  deleteCategory: jest.fn(),
  getCategoriesWithCounts: jest.fn(),
  getDefaultCategoryValues: jest.fn(),
  getCategoryAccess: jest.fn(),
  setCategoryAccess: jest.fn(),
  makeCategoryAgentsPrivate: jest.fn(),
  findUsers: jest.fn(),
  findGroupById: jest.fn(),
}));

jest.mock('../actions', () => require('express').Router());
jest.mock('../tools', () => require('express').Router());

const { v1 } = require('../v1');

function createApp(role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', role };
    next();
  });
  app.use('/api/agents', v1);
  return app;
}

const managementRoutes = [
  ['get', '/api/agents/categories/manage', 'list'],
  ['post', '/api/agents/categories', 'create'],
  ['put', '/api/agents/categories/order', 'reorder'],
  ['patch', '/api/agents/categories/altitude', 'update'],
  ['delete', '/api/agents/categories/altitude', 'remove'],
  ['get', '/api/agents/categories/altitude/access', 'getAccess'],
  ['put', '/api/agents/categories/altitude/access', 'setAccess'],
  ['post', '/api/agents/categories/altitude/access/private', 'makePrivate'],
];

describe('agent category routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(managementRoutes)('%s %s refuses a non-admin', async (method, path, handler) => {
    const response = await request(createApp('USER'))[method](path).send({});

    expect(response.status).toBe(403);
    expect(mockCategories[handler]).not.toHaveBeenCalled();
  });

  it.each(managementRoutes)(
    '%s %s reaches its handler for an admin',
    async (method, path, handler) => {
      const response = await request(createApp('ADMIN'))[method](path).send({});

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ handler });
    },
  );

  it('keeps the read-only category list open to every user', async () => {
    const response = await request(createApp('USER')).get('/api/agents/categories');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ handler: 'getAgentCategories' });
  });
});
