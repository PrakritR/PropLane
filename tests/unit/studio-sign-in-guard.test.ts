import { describe, expect, it } from "vitest";
import {
  isStudioSignInRole,
  studioAccountFor,
  studioSignInAllowed,
  STUDIO_SIGN_IN_SUPABASE_REF,
} from "@/lib/dev/studio-sign-in.server";

const DEV_TEST_URL = `https://${STUDIO_SIGN_IN_SUPABASE_REF}.supabase.co`;
const STAGING_URL = "https://xwszcafaontidfgznlxd.supabase.co";
const PRODUCTION_URL = "https://qahnczmilgptcedaqype.supabase.co";

function envWith(overrides: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    NEXT_PUBLIC_SUPABASE_URL: DEV_TEST_URL,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("studioSignInAllowed", () => {
  it("allows localhost, development, dev/test project — the one happy path", () => {
    expect(studioSignInAllowed("localhost:3000", envWith({}))).toBe(true);
    expect(studioSignInAllowed("127.0.0.1:3000", envWith({}))).toBe(true);
  });

  it("refuses outside NODE_ENV=development, even on localhost against the dev/test project", () => {
    expect(studioSignInAllowed("localhost:3000", envWith({ NODE_ENV: "production" }))).toBe(false);
    expect(studioSignInAllowed("localhost:3000", envWith({ NODE_ENV: "test" }))).toBe(false);
    expect(studioSignInAllowed("localhost:3000", envWith({ NODE_ENV: undefined }))).toBe(false);
  });

  it("refuses a non-local request host", () => {
    expect(studioSignInAllowed("prop-lane.space", envWith({}))).toBe(false);
    expect(studioSignInAllowed("staging-prop-lane.space", envWith({}))).toBe(false);
    expect(studioSignInAllowed("192.168.1.50:3000", envWith({}))).toBe(false);
    expect(studioSignInAllowed(null, envWith({}))).toBe(false);
  });

  it("refuses the staging Supabase project even from localhost in development", () => {
    expect(studioSignInAllowed("localhost:3000", envWith({ NEXT_PUBLIC_SUPABASE_URL: STAGING_URL }))).toBe(false);
  });

  it("refuses the production Supabase project even from localhost in development", () => {
    expect(studioSignInAllowed("localhost:3000", envWith({ NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_URL }))).toBe(false);
  });

  it("refuses a missing or malformed Supabase URL", () => {
    expect(studioSignInAllowed("localhost:3000", envWith({ NEXT_PUBLIC_SUPABASE_URL: undefined }))).toBe(false);
    expect(studioSignInAllowed("localhost:3000", envWith({ NEXT_PUBLIC_SUPABASE_URL: "not-a-url" }))).toBe(false);
    expect(studioSignInAllowed("localhost:3000", envWith({ NEXT_PUBLIC_SUPABASE_URL: "" }))).toBe(false);
  });
});

describe("isStudioSignInRole", () => {
  it("accepts exactly the four portal roles", () => {
    expect(isStudioSignInRole("manager")).toBe(true);
    expect(isStudioSignInRole("resident")).toBe(true);
    expect(isStudioSignInRole("vendor")).toBe(true);
    expect(isStudioSignInRole("admin")).toBe(true);
  });

  it("rejects anything else, including null and empty string", () => {
    expect(isStudioSignInRole("superadmin")).toBe(false);
    expect(isStudioSignInRole("")).toBe(false);
    expect(isStudioSignInRole(null)).toBe(false);
  });
});

describe("studioAccountFor", () => {
  it("maps manager to the all-portals testeverything@ sandbox account by default", () => {
    expect(studioAccountFor("manager", {} as NodeJS.ProcessEnv)).toEqual({
      email: "testeverything@test.proplane.local",
      password: "TestEverything123!",
    });
  });

  it("maps the other three roles to their dedicated single-role fixtures by default", () => {
    expect(studioAccountFor("resident", {} as NodeJS.ProcessEnv)).toEqual({
      email: "resident@test.proplane.local",
      password: "TestResident123!",
    });
    expect(studioAccountFor("vendor", {} as NodeJS.ProcessEnv)).toEqual({
      email: "vendor@test.proplane.local",
      password: "TestVendor123!",
    });
    expect(studioAccountFor("admin", {} as NodeJS.ProcessEnv)).toEqual({
      email: "admin@test.proplane.local",
      password: "TestAdmin123!",
    });
  });

  it("prefers the same E2E_* env overrides every other QA fixture reads", () => {
    const env = {
      E2E_MANAGER_EMAIL: "ignored@test.proplane.local",
      E2E_EVERYTHING_EMAIL: "Custom-Everything@Test.proplane.local",
      E2E_EVERYTHING_PASSWORD: "CustomPass123!",
    } as NodeJS.ProcessEnv;
    expect(studioAccountFor("manager", env)).toEqual({
      email: "custom-everything@test.proplane.local",
      password: "CustomPass123!",
    });
  });
});
