// The per-client-workspace first-text attestation reader, and the fail-closed workspace line read.
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import { readVendorWorkspaceAttestation } from "@/lib/sms/vendor-conversation-consent.server";
import { resolveWorkspaceSendLine } from "@/lib/sms/manager-number-provisioning.server";

function chainDb(result: { data?: unknown; error?: unknown }) {
  const eqs: Array<[string, unknown]> = [];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (column: string, value: unknown) => { eqs.push([column, value]); return chain; };
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.in = () => chain;
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: result.data ?? [], error: result.error ?? null });
  return { db: { from: () => chain } as unknown as SupabaseClient, eqs };
}

describe("readVendorWorkspaceAttestation", () => {
  it("looks for the attestation scoped to the client workspace", async () => {
    const { db, eqs } = chainDb({ data: [{ source: "manager_attested_vendor_relationship" }] });
    expect(await readVendorWorkspaceAttestation(db, { managerUserId: "so", phone: "+12065550301", workspaceId: "ws-1" })).toEqual({ ok: true, attested: true });
    expect(eqs).toContainEqual(["evidence->>clientWorkspaceId", "ws-1"]);
    expect(eqs).toContainEqual(["source", "manager_attested_vendor_relationship"]);
    expect(eqs).toContainEqual(["manager_user_id", "so"]);
  });
  it("no row means this workspace has not attested", async () => {
    const { db } = chainDb({ data: [] });
    expect(await readVendorWorkspaceAttestation(db, { managerUserId: "so", phone: "+12065550301", workspaceId: "ws-2" })).toEqual({ ok: true, attested: false });
  });
  it("a failed read is not 'not attested': it is unreadable", async () => {
    const { db } = chainDb({ error: { message: "down" } });
    expect(await readVendorWorkspaceAttestation(db, { managerUserId: "so", phone: "+12065550301", workspaceId: "ws-1" })).toEqual({ ok: false, error: "scoped_consent_unreadable" });
  });
  it("needs a workspace", async () => {
    const { db } = chainDb({});
    expect((await readVendorWorkspaceAttestation(db, { managerUserId: "so", phone: "+12065550301", workspaceId: " " })).ok).toBe(false);
  });
});

describe("resolveWorkspaceSendLine failClosed", () => {
  it("throws when the workspace's number rows cannot be read (instead of reading as 'no line')", async () => {
    const { db } = chainDb({ error: { message: "down" } });
    await expect(resolveWorkspaceSendLine(db, "owner", "ws-1", { failClosed: true })).rejects.toThrow("workspace_line_unreadable");
  });
  it("without the option a failed read still reads as no line (every other caller is unchanged)", async () => {
    const { db } = chainDb({ error: { message: "down" } });
    expect(await resolveWorkspaceSendLine(db, "owner", "ws-1")).toBeNull();
  });
});
