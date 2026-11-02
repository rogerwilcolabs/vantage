# Hyprop mall stores MCP

Shop and centre data for one Hyprop mall, trimmed from Hyprop's public feeds so the agent gets only what it needs:

| Tool | Returns | Typical size (Canal Walk) |
|---|---|---|
| `get_shop` | link, floor, hours, open/closed status, phones (`tel:`), email (`mailto:`), categories for named shops | ~100 tokens per shop |
| `get_shop_links` | name and page link for named shops, or for every shop | ~30 tokens per shop, ~7.9k for all |
| `get_category` | every category with counts and pages, or one category's total, page and shops | 0.2k (Banks) to 3.1k (Fashion) |
| `get_centre_info` | centre hours, directions link, department phone numbers and email | ~0.7k |
| `get_directions` | walking steps between two places (shops, entrances, toilets, parking…), walking time, floors, and a mall-map link with the route drawn | ~0.15-0.25k, a few ms |
| `web_search` | a short answer and source sites, from Gemini with Google Search, for prices, menus, events, special hours | ~0.1k, ~4-10s (6h cache) |

`web_search` exists because the agent itself runs without Google Search grounding. Vertex hung on streamed
requests that combined function tools with Search. This tool's request has Search but no function tools and is not
streamed. It is only offered when `GOOGLE_SERVICE_KEY_FILE` (inline JSON or a path) is passed in;
`WEB_SEARCH_MODEL` (default `gemini-3.5-flash`), `WEB_SEARCH_THINKING` (default `MINIMAL`),
`WEB_SEARCH_TIMEOUT_MS` (default `12000`; past it the agent answers without the web) and `WEB_SEARCH_LOCATION`
(default `global`) are optional.

Both feeds are cached in memory for 12 hours (`CACHE_HOURS` to change). After that, callers get the old copy while it
refreshes in the background, and a failed refresh keeps the last good copy and retries after 5 minutes.

Sources: `https://cdn.hyprop.co.za/storeLists/<mall id>.json` and `https://api.hyprop.co.za/public/mall/<mall id>`.

## Directions

`get_directions` routes on the centre's Mappedin map: the map, key and routing the website's mall-map page uses,
through the Mappedin SDK (`@mappedin/mappedin-js`, pinned) without drawing anything. The key and venue come from the
mall API's `general.mapsConfig`, so a key Hyprop changes there is picked up at the next refresh. `MAPPEDIN_KEY`,
`MAPPEDIN_SECRET` and `MAPPEDIN_VENUE` override them, for a key of ECHO's own. Shops' ids on the map are their slugs
in the store list, which is how the map link (`/mall-map#/directions?to=…&from=…`) finds them.

The map (a 0.8 MB download) loads at startup in 2-3s, after which the server uses about 200 MB of memory, and
refreshes like the feeds. Routing then needs no network, so a failed refresh keeps the last map. Without a map
(Mappedin rejects the key, is down, or is still loading after 8s), the tool answers with each place's floor and the
map link, `steps_available: false`, and nothing about the error. A failed load is retried after 5 minutes.

Each failed load, and each question answered without steps, is logged to stderr (Vantage's own logs) as
`[mall-stores] directions: …` with its cause: `MAPPEDIN_AUTH` (401/403: the key changed or was revoked),
`MAPPEDIN_NOT_FOUND`, `MAPPEDIN_RATE_LIMITED`, `MAPPEDIN_UNAVAILABLE` (5xx), `MAPPEDIN_HTTP`, `MAPPEDIN_UNREACHABLE`,
`MAPPEDIN_TIMEOUT`, `MAPPEDIN_LOADING`, `MAPPEDIN_DATA`, `NO_ROUTE`, `NOT_ON_MAP`, `MALL_API_FAILED`,
`MAP_CONFIG_MISSING` or `SDK_LOAD_FAILED`.

## Configuration

One server per mall. `MALL` is a key in `malls.json`, which holds each mall's ID, domain and category-page map.
Only Canal Walk's category pages have been checked in a browser; other malls link categories to `/shops` until theirs
are added.

```yaml
mcpServers:
  canal_walk_stores:
    command: node
    args:
      - /mcp/hyprop/mall-stores/index.js
    env:
      MALL: canal-walk
      GOOGLE_SERVICE_KEY_FILE: "${GOOGLE_SERVICE_KEY_FILE}"
```

Only the variables listed under `env` reach the server, as LibreChat starts it with a minimal environment: to use
`MAPPEDIN_KEY` and `MAPPEDIN_SECRET`, list them there too.

`node_modules` is not committed, and `mcp/` is mounted into the container, so run `npm ci` in this folder wherever it runs.

## Test

`npm test` runs the server over stdio against the live Canal Walk feeds and map and checks each tool. With
`GOOGLE_SERVICE_KEY_FILE` set in the shell it also makes one real `web_search` request. The directions checks end
with a wrong `MAPPEDIN_SECRET`, to check the fallback answer.
