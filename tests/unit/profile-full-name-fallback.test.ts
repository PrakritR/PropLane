import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveProfileFullName } from "@/lib/auth/profile-name.server";

vi.mock("server-only", () => ({}));

function client(meta: Record<string, unknown> | null) {
  const update = vi.fn(() => ({ eq: () => ({ is: () => Promise.resolve({ error: null }) }) }));
  return {
    update,
    db: {
      auth: { admin: { getUserById: async () => ({ data: { user: meta ? { user_metadata: meta } : null }, error: null }) } },
      from: () => ({ update }),
    } as unknown as SupabaseClient,
  };
}

describe("a resident's name survives signup (profiles.full_name was left null)", () => {
  it("keeps the profile's own name", async () => {
    const { db, update } = client({ full_name: "Meta Name" });
    await expect(resolveProfileFullName(db, "u1", "  Lena Longterm ")).resolves.toBe("Lena Longterm");
    expect(update).not.toHaveBeenCalled();
  });

  it("falls back to the name typed at signup and writes it back to the profile", async () => {
    const { db, update } = client({ full_name: "Wanda Webfix" });
    await expect(resolveProfileFullName(db, "u1", null)).resolves.toBe("Wanda Webfix");
    expect(update).toHaveBeenCalledWith({ full_name: "Wanda Webfix" });
  });

  it("is empty when no name exists anywhere", async () => {
    const { db } = client({});
    await expect(resolveProfileFullName(db, "u1", "")).resolves.toBe("");
  });

  it("is wired into the guest stay readers, the profile read and the signup write", () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(read("src/app/api/resident/stays/route.ts")).toContain("resolveProfileFullName");
    expect(read("src/lib/short-stay/guest-stays.server.ts")).toContain("resolveProfileFullName");
    expect(read("src/app/api/profile/route.ts")).toContain("resolveProfileFullName");
    expect(read("src/app/api/auth/signup/route.ts")).toContain("full_name: fullName");
  });
});
