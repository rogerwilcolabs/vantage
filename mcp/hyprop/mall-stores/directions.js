import { fetchJson, normName } from './shops.js';

// Walking directions inside the centre, from its Mappedin map: the same map, key and routing as the website's
// mall-map page (mappedin-web.js), run here without drawing anything. The key and venue come from Hyprop's mall API
// (general.mapsConfig), so a key Hyprop changes there is picked up at the next refresh; MAPPEDIN_KEY,
// MAPPEDIN_SECRET and MAPPEDIN_VENUE override them, for a key of ECHO's own.
//
// Once loaded, routing needs no network, so a failed refresh keeps the last map. Without any map, the tool still
// answers with each place's floor and the map link, and the cause goes to stderr (Vantage's logs).

const CACHE_MS = Number(process.env.CACHE_HOURS || 12) * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const LOAD_TIMEOUT_MS = 30_000; // a load normally takes 2-3s
const QUESTION_WAIT_MS = 8_000; // a question asked while the map loads waits this long, then gets the fallback
const WALKING_SPEED = 1.4; // m/s: the website shows 345 m as 4 minutes
const LANDMARK_M = 12; // a turn is named after a shop or court this close to it
const SHORT_LEG_M = 8; // two turns closer than this are one turn
const STRAIGHT_DEG = 25; // a turn that changes the heading less than this is going straight on

// stdout carries the MCP protocol, so logs go to stderr.
const log = (message) => console.error(`[mall-stores] directions: ${message}`);

const env = (name) => {
  const value = process.env[name]?.trim();
  // librechat.yaml passes "${NAME}" through unchanged when the variable is not set.
  return value && !value.startsWith('${') ? value : undefined;
};

class DirectionsError extends Error {
  constructor(code, message, { status } = {}) {
    super(message);
    Object.assign(this, { code, status });
  }
}

/**
 * Sorts a failure by its cause. When Mappedin answered, the SDK's error carries its HTTP status and reason, as in
 * "Get access token failed: 401 Unauthorized: {...}" or "404 Not Found".
 */
function classify(err) {
  if (err instanceof DirectionsError) return err;
  const message = String(err?.message ?? err);
  const status = Number(/\b([1-5]\d\d) [A-Z][a-z]/.exec(message)?.[1]) || undefined;
  if (status === 401 || status === 403)
    return new DirectionsError('MAPPEDIN_AUTH', message, { status });
  if (status === 404) return new DirectionsError('MAPPEDIN_NOT_FOUND', message, { status });
  if (status === 429) return new DirectionsError('MAPPEDIN_RATE_LIMITED', message, { status });
  if (status >= 500) return new DirectionsError('MAPPEDIN_UNAVAILABLE', message, { status });
  if (status) return new DirectionsError('MAPPEDIN_HTTP', message, { status });
  if (
    /failed to fetch|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(
      message,
    )
  ) {
    return new DirectionsError('MAPPEDIN_UNREACHABLE', message);
  }
  return new DirectionsError('MAPPEDIN_DATA', message);
}

const withTimeout = (promise, ms, makeError) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/** The map's key, secret and venue: the variables first, then the mall API that the website reads them from. */
async function mapsConfig(mall) {
  const key = env('MAPPEDIN_KEY');
  const secret = env('MAPPEDIN_SECRET');
  const venue = env('MAPPEDIN_VENUE');
  let general = {};
  if (!key || !secret || !venue) {
    try {
      general = (await fetchJson(`https://api.hyprop.co.za/public/mall/${mall.id}`)).general ?? {};
    } catch (err) {
      const status = Number(/HTTP (\d{3})/.exec(err.message)?.[1]) || undefined;
      throw new DirectionsError('MALL_API_FAILED', err.message, { status });
    }
  }
  const config = general.mapsConfig ?? {};
  const resolved = {
    key: key ?? config.miKey?.id,
    secret: secret ?? config.miKey?.key,
    venue: venue ?? config.venue,
    language: config.language || 'en',
  };
  if (!resolved.key || !resolved.secret || !resolved.venue) {
    throw new DirectionsError(
      'MAP_CONFIG_MISSING',
      `The mall API has no map key or venue (mapsEnabled: ${general.mapsEnabled})`,
    );
  }
  return resolved;
}

// Matching for places that are not shops: "toilets" and "toilet" both find Toilets.
const singular = (key) =>
  key
    .split(' ')
    .map((w) => (w.length > 3 ? w.replace(/s$/, '') : w))
    .join(' ');
const SYNONYMS = new Map([
  ['bathroom', 'toilet'],
  ['restroom', 'toilet'],
  ['washroom', 'toilet'],
  ['loo', 'toilet'],
  ['info desk', 'information desk'],
  ['help desk', 'information desk'],
  ['car park', 'parking'],
  ['parkade', 'parking'],
  ['cash machine', 'atm'],
]);

async function loadMap(mall) {
  const started = Date.now();
  const config = await mapsConfig(mall);
  let sdk;
  try {
    sdk = await import('@mappedin/mappedin-js');
  } catch (err) {
    throw new DirectionsError('SDK_LOAD_FAILED', err.message);
  }
  sdk.setLoggerLevel('warn');
  const mapData = await withTimeout(
    sdk.getMapData({
      key: config.key,
      secret: config.secret,
      mapId: config.venue,
      language: config.language,
      // Mappedin's map statistics are the website's; tokens are fetched again at each refresh.
      analytics: { sendEvents: false, logEvents: false },
      prefetchTokens: false,
    }),
    LOAD_TIMEOUT_MS,
    () => new DirectionsError('MAPPEDIN_TIMEOUT', `No map after ${LOAD_TIMEOUT_MS / 1000}s`),
  );

  const routable = mapData
    .getByType('enterprise-location')
    .filter((l) => !l.hidden && (l.spaces.length || l.nodes.length));
  const named = (l) => ({ key: singular(normName(l.name)), location: l });
  return {
    mapData,
    venue: config.venue,
    loadedAt: Date.now(),
    ms: Date.now() - started,
    // Shops' ids on the map are their slugs in Hyprop's feed.
    byExternalId: new Map(routable.map((l) => [l.externalId, l])),
    // Entrances, toilets, parking, the information desk, courts and so on.
    places: routable.filter((l) => l.type !== 'tenant').map(named),
    tenants: routable.filter((l) => l.type === 'tenant').map(named),
    landmarks: routable.filter((l) => l.type === 'tenant' || / court$/i.test(l.name)),
  };
}

/** Exact names first; otherwise every place whose name has each word ("entrance" finds them all, for the nearest). */
function findMapPlaces(query, places) {
  let q = singular(normName(query));
  q = SYNONYMS.get(q) ?? q;
  if (q.length < 2) return [];
  const exact = places.filter((p) => p.key === q);
  if (exact.length) return exact;
  const words = q.split(' ');
  return places
    .filter((p) => words.every((w) => p.key.split(' ').some((kw) => kw.startsWith(w))))
    .slice(0, 20);
}

const heading = (a, b) => {
  const rad = Math.PI / 180;
  const x = (b.longitude - a.longitude) * Math.cos(((a.latitude + b.latitude) / 2) * rad);
  return (Math.atan2(x, b.latitude - a.latitude) / rad + 360) % 360; // clockwise from north
};
const turnAngle = (from, to) => ((to - from + 540) % 360) - 180; // positive is a right turn

/**
 * The SDK's instructions, merged the way the website shows them: an instruction's distance is the walk that leads
 * up to it, so each step here carries the walk that follows it instead. A "turn" that leaves you heading the same
 * way (the path bending round a court) is going straight on, two turns a few metres apart are one, and getting off
 * an escalator or lift belongs with getting on.
 */
function simplify(instructions) {
  const steps = instructions.map((s, i) => {
    const prev = instructions[i - 1]?.coordinate;
    const next = instructions[i + 1]?.coordinate;
    const { type, bearing, connection, direction, toFloor } = s.action;
    return {
      type,
      bearing,
      coordinate: s.coordinate,
      connection: connection?.type,
      direction,
      toFloor: toFloor?.name,
      after: instructions[i + 1]?.distance ?? 0,
      angle:
        type === 'Turn' && prev && next
          ? turnAngle(heading(prev, s.coordinate), heading(s.coordinate, next))
          : undefined,
    };
  });
  const out = [];
  for (const step of steps) {
    const last = out.at(-1);
    if (
      step.type === 'Turn' &&
      (step.bearing === 'Straight' || Math.abs(step.angle ?? 90) < STRAIGHT_DEG)
    ) {
      step.type = 'Straight';
    }
    if (step.type === 'Straight' && last?.type === 'Straight') {
      last.after += step.after;
      continue;
    }
    if (step.type === 'Turn' && last?.type === 'Turn' && last.after < SHORT_LEG_M) {
      const net = (last.angle ?? 0) + (step.angle ?? 0);
      last.after += step.after;
      if (Math.abs(net) < STRAIGHT_DEG) last.type = 'Straight';
      else if (Math.sign(net) !== Math.sign(last.angle ?? net))
        last.bearing = net > 0 ? 'Right' : 'Left';
      last.angle = net;
      continue;
    }
    if (step.type === 'ExitConnection' && last?.type === 'TakeConnection') {
      last.after = step.after;
      last.exitBearing = step.bearing;
      continue;
    }
    out.push(step);
  }
  return out;
}

const BEARINGS = {
  Right: 'right',
  Left: 'left',
  SlightRight: 'slightly right',
  SlightLeft: 'slightly left',
};
const CONNECTIONS = { elevator: 'lift' }; // South African English; escalator, stairs and ramp read as they are
const metres = (m) => `${m < 20 ? Math.max(1, Math.round(m)) : Math.round(m / 5) * 5} m`;
const walkingTime = (m) => {
  const minutes = Math.round(m / WALKING_SPEED / 60);
  return minutes < 1 ? 'less than a minute' : `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
};
// Each stretch of walking also says how long it takes, as the website's steps do.
const leg = (m) => `${metres(m)} (${walkingTime(m)})`;
const walk = (m, joiner = ' and walk ') => (m >= 1 ? `${joiner}${leg(m)}` : '');

function stepText(step, landmark, from, to) {
  const turn = (bearing) =>
    bearing === 'Back' ? 'Turn around' : `Turn ${BEARINGS[bearing] ?? 'right'}`;
  const connection = CONNECTIONS[step.connection] ?? step.connection ?? 'stairs';
  switch (step.type) {
    case 'Departure':
      return `Leave ${from}${walk(step.after)}`;
    case 'Arrival':
      return `Arrive at ${to}`;
    case 'Straight':
      return `Continue straight${step.after >= 1 ? ` for ${leg(step.after)}` : ''}`;
    case 'TakeConnection': {
      const way = step.direction === 'up' || step.direction === 'down' ? ` ${step.direction}` : '';
      const exit = BEARINGS[step.exitBearing] ? `, turn ${BEARINGS[step.exitBearing]}` : '';
      return `Take the ${connection}${way} to the ${step.toFloor}${exit}${walk(step.after, exit ? ' and walk ' : ', then walk ')}`;
    }
    case 'ExitConnection':
      return `Get off the ${connection}${walk(step.after)}`;
    default:
      return `${turn(step.bearing)}${landmark ? ` at ${landmark}` : ''}${walk(step.after)}`;
  }
}

/** Returns get_directions' run function and a warm-up that loads the map when the server starts. */
export function createDirections(mall, data) {
  let map;
  let failure; // { error, at } of the last failed load
  let pending = null;

  /** One log line per failed map load, and per question answered without steps, with its cause. */
  const report = (error, question) => {
    const http = error.status ? `, HTTP ${error.status}` : '';
    const what = question
      ? `"${question.from}" -> "${question.to}" answered without steps (${error.code}${http})`
      : `map load failed (${error.code}${http}), ${map ? 'still using the previous map' : 'no map to use'}`;
    log(`${what}: ${error.message.slice(0, 300)}`);
  };

  const load = () => {
    pending ??= loadMap(mall)
      .then((loaded) => {
        map = loaded;
        failure = undefined;
        log(
          `map ${loaded.venue} loaded: ${loaded.byExternalId.size} places in ${(loaded.ms / 1000).toFixed(1)}s`,
        );
        return loaded;
      })
      .catch((err) => {
        const error = classify(err);
        failure = { error, at: Date.now() };
        report(error);
        throw error;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  /** The current map; a stale one is refreshed in the background, and a failed load is retried after RETRY_MS. */
  const currentMap = async () => {
    const now = Date.now();
    if ((!map || now - map.loadedAt > CACHE_MS) && (!failure || now - failure.at > RETRY_MS)) {
      load().catch(() => {});
    }
    if (map) return map;
    if (!pending) throw failure.error;
    return withTimeout(
      pending,
      QUESTION_WAIT_MS,
      () =>
        new DirectionsError(
          'MAPPEDIN_LOADING',
          `The map was still loading after ${QUESTION_WAIT_MS / 1000}s`,
        ),
    );
  };

  /** A place as shop listings from Hyprop's feed or as places on the map; `targets` are what can be routed. */
  async function resolve(query, current) {
    let listings = [];
    try {
      listings = await data.findShopListings(query);
    } catch (err) {
      log(`store list unavailable for "${query}": ${err.message}`);
    }
    if (listings.length) {
      const exact = listings.filter((s) => s.key === normName(query));
      const chosen = exact.length ? exact : listings;
      const targets = current
        ? chosen
            .filter((s) => current.byExternalId.has(s.slug))
            .map((s) => ({
              location: current.byExternalId.get(s.slug),
              name: s.name,
              url: s.url,
              slug: s.slug,
            }))
        : [];
      const [first] = chosen;
      return {
        found: true,
        name: first.name,
        url: first.url,
        floor: first.floor,
        slug: first.slug,
        targets,
      };
    }
    if (!current) return { found: true, name: query, targets: [] }; // not a shop, and no map to say what it is
    let hits = findMapPlaces(query, current.places);
    if (!hits.length) hits = findMapPlaces(query, current.tenants);
    if (!hits.length) return { found: false, query };
    const targets = hits.map(({ location }) => ({
      location,
      name: location.name,
      slug: location.externalId,
    }));
    return { found: true, name: targets[0].name, slug: targets[0].slug, targets };
  }

  /** The shortest route between any of the places' listings, e.g. the nearest of several entrances. */
  async function bestRoute(current, from, to, accessible) {
    let best;
    for (const a of from.targets.slice(0, 10)) {
      for (const b of to.targets.slice(0, 20)) {
        const directions = await current.mapData.getDirections(a.location, b.location, {
          accessible,
        });
        if (directions && (!best || directions.distance < best.directions.distance))
          best = { a, b, directions };
      }
    }
    return best;
  }

  async function landmarkNear(current, coordinate, exclude) {
    const near = await current.mapData.Query.nearest(coordinate, current.landmarks, {
      maxDistance: LANDMARK_M,
      maxResults: 3,
      limit: 'same-floor',
      mode: 'absolute-distance',
    });
    return near?.find((n) => !exclude.has(n.feature.id))?.feature.name;
  }

  const mapLink = (fromSlug, toSlug) => {
    const page = `${mall.site}/mall-map`;
    if (fromSlug && toSlug) {
      return `${page}#/directions?${new URLSearchParams({ to: toSlug, from: fromSlug, textDirectionsVisible: 'true' })}`;
    }
    // The website's "Get directions" link: the destination filled in, and the start left to choose.
    return toSlug
      ? `${page}#/directions?${new URLSearchParams({ to: toSlug, isEditing: 'true' })}`
      : page;
  };

  async function describe(current, { a, b, directions }, accessible) {
    const ins = directions.instructions;
    const floor = (coordinate) =>
      coordinate && current.mapData.getById('floor', coordinate.floorId)?.name;
    const place = (target, coordinate) => ({
      name: target.name,
      floor: floor(coordinate),
      url: target.url,
    });
    const result = {
      from: place(a, ins[0]?.coordinate),
      to: place(b, ins.at(-1)?.coordinate),
      accessible: accessible || undefined,
    };
    if (!directions.coordinates.length || directions.distance === 0) {
      return { ...result, note: 'Both are the same place.', map_link: mapLink(undefined, b.slug) };
    }
    const exclude = new Set([a.location.id, b.location.id]);
    const steps = [];
    let lastLandmark;
    for (const step of simplify(ins)) {
      let landmark;
      if (step.type === 'Turn') {
        landmark = await landmarkNear(current, step.coordinate, exclude);
        if (landmark === lastLandmark) landmark = undefined;
        else lastLandmark = landmark;
      }
      steps.push(stepText(step, landmark, a.name, b.name));
    }
    return {
      ...result,
      distance: metres(directions.distance),
      walking_time: walkingTime(directions.distance),
      steps,
      map_link: mapLink(a.slug, b.slug),
    };
  }

  const summary = (p) =>
    p.found ? { name: p.name, floor: p.floor, url: p.url } : { query: p.query, found: false };

  return {
    warm: () => load().catch(() => {}),

    async getDirections(args) {
      const fromQuery = String(args.from ?? '').trim();
      const toQuery = String(args.to ?? '').trim();
      const accessible = args.accessible === true;
      if (!fromQuery || !toQuery) {
        return {
          note: 'Both places are needed. Ask which shop or entrance they are starting from.',
        };
      }

      let current;
      let problem;
      try {
        current = await currentMap();
      } catch (err) {
        problem = classify(err);
      }

      const [from, to] = await Promise.all([
        resolve(fromQuery, current),
        resolve(toQuery, current),
      ]);
      if (!from.found || !to.found) {
        return {
          from: summary(from),
          to: summary(to),
          note: `No shop or place by this name at ${mall.name}.`,
        };
      }

      if (current && from.targets.length && to.targets.length) {
        try {
          const route = await bestRoute(current, from, to, accessible);
          if (route) return await describe(current, route, accessible);
          problem = new DirectionsError(
            'NO_ROUTE',
            `No route from ${from.name} to ${to.name}${accessible ? ' without stairs or escalators' : ''}`,
          );
        } catch (err) {
          problem = classify(err);
        }
      } else if (current) {
        const missing = [from, to].filter((p) => !p.targets.length).map((p) => p.name);
        problem = new DirectionsError(
          'NOT_ON_MAP',
          `${missing.join(' and ')} not found on the Mappedin map`,
        );
      }

      report(problem, { from: fromQuery, to: toQuery });
      return {
        from: summary(from),
        to: summary(to),
        steps_available: false,
        note: "Step-by-step directions are not available right now. Give each place's floor and the map link, which shows the route. Do not mention a problem.",
        map_link: mapLink(from.slug, to.slug),
      };
    },
  };
}
