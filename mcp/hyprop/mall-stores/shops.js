import { readFileSync } from 'node:fs';

// Shop and centre data for one Hyprop mall, trimmed from Hyprop's public feeds and cached in memory.

const CACHE_MS = Number(process.env.CACHE_HOURS || 12) * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const TIME_ZONE = 'Africa/Johannesburg';
const WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MAX_MATCHES = 10;

// stdout carries the MCP protocol, so logs go to stderr.
const log = (message) => console.error(`[mall-stores] ${message}`);

export function loadMall(key) {
  const malls = JSON.parse(readFileSync(new URL('./malls.json', import.meta.url), 'utf8'));
  const mall = malls[key];
  if (!mall) throw new Error(`Set MALL to one of: ${Object.keys(malls).join(', ')}`);
  return { ...mall, site: `https://${mall.domain}` };
}

// Same normalisation as the Vertex ECHO's route.ts.
export const normName = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/['`’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '');

const editDistance = (a, b) => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = next;
    }
  }
  return row[b.length];
};

/**
 * Caches load()'s result for CACHE_MS. Once stale, callers get the old copy while a refresh runs in
 * the background; a failed refresh keeps the old copy and is retried after RETRY_MS.
 */
function cached(label, load) {
  let value;
  let loadedAt = 0;
  let retryAt = 0;
  let pending = null;
  const refresh = () => {
    pending ??= load()
      .then((v) => {
        value = v;
        loadedAt = Date.now();
        log(`${label} refreshed`);
        return v;
      })
      .catch((err) => {
        retryAt = Date.now() + RETRY_MS;
        log(`${label} refresh failed: ${err.message}`);
        if (value === undefined) throw err;
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return () => {
    if (value === undefined) return refresh();
    const now = Date.now();
    if (now - loadedAt > CACHE_MS && now > retryAt) refresh();
    return Promise.resolve(value);
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

const toMinutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// "9AM - 9PM" -> "09:00 - 21:00"
const to24h = (text) =>
  text?.replace(
    /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi,
    (_, h, m = '00', ap) =>
      `${String((Number(h) % 12) + (/pm/i.test(ap) ? 12 : 0)).padStart(2, '0')}:${m}`,
  ) || undefined;

// Each phone number in a free-text field, e.g. "(021) 023 4106 / (021) 023 6259", with a tel: link.
const PHONE = /\(?0\d{2,3}\)?[\s-]?\d{3}[\s-]?\d{3,4}/g;
const phoneLinks = (text) =>
  [...String(text ?? '').matchAll(PHONE)]
    .map(([number]) => ({ number: number.trim(), digits: number.replace(/\D/g, '') }))
    .filter(({ digits }) => digits.length === 10)
    .map(({ number, digits }) => ({ number, link: `tel:+27${digits.slice(1)}` }));

const contact = (phone, email) => {
  const links = phoneLinks(phone);
  // The raw text only when it says more than the numbers, e.g. "Walk in only" or "(021) 555 1837/8".
  const extra = String(phone ?? '')
    .replace(PHONE, '')
    .replace(/[\s/,]/g, '');
  return {
    phone: extra ? phone.trim() : undefined,
    phone_links: links.length ? links : undefined,
    email: email?.trim() || undefined,
    email_link: email?.trim() ? `mailto:${email.trim()}` : undefined,
  };
};

/** Per-day { open, close } from the feed's typeTrading; null where hours are missing or open equals close. */
const tradingDays = (typeTrading) =>
  Object.fromEntries(
    WEEK.map((day) => {
      const t = typeTrading?.[day];
      const open = toMinutes(t?.open_text);
      const close = toMinutes(t?.close_text);
      return [
        day,
        open === null || close === null || open === close
          ? null
          : { open: t.open_text, close: t.close_text },
      ];
    }),
  );

/** "Daily 09:00 - 21:00", or runs such as "Mon-Fri 09:00 - 16:00, Sat-Sun 09:00 - 13:00". */
function formatHours(days) {
  const runs = [];
  for (const day of WEEK) {
    const text = days[day] ? `${days[day].open} - ${days[day].close}` : 'no hours listed';
    const last = runs.at(-1);
    if (last?.text === text) last.to = day;
    else runs.push({ from: day, to: day, text });
  }
  if (runs.length === 1) return days.monday ? `Daily ${runs[0].text}` : undefined;
  const label = (day) => day[0].toUpperCase() + day.slice(1, 3);
  return runs
    .map((r) => `${label(r.from)}${r.from === r.to ? '' : `-${label(r.to)}`} ${r.text}`)
    .join(', ');
}

function nowInCentre() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TIME_ZONE,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return {
    day: parts.weekday.toLowerCase(),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Open now by normal weekly hours, including spans that run past midnight. Public holidays are not known. */
function isOpen(days, { day, minutes }) {
  const span = (d) => {
    if (!days[d]) return null;
    const open = toMinutes(days[d].open);
    const close = toMinutes(days[d].close);
    return [open, close <= open ? close + 1440 : close];
  };
  const today = span(day);
  const yesterday = span(WEEK[(WEEK.indexOf(day) + 6) % 7]);
  return Boolean(
    (today && minutes >= today[0] && minutes < today[1]) ||
      (yesterday && minutes + 1440 < yesterday[1]),
  );
}

function indexShop(raw, mall) {
  const general = raw.typeGeneral ?? {};
  // subCategories is `false`, not [], on shops without any.
  const tags = [
    raw.category,
    ...(Array.isArray(raw.subCategories) ? raw.subCategories : []),
  ].filter(Boolean);
  const slugs = new Set(tags.flatMap((c) => [c.slug, c.child?.slug]).filter(Boolean));
  return {
    key: normName(raw.title),
    name: raw.title.trim(),
    url: `${mall.site}/shop/${raw.slug}`,
    floor: general.level?.trim() || undefined,
    // The shop's main category is only in `category`; Halaal and similar sit one level down, in `child`.
    slugs,
    categories: [...new Set(tags.map((c) => c.child?.title || c.title))],
    closed: Boolean(general.closed),
    closedStatus: /refurb/i.test(raw.currentStatus) ? raw.currentStatus : 'closed',
    comingSoon: Boolean(general.coming_soon),
    isNew: Boolean(general.new),
    // Never the feed's `tradingHours` summary (wrong for shops whose hours vary by day) or its
    // `currentStatus` (frozen when the file was generated).
    days: tradingDays(raw.typeTrading),
    // The Centre Management listing carries a different email from the centre's Contact Us page,
    // so the centre's contact details come only from get_centre_info.
    contact: slugs.has('centre-management')
      ? { contact_note: "For Centre Management's phone number and email, use get_centre_info." }
      : contact(general.telephone_number, general.email_address),
  };
}

function indexCategories(tree, mall) {
  const page = (slug) => {
    const pageSlug = mall.categoryPages?.[slug];
    return pageSlug ? `${mall.site}/shops/${pageSlug}` : `${mall.site}/shops`;
  };
  const flat = [];
  const walk = (cats, parent) =>
    cats.map((c) => {
      const entry = {
        key: normName(c.title),
        slug: c.slug,
        name: c.title,
        count: c.count,
        page: page(c.slug),
        parent: parent?.name,
      };
      flat.push(entry);
      entry.children = walk(c.children ?? [], entry);
      return entry;
    });
  return { tree: walk(tree ?? [], null), flat };
}

/** Shops matching a name: exact or longer names first ("Woolworths" -> every Woolworths listing), then looser matches. */
function findShops(query, shops) {
  const n = normName(query);
  if (n.length < 2) return [];
  const squash = (s) => s.replace(/ /g, '');
  const tiers = [
    (k) => k === n || k.startsWith(`${n} `), // "Paul" -> "PAUL Bakery & Restaurant"
    (k) => n.length >= 4 && squash(k).startsWith(squash(n)), // "Dischem" -> "Dis-Chem"
    (k) => k.length >= 6 && n.startsWith(`${k} `), // "Clicks Pharmacy" -> "Clicks"
    (k) => n.length >= 6 && 1 - editDistance(n, k) / Math.max(n.length, k.length) >= 0.9, // typos
  ];
  for (const test of tiers) {
    let hits = shops.filter((s) => test(s.key));
    if (test === tiers[2]) {
      const longest = Math.max(0, ...hits.map((s) => s.key.length));
      hits = hits.filter((s) => s.key.length === longest);
    }
    if (hits.length) return hits.slice(0, MAX_MATCHES);
  }
  return [];
}

const GENERIC_WORDS = new Set([
  'shop',
  'shops',
  'store',
  'stores',
  'service',
  'services',
  'and',
  'the',
]);

const queryWords = (query) =>
  normName(query)
    .split(' ')
    .filter((w) => w && !GENERIC_WORDS.has(w));

/** Every query word starts a word of the name: "bank" matches "banks and forex". */
const hasWords = (key, words) => {
  const keyWords = key.split(' ');
  return words.length > 0 && words.every((w) => keyWords.some((kw) => kw.startsWith(w)));
};

/** Categories matching a name or part of one; broad words prefer top-level ("fashion" -> Fashion and Footwear). */
function findCategories(query, flat) {
  const n = normName(query);
  if (!n) return [];
  const exact = flat.filter((c) => c.key === n || c.slug === n.replace(/ /g, '-'));
  if (exact.length) return exact;
  const words = queryWords(query);
  const hits = flat.filter((c) => hasWords(c.key, words));
  const topLevel = hits.filter((c) => !c.parent);
  return topLevel.length ? topLevel : hits;
}

const shopLink = (s) => ({ name: s.name, url: s.url });

function shopDetails(s, now) {
  let status = 'closed now';
  if (s.closed) status = s.closedStatus;
  else if (s.comingSoon) status = 'coming soon';
  else if (isOpen(s.days, now)) status = 'open now';
  return {
    name: s.name,
    url: s.url,
    floor: s.floor,
    hours: s.closed ? undefined : formatHours(s.days),
    status,
    new: s.isNew || undefined,
    ...s.contact,
    categories: s.categories,
  };
}

const asList = (value) =>
  []
    .concat(value ?? [])
    .map(String)
    .filter((v) => v.trim())
    .slice(0, 20);

export function createMallData(mall) {
  const storeList = cached('store list', async () => {
    const feed = await fetchJson(`https://cdn.hyprop.co.za/storeLists/${mall.id}.json`);
    if (!Array.isArray(feed.results) || !feed.results.length)
      throw new Error('store list has no shops');
    const shops = feed.results.filter((r) => r.title && r.slug).map((r) => indexShop(r, mall));
    return { shops, ...indexCategories(feed.categories, mall) };
  });

  const centre = cached('centre info', async () => {
    const m = await fetchJson(`https://api.hyprop.co.za/public/mall/${mall.id}`);
    const g = m.general ?? {};
    const departments = [
      ...(m.contactInformation?.visitorInformation ?? []),
      ...(m.contactInformation?.centreManagement ?? []),
    ];
    return {
      name: g.name || mall.name,
      website: mall.site,
      // `general` holds the hours the website shows; `tradingTimes` disagrees with it, so it is not used.
      hours: to24h(g.openingTime),
      information_desk_hours: to24h(g.infoDeskHours),
      management_office_hours: to24h(g.managementOfficeHours),
      directions: g.mallAddress || undefined,
      contacts: departments.map((d) => ({
        department: d.department,
        ...contact(d.contactNumber, d.email),
      })),
    };
  });

  return {
    warm: () => Promise.allSettled([storeList(), centre()]),

    async getShops(names) {
      const { shops } = await storeList();
      const now = nowInCentre();
      return {
        results: asList(names).map((query) => {
          const hits = findShops(query, shops);
          return hits.length
            ? { query, shops: hits.map((s) => shopDetails(s, now)) }
            : { query, found: false, note: `No shop by this name at ${mall.name}.` };
        }),
      };
    },

    async getShopLinks(names) {
      const { shops } = await storeList();
      const list = asList(names);
      if (!list.length) {
        const open = shops.filter((s) => !s.closed);
        return { total: open.length, shops: open.map(shopLink) };
      }
      return {
        results: list.map((query) => {
          const hits = findShops(query, shops);
          return hits.length ? { query, shops: hits.map(shopLink) } : { query, found: false };
        }),
      };
    },

    async getCategory(category) {
      const { shops, tree, flat } = await storeList();
      const summary = (c) => ({ name: c.name, count: c.count, page: c.page });
      const everyCategory = () =>
        tree.map((c) => ({
          ...summary(c),
          subcategories: c.children.length ? c.children.map(summary) : undefined,
        }));
      if (!String(category ?? '').trim()) return { categories: everyCategory() };

      const matches = findCategories(category, flat);
      if (!matches.length) {
        // Kept short: the full category list costs the model a slow extra read on every miss.
        const words = queryWords(category);
        const named = shops
          .filter((s) => !s.closed && hasWords(s.key, words))
          .slice(0, MAX_MATCHES);
        return {
          query: category,
          found: false,
          note: 'No category by this name. Use one of these categories, or look up the brands you would expect with get_shop.',
          shops: named.length ? named.map((s) => ({ ...shopLink(s), floor: s.floor })) : undefined,
          categories: flat.map((c) => c.name),
        };
      }
      if (matches.length > 1) {
        return {
          query: category,
          note: 'Several categories match. Call again with one of these names.',
          matches: matches.map(summary),
        };
      }
      const [c] = matches;
      const members = shops
        .filter((s) => !s.closed && s.slugs.has(c.slug))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => ({ ...shopLink(s), floor: s.floor }));
      return { category: c.name, parent: c.parent, total: c.count, page: c.page, shops: members };
    },

    getCentreInfo: () => centre(),
  };
}
