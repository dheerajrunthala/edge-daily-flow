// feeds.ts is the gnarliest code in the project and had no tests at all.
//
// Almost every case below is a line from the "Feed gotchas" section of CLAUDE.md, which
// reads as a test plan: each one is a real malformation found in a live feed that cost an
// hour to diagnose. A regression in any of them is silent — a story quietly missing from
// a digest, or a tip sheet quietly in one — so they are worth pinning.
//
// This file runs under the existing vitest `include` only because feeds.ts has no npm: or
// jsr: imports. Keep it that way (see the note in vitest.config.ts).

import { describe, expect, it } from "vitest";

import {
  DUPLICATE_THRESHOLD,
  FEEDS,
  type Feed,
  type FeedItem,
  RECENCY_WINDOW_HOURS,
  candidateScore,
  isGoogleNewsLink,
  isJunk,
  isRecent,
  mergeStories,
  normalizeUrl,
  parseFeed,
  parseFeedDate,
  publisherKey,
  shortlist,
  titleTokens,
} from "./feeds.ts";

const feed = (over: Partial<Feed> = {}): Feed => ({
  url: "https://example.com/rss",
  name: "Example",
  category: "AI",
  tier: "trusted",
  ...over,
});

const item = (over: Partial<FeedItem> = {}): FeedItem => ({
  title: "A headline",
  url: "https://example.com/a",
  publishedAt: new Date("2026-10-28T00:00:00Z"),
  summary: "",
  feed: feed(),
  publisher: "example.com",
  resolved: true,
  ...over,
});

describe("parseFeedDate", () => {
  it("parses RFC-822, which is what most feeds send", () => {
    expect(parseFeedDate("Tue, 27 Oct 2026 14:30:00 +0000")?.toISOString()).toBe(
      "2026-10-27T14:30:00.000Z",
    );
  });

  it("parses ISO 8601, which is what Atom feeds send", () => {
    expect(parseFeedDate("2026-10-27T14:30:00Z")?.toISOString()).toBe("2026-10-27T14:30:00.000Z");
  });

  // The documented SEBI quirk: Date.parse rejects this outright, so the fallback regex
  // is the only reason SEBI items carry a date at all.
  it('parses SEBI\'s "09 Oct, 2026 +0530", which Date.parse refuses', () => {
    expect(Number.isNaN(Date.parse("09 Oct, 2026 +0530"))).toBe(true);
    expect(parseFeedDate("09 Oct, 2026 +0530")?.toISOString()).toBe("2026-10-08T18:30:00.000Z");
  });

  // Regression: V8 parses a zoneless "09 Oct, 2026" leniently, as midnight in the
  // *server's* timezone — so this resolved to a different calendar day in the Edge
  // runtime (UTC) than on an Asia/Kolkata laptop, and isRecent() disagreed with itself
  // depending on where it ran. The day-month-year shape is now matched before
  // Date.parse gets a chance, and pinned to UTC.
  it("pins a SEBI-shaped date with no offset to UTC, not the host timezone", () => {
    expect(parseFeedDate("09 Oct, 2026")?.toISOString()).toBe("2026-10-09T00:00:00.000Z");
  });

  it("still honours an explicit offset on that shape", () => {
    expect(parseFeedDate("09 Oct, 2026 -0500")?.toISOString()).toBe("2026-10-09T05:00:00.000Z");
  });

  it("returns null for a missing or unparseable date rather than Invalid Date", () => {
    expect(parseFeedDate(null)).toBeNull();
    expect(parseFeedDate("last Thursday")).toBeNull();
    expect(parseFeedDate("")).toBeNull();
  });
});

describe("normalizeUrl", () => {
  it("strips every tracking parameter family", () => {
    const got = normalizeUrl(
      "https://example.com/a?utm_source=x&utm_medium=y&fbclid=z&gclid=w&ref=rss&id=42",
    );
    expect(got).toBe("https://example.com/a?id=42");
  });

  it("keeps parameters that identify the article", () => {
    expect(normalizeUrl("https://example.com/story?id=42&page=2")).toBe(
      "https://example.com/story?id=42&page=2",
    );
  });

  // SEBI concatenates its own origin onto links that are already absolute.
  it("unwraps SEBI's doubled origin", () => {
    expect(
      normalizeUrl("https://www.sebi.gov.in/https://www.sebi.gov.in/sebi_data/order.pdf"),
    ).toBe("https://www.sebi.gov.in/sebi_data/order.pdf");
  });

  it("resolves a bare path against the feed's own origin", () => {
    expect(normalizeUrl("/news/story-1", feed({ url: "https://rbi.org.in/feed.xml" }))).toBe(
      "https://rbi.org.in/news/story-1",
    );
  });

  it("returns null for a bare path when there is no feed to resolve against", () => {
    expect(normalizeUrl("/news/story-1")).toBeNull();
  });

  it("rejects non-http protocols", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("ftp://example.com/a")).toBeNull();
  });

  it("drops the fragment and a trailing slash, so two spellings compare equal", () => {
    expect(normalizeUrl("https://example.com/a/#comments")).toBe("https://example.com/a");
    expect(normalizeUrl("https://example.com/a/")).toBe("https://example.com/a");
  });

  it("keeps the root path, which has no trailing slash to strip", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("returns null for junk rather than throwing", () => {
    expect(normalizeUrl("not a url")).toBeNull();
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
  });
});

describe("publisherKey", () => {
  it("folds www., m., amp. and mobile. to one newsroom", () => {
    const keys = [
      "www.thehindu.com",
      "m.thehindu.com",
      "amp.thehindu.com",
      "mobile.thehindu.com",
    ].map(publisherKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("thehindu.com");
  });

  // Economic Times publishes one newsroom under two domains; without the alias a story
  // carried once would report source_count 2 and read as corroborated.
  it("folds Economic Times' split domains", () => {
    expect(publisherKey("economictimes.com")).toBe(publisherKey("economictimes.indiatimes.com"));
  });

  it("folds the other known aliases", () => {
    expect(publisherKey("timesofindia.com")).toBe("timesofindia.indiatimes.com");
    expect(publisherKey("hindustantimes.co.in")).toBe("hindustantimes.com");
  });

  it("lowercases and otherwise passes a bare host through", () => {
    expect(publisherKey("Reuters.COM")).toBe("reuters.com");
  });
});

describe("isGoogleNewsLink", () => {
  it("recognises the aggregator links that cannot be resolved server-side", () => {
    expect(isGoogleNewsLink("https://news.google.com/rss/articles/CBMiKWh0dHBz")).toBe(true);
    expect(isGoogleNewsLink("http://news.google.com/x")).toBe(true);
  });

  it("does not match the publisher's own domain or other Google properties", () => {
    expect(isGoogleNewsLink("https://reuters.com/a")).toBe(false);
    expect(isGoogleNewsLink("https://blog.google/technology/ai/")).toBe(false);
  });
});

describe("isJunk", () => {
  it("drops sponsored and advertorial items, matching the body too", () => {
    expect(isJunk(item({ summary: "This is a sponsored post by Acme." }))).toBe(true);
  });

  it("drops the stock-tip genre that floods the Indian market feeds", () => {
    const titles = [
      "This multibagger stock gave 400% returns",
      "Top 5 stocks to buy this week",
      "Trade setup for Monday: 15 things to know",
      "Should you buy or sell Reliance now?",
      "Penny stocks to watch",
      "Technical view: Nifty support levels",
    ];
    for (const title of titles) {
      expect(isJunk(item({ title })), title).toBe(true);
    }
  });

  // The documented rule: tip patterns are judged on the title ALONE, because a real
  // story may quote an analyst's target price in its body without being a tip sheet.
  it("keeps a real story that merely quotes a target price in its body", () => {
    expect(
      isJunk(
        item({
          title: "Infosys beats estimates as deal wins accelerate",
          summary: "Analysts at Jefferies raised their target price to Rs 2,100 after the result.",
        }),
      ),
    ).toBe(false);
  });

  it("drops recurring daily filler", () => {
    expect(isJunk(item({ title: "Today's horoscope: 28 October 2026" }))).toBe(true);
    expect(isJunk(item({ title: "Gold and silver rates today: check prices" }))).toBe(true);
  });

  // Also documented: a genuine price-change story must survive the petrol-filler rule.
  it("keeps an actual fuel price story", () => {
    expect(isJunk(item({ title: "Jio-bp raises petrol price by Rs 5 a litre" }))).toBe(false);
  });

  it("keeps ordinary news", () => {
    expect(isJunk(item({ title: "RBI holds repo rate at 6.5%" }))).toBe(false);
  });
});

describe("titleTokens", () => {
  // Google News appends " - Publisher"; left in, the same story from a direct feed and
  // from the aggregator would not merge.
  it("drops Google News' trailing publisher suffix", () => {
    expect([...titleTokens("Zerodha launches US stock investing - Business Standard")]).toEqual([
      ...titleTokens("Zerodha launches US stock investing"),
    ]);
  });

  it("drops stopwords and short words", () => {
    const t = titleTokens("The RBI is on track to be in the news about it");
    expect(t.has("the")).toBe(false);
    expect(t.has("is")).toBe(false);
    expect(t.has("about")).toBe(false);
    expect(t.has("rbi")).toBe(true);
    expect(t.has("track")).toBe(true);
  });

  it("normalises apostrophes so curly and straight forms match", () => {
    expect([...titleTokens("Urban Company’s fundraise")]).toEqual([
      ...titleTokens("Urban Company's fundraise"),
    ]);
  });
});

describe("mergeStories", () => {
  it("merges items that share a URL exactly", () => {
    const merged = mergeStories([
      item({ publisher: "a.com" }),
      item({ publisher: "b.com", title: "Completely different words here" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sourceCount).toBe(2);
  });

  it("merges near-identical headlines inside one category", () => {
    const merged = mergeStories([
      item({
        url: "https://a.com/1",
        title: "Tessolve Semiconductor raises $75 million to expand services",
        publisher: "a.com",
      }),
      item({
        url: "https://b.com/2",
        title: "Tessolve Semiconductor raises $75 million for services expansion",
        publisher: "b.com",
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sourceCount).toBe(2);
  });

  // Cross-category merging would hide one of two legitimate digest entries.
  it("never merges across categories, even for an identical headline", () => {
    const merged = mergeStories([
      item({ url: "https://a.com/1", feed: feed({ category: "AI" }) }),
      item({
        url: "https://b.com/2",
        feed: feed({ category: "Global Tech" }),
      }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("counts newsrooms rather than hostnames, folding m. and amp.", () => {
    const merged = mergeStories([
      item({ url: "https://a.com/1", publisher: "www.thehindu.com" }),
      item({ url: "https://a.com/1", publisher: "m.thehindu.com" }),
      item({ url: "https://a.com/1", publisher: "amp.thehindu.com" }),
    ]);
    expect(merged[0].sourceCount).toBe(1);
  });

  // The whole reason the aggregator tier exists: it can tell us a story is big while a
  // primary source supplies a link that actually resolves.
  it("prefers a resolved URL over an unresolved one when picking the canonical item", () => {
    const merged = mergeStories([
      item({
        url: "https://news.google.com/rss/articles/CBMi1",
        resolved: false,
        feed: feed({ tier: "aggregator" }),
        publisher: "reuters.com",
      }),
      item({
        url: "https://reuters.com/real",
        resolved: true,
        feed: feed({ tier: "trusted" }),
        publisher: "reuters.com",
      }),
    ]);
    expect(merged[0].item.url).toBe("https://reuters.com/real");
  });

  it("prefers the higher tier when both candidates resolve", () => {
    const merged = mergeStories([
      item({ url: "https://a.com/1", feed: feed({ tier: "trusted" }), publisher: "a.com" }),
      item({ url: "https://a.com/1", feed: feed({ tier: "primary" }), publisher: "b.com" }),
    ]);
    expect(merged[0].item.feed.tier).toBe("primary");
  });

  it("reports the best tier present in the group", () => {
    const merged = mergeStories([
      item({
        url: "https://news.google.com/rss/articles/CBMi2",
        resolved: false,
        feed: feed({ tier: "aggregator" }),
      }),
      item({ url: "https://news.google.com/rss/articles/CBMi2", feed: feed({ tier: "primary" }) }),
    ]);
    expect(merged[0].tier).toBe("primary");
  });

  it("keeps the threshold where the sweep put it", () => {
    expect(DUPLICATE_THRESHOLD).toBe(0.45);
  });
});

describe("isRecent", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  // Documented: lab blogs and GitHub release feeds are quiet for days at a time, and a
  // 24h window would drop the primary tier entirely most days.
  it("gives primary sources 72 hours", () => {
    expect(RECENCY_WINDOW_HOURS.primary).toBe(72);
    const it48 = item({ feed: feed({ tier: "primary" }), publishedAt: hoursAgo(48) });
    expect(isRecent(it48, now)).toBe(true);
  });

  it("holds newsrooms and aggregators to 24 hours", () => {
    expect(
      isRecent(item({ feed: feed({ tier: "trusted" }), publishedAt: hoursAgo(48) }), now),
    ).toBe(false);
    expect(
      isRecent(item({ feed: feed({ tier: "trusted" }), publishedAt: hoursAgo(12) }), now),
    ).toBe(true);
  });

  // Several feeds omit dates; dropping them loses real news.
  it("keeps undated items", () => {
    expect(isRecent(item({ publishedAt: null }), now)).toBe(true);
  });

  it("tolerates small clock skew but rejects a date in the future", () => {
    expect(isRecent(item({ publishedAt: hoursAgo(-1) }), now)).toBe(true);
    expect(isRecent(item({ publishedAt: hoursAgo(-5) }), now)).toBe(false);
  });
});

describe("candidateScore and shortlist", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const story = (over: { tier?: Feed["tier"]; sourceCount?: number; hours?: number } = {}) => {
    const tier = over.tier ?? "trusted";
    const hours = over.hours ?? 0;
    const it = item({
      feed: feed({ tier }),
      publishedAt: new Date(now.getTime() - hours * 3_600_000),
    });
    return {
      item: it,
      sourceCount: over.sourceCount ?? 1,
      sources: ["a.com"],
      tier,
      members: [it],
    };
  };

  it("ranks a primary source above a trusted one, all else equal", () => {
    expect(candidateScore(story({ tier: "primary" }), now)).toBeGreaterThan(
      candidateScore(story({ tier: "trusted" }), now),
    );
  });

  it("caps corroboration so one viral story cannot crowd out a category", () => {
    const five = candidateScore(story({ sourceCount: 5 }), now);
    const twenty = candidateScore(story({ sourceCount: 20 }), now);
    expect(twenty).toBe(five);
  });

  it("decays freshness to zero by 36 hours", () => {
    const fresh = candidateScore(story({ hours: 0 }), now);
    const old = candidateScore(story({ hours: 40 }), now);
    expect(fresh - old).toBeCloseTo(6, 5);
  });

  it("treats an undated story as a day old rather than brand new", () => {
    const undated = { ...story(), item: item({ publishedAt: null }) };
    expect(candidateScore(undated, now)).toBeCloseTo(candidateScore(story({ hours: 24 }), now), 5);
  });

  it("caps the shortlist at the limit, highest score first", () => {
    const stories = [
      story({ tier: "aggregator" }),
      story({ tier: "primary" }),
      story({ tier: "trusted" }),
    ];
    const out = shortlist(stories, now, 2);
    expect(out).toHaveLength(2);
    expect(out[0].tier).toBe("primary");
  });
});

describe("parseFeed", () => {
  it("parses an RSS item", () => {
    const xml = `<rss><channel><item>
      <title>RBI holds the repo rate</title>
      <link>https://rbi.org.in/a?utm_source=rss</link>
      <pubDate>Tue, 27 Oct 2026 10:00:00 +0000</pubDate>
      <description>&lt;p&gt;The committee voted 5-1.&lt;/p&gt;</description>
    </item></channel></rss>`;
    const [got] = parseFeed(xml, feed());
    expect(got.title).toBe("RBI holds the repo rate");
    expect(got.url).toBe("https://rbi.org.in/a");
    expect(got.summary).toBe("The committee voted 5-1.");
    expect(got.publishedAt?.toISOString()).toBe("2026-10-27T10:00:00.000Z");
    expect(got.publisher).toBe("rbi.org.in");
    expect(got.resolved).toBe(true);
  });

  // Atom's <link> is self-closing, so the element-text picker misses it entirely.
  it("parses an Atom entry whose link is a self-closing rel=alternate", () => {
    const xml = `<feed><entry>
      <title>Deno 2.5 released</title>
      <link rel="alternate" href="https://deno.com/blog/v2.5"/>
      <updated>2026-10-27T10:00:00Z</updated>
      <summary>Faster startup.</summary>
    </entry></feed>`;
    const [got] = parseFeed(xml, feed({ tier: "primary" }));
    expect(got.url).toBe("https://deno.com/blog/v2.5");
    expect(got.title).toBe("Deno 2.5 released");
  });

  it("unwraps CDATA and decodes entities in the title", () => {
    const xml = `<rss><channel><item>
      <title><![CDATA[Tata & Sons: "a long-term bet"]]></title>
      <link>https://a.com/1</link>
    </item></channel></rss>`;
    expect(parseFeed(xml, feed())[0].title).toBe('Tata & Sons: "a long-term bet"');
  });

  it("decodes numeric and named entities", () => {
    const xml = `<rss><channel><item>
      <title>Rupee at &#8377;95 &amp; falling</title>
      <link>https://a.com/2</link>
    </item></channel></rss>`;
    expect(parseFeed(xml, feed())[0].title).toBe("Rupee at ₹95 & falling");
  });

  it("skips items with no title or no usable link", () => {
    const xml = `<rss><channel>
      <item><link>https://a.com/1</link></item>
      <item><title>No link here</title></item>
      <item><title>Bad link</title><link>javascript:alert(1)</link></item>
      <item><title>Good</title><link>https://a.com/4</link></item>
    </channel></rss>`;
    const got = parseFeed(xml, feed());
    expect(got).toHaveLength(1);
    expect(got[0].title).toBe("Good");
  });

  // OpenAI and Hugging Face serve their entire archive in one feed (1287 and 876 items).
  it("caps a huge feed at the 150 newest items", () => {
    const items = Array.from({ length: 200 }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, "0");
      return `<item><title>Post ${i}</title><link>https://a.com/${i}</link>
        <pubDate>2026-10-${day}T00:00:00Z</pubDate></item>`;
    }).join("");
    const got = parseFeed(`<rss><channel>${items}</channel></rss>`, feed());
    expect(got).toHaveLength(150);
  });

  // For an aggregator item the feed name is "Google News", not the newsroom — the real
  // publisher is only in <source url="...">.
  it("takes an aggregator item's publisher from <source url>, not the feed name", () => {
    const xml = `<rss><channel><item>
      <title>Reuters reports on chips</title>
      <link>https://news.google.com/rss/articles/CBMiABC</link>
      <source url="https://www.reuters.com">Reuters</source>
    </item></channel></rss>`;
    const [got] = parseFeed(xml, feed({ tier: "aggregator", name: "Google News" }));
    expect(got.publisher).toBe("reuters.com");
    expect(got.resolved).toBe(false);
  });

  it("returns an empty array for XML with no items rather than throwing", () => {
    expect(parseFeed("<rss><channel></channel></rss>", feed())).toEqual([]);
    expect(parseFeed("", feed())).toEqual([]);
  });
});

describe("the source map itself", () => {
  it("has a unique URL per feed, so no source is polled twice", () => {
    const urls = FEEDS.map((f) => f.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("gives every feed a known category and tier", () => {
    for (const f of FEEDS) {
      expect(["primary", "trusted", "aggregator"], f.name).toContain(f.tier);
      expect(f.url.startsWith("https://"), f.name).toBe(true);
    }
  });
});
