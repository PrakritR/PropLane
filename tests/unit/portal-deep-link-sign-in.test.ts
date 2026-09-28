import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }),
}));

import { middleware } from "@/middleware";

describe("logged-out portal deep links", () => {
  const oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const oldKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  afterEach(() => {
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = oldKey;
  });

  it("preserves the requested record and section across sign-in", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
    const response = await middleware(new NextRequest(
      "https://proplane.example/portal/applications/AXIS-123?tab=application-form",
    ));

    const signIn = new URL(response.headers.get("location")!);
    expect(signIn.pathname).toBe("/auth/sign-in");
    expect(signIn.searchParams.get("next")).toBe("/portal/applications/AXIS-123?tab=application-form");
  });
});
