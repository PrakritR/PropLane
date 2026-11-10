import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupSyntheticProperties, createSyntheticProperty } from "../helpers/synthetic-property-e2e";

const actorId = "11111111-1111-4111-8111-111111111111";
const originalEnv = {
  privateDir: process.env.E2E_PRIVATE_FIXTURE_DIR,
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
};
let privateDir: string | undefined;

afterEach(() => {
  if (originalEnv.privateDir === undefined) delete process.env.E2E_PRIVATE_FIXTURE_DIR;
  else process.env.E2E_PRIVATE_FIXTURE_DIR = originalEnv.privateDir;
  if (originalEnv.supabaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalEnv.supabaseUrl;
  if (privateDir) rmSync(privateDir, { recursive: true, force: true });
  privateDir = undefined;
});

function fixture() {
  privateDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "synthetic-property-intent-")));
  process.env.E2E_PRIVATE_FIXTURE_DIR = privateDir;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://emstjswhotsnyksqhqyf.supabase.co";

  const rows: Array<Record<string, unknown>> = [];
  const deletes: string[] = [];
  const intentStatesAtPost: Array<{ id: string; outcome: string; mode: number }> = [];
  let upserts = 0;
  const request = {
    get: vi.fn(async () => ({
      ok: () => true,
      json: async () => ({ snapshot: { extrasByUser: { [actorId]: rows } } }),
    })),
    post: vi.fn(async (_url: string, options?: { data?: Record<string, unknown> }) => {
      const data = options?.data ?? {};
      if (data.action === "delete") {
        deletes.push(String(data.id));
        const index = rows.findIndex((row) => row.id === data.id);
        if (index >= 0) rows.splice(index, 1);
        return { ok: () => true, status: () => 200 };
      }

      upserts += 1;
      const id = String(data.id);
      const manifestPath = path.join(privateDir!, `property-intent-${id}.json`);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { outcome: string };
      intentStatesAtPost.push({ id, outcome: manifest.outcome, mode: statSync(manifestPath).mode & 0o777 });
      if (upserts === 1) throw new Error("connection closed before response");

      const propertyData = data.propertyData as Record<string, unknown>;
      rows.push({
        id,
        buildingName: propertyData.buildingName,
        managerUserId: actorId,
        fixturePurpose: propertyData.fixturePurpose,
        adminPublishLive: propertyData.adminPublishLive,
      });
      return { ok: () => true, status: () => 200 };
    }),
  };
  const cookie = `base64-${Buffer.from(JSON.stringify({ user: { id: actorId } })).toString("base64")}`;
  const page = {
    url: () => "http://localhost:3007/portal/properties",
    context: () => ({ cookies: async () => [{ name: "sb-emstjswhotsnyksqhqyf-auth-token", value: cookie }] }),
    request,
  } as unknown as Page;
  return { page, rows, deletes, intentStatesAtPost };
}

describe("synthetic property write intent", () => {
  it("refuses to send a write when the private intent directory is not private", async () => {
    const f = fixture();
    chmodSync(privateDir!, 0o755);

    await expect(createSyntheticProperty(f.page)).rejects.toThrow(/E2E_PRIVATE_FIXTURE_DIR/);
    expect(f.page.request.post).not.toHaveBeenCalled();
  });

  it("records private intent before POST, retains unknown writes, and still cleans confirmed fixtures", async () => {
    const f = fixture();

    await expect(createSyntheticProperty(f.page)).rejects.toThrow("connection closed before response");
    const unknown = f.intentStatesAtPost[0]!;
    const unknownManifestPath = path.join(privateDir!, `property-intent-${unknown.id}.json`);
    expect(unknown).toEqual({ id: unknown.id, outcome: "pending", mode: 0o600 });
    expect(JSON.parse(readFileSync(unknownManifestPath, "utf8"))).toMatchObject({ id: unknown.id, outcome: "unknown", target: "emstjswhotsnyksqhqyf" });

    const confirmed = await createSyntheticProperty(f.page);
    expect(f.intentStatesAtPost[1]).toEqual({ id: confirmed.id, outcome: "pending", mode: 0o600 });
    expect(f.rows.some((row) => row.id === confirmed.id)).toBe(true);

    await expect(cleanupSyntheticProperties(f.page)).rejects.toThrow(/cleanup incomplete/i);
    expect(f.deletes).toEqual([confirmed.id]);
    const confirmedManifest = JSON.parse(readFileSync(path.join(privateDir!, `property-intent-${confirmed.id}.json`), "utf8"));
    expect(confirmedManifest).toMatchObject({ outcome: "confirmed", cleanupConfirmed: true });
    expect(f.rows.some((row) => row.id === confirmed.id)).toBe(false);
    expect(f.rows.some((row) => row.id === unknown.id)).toBe(false);
    expect(JSON.parse(readFileSync(unknownManifestPath, "utf8"))).toMatchObject({ id: unknown.id, outcome: "unknown" });
  });
});
