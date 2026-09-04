// @vitest-environment jsdom
//
// PRP-221 / PRP-222 — the Bathrooms and Shared spaces wizard steps, asserted against the
// RENDERED DOM rather than the source text.
//
// The existing `listing-wizard-step-redesign` coverage matches string literals in the form's
// source. That proves the file still contains certain characters; it cannot tell whether the
// step renders, whether a type tile actually presets the fixtures it claims to, or whether the
// bathroom type shown is derived from those fixtures instead of a stored second field. These
// drive the real component.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ManagerAddListingForm } from "@/components/portal/pro-add-listing-form";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

/** Wizard step indexes — see LISTING_FORM_STEPS in the form. */
const STEP_BATHROOMS = 2;
const STEP_SPACES = 3;

let MANAGER_ID = "";
let seq = 0;

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: MANAGER_ID, ready: true }),
}));

vi.mock("@supabase/ssr", () => {
  const client = {
    auth: { getSession: async () => ({ data: { session: null } }) },
    storage: {
      from: () => ({
        remove: async () => ({ data: null, error: null }),
        upload: async () => ({ error: null }),
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.test/${path}` } }),
      }),
    },
  };
  return { createBrowserClient: () => client, createServerClient: () => client };
});

Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
  window.history.replaceState(null, "", "/portal/properties");
  window.sessionStorage?.clear();
  MANAGER_ID = `mgr-wizard-steps-${(seq += 1)}`;
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [] }) }) as unknown as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function renderStep(stepIndex: number) {
  const sub = createDefaultListingSubmission();
  return render(
    <ManagerAddListingForm
      onClose={vi.fn()}
      onSubmitted={vi.fn()}
      showToast={vi.fn()}
      skuTier="pro"
      propCountBeforeSubmit={0}
      initialSubmission={sub}
      initialStepIndex={stepIndex}
      initialMaxStepReached={5}
    />,
  );
}

function tile(id: string): HTMLElement {
  const el = document.querySelector(`[data-attr="listing-add-bathroom-${id}"]`);
  if (!el) throw new Error(`no bathroom tile "${id}"`);
  return el as HTMLElement;
}

describe("PRP-221 bathrooms step", () => {
  it("offers each bathroom type as a single tap", () => {
    renderStep(STEP_BATHROOMS);

    for (const id of ["full", "half", "ensuite"]) {
      expect(tile(id)).toBeTruthy();
    }
  });

  it("presets the fixtures the type implies — a full bath has a shower, a half bath does not", () => {
    // The fixture CHECKBOX exists either way; what differs is whether the tile ticked it.
    // Reading the label text alone would pass for both types and prove nothing.
    const showerChecked = () => {
      const boxes = screen.getAllByLabelText(/^shower$/i) as HTMLInputElement[];
      expect(boxes).toHaveLength(1);
      return boxes[0]!.checked;
    };

    renderStep(STEP_BATHROOMS);
    fireEvent.click(tile("full"));
    expect(showerChecked()).toBe(true);

    cleanup();
    renderStep(STEP_BATHROOMS);
    fireEvent.click(tile("half"));
    expect(showerChecked()).toBe(false);
  });

  it("does not offer a whole-house bathroom option", () => {
    renderStep(STEP_BATHROOMS);

    expect(document.body.textContent ?? "").not.toMatch(/whole[- ]house/i);
  });

  it("adds a bathroom rather than silently doing nothing", () => {
    renderStep(STEP_BATHROOMS);
    const before = document.body.textContent ?? "";

    fireEvent.click(tile("full"));

    expect(document.body.textContent).not.toBe(before);
  });
});

describe("PRP-222 wizard ADD rows", () => {
  it("puts a dashed ADD row on the bathrooms step", () => {
    renderStep(STEP_BATHROOMS);

    const adds = screen.queryAllByRole("button", { name: /add/i });
    expect(adds.length).toBeGreaterThan(0);
  });

  it("puts a dashed ADD row on the shared spaces step", () => {
    renderStep(STEP_SPACES);

    const adds = screen.queryAllByRole("button", { name: /add/i });
    expect(adds.length).toBeGreaterThan(0);
  });

  it("shows one empty state on shared spaces, not a banner plus a dashed box", () => {
    renderStep(STEP_SPACES);

    expect(document.body.textContent ?? "").not.toMatch(/quick add/i);
  });
});
