// The redirect allowlist on /authorize, tested as a unit.
//
// This guard is the whole security of implicit-grant account linking: the page hands a live
// API token to whatever address it is given, so "which addresses are acceptable" is the only
// thing standing between a user and an attacker collecting their credential.
//
// The logic is duplicated here rather than imported because authorize.tsx is a route module
// that pulls in AppShell, the Supabase client and the router. That makes this the fourth of
// the five places CLAUDE.md rule 5 lists, and it is kept honest by the last test in this
// file, which asserts the regex source in the route still matches the one under test.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const AMAZON_HOST =
  /(^|\.)amazon\.(com|co\.uk|co\.jp|in|de|fr|it|es|nl|se|pl|com\.au|com\.br|com\.mx|com\.tr|sa|ae|eg|ca|cn|sg)$/i;
const LINK_PATHS = ["/spa/skill/account-linking-status.html", "/api/skill/link/"] as const;

function allowedPath(pathname: string): boolean {
  return LINK_PATHS.some((p) => pathname === p || pathname.startsWith(p));
}

function redirectAllowed(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!AMAZON_HOST.test(url.hostname)) return null;
  if (!allowedPath(url.pathname)) return null;
  return url;
}

/**
 * The exact three URLs the Alexa developer console issued for this skill, copied verbatim
 * from the Account Linking page.
 *
 * Captured input, not invented input — which is the project's fixture rule, and it is the
 * reason these three matter more than the rest of the file. The first version of this guard
 * accepted only `/api/skill/link/{vendorId}`, the path every tutorial and SDK doc shows, and
 * refused all three of these. The hosts were on the allowlist the whole time.
 */
const REAL_CONSOLE_URLS = [
  "https://alexa.amazon.co.jp/spa/skill/account-linking-status.html?vendorId=M1S1ZU9TQ3OZF9",
  "https://layla.amazon.com/spa/skill/account-linking-status.html?vendorId=M1S1ZU9TQ3OZF9",
  "https://pitangui.amazon.com/spa/skill/account-linking-status.html?vendorId=M1S1ZU9TQ3OZF9",
] as const;

describe("the three URLs Amazon actually issued for this skill", () => {
  it.each(REAL_CONSOLE_URLS)("accepts %s", (uri) => {
    expect(redirectAllowed(uri)).not.toBeNull();
  });

  it("preserves the vendorId, which Amazon needs on the way back", () => {
    const got = redirectAllowed(REAL_CONSOLE_URLS[1]);
    expect(got?.searchParams.get("vendorId")).toBe("M1S1ZU9TQ3OZF9");
  });

  it("keeps the query when the token fragment is appended", () => {
    // What the page actually builds: the console URL, its query intact, plus the credential
    // in the fragment. A fragment is never sent to a server, which is why implicit grant
    // uses one.
    const target = redirectAllowed(REAL_CONSOLE_URLS[1])!;
    const final = `${target.toString()}#${new URLSearchParams({
      access_token: "de_example",
      token_type: "Bearer",
      state: "xyz",
    }).toString()}`;
    expect(final).toContain("?vendorId=M1S1ZU9TQ3OZF9#");
    expect(final).toContain("access_token=de_example");
  });
});

describe("accepts the same shape from other marketplaces", () => {
  // Amazon issues one linking host per marketplace and uses whichever matches the account.
  // The console gave three; these are the others in the same shape, so a user signing in
  // from another region is not refused the way the India attempt was.
  it.each([
    "https://alexa.amazon.com/spa/skill/account-linking-status.html?vendorId=M2X",
    "https://alexa.amazon.in/spa/skill/account-linking-status.html?vendorId=M2X",
    "https://alexa.amazon.co.uk/spa/skill/account-linking-status.html?vendorId=M2X",
    "https://alexa.amazon.de/spa/skill/account-linking-status.html?vendorId=M2X",
    "https://alexa.amazon.com.au/spa/skill/account-linking-status.html?vendorId=M2X",
    "https://alexa.amazon.com.br/spa/skill/account-linking-status.html?vendorId=M2X",
  ])("accepts %s", (uri) => {
    expect(redirectAllowed(uri)).not.toBeNull();
  });

  // Kept because Amazon has not retired it and a skill configured years ago may still use
  // it. This is the path the docs show, and the only one the first version accepted.
  it.each([
    "https://layla.amazon.com/api/skill/link/M2ABCDEFG",
    "https://pitangui.amazon.com/api/skill/link/M2ABCDEFG",
    "https://alexa.amazon.co.jp/api/skill/link/M2ABCDEFG",
  ])("still accepts the legacy path %s", (uri) => {
    expect(redirectAllowed(uri)).not.toBeNull();
  });

  it("accepts the bare apex domain, not just subdomains", () => {
    expect(redirectAllowed("https://amazon.com/api/skill/link/M2X")).not.toBeNull();
  });
});

describe("refuses everything else", () => {
  // The attack a suffix check usually ships with. `endsWith("amazon.com")` accepts all of
  // these; the (^|\.) anchor is what makes them fail.
  // The same real path on a lookalike host. endsWith("amazon.com") accepts every one of
  // these; the (^|\.) anchor is what makes them fail. This is the bug this kind of check
  // usually ships with.
  it.each([
    "https://evil-amazon.com/spa/skill/account-linking-status.html?vendorId=M2X",
    "https://notamazon.com/spa/skill/account-linking-status.html?vendorId=M2X",
    "https://amazon.com.evil.net/spa/skill/account-linking-status.html?vendorId=M2X",
    "https://myamazon.in/spa/skill/account-linking-status.html?vendorId=M2X",
    "https://layla.amazon.com.attacker.io/spa/skill/account-linking-status.html",
  ])("refuses the lookalike domain %s", (uri) => {
    expect(redirectAllowed(uri)).toBeNull();
  });

  it("refuses an Amazon host on the wrong path", () => {
    // Amazon owns the host, but this is not a linking callback. Without the path check, any
    // open redirect or user-content page on an Amazon domain becomes a way to exfiltrate
    // the token.
    expect(redirectAllowed("https://layla.amazon.com/gp/wishlist")).toBeNull();
    expect(redirectAllowed("https://alexa.amazon.com/api/skill/")).toBeNull();
    expect(redirectAllowed("https://layla.amazon.com/spa/skill/")).toBeNull();
  });

  it("refuses http, so the token cannot cross the network in clear", () => {
    expect(
      redirectAllowed("http://layla.amazon.com/spa/skill/account-linking-status.html"),
    ).toBeNull();
  });

  it("refuses non-http schemes outright", () => {
    expect(redirectAllowed("javascript:alert(1)")).toBeNull();
    expect(redirectAllowed("data:text/html,<script>1</script>")).toBeNull();
  });

  it("refuses a path that only contains an allowed prefix as a later segment", () => {
    expect(redirectAllowed("https://layla.amazon.com/x/api/skill/link/M2X")).toBeNull();
    expect(
      redirectAllowed("https://layla.amazon.com/evil/spa/skill/account-linking-status.html"),
    ).toBeNull();
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

  it("has the same link paths, both of them", () => {
    for (const p of LINK_PATHS) expect(route).toContain(`"${p}"`);
  });

  it("still checks protocol, host and path", () => {
    expect(route).toContain('url.protocol !== "https:"');
    expect(route).toContain("AMAZON_HOST.test(url.hostname)");
    expect(route).toContain("allowedPath(url.pathname)");
  });
});
