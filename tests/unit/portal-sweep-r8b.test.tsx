// @vitest-environment jsdom
/** Round 8 (B1, B2, C, D, E1, E2): badges equal lists, locked More rows, row sheet, stepper, no subtext. */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/hooks/use-is-native-app", () => ({ useNativeChrome: () => false }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/portal-nav-prefetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal-nav-prefetch")>()),
  portalMobileLinkPrefetchEnabled: () => false,
}));
vi.mock("@/lib/portal-nav-client", () => ({
  isCrossPortalNavigation: () => false,
  portalNavClick: () => () => {},
}));

const { PortalNativeMoreSheet } = await import("@/components/portal/portal-native-more-sheet");
const { InboxThreadEmpty } = await import("@/components/portal/portal-inbox-ui");
const { ResidentLifecycleCompactTracker } = await import("@/components/portal/resident-lifecycle-compact-tracker");
const { DropdownMenu, DropdownMenuContent, DropdownMenuItem } = await import("@/components/ui/dropdown-menu");
const { residentLifecycleSteps, resolveResidentLifecycleNextAction } = await import("@/lib/resident-lifecycle-journey");
const { buildResidentLeaseDocumentRows, residentPendingLeaseRowCount } = await import("@/lib/resident-lease-documents");
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

afterEach(cleanup);

function renderSheet(items: Parameters<typeof PortalNativeMoreSheet>[0]["items"]) {
  return render(
    <PortalNativeMoreSheet
      open
      onOpenChange={() => {}}
      items={items}
      kind="resident"
      activeSection="dashboard"
      showNavIcons={false}
    />,
  );
}

describe("B2: More sheet locked rows match desktop", () => {
  it("an inert lock shows the lock glyph, no chevron and is a no-op button (no href)", () => {
    renderSheet([{ section: "services", label: "Services", href: "/resident/services", locked: true }]);
    const row = screen.getByRole("button", { name: /Services \(locked\)/ });
    expect(row.getAttribute("href")).toBeNull();
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.querySelector("[data-nav-lock-icon]")).not.toBeNull();
    expect(row.querySelector(".lucide-chevron-right")).toBeNull();
    expect(document.querySelector('a[href="#"]')).toBeNull();
  });

  it("an upsell / notice lock stays a live link to its destination, with the lock and no chevron", () => {
    renderSheet([
      { section: "documents", label: "Documents", href: "/resident/documents", locked: true, lockedNavigable: true },
    ]);
    const row = screen.getByRole("link", { name: /Documents \(locked\)/ });
    expect(row.getAttribute("href")).toBe("/resident/documents");
    expect(row.querySelector("[data-nav-lock-icon]")).not.toBeNull();
    expect(row.querySelector(".lucide-chevron-right")).toBeNull();
  });

  it("an unlocked row keeps its chevron and has no lock", () => {
    renderSheet([{ section: "dashboard", label: "Dashboard", href: "/resident/dashboard" }]);
    const row = screen.getByRole("link", { name: "Dashboard" });
    expect(row.querySelector(".lucide-chevron-right")).not.toBeNull();
    expect(row.querySelector("[data-nav-lock-icon]")).toBeNull();
  });
});

describe("B1: the Lease badge counts what the Lease list lists", () => {
  const unshared = {
    id: "lease-1",
    unit: "Alder House",
    bucket: "resident",
    status: "Resident Signature Pending",
    updatedAtIso: "2026-08-14T00:00:00.000Z",
    generatedHtml: null,
    managerUploadedPdf: null,
    signedLeaseSnapshots: [],
  } as unknown as LeasePipelineRow;

  it("a lease the resident cannot see (no document) lists nothing and badges nothing", () => {
    expect(buildResidentLeaseDocumentRows(unshared)).toEqual([]);
    expect(residentPendingLeaseRowCount(unshared)).toBe(0);
  });

  it("a shared lease awaiting signature is one Pending row and one badge", () => {
    const shared = { ...unshared, generatedHtml: "<p>lease</p>" } as unknown as LeasePipelineRow;
    const pending = buildResidentLeaseDocumentRows(shared).filter((row) => row.filterBucket === "pending");
    expect(pending).toHaveLength(1);
    expect(residentPendingLeaseRowCount(shared)).toBe(pending.length);
  });

  it("no lease row, no badge", () => {
    expect(residentPendingLeaseRowCount(null)).toBe(0);
  });

  it("the resident prefetch warms the applications the Application badge reads", () => {
    const src = readFileSync("src/lib/portal-data-store.ts", "utf8");
    const resident = src.slice(src.indexOf('if (kind === "resident")'), src.indexOf('if (kind === "vendor")'));
    expect(resident).toContain("syncManagerApplicationsFromServer({ selfScope: true })");
  });

  it("the dashboard Unread tile counts the same Active rows as the Communication badge", () => {
    const src = readFileSync("src/components/portal/resident-dashboard.tsx", "utf8");
    expect(src).toContain("buildActiveCommunicationThreads(");
    expect(src).not.toContain("countUnopenedPersistedInbox");
  });
});

describe("C: a row's ⋯ menu is a bottom sheet on a phone", () => {
  function matchMedia(coarse: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("pointer: fine") ? !coarse : query.includes("max-width: 639px") ? coarse : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));
  }
  beforeEach(() => vi.unstubAllGlobals());

  function renderMenu() {
    return render(
      <DropdownMenu open modal={false}>
        <DropdownMenuContent rowSheet>
          <DropdownMenuItem>View</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
  }

  it("touch: the content is a sheet with a grab handle", () => {
    matchMedia(true);
    renderMenu();
    expect(document.querySelector("[data-menu-sheet]")).not.toBeNull();
    expect(document.querySelector("[data-menu-sheet-handle]")).not.toBeNull();
  });

  it("mouse: it stays an anchored popover, no handle", () => {
    matchMedia(false);
    renderMenu();
    expect(document.querySelector("[data-menu-sheet]")).toBeNull();
    expect(document.querySelector("[data-menu-sheet-handle]")).toBeNull();
  });

  it("the shared row menus opt in", () => {
    for (const file of [
      "src/components/ui/record-action-menu.tsx",
      "src/components/portal/portal-row-menu.tsx",
      "src/components/portal/vendor-row-menu.tsx",
      "src/components/ui/data-list.tsx",
    ]) {
      expect(readFileSync(file, "utf8"), file).toContain("rowSheet");
    }
  });

  it("the page shell clips instead of hiding, so a focus scroll cannot slide it sideways", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const rule = css.slice(css.indexOf("html[data-communication-surface] .portal-main-inner,"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("overflow: clip");
  });
});

describe("D: the phone stepper keeps each label under its own number", () => {
  it("every step is its own column; the current step's longer label gets the wider one", () => {
    const steps = residentLifecycleSteps({
      applicationSubmitted: true,
      applicationFeePaid: false,
      applicationApproved: false,
      residentSignedLease: false,
      managerCountersigned: false,
      moveInChargesPaid: false,
      movedIn: false,
    });
    const { container } = render(<ResidentLifecycleCompactTracker steps={steps} />);
    const list = container.querySelector("[data-jr-track]") as HTMLElement;
    const cols = list.style.getPropertyValue("--jr-cols").split(" ");
    expect(cols).toHaveLength(6);
    const current = steps.findIndex((step) => step.state === "current");
    expect(cols[current]).toBe("minmax(0,1.35fr)");
    expect(cols.filter((col) => col === "minmax(0,1fr)")).toHaveLength(5);
    for (const label of list.querySelectorAll("b")) {
      expect(label.className).toContain("[overflow-wrap:anywhere]");
      expect(label.className).toContain("w-full");
    }
  });
});

describe("E1 / E2: no sentence under a title", () => {
  it("the inbox empty state is the title alone", () => {
    const { container } = render(<InboxThreadEmpty />);
    expect(screen.getByText("Select a conversation")).toBeTruthy();
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.textContent).not.toContain("Choose a message");
  });

  it("no next action carries a subtext field, in any lifecycle state", () => {
    const base = {
      applicationSubmitted: true,
      applicationFeePaid: true,
      applicationApproved: true,
      residentSignedLease: true,
      managerCountersigned: true,
      moveInChargesPaid: true,
      movedIn: true,
    };
    const states = [
      { ...base, applicationDeclined: true },
      { ...base, applicationFeeDeclined: true, applicationFeePaid: false },
      { ...base, applicationSubmitted: false },
      { ...base, applicationFeePaid: false, applicationFeeLabel: "$50.00" },
      { ...base, applicationFeePaid: false },
      { ...base, applicationApproved: false },
      { ...base, residentSignedLease: false },
      { ...base, moveInChargesPaid: false, moveInTotalLabel: "$1,080.00" },
      { ...base, managerCountersigned: false },
      { ...base, movedIn: false },
      base,
    ];
    for (const state of states) {
      const action = resolveResidentLifecycleNextAction(state);
      expect(Object.keys(action).sort()).toEqual(["ctaLabel", "href", "title", "urgent", "who"]);
    }
  });

  it("neither the dashboard banner nor the status hero renders a sentence", () => {
    for (const file of [
      "src/components/portal/resident-dashboard.tsx",
      "src/components/portal/resident-lifecycle-status-panel.tsx",
    ]) {
      expect(readFileSync(file, "utf8"), file).not.toContain("action.detail");
    }
  });
});
