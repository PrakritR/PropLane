// @vitest-environment jsdom
//
// The admin assistant's panel: its own placeholder and chips, and a panel that
// is always readable. The rail sat on `bg-white dark:bg-background` while the
// admin shell redefined --background as navy, so an OS-dark Mac got a navy
// panel with dark ink. Text and fill must come from the same token pair.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/axis-assistant/assistant-conversation-context", () => ({
  useOptionalAssistantConversation: () => ({
    input: "",
    setInput: vi.fn(),
    send: state.send,
    error: null,
    setError: vi.fn(),
    attachments: [],
    setAttachments: vi.fn(),
    messages: [],
    ratings: {},
    submitFeedback: vi.fn(),
    pendingAction: null,
    loading: false,
    resolvePendingAction: vi.fn(),
    multiThread: false,
    threads: [],
    activeThreadId: "",
    historyOpen: false,
    historyLoading: false,
    historyError: null,
    historySearch: "",
    hasMoreHistory: false,
    openHistory: vi.fn(),
    closeHistory: vi.fn(),
    searchHistory: vi.fn(),
    selectThread: vi.fn(),
    deleteThread: vi.fn(),
    loadMoreHistory: vi.fn(),
    startNewChat: vi.fn(async () => {}),
    hydrateArchive: vi.fn(),
  }),
}));

import { AssistantDockPanel } from "@/components/portal/assistant-dock-panel";
import { ADMIN_ASSISTANT_ENDPOINT } from "@/components/portal/assistant-panel-chrome";

const repoRoot = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

afterEach(cleanup);
beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  vi.clearAllMocks();
});

describe("admin assistant panel copy", () => {
  it("asks about PropLane, not a portfolio", () => {
    render(<AssistantDockPanel endpoint={ADMIN_ASSISTANT_ENDPOINT} managerName="Ops Person" />);
    const box = screen.getByRole("textbox", { name: "Ask the PropLane Assistant about PropLane" });
    expect(box).toHaveAttribute("placeholder", "Ask about PropLane…");
    expect(screen.queryByText(/Late on rent/)).toBeNull();
  });

  it("offers the four admin suggestions and sends each as a prompt", () => {
    render(<AssistantDockPanel endpoint={ADMIN_ASSISTANT_ENDPOINT} />);
    for (const [label, prompt] of [
      ["Earnings", "How much did we earn this month?"],
      ["Trials ending", "Who is on a trial ending this week?"],
      ["Promo codes", "Which promo codes are used most?"],
      ["Failed texts", "Show failed texts today"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
      expect(state.send).toHaveBeenLastCalledWith(prompt, { contextHint: null });
    }
  });

  it("leaves the manager, vendor and resident placeholders alone", () => {
    for (const [endpoint, placeholder] of [
      [undefined, "Ask about your portfolio…"],
      ["/api/agent/vendor-chat", "Ask about your jobs…"],
      ["/api/agent/resident-chat", "Ask about your home…"],
    ] as const) {
      const view = render(<AssistantDockPanel endpoint={endpoint} />);
      expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", placeholder);
      view.unmount();
    }
  });
});

describe("assistant panel is always readable", () => {
  const rail = read("src/components/portal/portal-assistant-rail.tsx");
  const chrome = read("src/components/portal/assistant-panel-chrome.tsx");
  const dock = read("src/components/portal/assistant-dock-panel.tsx");
  const css = read("src/app/globals.css");

  it("the rail pairs its fill and text tokens and never keys to the OS color scheme", () => {
    const className = /<aside\s+className="([^"]+)"/.exec(rail)![1]!;
    expect(className).toMatch(/(^|\s)bg-card(\s|$)/);
    expect(className).toMatch(/(^|\s)text-foreground(\s|$)/);
    // Tailwind's `dark:` follows prefers-color-scheme; this app's theme is the data-theme attribute.
    expect(className).not.toMatch(/(^|\s)dark:/);
    expect(className).not.toMatch(/(^|\s)bg-white(\s|$)/);
  });

  it("the dock panel and message bubbles use card/foreground tokens, not raw colors", () => {
    expect(dock).toMatch(/border border-border bg-card"/);
    // assistant bubble: a foreground tint with foreground text; user bubble: the primary button fill with white text
    expect(chrome).toContain("border border-border bg-foreground/[0.04] text-foreground");
    expect(chrome).toContain('text-white shadow-[0_8px_20px_-12px_rgba(47,107,255,0.6)]');
    expect(chrome).toContain('"var(--btn-primary)"');
    for (const source of [rail, dock]) expect(source).not.toMatch(/(^|[\s"])dark:/);
  });

  it("the admin surface no longer redefines the background to navy", () => {
    expect(css).not.toMatch(/\[data-surface="admin"\]\s*\{/);
    expect(css).not.toContain("#0a0e18");
  });

  it("the manager, resident and vendor layouts still mount the same rail", () => {
    for (const file of ["portal", "resident", "vendor", "admin"]) {
      expect(read(`src/app/${file}/layout.tsx`)).toContain("<PortalAssistantRail");
    }
  });
});
