// @vitest-environment jsdom
//
// Quick replies in the UI (vendor-portal-redesign-1006): the ⚡ menu inserts a
// saved reply (editable afterwards), Settings → Quick replies adds / edits /
// deletes / reorders through the vendor route, and the review reply dialog
// takes a quick reply and saves with Save in the footer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { resetSharedGets } from "@/lib/shared-get-cache";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/profile",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { QuickReplyMenu } from "@/components/portal/quick-reply-menu";
import { VendorQuickRepliesSettings } from "@/components/portal/vendor-quick-replies-settings";
import { VendorReviewsPanel } from "@/components/portal/vendor-reviews-panel";
import { insertQuickReplyText } from "@/lib/vendor-quick-replies";
import { useState } from "react";

const STARTERS = [
  { id: "s1", text: "On my way" },
  { id: "s2", text: "Running 15 minutes late" },
  { id: "s3", text: "Need photos of the issue" },
];

type Call = { url: string; method: string; body?: unknown };
let calls: Call[] = [];
let saved: { id: string; text: string }[] | null = null;
let reviews: Record<string, unknown>[] = [];

function stubFetch() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.includes("/api/vendor/quick-replies")) {
        if (method === "PUT") {
          saved = body.replies;
          return { ok: true, status: 200, json: async () => ({ replies: saved, isStarterSet: false }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({ replies: saved ?? STARTERS, isStarterSet: saved === null }) } as Response;
      }
      if (url.includes("/api/vendor/reviews/") && url.endsWith("/reply")) {
        const review = { ...reviews[0], vendorReply: body.reply, vendorRepliedAt: "2026-10-06T00:00:00.000Z" };
        return { ok: true, status: 200, json: async () => ({ review }) } as Response;
      }
      if (url.includes("/api/vendor/reviews")) {
        return { ok: true, status: 200, json: async () => ({ reviews, aggregate: { average: 5, count: reviews.length } }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
}

beforeEach(() => {
  saved = null;
  reviews = [
    { id: "r1", stars: 5, body: "Fast and tidy", vendorReply: null, vendorRepliedAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", reviewerLabel: "A PropLane manager" },
  ];
  stubFetch();
});
afterEach(() => {
  cleanup();
  resetSharedGets();
  vi.unstubAllGlobals();
});

function Harness() {
  const [draft, setDraft] = useState("");
  return (
    <>
      <textarea aria-label="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <QuickReplyMenu defaultOpen onPick={(t) => setDraft((d) => insertQuickReplyText(d, t))} />
    </>
  );
}

describe("QuickReplyMenu", () => {
  it("lists the vendor's replies and inserts the picked one into an editable field", async () => {
    render(<Harness />);
    const item = await screen.findByText("Running 15 minutes late");
    fireEvent.click(item);
    const draft = screen.getByLabelText("draft") as HTMLTextAreaElement;
    expect(draft.value).toBe("Running 15 minutes late");
    // still editable
    fireEvent.change(draft, { target: { value: "Running 20 minutes late" } });
    expect(draft.value).toBe("Running 20 minutes late");
  });

  it("offers a way to manage them, pointing at Settings → Quick replies", async () => {
    render(<Harness />);
    const manage = await screen.findByText("Manage quick replies");
    expect(manage.closest("a")?.getAttribute("href")).toBe("/vendor/profile?tab=quick-replies");
  });
});

describe("Settings → Quick replies", () => {
  const renderPane = () =>
    render(
      <AppUiProvider>
        <VendorQuickRepliesSettings />
      </AppUiProvider>,
    );

  it("shows the starter set as rows with a count in the one tab", async () => {
    renderPane();
    expect(await screen.findByText("On my way")).toBeTruthy();
    expect(document.querySelectorAll('[data-attr="vendor-quick-reply-row"]')).toHaveLength(3);
    expect(document.querySelector('[data-attr="vendor-quick-replies-tab"]')?.textContent).toContain("3");
  });

  it("adds a reply and saves the whole list through PUT", async () => {
    renderPane();
    await screen.findByText("On my way");
    fireEvent.click(screen.getByRole("button", { name: "Add quick reply" }));
    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "Be there at noon" } });
    fireEvent.click(screen.getByRole("button", { name: "Save quick reply" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect((put.body as { replies: { text: string }[] }).replies.map((r) => r.text)).toEqual([
      "On my way",
      "Running 15 minutes late",
      "Need photos of the issue",
      "Be there at noon",
    ]);
  });

  it("the row ⋯ carries Edit, Move up, Move down and Delete (red, last)", async () => {
    renderPane();
    await screen.findByText("On my way");
    const trigger = document.querySelectorAll('[data-attr="vendor-quick-reply-menu"]')[1] as HTMLElement;
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Edit", "Move up", "Move down", "Delete"]);
  });
});

describe("Reviews reply dialog", () => {
  it("replies with a quick reply: ⚡ inserts it, Save sits in the footer and POSTs the first reply", async () => {
    render(
      <AppUiProvider>
        <VendorReviewsPanel tabId="all" />
      </AppUiProvider>,
    );
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-review-row"]')).toHaveLength(1));
    // The ⋯ offers Reply and Reply with a quick reply for an unreplied review.
    fireEvent.pointerDown(document.querySelector('[data-attr="vendor-review-menu"]') as HTMLElement, { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Reply", "Reply with a quick reply"]);
    fireEvent.click(within(menu).getByText("Reply with a quick reply"));

    // The dialog opens with the quick-reply menu already open.
    const reply = await screen.findByText("On my way");
    fireEvent.click(reply);
    const input = (await screen.findByLabelText("Your reply")) as HTMLTextAreaElement;
    expect(input.value).toBe("On my way");
    fireEvent.change(input, { target: { value: "On my way — thanks for the review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reply" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/reply"))).toBe(true));
    const call = calls.find((c) => c.url.endsWith("/reply"))!;
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ reply: "On my way — thanks for the review" });
  });

  it("a replied review offers Edit reply, and saving it is a PATCH", async () => {
    reviews = [{ ...reviews[0], vendorReply: "Thanks!", vendorRepliedAt: "2026-10-02T00:00:00.000Z" }];
    render(
      <AppUiProvider>
        <VendorReviewsPanel tabId="all" />
      </AppUiProvider>,
    );
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-review-row"]')).toHaveLength(1));
    fireEvent.pointerDown(document.querySelector('[data-attr="vendor-review-menu"]') as HTMLElement, { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Edit reply"]);
    fireEvent.click(within(menu).getByText("Edit reply"));
    const input = (await screen.findByLabelText("Your reply")) as HTMLTextAreaElement;
    expect(input.value).toBe("Thanks!");
    fireEvent.change(input, { target: { value: "Thanks so much!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reply" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/reply"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/reply"))!.method).toBe("PATCH");
  });
});
