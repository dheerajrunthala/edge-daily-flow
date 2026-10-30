// The redirect allowlist on /authorize, tested as a unit.
//
// This guard is the whole security of implicit-grant account linking: the page hands a live
// API token to whatever address it is given, so "which addresses are acceptable" is the only
// thing standing between a user and an attacker collecting their credential.
//
// The logic is duplicated here rather than imported because authorize.tsx is a route module
// that pulls in AppShell, the Supabase client and the router. That is a fourth mirrored pair,
// and the pair is kept honest by the last test in this file, which asserts the regex source
// in the route still matches the one under test.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const AMAZON_HOST =
  /(^|\.)amazon\.(com|co\.uk|co\.jp|in|de|fr|it|es|nl|se|pl|com\.au|com\.br|com\.mx|com\.tr|sa|ae|eg|ca|cn|sg)$/i;
const LINK_PATH = "/api/skill/link/";

function redirectAllowed(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!AMAZON_HOST.test(url.hostname)) return null;
  if (!url.pathname.startsWith(LINK_PATH)) return null;
  return url;
}

describe("accepts Amazon's real linking callbacks", () => {
  // The three every tutorial lists, plus the regional hosts that the original fixed
  // allowlist rejected — which is the bug this file exists because of. A link attempt from
  // India failed against the four-host version.
  it.each([
    "https://layla.amazon.com/api/skill/link/M2ABCDEFG",
    "https://pitangui.amazon.com/api/skill/link/M2ABCDEFG",
    "https://alexa.amazon.co.jp/api/skill/link/M2ABCDEFG",
    "https://alexa.amazon.com/api/skill/link/M2ABCDEFG",
    "https://alexa.amazon.in/api/skill/link/M2ABCDEFG",
    "https://alexa.amazon.co.uk/api/skill/link/M2ABCDEFG",
    "https://alexa.amazon.de/api/skill/link/M2ABCDEFG",
    "https://alexa.amazon.com.au/api/skill/link/M2ABCDEFG",
    "https://alexa.amazon.com.br/api/skill/link/M2ABCDEFG",
  ])("accepts %s", (uri) => {
    expect(redirectAllowed(uri)).not.toBeNull();
  });

  it("accepts the bare apex domain, not just subdomains", () => {
    expect(redirectAllowed("https://amazon.com/api/skill/link/M2X")).not.toBeNull();
  });

  it("keeps the query string, which carries Amazon's own parameters", () => {
    const got = redirectAllowed("https://layla.amazon.com/api/skill/link/M2X?foo=bar");
    expect(got?.search).toBe("?foo=bar");
  });
});

describe("refuses everything else", () => {
  // The attack a suffix check usually ships with. `endsWith("amazon.com")` accepts all of
  // these; the (^|\.) anchor is what makes them fail.
  it.each([
    "https://evil-amazon.com/api/skill/link/M2X",
    "https://notamazon.com/api/skill/link/M2X",
    "https://amazon.com.evil.net/api/skill/link/M2X",
    "https://myamazon.in/api/skill/link/M2X",
  ])("refuses the lookalike domain %s", (uri) => {
    expect(redirectAllowed(uri)).toBeNull();
  });

  it("refuses an Amazon host on the wrong path", () => {
    // Amazon owns the host, but this is not the account-linking callback. Without the path
    // check, any open redirect or user-content page on an Amazon domain becomes a way to
    // exfiltrate the token.
    expect(redirectAllowed("https://layla.amazon.com/gp/wishlist")).toBeNull();
    expect(redirectAllowed("https://alexa.amazon.com/api/skill/")).toBeNull();
  });

  it("refuses http, so the token cannot cross the network in clear", () => {
    expect(redirectAllowed("http://layla.amazon.com/api/skill/link/M2X")).toBeNull();
  });

  it("refuses non-http schemes outright", () => {
    expect(redirectAllowed("javascript:alert(1)")).toBeNull();
    expect(redirectAllowed("data:text/html,<script>1</script>")).toBeNull();
  });

  it("refuses a path that only contains the prefix as a later segment", () => {
    expect(redirectAllowed("https://layla.amazon.com/x/api/skill/link/M2X")).toBeNull();
  });

  it("refuses junk and empty input rather than throwing", () => {
    expect(redirectAllowed("")).toBeNull();
    expect(redirectAllowed("not a url")).toBeNull();
    expect(redirectAllowed("/api/skill/link/M2X")).toBeNull();
  });
});

describe("the route's copy of the rule matches this one", () => {
  // The mirrored-pair guard. If someone widens the regex in authorize.tsx to unblock a
  // region, these tests would otherwise keep passing against the old rule and prove nothing.
  const route = readFileSync("src/routes/_authenticated/authorize.tsx", "utf8");

  it("has the same host pattern", () => {
    expect(route).toContain(AMAZON_HOST.source);
  });

  it("has the same link path", () => {
    expect(route).toContain(`"${LINK_PATH}"`);
  });

  it("still checks protocol, host and path", () => {
    expect(route).toContain('url.protocol !== "https:"');
    expect(route).toContain("AMAZON_HOST.test(url.hostname)");
    expect(route).toContain("url.pathname.startsWith(LINK_PATH)");
  });
});
