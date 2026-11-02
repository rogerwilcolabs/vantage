import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Runs the server over stdio, as LibreChat does, against the live Canal Walk feeds and map.
// Usage: node test.js (MALL defaults to canal-walk here; the checks below are Canal Walk's)

const connect = async (env = {}) => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['index.js'],
    cwd: import.meta.dirname,
    env: { ...process.env, MALL: process.env.MALL || 'canal-walk', ...env },
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
};
const client = await connect();

const call = async (name, args = {}, on = client) => {
  const started = performance.now();
  const result = await on.callTool({ name, arguments: args });
  const ms = performance.now() - started;
  const text = result.content[0].text;
  assert.ok(!result.isError, `${name} failed: ${text}`);
  console.log(
    `${name} ${JSON.stringify(args)}: ${text.length} chars (~${Math.round(text.length / 3.5)} tokens), ${ms.toFixed(0)} ms`,
  );
  return JSON.parse(text);
};
const check = (label, fn) => {
  fn();
  console.log(`  ok - ${label}`);
};

const hasSearchKey = Boolean(process.env.GOOGLE_SERVICE_KEY_FILE);
const { tools } = await client.listTools();
check(
  hasSearchKey
    ? 'six tools, with web_search'
    : 'five tools (no GOOGLE_SERVICE_KEY_FILE, so no web_search)',
  () =>
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'get_category',
      'get_centre_info',
      'get_directions',
      'get_shop',
      'get_shop_links',
      ...(hasSearchKey ? ['web_search'] : []),
    ]),
);

if (hasSearchKey) {
  // One real Gemini + Google Search request; the second call must come from the cache.
  const search = await call('web_search', { query: 'How much is a milkshake at RocoMamas?' });
  check('web search answers with sources', () =>
    assert.ok(search.answer.length > 20 && search.sources?.length),
  );
  const started = performance.now();
  await call('web_search', { query: 'How much is a milkshake at RocoMamas?' });
  check('repeat question is served from the cache', () =>
    assert.ok(performance.now() - started < 100),
  );
}

const halaal = await call('get_category', { category: 'halaal' });
check("Halaal is found one level down, with the website's count and page", () => {
  assert.equal(halaal.category, 'Halaal Options');
  assert.equal(halaal.total, 47);
  assert.equal(halaal.shops.length, 47);
  assert.equal(halaal.page, 'https://canalwalk.co.za/shops/halaal-options');
});

const banks = await call('get_category', { category: 'banks' });
check('partial category name', () => assert.equal(banks.category, 'Banks and Forex'));

const fashion = await call('get_category', { category: 'fashion' });
check('broad word prefers the top-level category', () => {
  assert.equal(fashion.category, 'Fashion and Footwear');
  assert.equal(fashion.total, 111);
});

const footwear = await call('get_category', { category: 'footwear stores' });
check('category without a page links to /shops', () =>
  assert.equal(footwear.page, 'https://canalwalk.co.za/shops'),
);

const sports = await call('get_category', { category: 'sport' });
check('feed slug that is wrong on the website uses the checked page', () =>
  assert.equal(sports.page, 'https://canalwalk.co.za/shops/sports-and-fitness'),
);

const miss = await call('get_category', { category: 'pharmacy' });
check('a miss returns category names only, not the full list with pages', () => {
  assert.equal(miss.found, false);
  assert.ok(miss.categories.length > 30 && miss.categories.every((c) => typeof c === 'string'));
});

const named = await call('get_category', { category: 'chem' });
check('a miss also returns shops with the word in their name', () =>
  assert.ok(named.shops.some((s) => /dis-chem/i.test(s.name))),
);

const all = await call('get_category');
check('category list', () =>
  assert.ok(all.categories.length >= 15 && all.categories.every((c) => c.count > 0)),
);
check('category list carries the total number of open shops', () =>
  assert.ok(all.total_shops > 300 && all.all_shops_page === 'https://canalwalk.co.za/shops'),
);

const found = await call('get_shop', {
  names: ['Woolworths', 'Paul', 'Vida E Café', 'Dischem', 'Absa', 'Ocean Basket', 'Kids Emporium'],
});
const byQuery = Object.fromEntries(found.results.map((r) => [r.query, r]));
check('multi-listing brand returns every listing', () =>
  assert.ok(byQuery.Woolworths.shops.length >= 2),
);
check('short name finds the longer listing', () =>
  assert.match(byQuery.Paul.shops[0].name, /^PAUL/i),
);
check('accent and spelling differences', () =>
  assert.match(byQuery['Vida E Café'].shops[0].name, /vida e caff/i),
);
check('name without its hyphen', () => assert.match(byQuery.Dischem.shops[0].name, /dis-chem/i));
check('hours that vary by day are listed per day', () =>
  assert.match(byQuery.Absa.shops[0].hours, /^Mon-Fri 09:00 - 16:00/),
);
check('refurbishment status and no hours', () => {
  assert.equal(byQuery['Ocean Basket'].shops[0].status, 'closed for refurbishment');
  assert.equal(byQuery['Ocean Basket'].shops[0].hours, undefined);
});
check('removed shop is not found', () => assert.equal(byQuery['Kids Emporium'].found, false));
check('phone numbers get tel: links', () =>
  assert.ok(
    found.results
      .flatMap((r) => r.shops ?? [])
      .some((s) => s.phone_links?.[0]?.link.startsWith('tel:+27')),
  ),
);

const office = await call('get_shop', { names: ['Centre Management'] });
check('Centre Management listing defers its contact details to get_centre_info', () => {
  const listing = office.results[0].shops[0];
  assert.equal(listing.email, undefined);
  assert.equal(listing.phone_links, undefined);
  assert.match(listing.contact_note, /get_centre_info/);
});

const links = await call('get_shop_links', { names: ['Clicks'] });
check('shop page from the slug', () =>
  assert.equal(links.results[0].shops[0].url, 'https://canalwalk.co.za/shop/clicks'),
);

const everyLink = await call('get_shop_links');
check('every open shop', () => assert.ok(everyLink.total > 300));

const centre = await call('get_centre_info');
check('centre hours as the website shows them', () => assert.equal(centre.hours, '09:00 - 21:00'));
check('directions link', () =>
  assert.match(centre.directions, /^https:\/\/www\.google\.com\/maps\//),
);
check('security contact with a tel: link', () =>
  assert.ok(
    centre.contacts.some(
      (c) => c.department === 'Security' && c.phone_links?.[0]?.link.startsWith('tel:'),
    ),
  ),
);

// Directions, from the live Mappedin map the website uses.
const route = await call('get_directions', { from: 'Woolworths Café', to: 'Miladys' });
console.log(route.steps.map((s, i) => `    ${i + 1}. ${s}`).join('\n'));
check('route on one floor, merged the way the website shows it', () => {
  assert.equal(route.from.floor, 'Lower Level');
  assert.equal(route.to.floor, 'Lower Level');
  assert.match(
    route.steps[0],
    /^Leave Woolworths Café and walk \d+ m \((about \d+ minutes?|less than a minute)\)$/,
  );
  assert.equal(route.steps.at(-1), 'Arrive at Miladys');
  assert.ok(route.steps.length >= 3 && route.steps.length <= 6, `${route.steps.length} steps`);
  assert.equal(route.walking_time, 'about 4 minutes');
});
check('map link opens the website map with the route and its steps', () =>
  assert.equal(
    route.map_link,
    'https://canalwalk.co.za/mall-map#/directions?to=miladys&from=woolworths-cafe&textDirectionsVisible=true',
  ),
);

const upstairs = await call('get_directions', { from: 'Woolworths Café', to: 'Ackermans' });
console.log(upstairs.steps.map((s, i) => `    ${i + 1}. ${s}`).join('\n'));
check('route to another floor takes the escalator', () => {
  assert.equal(upstairs.to.floor, 'Upper Level');
  assert.ok(upstairs.steps.some((s) => /^Take the escalator up to the Upper Level/.test(s)));
});

const accessible = await call('get_directions', {
  from: 'Woolworths Café',
  to: 'Ackermans',
  accessible: true,
});
console.log(accessible.steps.map((s, i) => `    ${i + 1}. ${s}`).join('\n'));
check('accessible route avoids escalators and stairs', () => {
  assert.equal(accessible.accessible, true);
  assert.ok(!accessible.steps.some((s) => /escalator|stairs/.test(s)));
  assert.ok(accessible.steps.some((s) => /^Take the (lift|ramp)/.test(s)));
});

const toilets = await call('get_directions', { from: 'Miladys', to: 'bathroom' });
check('places that are not shops, by another name, with their map id in the link', () => {
  assert.equal(toilets.to.name, 'Toilets');
  assert.match(toilets.map_link, /to=LOC-[A-Z0-9]+&from=miladys/);
});

const entrance = await call('get_directions', { from: 'entrance', to: 'Miladys' });
check('"entrance" starts from the nearest entrance', () =>
  assert.match(entrance.from.name, /^Entrance \d+/),
);

const unknown = await call('get_directions', { from: 'Kids Emporium', to: 'Miladys' });
check('a place that is not at the centre is not found', () => {
  assert.equal(unknown.from.found, false);
  assert.equal(unknown.steps, undefined);
});

await client.close();

// A key Mappedin rejects (as when Hyprop changes it): the answer falls back to floors and the map link, and the
// cause is logged to stderr.
const badKey = await connect({ MAPPEDIN_SECRET: 'not-the-secret' });
const fallback = await call('get_directions', { from: 'Woolworths Café', to: 'Miladys' }, badKey);
check('rejected key: floors and the map link, no steps, nothing about the error', () => {
  assert.equal(fallback.steps_available, false);
  assert.equal(fallback.steps, undefined);
  assert.equal(fallback.from.floor, 'Lower Level');
  assert.equal(fallback.map_link, route.map_link);
  assert.doesNotMatch(JSON.stringify(fallback), /401|unauthori|secret|error/i);
});
await badKey.close();

console.log('\nAll checks passed.');
