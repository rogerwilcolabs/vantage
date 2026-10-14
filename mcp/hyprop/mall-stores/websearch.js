import { readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';

// Web lookups for what the shop tools do not cover (prices, menus, events, special hours), through Gemini with
// Google Search grounding. Each lookup is its own request with Search and no function tools, and is not streamed:
// Vertex hung on streamed requests that combined function tools with Search, so the agent itself
// runs without grounding and calls this tool instead.

const MODEL = process.env.WEB_SEARCH_MODEL || 'gemini-3.5-flash';
const LOCATION = process.env.WEB_SEARCH_LOCATION || 'global';
const THINKING = process.env.WEB_SEARCH_THINKING || 'MINIMAL';
// The shopper is waiting on the whole answer; past this, the agent answers without the web.
const TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS) || 12_000;
const CACHE_MS = 6 * 60 * 60 * 1000;
const CACHE_SIZE = 200;

/** The service account in GOOGLE_SERVICE_KEY_FILE, as inline JSON or a file path; null when unset. */
function loadCredentials() {
  const raw = process.env.GOOGLE_SERVICE_KEY_FILE?.trim();
  // librechat.yaml passes "${GOOGLE_SERVICE_KEY_FILE}" through unchanged when the variable is not set.
  if (!raw || raw.startsWith('${')) return null;
  return JSON.parse(raw.startsWith('{') ? raw : readFileSync(raw, 'utf8'));
}

/** Returns the web_search function, or null when no service account is configured. */
export function createWebSearch(mall) {
  const credentials = loadCredentials();
  if (!credentials) return null;

  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const host =
    LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${LOCATION}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${credentials.project_id}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const system =
    `You find facts on the web for the digital assistant of ${mall.name} shopping centre (${mall.site}) in South Africa. ` +
    `Look for the answer at ${mall.name} specifically, or the brand's South African details when the centre has none. ` +
    'Reply in at most four short bullet points of plain facts, with prices in Rand and times in 24-hour format. ' +
    'Say when a price or detail comes from a menu or page that may be out of date. If you cannot find it, say so. Never guess.';
  const cache = new Map();

  return async function webSearch(query) {
    const question = String(query ?? '').trim();
    if (!question) throw new Error('query is required');
    const key = question.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

    const { token } = await (await auth.getClient()).getAccessToken();
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: question }] }],
          tools: [{ googleSearch: {} }],
          ...(/gemini-([3-9]|\d{2,})/.test(MODEL) && {
            generationConfig: { thinkingConfig: { thinkingLevel: THINKING } },
          }),
        }),
      });
    } catch (err) {
      if (err.name !== 'TimeoutError') throw err;
      return {
        query: question,
        found: false,
        note: 'The web search took too long. Say you could not find this right now.',
      };
    }
    const body = await res.json();
    if (!res.ok) throw new Error(`web search failed: ${body.error?.message ?? res.status}`);

    const candidate = body.candidates?.[0];
    const answer = (candidate?.content?.parts ?? [])
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim();
    // Source titles are site names; the grounding URLs are long Google redirect links, not worth showing.
    const sources = [
      ...new Set(
        (candidate?.groundingMetadata?.groundingChunks ?? [])
          .map((c) => c.web?.title)
          .filter(Boolean),
      ),
    ];
    const result = {
      query: question,
      answer: answer || 'Nothing found.',
      sources: sources.length ? sources : undefined,
    };
    cache.set(key, { at: Date.now(), result });
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return result;
  };
}
