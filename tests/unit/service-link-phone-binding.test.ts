/**
 * A texted service link carries the number the MANAGER typed. The vendor who
 * redeems it has not been shown to hold that number — a link can be forwarded —
 * so it never becomes the roster row's `phone`, which is what the inbound SMS
 * pipeline reads as identity. Until verification says otherwise the number is
 * `linkPhone`, and the routing readers ignore an unverified service-link row.
 *
 * Also here: the HMAC keys behind the vendor calendar feed and the work-number
 * claim token refuse to sign at all when the service role key is missing,
 * rather than falling back to a literal anybody could read out of the source.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rosterPhoneIdentifiesVendor } from "@/lib/manager-vendors-storage";
import { routeUnrecognizedInboundText } from "@/lib/sms/inbound-text-routing.server";
import { featureSigningSecret } from "@/lib/feature-signing-secret.server";

type Row = Record<string, unknown>;

function database(seed: Record<string, Row[]> = {}) {
  const rows: Record<string, Row[]> = structuredClone(seed);
  const db = {
    from(table: string) {
      const predicates: ((row: Row) => boolean)[] = [];
      let maxRows = Infinity;
      const query = {
        select() { return query; },
        eq(column: string, value: unknown) { predicates.push((row) => row[column] === value); return query; },
        in(column: string, values: unknown[]) { predicates.push((row) => values.includes(row[column])); return query; },
        not(column: string, _op: string, value: unknown) { predicates.push((row) => (value === null ? row[column] != null : row[column] !== value)); return query; },
        like(column: string, pattern: string) { const re = new RegExp(`^${pattern.replace(/%/g, ".*")}$`); predicates.push((row) => re.test(String(row[column] ?? ""))); return query; },
        gte(column: string, value: unknown) { predicates.push((row) => String(row[column] ?? "") >= String(value)); return query; },
        order() { return query; },
        limit(n: number) { maxRows = n; return query; },
        async maybeSingle() {
          return { data: (rows[table] ?? []).find((row) => predicates.every((p) => p(row))) ?? null, error: null };
        },
        async upsert(value: Row) {
          const list = (rows[table] ??= []);
          const at = list.findIndex((row) => row.id === value.id);
          if (at === -1) list.push(value);
          else list[at] = value;
          return { error: null };
        },
        then(resolve: (result: { data: Row[]; error: null }) => void) {
          resolve({ data: (rows[table] ?? []).filter((row) => predicates.every((p) => p(row))).slice(0, maxRows), error: null });
        },
      };
      return query;
    },
  };
  return { db: db as never, rows };
}

const MANAGER = "mgr-seattle";
const VICTIM_PHONE = "+12065550199";

/** The roster row a forwarded link used to write for whoever redeemed it. */
const forwardedLinkRow = {
  id: "vendor-b",
  manager_user_id: MANAGER,
  vendor_user_id: "u-vendor-b",
  row_data: {
    id: "vendor-b",
    name: "Vendor B",
    active: true,
    vendorUserId: "u-vendor-b",
    origin: "service_link",
    contactHeldUntilBid: true,
    phone: VICTIM_PHONE,
    phoneVerified: false,
  },
};

describe("an unverified service-link phone is not identity", () => {
  it("the predicate answers for every row shape", () => {
    expect(rosterPhoneIdentifiesVendor({ origin: "service_link", phoneVerified: false })).toBe(false);
    expect(rosterPhoneIdentifiesVendor({ origin: "service_link" })).toBe(false);
    expect(rosterPhoneIdentifiesVendor({ origin: "service_link", phoneVerified: true })).toBe(true);
    expect(rosterPhoneIdentifiesVendor({ origin: "work_board" })).toBe(true);
    // A vendor the manager added by hand has no origin at all.
    expect(rosterPhoneIdentifiesVendor({})).toBe(true);
    expect(rosterPhoneIdentifiesVendor(null)).toBe(false);
  });

  it("the real recipient's text is never filed under the vendor who opened the forwarded link", async () => {
    const { db } = database({ manager_vendor_records: [forwardedLinkRow] });
    const routed = await routeUnrecognizedInboundText(db, {
      managerUserId: MANAGER,
      workspaceId: "ws-seattle",
      fromPhone: VICTIM_PHONE,
      body: "Hi, is Room 3 still available?",
    });
    expect(routed).not.toMatchObject({ vendorId: "vendor-b" });
    expect(routed).not.toMatchObject({ vendorUserId: "u-vendor-b" });
  });

  it("the same row once verified IS that vendor again", async () => {
    const verified = { ...forwardedLinkRow, row_data: { ...forwardedLinkRow.row_data, phoneVerified: true } };
    const { db } = database({ manager_vendor_records: [verified] });
    const routed = await routeUnrecognizedInboundText(db, {
      managerUserId: MANAGER,
      fromPhone: VICTIM_PHONE,
      body: "On my way",
    });
    expect(routed).toMatchObject({ kind: "vendor", vendorId: "vendor-b", vendorUserId: "u-vendor-b" });
  });

  it("the redeem path writes the texted number as linkPhone, never as phone, and promotes it on verification", () => {
    const src = readFileSync("src/lib/service-work-board.server.ts", "utf8");
    const roster = src.slice(src.indexOf("async function ensureHeldVendorRosterRow"));
    expect(roster.slice(0, roster.indexOf("\n}"))).toContain('phone: "",');
    expect(src).toContain('linkPhone: input.knownPhone.trim(), phoneVerified: false');
    expect(src).toMatch(/phoneVerified: true,[\s\S]*phone: linkPhone/);
  });

  it("both routing readers skip an unverified link row and read in a deterministic order", () => {
    for (const file of ["src/lib/sms/inbound-text-routing.server.ts", "src/lib/vendor-work-identity.server.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toContain("rosterPhoneIdentifiesVendor");
      expect(src, file).toContain('.order("id", { ascending: true })');
    }
  });
});

describe("feature signing secrets fail closed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the service role key when it is set", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
    expect(featureSigningSecret("vendor-calendar-feed")).toBe("service-role-key");
  });

  it("refuses to sign on a real runtime with no key, instead of using a published literal", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => featureSigningSecret("vendor-calendar-feed")).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("gives the test runner a per-feature stand-in, so two features never share a key", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    vi.stubEnv("NODE_ENV", "test");
    expect(featureSigningSecret("a")).not.toBe(featureSigningSecret("b"));
  });

  it("no module keeps a literal secret fallback", () => {
    for (const file of ["src/lib/vendor-calendar-feed.server.ts", "src/lib/vendor-work-number-claim-token.server.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toContain("featureSigningSecret(");
      expect(src.includes('SUPABASE_SERVICE_ROLE_KEY ?? "'), file).toBe(false);
    }
  });
});
