// loadSharedLineConfigStrict tells "the line is off" from "I could not read the line".
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadSharedLineConfig, loadSharedLineConfigStrict } from "@/lib/one-number/config.server";

function dbWith(result: { data: unknown; error: { code?: string } | null } | "throw") {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (result === "throw") throw new Error("network");
            return result;
          },
        }),
      }),
    }),
  } as never;
}

describe("loadSharedLineConfigStrict", () => {
  it("reports a failed read instead of folding it into per_workspace", async () => {
    expect(await loadSharedLineConfigStrict(dbWith({ data: null, error: { code: "XX000" } }))).toEqual({ ok: false });
    expect(await loadSharedLineConfigStrict(dbWith("throw"))).toEqual({ ok: false });
  });

  it("the plain loader keeps failing closed to per_workspace on the same errors", async () => {
    expect((await loadSharedLineConfig(dbWith({ data: null, error: { code: "XX000" } }))).mode).toBe("per_workspace");
    expect((await loadSharedLineConfig(dbWith("throw"))).mode).toBe("per_workspace");
  });

  it("a missing table, column or row (code before the migration) is a successful per_workspace answer", async () => {
    for (const result of [{ data: null, error: { code: "42P01" } }, { data: null, error: { code: "PGRST205" } }, { data: null, error: null }] as const) {
      const read = await loadSharedLineConfigStrict(dbWith(result));
      expect(read).toMatchObject({ ok: true, config: { mode: "per_workspace" } });
    }
  });

  it("a readable shadow row is returned as is", async () => {
    const read = await loadSharedLineConfigStrict(dbWith({ data: { line_mode: "shadow", shared_number_e164: null, shared_pilot_workspace_ids: [] }, error: null }));
    expect(read).toMatchObject({ ok: true, config: { mode: "shadow" } });
  });
});
