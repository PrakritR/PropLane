// @vitest-environment jsdom
//
// Covers the captain-decided apply/account model (PLAN-0924-1421): a resident
// account is REQUIRED to apply. The prompt offers Create account (primary) and
// Sign in (returning) — there is no guest path — and Create account carries the
// listing context through signup so the renter lands back on this application.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  publicApplyCreateAccountHref,
  publicApplySignInHref,
} from "@/lib/rental-application/public-apply-session";

// The prompt checks the Supabase session on mount — force "not signed in" so the
// gate renders its three actions.
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
}));

import { PublicApplyAccountPrompt } from "@/components/marketing/public-apply-account-prompt";

const PROPERTY_ID = "mgr-qa-madison-9f3k2z";

describe("publicApply href helpers carry listing context", () => {
  it("create-account href targets resident signup with the apply next", () => {
    const href = publicApplyCreateAccountHref(PROPERTY_ID);
    expect(href).toContain("/auth/create-account");
    expect(href).toContain("role=resident");
    // next must round-trip back to this listing's application
    const next = new URL(href, "http://x").searchParams.get("next");
    expect(next).toBe(`/resident/applications/apply?propertyId=${PROPERTY_ID}`);
  });

  it("sign-in href carries the same apply next for returning residents", () => {
    const next = new URL(publicApplySignInHref(PROPERTY_ID), "http://x").searchParams.get("next");
    expect(next).toBe(`/resident/applications/apply?propertyId=${PROPERTY_ID}`);
  });
});

describe("PublicApplyAccountPrompt offers only account actions", () => {
  beforeEach(() => {
    try {
      window.sessionStorage.clear();
    } catch {
      /* ignore */
    }
  });
  afterEach(() => cleanup());

  it("offers Create account (primary) and Sign in, with create carrying context", async () => {
    const returnPath = `/resident/applications/apply?propertyId=${PROPERTY_ID}`;
    render(
      <PublicApplyAccountPrompt
        gateKey={PROPERTY_ID}
        applyReturnPath={returnPath}
        propertyTitle="QA Madison Studio"
      />,
    );

    const create = await screen.findByText("Create account");
    const signIn = screen.getByText("Sign in");

    expect(create).toBeTruthy();
    expect(signIn).toBeTruthy();

    // Create account is the recommended path and carries the listing context.
    const createHref = create.closest("a")?.getAttribute("href") ?? "";
    expect(createHref).toContain("/auth/create-account");
    expect(createHref).toContain(encodeURIComponent(`/resident/applications/apply?propertyId=${PROPERTY_ID}`));

    // Sign in stays a real link for returning residents.
    expect(signIn.closest("a")?.getAttribute("href")).toContain("/auth/sign-in");
  });

  it("has no guest button and no guest copy", async () => {
    render(
      <PublicApplyAccountPrompt
        gateKey={PROPERTY_ID}
        applyReturnPath={`/resident/applications/apply?propertyId=${PROPERTY_ID}`}
        propertyTitle="QA Madison Studio"
      />,
    );

    await screen.findByText("Create account");
    expect(screen.queryByText(/without an account/i)).toBeNull();
    expect(screen.queryByText(/as a guest/i)).toBeNull();
    expect(screen.queryByText(/we recommend/i)).toBeNull();
    expect(document.querySelector('[data-attr="public-apply-continue-guest"]')).toBeNull();
    expect(screen.getByText(/account is required to apply/i)).toBeTruthy();
  });

  it("stays gated even when a stale guest-continue session key exists", async () => {
    window.sessionStorage.setItem(`proplane_apply_guest_continue:${PROPERTY_ID}`, "1");
    render(
      <PublicApplyAccountPrompt
        gateKey={PROPERTY_ID}
        applyReturnPath={`/resident/applications/apply?propertyId=${PROPERTY_ID}`}
      />,
    );
    expect(await screen.findByText("Create account")).toBeTruthy();
  });
});
