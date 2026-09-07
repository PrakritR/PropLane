/**
 * SSRF guard for outbound webhook URLs.
 *
 * A webhook endpoint is attacker-chosen by construction — anyone with a manager
 * account types it into a form — and PropLane's server then makes an
 * authenticated-from-the-inside request to it. Without this check the feature is
 * a request forwarder onto the deployment's own network: cloud metadata
 * (169.254.169.254), a private VPC address, or `localhost` reaching another
 * route on the same box.
 *
 * The check runs TWICE by design: at subscribe time, so a bad URL never lands in
 * the table, and again immediately before every delivery, because DNS is not
 * stable — a hostname that resolved to a public address at subscribe time can be
 * re-pointed at 127.0.0.1 an hour later (DNS rebinding). Checking only once is
 * the same bug as checking a permission at create time and never again.
 *
 * This is a literal, allowlist-shaped check on the URL itself (scheme, and the
 * host when it is an IP literal); the delivery path additionally resolves the
 * hostname and re-checks every resolved address. Pure and dependency-free so it
 * can be unit-tested and reused from both places.
 */

export type WebhookUrlRefusal =
  | "invalid"
  | "scheme"
  | "credentials"
  | "port"
  | "private_host";

export type WebhookUrlCheck = { ok: true; url: URL } | { ok: false; reason: WebhookUrlRefusal; message: string };

/** Hostnames that are never a legitimate third-party endpoint. */
const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);
/** `.local` (mDNS) and `.internal` (cloud-private zones) never leave a private network. */
const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".home.arpa"];

function isIpv4Literal(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** RFC1918, loopback, link-local (incl. 169.254.169.254), CGNAT, broadcast, reserved. */
export function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 (TEST-NET-1)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10), and v4-mapped. */
export function isPrivateIpv6(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "::1" || host === "::" || host === "0:0:0:0:0:0:0:1") return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped) {
    const octets = isIpv4Literal(mapped[1]);
    return octets ? isPrivateIpv4(octets) : true;
  }
  const head = host.split(":")[0];
  if (/^f[cd][0-9a-f]{0,2}$/.test(head)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]?$/.test(head)) return true; // fe80::/10
  return false;
}

/** True when a hostname or IP literal must never be dialed. */
export function isPrivateWebhookHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  const octets = isIpv4Literal(host);
  if (octets) return isPrivateIpv4(octets);
  if (host.includes(":") || host.startsWith("[")) return isPrivateIpv6(host);
  // A bare label with no dot ("intranet") only resolves inside a private search
  // domain, so it is never a legitimate public endpoint either.
  if (!host.includes(".")) return true;
  return false;
}

/**
 * Validate a manager-supplied endpoint. `https` only — a signed payload sent in
 * the clear is still readable, and http would also permit a downgrade to a
 * plaintext internal service.
 */
export function checkWebhookUrl(raw: string): WebhookUrlCheck {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return { ok: false, reason: "invalid", message: "Enter a full URL, including https://." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "scheme", message: "Webhook URLs must use https://." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials", message: "Remove the username and password from the URL." };
  }
  // A non-default port is how an internal service is usually reached; keep the
  // surface to the one port a public HTTPS endpoint actually listens on.
  if (url.port && url.port !== "443") {
    return { ok: false, reason: "port", message: "Webhook URLs must use the default HTTPS port." };
  }
  if (isPrivateWebhookHost(url.hostname)) {
    return {
      ok: false,
      reason: "private_host",
      message: "That host is not reachable from the public internet.",
    };
  }
  return { ok: true, url };
}
