import "server-only";

import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

function ipv4Private(a: number, b: number, c: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

function expandIpv6(ip: string): number[] | null {
  let text = ip.split("%")[0]!.toLowerCase();
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = text.slice(0, dotted.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True for any address a published-CSV fetch must never reach. Unparseable counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
    return ipv4Private(a, b, c);
  }
  if (family === 6) {
    const g = expandIpv6(ip);
    if (!g) return true;
    const embeddedV4 = (hi: number, lo: number) => ipv4Private(hi >> 8, hi & 255, lo >> 8);
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      // ::, ::1, IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible
      return g[5] === 0 && g[6] === 0 && g[7]! <= 1 ? true : embeddedV4(g[6]!, g[7]!);
    }
    if (g[0] === 0x64 && g[1] === 0xff9b) return embeddedV4(g[6]!, g[7]!); // NAT64
    if (g[0] === 0x2002) return embeddedV4(g[1]!, g[2]!); // 6to4
    return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xff00) === 0xff00;
  }
  return true;
}

/** Every address of `hostname` when all of them are public, else null. */
export async function resolvePublicAddresses(hostname: string): Promise<string[] | null> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPrivateAddress(host) ? null : [host];
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) return null;
  return addresses.map((entry) => entry.address);
}

/** Resolve every address of `hostname` and require all of them to be public. */
export async function resolvesToPublicAddressesOnly(hostname: string): Promise<boolean> {
  return (await resolvePublicAddresses(hostname)) !== null;
}

/** A host that resolves to an address this fetch must never reach. The message is internal. */
export class NonPublicHostError extends Error {}

/** Only the addresses already vetted are ever connected to; the name still provides SNI and Host. */
function pinnedLookup(hostname: string, addresses: readonly string[]): LookupFunction {
  return ((host: string, options: unknown, callback: (...args: unknown[]) => void) => {
    if (host !== hostname) {
      callback(new NonPublicHostError("unexpected host lookup"));
      return;
    }
    if ((options as { all?: boolean } | null)?.all === true) {
      callback(
        null,
        addresses.map((address) => ({ address, family: isIP(address) })),
      );
      return;
    }
    const first = addresses[0]!;
    callback(null, first, isIP(first));
  }) as unknown as LookupFunction;
}

/**
 * GET one https URL, connecting ONLY to an address resolved and vetted up front.
 *
 * Resolving the name and then handing the NAME to `fetch` lets the second resolution answer
 * differently from the one that was checked (DNS rebinding): a TTL-0 record can say a public address
 * for the check and 169.254.169.254 for the connection. The address is therefore pinned through the
 * agent's own `lookup`, while SNI and the Host header keep the original name so TLS still verifies.
 *
 * Redirects are never followed here — the caller re-vets every hop.
 */
export async function fetchPinnedPublicHttps(
  target: string,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Response> {
  const url = new URL(target);
  if (url.protocol !== "https:") throw new NonPublicHostError("only https is fetched");
  const addresses = await resolvePublicAddresses(url.hostname);
  if (!addresses) throw new NonPublicHostError("host does not resolve to public addresses only");

  return await new Promise<Response>((settle, reject) => {
    const req = httpsRequest(
      {
        host: url.hostname,
        servername: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { host: url.host, "accept-encoding": "identity", ...(init.headers ?? {}) },
        lookup: pinnedLookup(url.hostname, addresses),
      },
      (res) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const one of value) headers.append(name, one);
          else if (typeof value === "string") headers.set(name, value);
        }
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          res.resume();
          settle(new Response(null, { status, headers }));
          return;
        }
        settle(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers }));
      },
    );
    req.setTimeout(init.timeoutMs ?? 15_000, () => req.destroy(new Error("the request timed out")));
    req.on("error", reject);
    req.end();
  });
}
