import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { revokeSignupSession } from "../helpers/signup-proof-session";
import { persistSignupJournal, type SignupJournal } from "../helpers/signup-proof-journal";
const manifest: SignupJournal = { schemaVersion: 1, target: "https://emstjswhotsnyksqhqyf.supabase.co", nonce: "a".repeat(32), absentBeforeSignup: true, email: `p8-manager-${"a".repeat(32)}-draft@example.invalid`, phone: "+12065550100", fullName: "P8 draft manager", tier: "pro", startedAt: "2026-01-01T00:00:00Z", actorId: "11111111-1111-4111-8111-111111111111" };
const user = { id: manifest.actorId, email: manifest.email, created_at: "2026-01-01T00:00:01Z", app_metadata: { proplane_email_onboarding: true } };
it("revokes only the verified exact subject, without returning the credential", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "signup-session-"));
  const file = path.join(dir, `p8-${manifest.nonce}.manifest.json`);
  try {
    persistSignupJournal(file, manifest);
    const signOut = vi.fn(async () => ({ error: null }));
    const client = { supabaseUrl: manifest.target, auth: { getUser: async () => ({ data: { user }, error: null }), admin: { signOut } } } as unknown as SupabaseClient;
    await expect(revokeSignupSession(client, file, "secret-jwt")).resolves.toBeUndefined();
    expect(signOut).toHaveBeenCalledWith("secret-jwt", "global");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("refuses foreign subjects and conceals auth errors", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "signup-session-"));
  const file = path.join(dir, `p8-${manifest.nonce}.manifest.json`);
  try {
    persistSignupJournal(file, manifest);
    const signOut = vi.fn();
    const client = { supabaseUrl: manifest.target, auth: { getUser: async () => ({ data: { user: { ...user, id: "foreign" } }, error: null }), admin: { signOut } } } as unknown as SupabaseClient;
    await expect(revokeSignupSession(client, file, "secret-jwt")).rejects.toThrow("Signup session revocation refused.");
    expect(signOut).not.toHaveBeenCalled();
    const failing = { supabaseUrl: manifest.target, auth: { getUser: async () => { throw new Error("secret-jwt"); } } } as unknown as SupabaseClient;
    await expect(revokeSignupSession(failing, file, "secret-jwt")).rejects.toThrow("Signup session revocation refused.");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("joins exact DEV cookie chunks and rejects malformed or foreign sessions without disclosure", async () => {
  const { revokeSignupContext } = await import("../helpers/signup-proof-session");
  const dir = mkdtempSync(path.join(os.tmpdir(), "signup-session-"));
  const file = path.join(dir, `p8-${manifest.nonce}.manifest.json`);
  try {
    persistSignupJournal(file, manifest);
    const signOut = vi.fn(async () => ({ error: null }));
    const client = { supabaseUrl: manifest.target, auth: { getUser: async () => ({ data: { user }, error: null }), admin: { signOut } } } as unknown as SupabaseClient;
    const encoded = "base64-" + Buffer.from(JSON.stringify({ access_token: "secret-jwt", refresh_token: "secret-refresh" })).toString("base64url");
    const name = "sb-emstjswhotsnyksqhqyf-auth-token";
    const context = { cookies: async () => [{ name: `${name}.1`, value: encoded.slice(12) }, { name: `${name}.0`, value: encoded.slice(0, 12) }] } as unknown as Pick<import("@playwright/test").BrowserContext, "cookies">;
    await revokeSignupContext(client, file, context);
    expect(signOut).toHaveBeenCalledWith("secret-jwt", "global");
    const bad = { cookies: async () => [{ name: `${name}.1`, value: encoded }] } as unknown as Pick<import("@playwright/test").BrowserContext, "cookies">;
    await expect(revokeSignupContext(client, file, bad)).rejects.toThrow("Signup context revocation refused.");
    expect(signOut).toHaveBeenCalledTimes(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
