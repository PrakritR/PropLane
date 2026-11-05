import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), stop: vi.fn(), identify: vi.fn(), persist: vi.fn(), url: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../e2e/support/signup-proof-process.mjs", () => ({ stopOwnedChild: mocks.stop }));
vi.mock("../helpers/signup-proof-journal", () => ({ identifySignupActor: mocks.identify, persistSignupJournal: mocks.persist }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }));
vi.mock("@playwright/test", () => ({ expect: () => ({ toHaveURL: mocks.url }) }));
import { captureSignupPhone } from "../helpers/signup-proof-e2e";
import type { SignupJournal } from "../helpers/signup-proof-journal";

let dir: string;
const nonce = "a".repeat(32);
const actor = "11111111-1111-4111-8111-111111111111";
const originalEnv = { ...process.env };
function setup() {
  const child = Object.assign(new EventEmitter(), { pid: 12345 });
  mocks.spawn.mockReturnValue(child);
  const manifest = { nonce, tier: "pro", registered: true, phase: "registered" } as SignupJournal;
  const reservation = { manifest, file: path.join(dir, `p8-${nonce}.manifest.json`) };
  const click = vi.fn().mockResolvedValue(undefined);
  const page = { getByRole: vi.fn().mockReturnValue({ click }) };
  return { child, reservation, page, click, marker: path.join(dir, "phone-worker-12345.json") };
}
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(path.join(os.tmpdir(), "signup-phone-"));
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://emstjswhotsnyksqhqyf.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "secret", AUTH_PROOF_CAPTURE_DIR: dir, NEXT_PUBLIC_APP_URL: "http://localhost:3000", PLAYWRIGHT_BASE_URL: "http://localhost:3000", SIGNUP_PROOF_RUN_NONCE: nonce, SIGNUP_PROOF_RUNNER_PID: String(process.pid), SIGNUP_PROOF_ENABLED: "1" });
  writeFileSync(path.join(dir, "server-ready.json"), JSON.stringify({ origin: "http://localhost:3000", pid: process.pid, wrapperPid: process.pid, runnerPid: process.pid, runNonce: nonce }), { mode: 0o600 });
  mocks.identify.mockResolvedValue(actor); mocks.url.mockResolvedValue(undefined); mocks.stop.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); process.env = { ...originalEnv }; rmSync(dir, { recursive: true, force: true }); });

it.each(["manager", "resident"] as const)("journals successful %s phone binding after reaping", async (role) => {
  const f = setup();
  mocks.stop.mockImplementation(async () => { expect(existsSync(f.marker)).toBe(true); expect(mocks.persist).not.toHaveBeenCalled(); });
  const promise = captureSignupPhone(f.page as never, f.reservation, role);
  await vi.waitFor(() => expect(existsSync(f.marker)).toBe(true));
  expect(JSON.parse(readFileSync(f.marker, "utf8"))).toEqual({ pid: 12345, actorId: actor, runNonce: nonce });
  f.child.emit("exit", 0);
  await expect(promise).resolves.toBe(actor);
  expect(f.click).toHaveBeenCalledTimes(role === "manager" ? 1 : 0);
  expect(mocks.stop).toHaveBeenCalledWith(f.child);
  expect(existsSync(f.marker)).toBe(false);
  expect(mocks.persist).toHaveBeenCalledWith(f.reservation.file, expect.objectContaining({ phoneBound: true, phase: "phone-bound" }));
});
it("reaps the spawned child when marker creation fails", async () => {
  const f = setup(); writeFileSync(f.marker, "existing");
  await expect(captureSignupPhone(f.page as never, f.reservation, "resident")).rejects.toThrow("journal refused");
  expect(mocks.stop).toHaveBeenCalledWith(f.child);
  expect(readFileSync(f.marker, "utf8")).toBe("existing"); expect(mocks.persist).not.toHaveBeenCalled();
});
it.each(["exit", "error"])("reaps and sanitizes worker %s failure", async (kind) => {
  const f = setup(); const promise = captureSignupPhone(f.page as never, f.reservation, "resident");
  await vi.waitFor(() => expect(existsSync(f.marker)).toBe(true));
  if (kind === "error") f.child.emit("error", new Error("SECRET")); else f.child.emit("exit", 1);
  await expect(promise).rejects.toThrow("Guarded synthetic phone proof failed.");
  expect(mocks.stop).toHaveBeenCalledWith(f.child); expect(existsSync(f.marker)).toBe(false); expect(mocks.persist).not.toHaveBeenCalled();
});
it("stops and reaps the exact worker on timeout", async () => {
  vi.useFakeTimers(); const f = setup();
  mocks.stop.mockImplementation(async () => { f.child.emit("exit", null); });
  const promise = captureSignupPhone(f.page as never, f.reservation, "resident");
  const failure = expect(promise).rejects.toThrow("Guarded synthetic phone proof failed.");
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(60_000);
  await failure;
  expect(mocks.stop).toHaveBeenCalledWith(f.child); expect(existsSync(f.marker)).toBe(false); expect(mocks.persist).not.toHaveBeenCalled();
});
it("does not spawn when the page gate fails", async () => {
  const f = setup(); mocks.url.mockRejectedValue(new Error("page failure"));
  await expect(captureSignupPhone(f.page as never, f.reservation, "manager")).rejects.toThrow();
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it("preserves the marker and refuses phone binding when worker shutdown cannot be verified", async () => {
  const f = setup();
  mocks.stop.mockRejectedValue(new Error("Owned signup process group is still live."));
  const promise = captureSignupPhone(f.page as never, f.reservation, "resident");
  const failure = expect(promise).rejects.toThrow("Owned signup process group is still live.");
  await vi.waitFor(() => expect(existsSync(f.marker)).toBe(true));
  f.child.emit("exit", 0);
  await failure;
  expect(mocks.stop).toHaveBeenCalledWith(f.child);
  expect(JSON.parse(readFileSync(f.marker, "utf8"))).toEqual({ pid: 12345, actorId: actor, runNonce: nonce });
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(f.reservation.manifest.phoneBound).toBeUndefined();
});

it("returns a fail-stop timeout and retains the marker when the worker cannot be reaped", async () => {
  vi.useFakeTimers(); const f = setup();
  mocks.stop.mockRejectedValue(new Error("Owned worker shutdown refused."));
  const result = captureSignupPhone(f.page as never, f.reservation, "resident");
  const rejection = expect(result).rejects.toThrow("Owned worker shutdown refused.");
  await vi.advanceTimersByTimeAsync(60_000);
  await rejection;
  expect(mocks.stop).toHaveBeenCalledWith(f.child);
  expect(existsSync(f.marker)).toBe(true); expect(mocks.persist).not.toHaveBeenCalled();
});
