import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [] }),
}));

import { getRequestUserFast, isReadMethod } from "@/lib/auth/request-user-fast.server";
import { getUserOrRejection } from "@/lib/auth/session-rejection";
import { getRequestAuthUser } from "@/lib/auth/request-auth-user";

/**
 * `getRequestUserFast` reads the verified token claims instead of a GoTrue
 * round trip. It is for READ handlers only, because claims reflect the token and
 * not a fresh read of the user: a revoked or banned session still reads until the
 * access token expires. A write must never take that path.
 */

const CLAIMS = {
  sub: "11111111-1111-1111-1111-111111111111",
  email: "pat@example.com",
  role: "authenticated",
  user_metadata: { role: "manager" },
  app_metadata: { provider: "email" },
  exp: Math.floor(Date.now() / 1000) + 3600,
};

function client(getClaims: () => Promise<unknown>, getUser?: () => Promise<unknown>) {
  return {
    auth: {
      getClaims: vi.fn(getClaims),
      getUser: vi.fn(getUser ?? (async () => ({ data: { user: null }, error: { message: "Auth session missing!" } }))),
    },
  } as never as {
    auth: { getClaims: ReturnType<typeof vi.fn>; getUser: ReturnType<typeof vi.fn> };
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("getRequestUserFast", () => {
  it("returns a minimal user from valid claims", async () => {
    const c = client(async () => ({ data: { claims: CLAIMS, header: {}, signature: new Uint8Array() }, error: null }));
    const user = await getRequestUserFast(c as never);
    expect(user).toEqual({
      id: CLAIMS.sub,
      email: "pat@example.com",
      user_metadata: { role: "manager" },
      app_metadata: { provider: "email" },
      role: "authenticated",
    });
    expect(c.auth.getUser).not.toHaveBeenCalled();
  });

  it("returns null when getClaims reports an error", async () => {
    const c = client(async () => ({ data: null, error: { message: "invalid JWT" } }));
    expect(await getRequestUserFast(c as never)).toBeNull();
  });

  it("returns null when getClaims returns no claims (no session)", async () => {
    const c = client(async () => ({ data: null, error: null }));
    expect(await getRequestUserFast(c as never)).toBeNull();
  });

  it("returns null for an expired token (getClaims rejects it)", async () => {
    const c = client(async () => ({ data: null, error: { name: "AuthInvalidJwtError", message: "JWT has expired" } }));
    expect(await getRequestUserFast(c as never)).toBeNull();
  });

  it("returns null when the claims carry no subject", async () => {
    const c = client(async () => ({ data: { claims: { ...CLAIMS, sub: "" } }, error: null }));
    expect(await getRequestUserFast(c as never)).toBeNull();
  });

  it("returns null (never throws) when getClaims throws", async () => {
    const c = client(async () => {
      throw new Error("jwks fetch failed");
    });
    expect(await getRequestUserFast(c as never)).toBeNull();
  });

  it("defaults missing metadata to empty objects", async () => {
    const c = client(async () => ({ data: { claims: { sub: CLAIMS.sub } }, error: null }));
    const user = await getRequestUserFast(c as never);
    expect(user?.user_metadata).toEqual({});
    expect(user?.app_metadata).toEqual({});
  });
});

describe("fast path wiring", () => {
  const okClaims = async () => ({ data: { claims: CLAIMS }, error: null });

  it("isReadMethod is GET/HEAD only", () => {
    expect(isReadMethod("GET")).toBe(true);
    expect(isReadMethod("head")).toBe(true);
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "", undefined]) expect(isReadMethod(m)).toBe(false);
  });

  it("getUserOrRejection({ fast }) skips GoTrue on valid claims", async () => {
    const c = client(okClaims);
    const { user } = await getUserOrRejection(c as never, "GET /x", { fast: true });
    expect(user?.id).toBe(CLAIMS.sub);
    expect(c.auth.getUser).not.toHaveBeenCalled();
  });

  it("getUserOrRejection without fast never reads claims", async () => {
    const c = client(okClaims, async () => ({ data: { user: { id: "u" } }, error: null }));
    const { user } = await getUserOrRejection(c as never, "GET /x");
    expect(user?.id).toBe("u");
    expect(c.auth.getClaims).not.toHaveBeenCalled();
  });

  it("a claims failure falls back to getUser, which still decides (fail closed)", async () => {
    const c = client(async () => ({ data: null, error: { message: "invalid JWT" } }));
    const { user, rejection } = await getUserOrRejection(c as never, "GET /x", { fast: true });
    expect(user).toBeNull();
    expect(rejection).toBeDefined();
    expect(c.auth.getUser).toHaveBeenCalledTimes(1);
  });

  it("getRequestAuthUser honors fast for GET but never for POST", async () => {
    const mk = () => client(okClaims, async () => ({ data: { user: { id: "fresh" } }, error: null }));

    const g = mk();
    const got = await getRequestAuthUser(g as never, new Request("http://x/api/a", { method: "GET" }) as never, { fast: true });
    expect(got?.id).toBe(CLAIMS.sub);
    expect(g.auth.getUser).not.toHaveBeenCalled();

    const p = mk();
    const posted = await getRequestAuthUser(p as never, new Request("http://x/api/a", { method: "POST" }) as never, { fast: true });
    expect(posted?.id).toBe("fresh");
    expect(p.auth.getClaims).not.toHaveBeenCalled();
  });

  it("a Bearer token never takes the fast path", async () => {
    const c = client(okClaims, async () => ({ data: { user: { id: "fresh" } }, error: null }));
    const req = new Request("http://x/api/a", { method: "GET", headers: { authorization: "Bearer abc" } });
    const got = await getRequestAuthUser(c as never, req as never, { fast: true });
    expect(got?.id).toBe("fresh");
    expect(c.auth.getClaims).not.toHaveBeenCalled();
  });
});

describe("source guard: the fast path is read-only", () => {
  const API_ROOT = path.resolve(__dirname, "../../src/app/api");
  const MUTATING = ["POST", "PUT", "PATCH", "DELETE"];

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  /** Body of each `export [async] function NAME(...) {...}` / `export const NAME = ...`. */
  function exportedHandlers(src: string): { name: string; body: string }[] {
    const found: { name: string; body: string }[] = [];
    const fn = /export\s+(?:async\s+)?function\s+(GET|HEAD|POST|PUT|PATCH|DELETE)\b[^{]*\{/g;
    for (let m = fn.exec(src); m; m = fn.exec(src)) {
      let depth = 1;
      let i = m.index + m[0].length;
      while (depth > 0 && i < src.length) {
        const ch = src[i++];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      found.push({ name: m[1]!, body: src.slice(m.index, i) });
    }
    const konst = /export\s+const\s+(GET|HEAD|POST|PUT|PATCH|DELETE)\s*=/g;
    for (let m = konst.exec(src); m; m = konst.exec(src)) {
      const rest = src.slice(m.index + m[0].length);
      const next = rest.search(/\nexport\s/);
      found.push({ name: m[1]!, body: src.slice(m.index, m.index + m[0].length + (next === -1 ? rest.length : next)) });
    }
    return found;
  }

  const FAST_USE = /getRequestUserFast|fast\s*:\s*true/;

  it("no POST/PUT/PATCH/DELETE handler uses getRequestUserFast or passes `fast: true`", () => {
    const offenders: string[] = [];
    for (const file of walk(API_ROOT)) {
      const src = readFileSync(file, "utf8");
      if (!FAST_USE.test(src)) continue;
      for (const h of exportedHandlers(src)) {
        if (MUTATING.includes(h.name) && FAST_USE.test(h.body)) offenders.push(`${path.relative(API_ROOT, file)} ${h.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the guard actually sees the converted GET handlers (not vacuous)", () => {
    let readHandlers = 0;
    for (const file of walk(API_ROOT)) {
      const src = readFileSync(file, "utf8");
      if (!FAST_USE.test(src)) continue;
      for (const h of exportedHandlers(src)) if (["GET", "HEAD"].includes(h.name) && FAST_USE.test(h.body)) readHandlers++;
    }
    expect(readHandlers).toBeGreaterThanOrEqual(15);
  });

  it("the parser slices a mutating handler body", () => {
    const sample = `export async function GET() { return a({ fast: true }); }\nexport async function POST() { if (x) { y(); } return b({ fast: true }); }`;
    const hs = exportedHandlers(sample);
    expect(hs.find((h) => h.name === "GET")!.body).not.toContain("POST");
    expect(FAST_USE.test(hs.find((h) => h.name === "POST")!.body)).toBe(true);
  });
});
