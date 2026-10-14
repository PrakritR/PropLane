/**
 * Client-safe host screening for "Other calendar" (`ical`) links. Any https host is allowed (the
 * manager names the site), so the screen is a DENY list of what must never be fetched: loopback,
 * private, link-local and internal names, and IP literals in those ranges. A public-looking name
 * that RESOLVES to a private address is caught at fetch time (`fetchPinnedPublicHttps`), not here.
 */

function ipv4Parts(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number) as [number, number, number, number];
  return parts.every((n) => n <= 255) ? parts : null;
}

function ipv4Private([a, b, c]: [number, number, number, number]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** True when this URL hostname is a name or literal address that a server must never fetch. */
export function isPrivateOrInternalHostname(rawHostname: string): boolean {
  const host = rawHostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (host.includes(":")) {
    // An IPv6 literal: only a clearly global unicast one (2000::/3) passes; the rest is loopback,
    // ULA, link-local, mapped or otherwise not something a calendar lives on.
    return !/^[23][0-9a-f]{0,3}:/.test(host);
  }
  const v4 = ipv4Parts(host);
  if (v4) return ipv4Private(v4);
  // Decimal / hex / octal IPv4 spellings ("2130706433", "0x7f.1") are not hostnames a site would use.
  if (/^[0-9x.]+$/.test(host)) return true;
  if (!host.includes(".")) return true;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home.arpa") ||
    host.endsWith(".intranet")
  );
}
