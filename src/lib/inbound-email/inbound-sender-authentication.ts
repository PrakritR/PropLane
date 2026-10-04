/**
 * Did the receiving mail system authenticate the sender for the domain it
 * CLAIMS in From?
 *
 * The Svix signature on the inbound webhook only proves the event came from
 * Resend, never that `From: victim@example.com` was really sent by example.com.
 * Anyone can type that header. Anything that attributes the message to the
 * person named in From (a copy in THEIR thread, a send "as" them) must first
 * pass this gate.
 *
 * The signal is the `Authentication-Results` header (RFC 8601) that the
 * receiving server stamps on the message: `dkim=pass header.d=<domain>` or
 * `spf=pass smtp.mailfrom=<addr>`, with the authenticated domain ALIGNED to the
 * From domain (the same domain, or one a parent of the other's subdomain). The
 * header is only consulted when it is present; no header, no pass, an
 * unparseable one, a fail/neutral/none result, or a pass for some OTHER domain
 * all answer false. Pure function; fails closed.
 */

export type InboundHeaders = Record<string, string | string[]> | Array<{ name?: unknown; value?: unknown }>;

/** Normalise the two shapes a provider uses (object map or `[{name,value}]`) to lower-cased names. */
export function normalizeInboundHeaders(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (name: unknown, value: unknown) => {
    if (typeof name !== "string" || !name.trim()) return;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (typeof v !== "string" || !v.trim()) continue;
      (out[name.trim().toLowerCase()] ??= []).push(v);
    }
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry && typeof entry === "object") add((entry as { name?: unknown }).name, (entry as { value?: unknown }).value);
    }
  } else if (raw && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) add(name, value);
  }
  return out;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return (at >= 0 ? address.slice(at + 1) : address).replace(/[>\s]/g, "").toLowerCase();
}

/** Relaxed alignment: identical, or one is a subdomain of the other (never a bare TLD). */
function aligned(authenticated: string, fromDomain: string): boolean {
  const a = authenticated.toLowerCase().replace(/\.$/, "");
  const f = fromDomain.toLowerCase().replace(/\.$/, "");
  if (!a.includes(".") || !f.includes(".")) return false;
  return a === f || f.endsWith(`.${a}`) || a.endsWith(`.${f}`);
}

export function inboundSenderAuthenticated(rawHeaders: unknown, fromAddress: string): boolean {
  const fromDomain = domainOf(fromAddress);
  if (!fromDomain.includes(".")) return false;
  const values = normalizeInboundHeaders(rawHeaders)["authentication-results"];
  // Only the topmost header: a receiver PREPENDS its own, so lower ones may
  // have been supplied by the sender.
  const header = values?.[0];
  if (!header) return false;

  for (const clause of header.split(";").slice(1)) {
    const text = clause.replace(/\([^)]*\)/g, " ").trim().toLowerCase();
    const method = text.match(/^(dkim|spf)\s*=\s*(\w+)/);
    if (!method || method[2] !== "pass") continue;
    if (method[1] === "dkim") {
      const d = text.match(/header\.(?:d|i)\s*=\s*"?@?([^\s;"]+)/);
      if (d && aligned(domainOf(d[1]!), fromDomain)) return true;
    } else {
      const mailFrom = text.match(/smtp\.mailfrom\s*=\s*"?([^\s;"]+)/);
      if (mailFrom && aligned(domainOf(mailFrom[1]!), fromDomain)) return true;
    }
  }
  return false;
}
