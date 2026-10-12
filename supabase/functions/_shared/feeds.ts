// The news source map, plus the feed-level plumbing `ingest-news` needs: fetching,
// parsing, URL normalisation, junk filtering and cross-source story merging.
//
// Every URL here was fetched and verified. Feeds that returned no usable items are
// recorded in DROPPED below rather than silently deleted, so we don't re-add them.

/** Mirrors CATEGORIES in src/lib/queries.ts. news_prefs.categories holds these strings. */
export type NewsCategory =
  | "AI"
  | "Software Development"
  | "Indian Stock Market"
  | "Indian Startups & Tech"
  | "Global Tech"
  | "Policy & Regulation";

/**
 * How much the source itself vouches for a story.
 * - `primary`    the actor speaking for itself: a regulator, a lab, a release feed.
 *                No middleman, so the facts are first-hand.
 * - `trusted`    a newsroom with an editor. Reliable, but it is reporting on someone else.
 * - `aggregator` Google News / Hacker News. Broad recall and a good signal of what is
 *                breaking, but no editorial control and the link usually needs cleaning.
 */
export type FeedTier = "primary" | "trusted" | "aggregator";

export type Feed = {
  url: string;
  /** Display name; also what lands in articles.source and news_items.source. */
  name: string;
  category: NewsCategory;
  tier: FeedTier;
};

/** Ranking weight for a tier. Passed to the model, and used to break merge ties. */
export const TIER_WEIGHT: Record<FeedTier, number> = {
  primary: 3,
  trusted: 2,
  aggregator: 1,
};

const GNEWS_IN = "hl=en-IN&gl=IN&ceid=IN:en";
const GNEWS_US = "hl=en-US&gl=US&ceid=US:en";
const gnews = (query: string, locale = GNEWS_US) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${locale}`;

/** A GitHub repo's releases feed — the changelog straight from the maintainers. */
const ghReleases = (repo: string, name: string): Feed => ({
  url: `https://github.com/${repo}/releases.atom`,
  name,
  category: "Software Development",
  tier: "primary",
});

export const FEEDS: Feed[] = [
  // ---------------------------------------------------------------- AI
  { url: "https://openai.com/blog/rss.xml", name: "OpenAI", category: "AI", tier: "primary" },
  {
    url: "https://deepmind.google/blog/rss.xml",
    name: "Google DeepMind",
    category: "AI",
    tier: "primary",
  },
  {
    url: "https://huggingface.co/blog/feed.xml",
    name: "Hugging Face",
    category: "AI",
    tier: "primary",
  },
  {
    url: "https://www.technologyreview.com/feed/",
    name: "MIT Technology Review",
    category: "AI",
    tier: "trusted",
  },
  // Willison is one person, but he is the best-sourced LLM writer going and links primaries.
  {
    url: "https://simonwillison.net/atom/everything/",
    name: "Simon Willison",
    category: "AI",
    tier: "trusted",
  },
  {
    url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
    name: "The Verge (AI)",
    category: "AI",
    tier: "trusted",
  },
  {
    url: gnews('"artificial intelligence" when:1d'),
    name: "Google News (AI)",
    category: "AI",
    tier: "aggregator",
  },

  // ----------------------------------------------- Software Development
  {
    url: "https://github.blog/feed/",
    name: "GitHub Blog",
    category: "Software Development",
    tier: "primary",
  },
  ghReleases("nodejs/node", "Node.js releases"),
  ghReleases("microsoft/TypeScript", "TypeScript releases"),
  ghReleases("denoland/deno", "Deno releases"),
  ghReleases("facebook/react", "React releases"),
  ghReleases("vitejs/vite", "Vite releases"),
  ghReleases("tailwindlabs/tailwindcss", "Tailwind CSS releases"),
  ghReleases("supabase/supabase", "Supabase releases"),
  ghReleases("postgres/postgres", "PostgreSQL releases"),
  {
    url: "https://feed.infoq.com/",
    name: "InfoQ",
    category: "Software Development",
    tier: "trusted",
  },
  // hnrss supports a points threshold, which is the whole reason to use it over the
  // official feed: it keeps the front page without the long tail of 3-point submissions.
  {
    url: "https://hnrss.org/frontpage?points=100",
    name: "Hacker News",
    category: "Software Development",
    tier: "aggregator",
  },

  // ------------------------------------------------ Indian Stock Market
  {
    url: "https://www.rbi.org.in/pressreleases_rss.xml",
    name: "RBI Press Releases",
    category: "Indian Stock Market",
    tier: "primary",
  },
  {
    url: "https://www.rbi.org.in/notifications_rss.xml",
    name: "RBI Notifications",
    category: "Indian Stock Market",
    tier: "primary",
  },
  // One combined feed of orders, circulars and press releases; dates and links both
  // need repair (see parseFeedDate and normalizeUrl).
  {
    url: "https://www.sebi.gov.in/sebirss.xml",
    name: "SEBI",
    category: "Indian Stock Market",
    tier: "primary",
  },
  {
    url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
    name: "ET Markets",
    category: "Indian Stock Market",
    tier: "trusted",
  },
  {
    url: "https://www.livemint.com/rss/markets",
    name: "Livemint Markets",
    category: "Indian Stock Market",
    tier: "trusted",
  },
  {
    url: "https://www.business-standard.com/rss/markets-106.rss",
    name: "Business Standard Markets",
    category: "Indian Stock Market",
    tier: "trusted",
  },
  {
    url: gnews("Sensex OR Nifty when:1d", GNEWS_IN),
    name: "Google News (Markets)",
    category: "Indian Stock Market",
    tier: "aggregator",
  },

  // -------------------------------------------- Indian Startups & Tech
  {
    url: "https://inc42.com/feed/",
    name: "Inc42",
    category: "Indian Startups & Tech",
    tier: "trusted",
  },
  // Note /rss, not /feed — /feed 404s.
  {
    url: "https://entrackr.com/rss",
    name: "Entrackr",
    category: "Indian Startups & Tech",
    tier: "trusted",
  },
  {
    url: "https://yourstory.com/feed",
    name: "YourStory",
    category: "Indian Startups & Tech",
    tier: "trusted",
  },
  {
    url: "https://www.livemint.com/rss/companies",
    name: "Livemint Companies",
    category: "Indian Startups & Tech",
    tier: "trusted",
  },
  {
    url: "https://www.business-standard.com/rss/companies-101.rss",
    name: "Business Standard Companies",
    category: "Indian Startups & Tech",
    tier: "trusted",
  },
  {
    url: gnews("India startup funding when:1d", GNEWS_IN),
    name: "Google News (Indian Startups)",
    category: "Indian Startups & Tech",
    tier: "aggregator",
  },

  // ---------------------------------------------------------- Global Tech
  {
    url: "https://www.theverge.com/rss/index.xml",
    name: "The Verge",
    category: "Global Tech",
    tier: "trusted",
  },
  {
    url: "https://techcrunch.com/feed/",
    name: "TechCrunch",
    category: "Global Tech",
    tier: "trusted",
  },
  {
    url: "https://feeds.arstechnica.com/arstechnica/index",
    name: "Ars Technica",
    category: "Global Tech",
    tier: "trusted",
  },
  // Reuters killed its public RSS feeds; a site: query is the remaining way in.
  {
    url: gnews("technology site:reuters.com when:1d"),
    name: "Google News (Reuters Tech)",
    category: "Global Tech",
    tier: "aggregator",
  },

  // --------------------------------------------------- Policy & Regulation
  {
    url: "https://www.medianama.com/feed/",
    name: "MediaNama",
    category: "Policy & Regulation",
    tier: "trusted",
  },
  {
    url: "https://www.business-standard.com/rss/economy-policy-102.rss",
    name: "Business Standard Economy & Policy",
    category: "Policy & Regulation",
    tier: "trusted",
  },
  // PIB's own RSS is dead (see DROPPED), so reach its releases through Google News.
  {
    url: gnews("site:pib.gov.in when:2d", GNEWS_IN),
    name: "Google News (PIB)",
    category: "Policy & Regulation",
    tier: "aggregator",
  },
  {
    url: gnews('(DPDP OR "data protection" OR TRAI OR MeitY) India when:2d', GNEWS_IN),
    name: "Google News (India Tech Policy)",
    category: "Policy & Regulation",
    tier: "aggregator",
  },
  {
    url: gnews('"AI regulation" when:1d'),
    name: "Google News (AI Regulation)",
    category: "Policy & Regulation",
    tier: "aggregator",
  },
];

/**
 * Verified broken on 2026-10-12. Keep the reasons — these are all plausible-looking
 * URLs that someone will otherwise try again.
 */
export const DROPPED: { url: string; reason: string }[] = [
  {
    url: "https://www.pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3",
    reason:
      "PIB: endpoint is up but serves an <rss> with an empty <channel>; every ModId/Regid " +
      "combination tried returned 0 items or an HTML error page. Replaced by a site: query.",
  },
  {
    url: "https://www.moneycontrol.com/rss/marketreports.xml",
    reason:
      "Moneycontrol: feed is abandoned — newest item is 23 Apr 2024. Same for " +
      "MCtopnews.xml and latestnews.xml. Was in the original plan; removed.",
  },
  {
    url: "https://www.anthropic.com/news/rss.xml",
    reason: "Anthropic: no public RSS feed (404 on /news/rss.xml and /rss.xml).",
  },
  {
    url: "https://deepmind.google/discover/blog/rss.xml",
    reason: "Old DeepMind blog path, 404s. Current path is /blog/rss.xml.",
  },
];

export function feedsForCategories(categories: readonly string[]): Feed[] {
  const want = new Set(categories);
  return FEEDS.filter((f) => want.has(f.category));
}

/** Every category at least one enabled user follows — the ingest work list. */
export function categoriesToIngest(perUser: readonly string[][]): NewsCategory[] {
  const seen = new Set(perUser.flat());
  return [...new Set(FEEDS.map((f) => f.category))].filter((c) => seen.has(c));
}

// ---------------------------------------------------------------- fetching

/**
 * Business Standard (and a few others behind the same CDN rules) answer 403 to anything
 * that looks like a bot, so we present as a browser everywhere for consistency.
 */
const FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
} as const;

const FETCH_TIMEOUT_MS = 20_000;

/**
 * OpenAI and Hugging Face serve their entire archive in one feed (1287 and 876 items
 * when last measured), so cap what we keep. Applied newest-first, since feed order
 * cannot be relied on.
 */
const MAX_ITEMS_PER_FEED = 150;

export type FeedItem = {
  title: string;
  url: string;
  /** null when the feed gave no parseable date. */
  publishedAt: Date | null;
  summary: string;
  feed: Feed;
  /** Publisher domain. Differs from feed.name for aggregator items. */
  publisher: string;
  /** False once a Google News link could not be resolved to the publisher's own URL. */
  resolved: boolean;
};

/** One feed -> its items. Never throws; a dead feed must not take the run down. */
export async function fetchFeed(feed: Feed): Promise<FeedItem[]> {
  let xml: string;
  try {
    const res = await fetch(feed.url, {
      headers: FETCH_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`feed ${feed.name}: HTTP ${res.status}`);
      return [];
    }
    xml = await res.text();
  } catch (e) {
    console.warn(`feed ${feed.name}: ${e instanceof Error ? e.message : e}`);
    return [];
  }
  return parseFeed(xml, feed);
}

export function parseFeed(xml: string, feed: Feed): FeedItem[] {
  const blocks = [
    ...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi),
  ].map((m) => m[0]);

  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = decodeXml(pick(block, ["title"]) ?? "").trim();
    const rawUrl = pick(block, ["link", "guid"]) ?? linkHref(block);
    if (!title || !rawUrl) continue;

    const url = normalizeUrl(decodeXml(rawUrl).trim(), feed);
    if (!url) continue;

    items.push({
      title,
      url,
      publishedAt: parseFeedDate(pick(block, ["pubDate", "published", "updated", "dc:date"])),
      summary: stripHtml(
        decodeXml(pick(block, ["description", "summary", "content", "content:encoded"]) ?? ""),
      ).slice(0, 1200),
      feed,
      publisher: publisherOf(url, block, feed),
      resolved: !isGoogleNewsLink(url),
    });
  }

  if (items.length <= MAX_ITEMS_PER_FEED) return items;
  return [...items]
    .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
    .slice(0, MAX_ITEMS_PER_FEED);
}

function pick(block: string, names: string[]): string | null {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i"));
    if (m) return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  }
  return null;
}

/** Atom's <link rel="alternate" href="..."/> is self-closing, so pick() misses it. */
function linkHref(block: string): string | null {
  const alt = block.match(/<link[^>]+rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alt) return alt[1];
  return block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? null;
}

/**
 * RFC-822/ISO dates parse directly. SEBI is the exception: it emits
 * "09 Oct, 2026 +0530", which Date.parse rejects outright.
 */
export function parseFeedDate(raw: string | null): Date | null {
  if (!raw) return null;
  const direct = Date.parse(raw);
  if (!Number.isNaN(direct)) return new Date(direct);

  const m = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,})[,.]?\s+(\d{4})\s*([+-]\d{4})?$/);
  if (m) {
    const retry = Date.parse(`${m[1]} ${m[2].slice(0, 3)} ${m[3]} 00:00:00 ${m[4] ?? "+0000"}`);
    if (!Number.isNaN(retry)) return new Date(retry);
  }
  return null;
}

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$|at_|CMP$|oc$)/i;

/** Canonical form for comparison and storage. Returns null for anything unusable. */
export function normalizeUrl(raw: string, feed?: Feed): string | null {
  let s = raw.trim();
  if (!s) return null;

  // SEBI concatenates its own origin onto already-absolute links:
  // "https://www.sebi.gov.in/https://www.sebi.gov.in/sebi_data/...pdf"
  const doubled = s.match(/^https?:\/\/[^/]+\/(https?:\/\/.+)$/i);
  if (doubled) s = doubled[1];

  // Some feeds put a bare path in <link>; resolve against the feed's own origin.
  if (s.startsWith("/") && feed) {
    try {
      s = new URL(s, new URL(feed.url).origin).toString();
    } catch {
      return null;
    }
  }

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  }
  u.hash = "";
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

/**
 * Outlets that publish the same newsroom under more than one hostname. Without this
 * the ET desktop and ET mobile copies of a story would count as two sources.
 */
const PUBLISHER_ALIASES: Record<string, string> = {
  "economictimes.com": "economictimes.indiatimes.com",
  "timesofindia.com": "timesofindia.indiatimes.com",
  "hindustantimes.co.in": "hindustantimes.com",
};

/** Identity used for counting sources; `publisher` stays as-is for display. */
export function publisherKey(publisher: string): string {
  const bare = publisher.replace(/^(?:www|m|amp|mobile)\./i, "").toLowerCase();
  return PUBLISHER_ALIASES[bare] ?? bare;
}

export function isGoogleNewsLink(url: string): boolean {
  return /^https?:\/\/news\.google\.com\//i.test(url);
}

function publisherOf(url: string, block: string, feed: Feed): string {
  // Google News names the real outlet in <source url="...">.
  const src = block.match(/<source[^>]*url=["']([^"']+)["']/i)?.[1];
  const host = (v: string) => {
    try {
      return new URL(v).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  if (feed.tier === "aggregator" && src) return host(src) || feed.name;
  return host(url) || feed.name;
}

// ------------------------------------------------- Google News link cleanup

/**
 * Best-effort unwrapping of a Google News redirect into the publisher's own URL.
 *
 * Reality check: for the current `/rss/articles/CBMi...` links there is no server-side
 * path left. The id is opaque (no base64-embedded URL any more), the article page
 * carries no publisher URL in its HTML (the hop is client-side JS), and the
 * DotsSplashUi `Fbv4je` RPC — the trick every library used — now answers with an empty
 * result even when given the page's own signature and timestamp. All three were tried
 * against live links on 2026-10-12.
 *
 * So: unwrap the older `?url=` form when we see it, and otherwise hand back the Google
 * link with resolved=false. Those links still work for a human in a browser, and
 * mergeStories prefers a direct feed's URL whenever the same story arrived from one —
 * which is the main reason the aggregator tier exists.
 */
export async function resolveItemUrl(item: FeedItem): Promise<FeedItem> {
  if (!isGoogleNewsLink(item.url)) return item;

  const embedded = new URL(item.url).searchParams.get("url");
  if (embedded) {
    const clean = normalizeUrl(embedded);
    if (clean && !isGoogleNewsLink(clean)) return { ...item, url: clean, resolved: true };
  }

  // A few old-style /news/url?... links still 3xx to the publisher. Cheap to try.
  try {
    const res = await fetch(item.url, {
      method: "HEAD",
      headers: FETCH_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    const clean = normalizeUrl(res.url);
    if (clean && !isGoogleNewsLink(clean)) return { ...item, url: clean, resolved: true };
  } catch {
    // Ignore — resolution is a nicety, not a requirement.
  }
  return item;
}

// ------------------------------------------------------------ junk filtering

/** Paid placement dressed as editorial. */
const SPONSORED = [
  /\bsponsored\b/i,
  /\bbrand(ed)?[\s-]?(post|content|story|hub)\b/i,
  /\bpartner(ed)?[\s-]?content\b/i,
  /\badvertorial\b/i,
  /\bpromoted\b/i,
  /\bpaid[\s-]?(post|content)\b/i,
  /\bin\s+association\s+with\b/i,
  /\bpress\s+release\s+distribution\b/i,
];

/**
 * Indian market feeds are full of tip sheets. These are not news and they are the one
 * category where following the "advice" costs the reader money, so they go.
 */
const STOCK_TIPS = [
  /\bmultibagger\b/i,
  /\btarget\s+price\b/i,
  /\bstocks?\s+to\s+(buy|bet\s+on|pick)\b/i,
  /\b(buy|sell)\s+or\s+(sell|buy)\b/i,
  /\bshould\s+you\s+(buy|sell|invest)\b/i,
  /\bintraday\s+(pick|tip|trade|idea)/i,
  /\bpenny\s+stocks?\b/i,
  /\b(top|best)\s+\d+\s+stocks?\b/i,
  /\bstock\s+(tips|recommendation)/i,
  /\bhot\s+picks?\b/i,
  /\btrade\s+setup\b/i,
  /\btechnical\s+(view|call)s?\b/i,
];

/** Recurring filler that carries no information. */
const NOISE = [
  /\b(today'?s|daily)\s+(horoscope|rashifal)\b/i,
  /\bgold\s+(and\s+silver\s+)?(rate|price)s?\s+today\b/i,
  // Must be the daily rate-check filler, not an actual price-change story
  // ("Jio-bp raises petrol price by \u20b95" is news and must survive).
  /\bpetrol\s*(,|\band\b)?\s*(diesel\s+)?(price|rate)s?\s+(today|on\s+\w+day)\b/i,
  /\blive\s+updates?\b.*\bblog\b/i,
];

export function isJunk(item: FeedItem): boolean {
  const hay = `${item.title}\n${item.summary}`;
  if (SPONSORED.some((re) => re.test(hay))) return true;
  if (NOISE.some((re) => re.test(item.title))) return true;
  // Tip-sheet patterns are judged on the title only: a real story may quote an
  // analyst's target price in the body without being a tip sheet itself.
  if (STOCK_TIPS.some((re) => re.test(item.title))) return true;
  return false;
}

// -------------------------------------------------------------- deduplication

const STOPWORDS = new Set(
  (
    "a an the and or but of in on for to from with by at as is are was were be been will " +
    "says say said after over into amid new news report reports update updates its it this " +
    "that these those has have had about more than per cent percent crore lakh billion million"
  ).split(" "),
);

/** Comparable token set for a headline: lowercased, de-punctuated, stopwords dropped. */
export function titleTokens(title: string): Set<string> {
  // Google News appends " - Publisher"; drop it so the same story matches across tiers.
  const core = title.replace(/\s+[-|–—]\s+[^-|–—]{2,40}$/, "");
  return new Set(
    core
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Headline overlap above this counts as the same story.
 *
 * Picked by sweeping a live 24h pull (585 items, 2026-10-12) and reading every pair:
 * the 0.45-0.55 band was entirely true duplicates (the same Tessolve funding round,
 * Rupee/RBI move and Bill Gates quote across three outlets each), while 0.35-0.45
 * started mixing genuinely different stories ("How AI is changing education" against
 * "...changing Fantasy Football"). 0.45 is the last clean step down.
 */
export const DUPLICATE_THRESHOLD = 0.45;

export type MergedStory = {
  /** Canonical item — the highest-tier, best-resolved member of the group. */
  item: FeedItem;
  /** How many distinct publishers carried this story. The crowd-interest signal. */
  sourceCount: number;
  /** Publishers and feed names that carried it, canonical first. */
  sources: string[];
  /** Strongest tier in the group, for the ranking prompt. */
  tier: FeedTier;
  /** Everything that merged into this story, canonical included. */
  members: FeedItem[];
};

/**
 * Collapse the same story arriving from several feeds into one entry carrying a
 * source_count. Exact-URL matches merge first, then headline similarity.
 *
 * The canonical pick is deliberate: a resolved publisher URL beats an unresolved
 * Google redirect, then higher tier wins, then the longer headline. That way an
 * aggregator can tell us a story is big while a primary source provides the link.
 */
export function mergeStories(items: FeedItem[]): MergedStory[] {
  const byUrl = new Map<string, FeedItem[]>();
  for (const item of items) {
    const group = byUrl.get(item.url);
    if (group) group.push(item);
    else byUrl.set(item.url, [item]);
  }

  const groups: { members: FeedItem[]; tokens: Set<string> }[] = [];
  for (const members of byUrl.values()) {
    const tokens = titleTokens(members[0].title);
    // Same category only: an identical headline under two categories is two digest
    // entries, and cross-category merging would hide one of them.
    const hit = groups.find(
      (g) =>
        g.members[0].feed.category === members[0].feed.category &&
        jaccard(g.tokens, tokens) >= DUPLICATE_THRESHOLD,
    );
    if (hit) hit.members.push(...members);
    else groups.push({ members: [...members], tokens });
  }

  return groups.map(({ members }) => {
    const ranked = [...members].sort(
      (a, b) =>
        Number(b.resolved) - Number(a.resolved) ||
        TIER_WEIGHT[b.feed.tier] - TIER_WEIGHT[a.feed.tier] ||
        b.title.length - a.title.length,
    );
    // Count distinct newsrooms, not distinct hostnames.
    const byKey = new Map<string, string>();
    for (const m of members) {
      const k = publisherKey(m.publisher);
      if (!byKey.has(k)) byKey.set(k, m.publisher);
    }
    const publishers = [...byKey.values()];
    return {
      item: ranked[0],
      sourceCount: publishers.length,
      sources: [
        ranked[0].publisher,
        ...publishers.filter((p) => publisherKey(p) !== publisherKey(ranked[0].publisher)),
      ],
      tier: ranked.reduce(
        (best, m) => (TIER_WEIGHT[m.feed.tier] > TIER_WEIGHT[best] ? m.feed.tier : best),
        "aggregator" as FeedTier,
      ),
      members,
    };
  });
}

/**
 * The one line per story that goes into the ranking prompt. Tier and source_count are
 * the two signals the model cannot infer from a headline.
 */
export function describeForRanking(story: MergedStory, index: number): string {
  const when = story.item.publishedAt?.toISOString() ?? "unknown";
  return [
    `[${index}] ${story.item.title}`,
    `    category=${story.item.feed.category} tier=${story.tier} source_count=${story.sourceCount}`,
    `    sources=${story.sources.slice(0, 5).join(", ")} published=${when}`,
    story.item.summary ? `    summary=${story.item.summary.slice(0, 400)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Google News (and ET) double-encode their descriptions, so a single pass turns
 * "&amp;nbsp;" into "&nbsp;" and leaves it there. Decode until it stops changing,
 * bounded at two passes so a literal "&amp;amp;" can't loop.
 */
function decodeXml(s: string): string {
  let out = s;
  for (let pass = 0; pass < 2; pass++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

function decodeOnce(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&(?:ldquo|rdquo);/g, '"')
    .replace(/&(?:lsquo|rsquo);/g, "'")
    .replace(/&(?:ndash|mdash);/g, "-")
    .replace(/&hellip;/g, "...")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}
