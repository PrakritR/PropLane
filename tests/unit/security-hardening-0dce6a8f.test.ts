/**
 * Regression guards for the security fixes from the full-project review at
 * 0dce6a8f. Each one pins the specific mechanism that was exploitable, so a
 * later refactor that reintroduces it fails here rather than in production.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clientIpFrom } from "@/lib/rate-limit";
import { documentStoragePathBelongsToOwner } from "@/lib/documents/manager-documents";

const repoRoot = path.resolve(__dirname, "../..");

/**
 * Source with comments stripped.
 *
 * These guards assert on the shape of real code, and several of the files
 * DESCRIBE the vulnerable shape in a comment so the next reader knows why the
 * current one exists. Matching raw text would then fail on the explanation
 * rather than the defect.
 */
function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("client IP derivation (rate-limit keying)", () => {
  // A proxy APPENDS the address it saw, so the LAST hop is the one our own
  // infrastructure observed and the first is attacker-chosen. Keying on the
  // first made every IP limit in the product bypassable by rotating a header.
  it("takes the last x-forwarded-for hop, not the caller-supplied first", () => {
    const req = new Request("https://prop-lane.space/api/whatever", {
      headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" },
    });
    expect(clientIpFrom(req)).toBe("3.3.3.3");
  });

  it("cannot be steered by a spoofed single-value header", () => {
    const spoofed = new Request("https://prop-lane.space/api/whatever", {
      headers: { "x-forwarded-for": "9.9.9.9", "x-vercel-forwarded-for": "3.3.3.3" },
    });
    // Vercel sets its own header and a caller cannot append to it, so it wins.
    expect(clientIpFrom(spoofed)).toBe("3.3.3.3");
  });

  it("falls back to x-real-ip, then unknown", () => {
    expect(
      clientIpFrom(new Request("https://x/", { headers: { "x-real-ip": "4.4.4.4" } })),
    ).toBe("4.4.4.4");
    expect(clientIpFrom(new Request("https://x/"))).toBe("unknown");
  });
});

describe("manager document storage paths", () => {
  // The signed-url routes authorize the ROW and then sign `storage_path` with
  // the SERVICE-ROLE client, which bypasses the folder-scoped storage policy.
  // A row whose path and owner disagree is what a planted row looks like.
  it("accepts a path under the row owner's own folder", () => {
    expect(documentStoragePathBelongsToOwner("manager/owner-1/123-abc.pdf", "owner-1")).toBe(true);
  });

  it("rejects a path pointing at another manager's folder", () => {
    expect(documentStoragePathBelongsToOwner("manager/victim-2/lease.pdf", "attacker-1")).toBe(false);
  });

  it("rejects prefix-collision and traversal shapes", () => {
    // `owner-1` must not match `owner-10`'s folder.
    expect(documentStoragePathBelongsToOwner("manager/owner-10/x.pdf", "owner-1")).toBe(false);
    expect(documentStoragePathBelongsToOwner("manager/owner-1/../owner-2/x.pdf", "owner-2")).toBe(false);
    expect(documentStoragePathBelongsToOwner("", "owner-1")).toBe(false);
    expect(documentStoragePathBelongsToOwner("manager/owner-1/x.pdf", "")).toBe(false);
    expect(documentStoragePathBelongsToOwner("manager/owner-1/x.pdf", null)).toBe(false);
  });
});

describe("work-order completion cannot re-own another manager's row", () => {
  const source = read("src/app/api/portal/work-orders/complete/route.ts");

  it("selects the stored owner and refuses a foreign row", () => {
    expect(source).toContain('.select("manager_user_id, row_data")');
    expect(source).toMatch(/existing\.manager_user_id !== auth\.userId/);
    expect(source).toMatch(/status: 403/);
  });

  it("writes the stored owner rather than stamping the caller", () => {
    expect(source).toContain("manager_user_id: ownerManagerUserId");
    expect(source).not.toMatch(/manager_user_id:\s*auth\.userId/);
  });
});

describe("application PDF route cannot inject PostgREST filters", () => {
  const source = read("src/app/api/manager-applications/[id]/pdf/route.ts");

  it("uses a parameterized .in() rather than a concatenated .or()", () => {
    expect(source).toContain('.in("id", ids)');
    // The vulnerable shape interpolated the raw path segment into a filter
    // string on the service-role client.
    expect(source).not.toMatch(/\.or\(\s*ids\.map/);
    expect(source).not.toContain("`id.eq.${");
  });

  it("still validates the id charset before querying", () => {
    expect(source).toMatch(/APPLICATION_ID_PATTERN\s*=\s*\/\^\[A-Za-z0-9\._-\]\+\$\//);
  });
});

describe("work-number backfill cron fails closed in production", () => {
  const source = read("src/app/api/cron/backfill-manager-work-numbers/route.ts");

  it("uses the same absent-secret fallback as every other cron route", () => {
    // The vulnerable shape was `if (cronSecret && …)`, which skipped the check
    // entirely when the secret was unset — in production too.
    expect(source).toContain("if (!cronSecret) return !isProductionRuntime();");
    expect(source).not.toMatch(/if\s*\(\s*cronSecret\s*&&/);
  });

  it("does not return provisioned numbers in the response body", () => {
    expect(source).not.toMatch(/\.\.\.result\b/);
  });
});

describe("x-pathname is server-derived, never caller-supplied", () => {
  const source = read("src/middleware.ts");

  it("strips any inbound value and forwards its own on the request", () => {
    expect(source).toContain('headers.delete("x-pathname")');
    expect(source).toContain('headers.set("x-pathname", path)');
    // Forwarding on the REQUEST is what makes it readable by `headers()` in a
    // server component; setting it only on the response left the layout reading
    // whatever the caller sent, which gated a role-check bypass.
    expect(source).toMatch(/return \{ request: \{ headers \} \}/);
  });
});
