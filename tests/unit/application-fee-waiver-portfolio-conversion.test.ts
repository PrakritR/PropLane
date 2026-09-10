/**
 * Converting a PORTFOLIO-wide waiver code into a per-property one is an
 * owner-only act.
 *
 * `upsertPropertyApplicationFeeWaiverCode` is always called with the property
 * OWNER's id — that is what makes redemption (which looks codes up under the
 * owner) find a code a co-manager set. So it cannot tell an owner from a
 * property-scoped co-manager on its own, and the caller has to say. Without
 * that, a co-manager assigned to one house could type the owner's account-wide
 * code and pin it to that house, charging the full application fee on every
 * other listing with no manager action and no notification.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  previewApplicationFeeWaiverCodeWrite,
  previewPropertyApplicationFeeWaiverCodeWrite,
  setPrimaryApplicationFeeWaiverCode,
  upsertPropertyApplicationFeeWaiverCode,
} from "@/lib/application-fee-waiver";

const OWNER = "owner-1";
const PROPERTY = "prop-3";

type Row = {
  id: string;
  manager_user_id: string;
  code: string;
  code_normalized: string;
  label: string | null;
  property_id: string | null;
  status: string;
  max_uses: number | null;
  used_count: number;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

let rows: Row[] = [];
let nextId = 0;

function seed(partial: Partial<Row> & { code: string }): Row {
  const row: Row = {
    id: `code-${++nextId}`,
    manager_user_id: OWNER,
    code: partial.code,
    code_normalized: partial.code,
    label: partial.label ?? null,
    property_id: partial.property_id ?? null,
    status: partial.status ?? "active",
    max_uses: null,
    used_count: 0,
    expires_at: null,
    created_at: new Date(2026, 0, 1).toISOString(),
    revoked_at: null,
  };
  rows.push(row);
  return row;
}

/** Just enough PostgREST for the three calls this function makes. */
function makeDb(): SupabaseClient {
  return {
    from() {
      let pendingUpdate: Partial<Row> | null = null;
      let pendingInsert: Partial<Row> | null = null;
      const filters: Record<string, string> = {};
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: async () => ({ data: rows.map((r) => ({ ...r })), error: null }),
        update: (patch: Partial<Row>) => {
          pendingUpdate = patch;
          return builder;
        },
        insert: (values: Partial<Row>) => {
          pendingInsert = values;
          return builder;
        },
        eq: (column: string, value: string) => {
          filters[column] = value;
          return builder;
        },
        maybeSingle: async () => {
          const target = rows.find(
            (r) => r.id === filters.id && r.manager_user_id === filters.manager_user_id,
          );
          if (!target) return { data: null, error: null };
          if (pendingUpdate) Object.assign(target, pendingUpdate);
          return { data: { id: target.id }, error: null };
        },
        // The conversion update is awaited straight off the builder, with no
        // `.select()` — so the builder itself has to be thenable.
        then: (resolve: (v: unknown) => unknown) => {
          const target = rows.find(
            (r) => r.id === filters.id && r.manager_user_id === filters.manager_user_id,
          );
          if (target && pendingUpdate) Object.assign(target, pendingUpdate);
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
        single: async () => {
          const created = seed({
            code: String(pendingInsert?.code ?? ""),
            label: pendingInsert?.label ?? null,
            property_id: pendingInsert?.property_id ?? null,
          });
          return { data: { ...created }, error: null };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  rows = [];
  nextId = 0;
});

describe("a portfolio-wide code", () => {
  it("is NOT re-scoped when the caller is not the owner", async () => {
    const portfolio = seed({ code: "FREE100", property_id: null });

    const result = await upsertPropertyApplicationFeeWaiverCode(
      makeDb(),
      OWNER,
      PROPERTY,
      "FREE100",
      { allowPortfolioConversion: false },
    );

    expect(result.ok).toBe(false);
    // The row is untouched, so it still waives the fee on every other listing.
    expect(portfolio.property_id).toBeNull();
    expect(portfolio.status).toBe("active");
  });

  it("is refused by default, so a caller that forgets to say gets the safe answer", async () => {
    const portfolio = seed({ code: "FREE100", property_id: null });

    const result = await upsertPropertyApplicationFeeWaiverCode(makeDb(), OWNER, PROPERTY, "FREE100");

    expect(result.ok).toBe(false);
    expect(portfolio.property_id).toBeNull();
  });

  it("leaves the property's OWN existing code alone when the conversion is refused", async () => {
    seed({ code: "FREE100", property_id: null });
    const existingOnThisProperty = seed({
      code: "SPRING",
      property_id: PROPERTY,
      label: `listing:${PROPERTY}`,
    });

    const result = await upsertPropertyApplicationFeeWaiverCode(
      makeDb(),
      OWNER,
      PROPERTY,
      "FREE100",
      { allowPortfolioConversion: false },
    );

    expect(result.ok).toBe(false);
    // The revoke sweep must not have run: a rejected save changes nothing.
    expect(existingOnThisProperty.status).toBe("active");
  });

  it("is converted when the owner asks for it", async () => {
    const portfolio = seed({ code: "FREE100", property_id: null });

    const result = await upsertPropertyApplicationFeeWaiverCode(
      makeDb(),
      OWNER,
      PROPERTY,
      "FREE100",
      { allowPortfolioConversion: true },
    );

    expect(result.ok).toBe(true);
    expect(portfolio.property_id).toBe(PROPERTY);
    expect(portfolio.label).toBe(`listing:${PROPERTY}`);
  });
});

describe("ordinary per-property saves are unaffected", () => {
  it("creates a brand-new code for the property", async () => {
    const result = await upsertPropertyApplicationFeeWaiverCode(
      makeDb(),
      OWNER,
      PROPERTY,
      "WELCOME50",
      { allowPortfolioConversion: false },
    );

    expect(result.ok).toBe(true);
    expect(rows.find((r) => r.code === "WELCOME50")?.property_id).toBe(PROPERTY);
  });

  it("still refuses a code already live on ANOTHER property", async () => {
    seed({ code: "SHARED", property_id: "prop-other", label: "listing:prop-other" });

    const result = await upsertPropertyApplicationFeeWaiverCode(
      makeDb(),
      OWNER,
      PROPERTY,
      "SHARED",
      { allowPortfolioConversion: true },
    );

    expect(result.ok).toBe(false);
  });

  it("keeps re-saving this property's own code idempotent", async () => {
    const mine = seed({ code: "MINE", property_id: PROPERTY, label: `listing:${PROPERTY}` });

    const result = await upsertPropertyApplicationFeeWaiverCode(
      makeDb(),
      OWNER,
      PROPERTY,
      "MINE",
      { allowPortfolioConversion: false },
    );

    expect(result.ok).toBe(true);
    expect(mine.status).toBe("active");
    expect(rows.filter((r) => r.status === "active").length).toBe(1);
  });
});

describe("the read-only precheck answers exactly what the write would", () => {
  it("reports the cross-property conflict without touching a row", async () => {
    const other = seed({ code: "SHARED", property_id: "prop-other", label: "listing:prop-other" });

    const preview = await previewPropertyApplicationFeeWaiverCodeWrite(makeDb(), OWNER, PROPERTY, "SHARED");

    expect(preview.ok).toBe(false);
    expect(preview.ok === false && preview.error).toContain("already in use on another property");
    expect(other.property_id).toBe("prop-other");
    expect(rows).toHaveLength(1);
  });

  it("reports the owner-only portfolio conversion, and clears it for the owner", async () => {
    seed({ code: "FREE100", property_id: null });

    const delegate = await previewPropertyApplicationFeeWaiverCodeWrite(makeDb(), OWNER, PROPERTY, "FREE100", {
      allowPortfolioConversion: false,
    });
    expect(delegate.ok).toBe(false);

    const owner = await previewPropertyApplicationFeeWaiverCodeWrite(makeDb(), OWNER, PROPERTY, "FREE100", {
      allowPortfolioConversion: true,
    });
    expect(owner.ok).toBe(true);
    // Still a read: nothing moved.
    expect(rows[0]!.property_id).toBeNull();
  });

  it("passes a code this property already owns, and a clear", async () => {
    seed({ code: "MINE", property_id: PROPERTY, label: `listing:${PROPERTY}` });

    expect((await previewPropertyApplicationFeeWaiverCodeWrite(makeDb(), OWNER, PROPERTY, "MINE")).ok).toBe(true);
    expect((await previewPropertyApplicationFeeWaiverCodeWrite(makeDb(), OWNER, PROPERTY, "")).ok).toBe(true);
    expect(rows[0]!.status).toBe("active");
  });

  it("rejects a malformed code the same way the write does", async () => {
    const preview = await previewPropertyApplicationFeeWaiverCodeWrite(makeDb(), OWNER, PROPERTY, "no");
    expect(preview.ok).toBe(false);
    expect(preview.ok === false && preview.error).toContain("4-32 letters");
  });
});

/**
 * Re-typing a code that was REVOKED earlier.
 *
 * The unique index is `(manager_user_id, code_normalized)` and ignores status, so
 * the retired row still owns its text. Nothing caught that: the plan saw no
 * ACTIVE collision, the listing/settings write committed, the property's live
 * code was revoked, and only then did the insert come back 23505 — leaving the
 * save reported as failed with no working code at all.
 */
describe("a code text that belongs to a retired row", () => {
  it("is refused before anything is written, leaving the live code active", async () => {
    seed({ code: "SPRING", property_id: PROPERTY, label: `listing:${PROPERTY}`, status: "revoked" });
    const live = seed({ code: "SUMMER", property_id: PROPERTY, label: `listing:${PROPERTY}` });

    const result = await upsertPropertyApplicationFeeWaiverCode(
      makeDb(),
      OWNER,
      PROPERTY,
      "SPRING",
      { allowPortfolioConversion: true },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("retired");
    // The revoke sweep never ran and no second row was created.
    expect(live.status).toBe("active");
    expect(rows).toHaveLength(2);
  });

  it("is reported by the read-only precheck, so the listing save refuses first", async () => {
    seed({ code: "SPRING", property_id: PROPERTY, label: `listing:${PROPERTY}`, status: "revoked" });

    const preview = await previewPropertyApplicationFeeWaiverCodeWrite(makeDb(), OWNER, PROPERTY, "SPRING");

    expect(preview.ok).toBe(false);
    expect(preview.ok === false && preview.error).toContain("retired");
  });

  it("is refused when the retired row sat on ANOTHER property too", async () => {
    seed({ code: "SPRING", property_id: "prop-other", label: "listing:prop-other", status: "revoked" });

    const preview = await previewPropertyApplicationFeeWaiverCodeWrite(makeDb(), OWNER, PROPERTY, "SPRING");

    expect(preview.ok).toBe(false);
    expect(preview.ok === false && preview.error).toContain("retired");
  });

  it("is refused on the PORTFOLIO path as well, before the active code is swept", async () => {
    seed({ code: "SPRING", property_id: null, status: "revoked" });
    const live = seed({ code: "SUMMER", property_id: null });

    const preview = await previewApplicationFeeWaiverCodeWrite(makeDb(), OWNER, "", "SPRING");
    expect(preview.ok).toBe(false);

    const result = await setPrimaryApplicationFeeWaiverCode(makeDb(), OWNER, "SPRING");
    expect(result.ok).toBe(false);
    expect(live.status).toBe("active");
    expect(rows).toHaveLength(2);
  });

  it("still lets an unrelated new text through on both paths", async () => {
    seed({ code: "SPRING", property_id: PROPERTY, label: `listing:${PROPERTY}`, status: "revoked" });

    expect((await previewPropertyApplicationFeeWaiverCodeWrite(makeDb(), OWNER, PROPERTY, "AUTUMN")).ok).toBe(true);
    expect((await previewApplicationFeeWaiverCodeWrite(makeDb(), OWNER, "", "AUTUMN")).ok).toBe(true);
  });
});
