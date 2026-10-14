# Hyprop mall stores MCP

Shop and centre data for one Hyprop mall, trimmed from Hyprop's public feeds so the agent gets only what it needs:

| Tool | Returns | Typical size (Canal Walk) |
|---|---|---|
| `get_shop` | link, floor, hours, open/closed status, phones (`tel:`), email (`mailto:`), categories for named shops | ~100 tokens per shop |
| `get_shop_links` | name and page link for named shops, or for every shop | ~30 tokens per shop, ~7.9k for all |
| `get_category` | every category with counts and pages, or one category's total, page and shops | 0.2k (Banks) to 3.1k (Fashion) |
| `get_centre_info` | centre hours, directions link, department phone numbers and email | ~0.7k |
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

`node_modules` is not committed, and `mcp/` is mounted into the container, so run `npm ci` in this folder wherever it runs.

## Test

`npm test` runs the server over stdio against the live Canal Walk feeds and checks each tool. With
`GOOGLE_SERVICE_KEY_FILE` set in the shell it also makes one real `web_search` request.
