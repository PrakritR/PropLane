import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  admin: vi.fn(), manager: vi.fn(), resident: vi.fn(),
}));
vi.mock("@playwright/test", () => ({
  test: { extend: (fixtures: unknown) => fixtures }, expect: {},
}));
vi.mock("../helpers/auth", () => ({
  signInAsAdmin: auth.admin, signInAsManager: auth.manager, signInAsResident: auth.resident,
}));
import { test as registeredFixtures } from "../e2e/authenticated-test";

type Role = "admin" | "manager" | "resident";
const fixtures = registeredFixtures as unknown as {
  authRole: [null, { option: true }];
  storageState: (args: object, use: (state: unknown) => Promise<void>) => Promise<void>;
  page: (args: { page: object; authRole: Role | null }, use: (page: object) => Promise<void>) => Promise<void>;
};

describe("E2E authenticated fixture behavior", () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it("starts with empty storage and leaves the default page unauthenticated", async () => {
    const storage = vi.fn().mockResolvedValue(undefined);
    await fixtures.storageState({}, storage);
    expect(storage).toHaveBeenCalledExactlyOnceWith({ cookies: [], origins: [] });
    expect(fixtures.authRole).toEqual([null, { option: true }]);
    const page = {};
    const use = vi.fn().mockResolvedValue(undefined);
    await fixtures.page({ page, authRole: null }, use);
    expect(use).toHaveBeenCalledExactlyOnceWith(page);
    for (const signIn of Object.values(auth)) expect(signIn).not.toHaveBeenCalled();
  });

  it.each<Role>(["admin", "manager", "resident"])("signs in once as %s before yielding", async (role) => {
    const page = {};
    const use = vi.fn(async (received: object) => {
      expect(received).toBe(page);
      expect(auth[role]).toHaveBeenCalledExactlyOnceWith(page);
    });
    await fixtures.page({ page, authRole: role }, use);
    expect(use).toHaveBeenCalledTimes(1);
    for (const other of ["admin", "manager", "resident"] as const) {
      if (other !== role) expect(auth[other]).not.toHaveBeenCalled();
    }
  });

  it("propagates a failed sign-in without yielding or retrying", async () => {
    const failure = new Error("sign-in rejected");
    auth.manager.mockRejectedValueOnce(failure);
    const use = vi.fn();
    await expect(fixtures.page({ page: {}, authRole: "manager" }, use)).rejects.toBe(failure);
    expect(auth.manager).toHaveBeenCalledTimes(1);
    expect(use).not.toHaveBeenCalled();
  });
});

const ROOT = path.resolve(__dirname, "../..");
const FIXTURE = readFileSync(path.join(ROOT, "tests/e2e/authenticated-test.ts"), "utf8");
const E2E_ROOT = path.join(ROOT, "tests/e2e");

function e2eSources(): string[] {
  return readdirSync(E2E_ROOT, { recursive: true })
    .filter((entry): entry is string => entry.endsWith(".spec.ts") || entry.endsWith(".spec.tsx"))
    .map((entry) => path.join(E2E_ROOT, entry));
}

describe("E2E authenticated fixture policy", () => {
  it("defaults to an empty context and dispatches only the requested role", () => {
    expect(FIXTURE).toContain('authRole: [null, { option: true }]');
    expect(FIXTURE).toContain('await applyStorageState({ cookies: [], origins: [] });');
    expect(FIXTURE).toContain('if (authRole === "admin") await signInAsAdmin(page);');
    expect(FIXTURE).toContain('if (authRole === "manager") await signInAsManager(page);');
    expect(FIXTURE).toContain('if (authRole === "resident") await signInAsResident(page);');
  });

  it("has no declarative saved seeded-role consumers, including conversation", () => {
    const offenders = e2eSources()
      .filter((file) => /\.auth\/(manager|resident|admin)\.json/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("keeps auth setup as smoke-only and forbids storage serialization", () => {
    const setup = readFileSync(path.join(ROOT, "tests/e2e/auth.setup.ts"), "utf8");
    expect(setup).toContain("signInAsManager(page)");
    expect(setup).toContain("signInAsResident(page)");
    expect(setup).toContain("signInAsAdmin(page)");
    expect(setup).not.toContain("storageState");
  });
});
