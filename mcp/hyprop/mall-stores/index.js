import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMallData, loadMall } from './shops.js';
import { createWebSearch } from './websearch.js';

// One server per mall: set MALL to a key in malls.json (e.g. canal-walk) in librechat.yaml.
const mall = loadMall(process.env.MALL);
const data = createMallData(mall);
// Only offered when GOOGLE_SERVICE_KEY_FILE is passed in.
const webSearch = createWebSearch(mall);

const shopNames = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Shop names, as many as you need in one call (up to 20). Partial names and small spelling differences are fine.',
};

const tools = [
  {
    name: 'get_shop',
    description:
      `Look up shops at ${mall.name} by name. Returns each shop's page link, floor, trading hours, ` +
      'open or closed status right now, phone numbers with tel: links, email with a mailto: link, and categories. ' +
      'Brands with several stores in the centre return every listing. found: false means the shop is not at the centre.',
    inputSchema: { type: 'object', properties: { names: shopNames }, required: ['names'] },
    run: (args) => data.getShops(args.names),
  },
  {
    name: 'get_shop_links',
    description:
      `Get the page link for shops at ${mall.name}, to link shop names in an answer. ` +
      "Pass the shops you plan to mention. With no names it returns every shop's name and link, which is large.",
    inputSchema: { type: 'object', properties: { names: shopNames } },
    run: (args) => data.getShopLinks(args.names),
  },
  {
    name: 'get_category',
    description:
      `With no category, gives the total number of shops at ${mall.name} and lists every shop category with its number of shops and its page on the website. ` +
      'With a category, returns its total number of shops, its page, and every shop in it with its link and floor.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'A category name or part of one. Leave out to list all categories.',
        },
      },
    },
    run: (args) => data.getCategory(args.category),
  },
  {
    name: 'get_centre_info',
    description:
      `${mall.name}'s own trading hours, information desk and management office hours, the Google Maps directions link, ` +
      "the website, and phone numbers and email addresses for the centre's departments, such as security and centre management.",
    inputSchema: { type: 'object', properties: {} },
    run: () => data.getCentreInfo(),
  },
  webSearch && {
    name: 'web_search',
    description:
      `Search the web for what the other tools do not cover at ${mall.name}: menu items and prices, product prices, ` +
      'events and promotions, special or public holiday trading hours, parking rates, centre facilities, and what a shop sells. ' +
      'Returns a short answer and its sources. Not for shop lists, floors, trading hours, links or contact details; the other tools have those.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to find, as a short question.' } },
      required: ['query'],
    },
    run: (args) => webSearch(args.query),
  },
].filter(Boolean);

const server = new Server(
  { name: 'hyprop-mall-stores', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find((t) => t.name === request.params.name);
  if (!tool) throw new Error(`Tool not found: ${request.params.name}`);
  try {
    const result = await tool.run(request.params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Could not load ${mall.name} data: ${error.message}` }],
      isError: true,
    };
  }
});

// Load both feeds at startup so the first question does not wait for them.
data.warm();
await server.connect(new StdioServerTransport());
