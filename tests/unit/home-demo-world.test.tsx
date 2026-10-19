// @vitest-environment jsdom
//
// The home demo tells one story in one world: Seattle Homes, with Jordan Rivera
// asking about Room 3 at 61 Willow Court. Every portal reads the same story
// progress (`world.ts`), and every count a panel prints is derived from the
// rows it draws (`docs/agents/marketing-mocks.md`).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DEMO_TABS, DemoPanel } from "@/components/marketing/site/product-mock/demo-panels";
import {
  NO_STORY,
  residentConversations,
  residentStory,
  vendorStory,
  worldFor,
} from "@/components/marketing/site/product-mock/world";
import { PROPERTY_ROWS, RESIDENT_HOME, RESIDENT_NAME } from "@/components/marketing/site/product-mock/fixtures";
import { ResidentLifecycleWorkspace } from "@/components/marketing/resident-lifecycle-workspace";
import { PORTAL_META, phoneScriptFor, storyAt } from "@/components/marketing/resident-lifecycle-script";
import HomeDashboardPanel from "@/components/marketing/home-dashboard-panel";
import { PREVIEW_ASSISTANT_PROMPTS, previewAssistantAnswer } from "@/components/marketing/home-preview-assistant-data";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

// The Tours / Applications / Leases panels warm the leasing pop-up chunk in a fire-and-forget
// effect (`prefetchLeasingPopups`), so nothing awaits it. Only the rows those panels draw are
// under test here, and under full-suite load that import landed after the environment was torn
// down — an unhandled rejection that exited the whole run 1. Drop the prefetch, keep the
// `next/dynamic` components (they render their loading fallback and are never clicked here).
vi.mock("@/components/marketing/site/product-mock/demo-popups-lazy-leasing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/marketing/site/product-mock/demo-popups-lazy-leasing")>()),
  prefetchLeasingPopups: () => {},
}));

afterEach(cleanup);

const managerAt = (beat: number) => storyAt("manager", beat);

describe("one sample world", () => {
  it("names one workspace for the manager and the resident, and Pacific Plumbing for the vendor", () => {
    expect(PORTAL_META.manager.workspace).toBe("Seattle Homes");
    expect(PORTAL_META.resident.workspace).toBe("Seattle Homes");
    expect(PORTAL_META.vendor.workspace).toBe("Pacific Plumbing");
  });

  it("puts 61 Willow Court in the portfolio with Room 3 as the home Jordan is moving into", () => {
    const willow = PROPERTY_ROWS.find((row) => row.street === "61 Willow Court");
    expect(willow?.title).toBe(RESIDENT_HOME.property);
    expect(willow?.rooms).toBe(3);
    expect(RESIDENT_HOME.room).toBe("Room 3");
    // People are shown by role in the chrome; a manager's list rows keep a plain first name.
    expect(RESIDENT_NAME).toBe("Jordan");
    expect(PORTAL_META.resident.profile.name).toBe("Resident");
  });

  it("derives the dashboard from the rows: rooms from the properties, occupancy from current residents", () => {
    const world = worldFor(NO_STORY);
    const rooms = world.properties.reduce((sum, p) => sum + p.rooms, 0);
    const occupied = world.residents.filter((r) => r.tab === "current").length;
    expect(world.dashboard.occupancy).toEqual({ value: `${Math.round((occupied / rooms) * 100)}%`, unit: `${occupied} / ${rooms}`, series: expect.any(Array), delta: expect.anything() });
    const pending = world.applications.filter((a) => a.bucket === "pending");
    expect(world.dashboard.applicationsReady.value).toBe(String(pending.length));
    expect(world.dashboard.applicationsReady.unit).toBe(`${new Set(pending.map((a) => a.property)).size} properties`);
    expect(world.dashboard.properties).toHaveLength(world.properties.length);
    expect(world.badges.applications).toBe(pending.length);
    expect(world.badges.services).toBe(world.services.filter((s) => s.state === "open").length);
  });

  it("moves Jordan through the manager's tabs as the four beats advance", () => {
    // Beat 1: he asked and booked a tour. Nothing else about him is in a list yet.
    const tour = worldFor(managerAt(0));
    expect(tour.tours.find((t) => t.guest === RESIDENT_NAME)?.bucket).toBe("upcoming");
    expect(tour.applications.some((a) => a.name === RESIDENT_NAME)).toBe(false);
    // Beat 2, once the resident has applied and before the manager approves: pending; he is a potential resident.
    const applied = worldFor({ ...managerAt(0), applicationSubmitted: true });
    expect(applied.applications.find((a) => a.name === RESIDENT_NAME)?.bucket).toBe("pending");
    expect(applied.residents.find((r) => r.name === RESIDENT_NAME)?.tab).toBe("potential");
    // Beat 3: approved and signed by both; he is a current resident and October rent is a pending charge.
    const signed = worldFor(managerAt(2));
    expect(signed.applications.find((a) => a.name === RESIDENT_NAME)?.bucket).toBe("approved");
    expect(signed.leases.find((l) => l.resident === RESIDENT_NAME)?.stage).toBe("Fully Signed");
    expect(signed.residents.find((r) => r.name === RESIDENT_NAME)?.tab).toBe("current");
    expect(signed.payments.find((p) => p.resident === RESIDENT_NAME)).toMatchObject({ chargeTitle: "October rent", amount: "$1,080.00", bucket: "pending" });
    expect(signed.badges.applications).toBe(applied.badges.applications - 1);
    expect(Number.parseInt(signed.dashboard.occupancy.value, 10)).toBeGreaterThan(Number.parseInt(worldFor(NO_STORY).dashboard.occupancy.value, 10));
    // Beat 4: rent is paid, and the faucet is booked with Pacific Plumbing, whose count follows.
    const paid = worldFor(managerAt(3));
    expect(paid.payments.find((p) => p.resident === RESIDENT_NAME)?.bucket).toBe("paid");
    expect(paid.services.find((s) => s.resident === RESIDENT_NAME)).toMatchObject({ title: "Kitchen faucet", state: "scheduled" });
    const before = signed.vendors.find((v) => v.name === "Pacific Plumbing")!.services;
    expect(paid.vendors.find((v) => v.name === "Pacific Plumbing")!.services).toBe(before + 1);
  });

  it("states what each manager tab says about Jordan, in the rows that are drawn", () => {
    const view = (tab: string, beat: number) => {
      const { container } = render(<DemoPanel portal="manager" tab={tab} story={managerAt(beat)} stage="pay" />);
      return container.textContent ?? "";
    };
    expect(view("applications", 1)).toContain(RESIDENT_NAME);
    cleanup();
    expect(view("leases", 2)).toContain(RESIDENT_NAME);
    cleanup();
    expect(view("residents", 3)).toContain(RESIDENT_NAME);
  });

  it("gives the resident portal Jordan's own rows, matching the phone at each beat", () => {
    const stage = (id: string) => residentStory(id);
    // Tour: the tour is booked, nothing is applied for yet.
    expect(worldFor(stage("tour")).tours.find((t) => t.guest === RESIDENT_NAME)?.bucket).toBe("upcoming");
    expect(phoneScriptFor("resident", "tour").items.some((i) => i.kind === "card" && i.eyebrow.startsWith("TOUR"))).toBe(true);
    // Apply: the manager sent the link, and the resident submitted.
    expect(worldFor(stage("apply")).applications.find((a) => a.name === RESIDENT_NAME)?.bucket).toBe("pending");
    expect(phoneScriptFor("resident", "apply").items.some((i) => i.kind === "card" && i.title === "Apply for Room 3 — PropLane")).toBe(true);
    // Sign: the lease is signed.
    expect(stage("sign").leaseStep).toBe(3);
    expect(phoneScriptFor("resident", "sign").items.some((i) => i.kind === "out" && i.text.startsWith("Signed"))).toBe(true);
    // Pay: October rent is paid, and the faucet is booked.
    const pay = worldFor(stage("pay"));
    expect(pay.payments.find((p) => p.resident === RESIDENT_NAME)).toMatchObject({ amount: "$1,080.00", bucket: "paid" });
    expect(pay.services.find((s) => s.resident === RESIDENT_NAME)?.title).toBe("Kitchen faucet");
    // His inbox is the phone's own thread, and he is "Resident" in it.
    const thread = residentConversations(stage("sign"), phoneScriptFor("resident", "sign").items)[0]!;
    expect(thread.messages.map((m) => m.body)).toContain("Signed, thank you!");
    expect(thread.messages.some((m) => m.author === "Resident")).toBe(true);
  });

  it("shows the vendor the area, never the street, until the quote is accepted", () => {
    const text = (stage: string, tab: string) => {
      const { container } = render(<DemoPanel portal="vendor" tab={tab} story={vendorStory(stage)} stage={stage} />);
      const out = container.textContent ?? "";
      cleanup();
      return out;
    };
    expect(text("offer", "work-orders")).toContain("Wallingford, Seattle");
    expect(text("offer", "work-orders")).not.toContain("Willow Court");
    expect(text("quote", "work-orders")).not.toContain("Willow Court");
    expect(text("visit", "work-orders")).toContain("Willow Court");
    expect(text("paid", "financials")).toContain("$180.00");
  });
});

describe("sidebar grouping (the redesigned shell)", () => {
  const mount = (portal: "manager" | "resident" | "vendor", props: Record<string, unknown> = {}) =>
    render(
      <ResidentLifecycleWorkspace portal={portal} tabs={DEMO_TABS[portal]} active={DEMO_TABS[portal][0]!.id} onSelect={() => {}} panel {...props}>
        <span />
      </ResidentLifecycleWorkspace>,
    );

  it("opens every portal with its unheaded home group, then headed groups that put the label first", () => {
    for (const portal of ["manager", "resident", "vendor"] as const) {
      const { container } = mount(portal);
      const groups = Array.from(container.querySelector("nav")!.children);
      expect(groups[0]!.querySelector("p"), `${portal}: the home group has no heading`).toBeNull();
      for (const group of groups.slice(1)) {
        const label = group.querySelector("p");
        // The resident's "My home" group has no heading: it would repeat its own first row.
        if (!label) {
          expect(portal, "only the resident's My home group is unheaded").toBe("resident");
          continue;
        }
        expect(group.firstElementChild, `${portal}: label first`).toBe(label);
      }
      // Every tab is exactly one row in exactly one group.
      const ids = Array.from(container.querySelectorAll("[data-demo-tab]")).map((node) => node.getAttribute("data-demo-tab"));
      expect(ids.sort()).toEqual(DEMO_TABS[portal].map((tab) => tab.id).sort());
      cleanup();
    }
  });

  it("draws the manager sidebar as the original headed groups, like the real shell", () => {
    const { container } = mount("manager");
    const groups = Array.from(container.querySelector("nav")!.children);
    expect(groups).toHaveLength(5);
    expect(groups[0]!.querySelector("p")).toBeNull();
    expect(Array.from(groups[0]!.querySelectorAll("button")).map((b) => b.getAttribute("data-demo-tab"))).toEqual(["dashboard", "tasks", "calendar", "communication"]);
    expect(groups.slice(1).map((group) => group.querySelector("p")?.textContent)).toEqual(["Portfolio", "Leasing", "People", "Money"]);
    expect(Array.from(container.querySelectorAll("nav [data-demo-tab]")).map((b) => b.getAttribute("aria-label"))).toEqual(
      DEMO_TABS.manager.map((tab) => tab.label),
    );
    expect(DEMO_TABS.manager.map((tab) => tab.id)).toEqual(expect.arrayContaining(["dashboard", "properties", "tours", "applications", "leases", "forms", "residents", "vendors", "services", "payments", "outgoing", "financials", "documents"]));
  });

  it("keeps every cursor target on its own row, and only the active row is current", () => {
    const { container } = mount("manager", { active: "applications" });
    for (const tab of DEMO_TABS.manager) expect(container.querySelector(`[data-demo-target="nav-${tab.id}"]`), tab.id).not.toBeNull();
    expect(container.querySelector('[data-demo-tab="applications"]')!.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector('[data-demo-tab="leases"]')!.getAttribute("aria-current")).toBeNull();
    expect(container.querySelector('[data-demo-tab="communication"]')!.getAttribute("aria-current")).toBeNull();
  });

  it("opens the Applications page from its own sidebar row, with no section tab strip", async () => {
    const { container } = render(<HomeDashboardPanel portal="manager" />);
    fireEvent.click(within(container.querySelector(".rlp-nav") as HTMLElement).getByRole("button", { name: "Applications", exact: true }));
    expect(container.querySelector("[data-portal-section-tabs]")).toBeNull();
    expect(container.querySelector('[data-demo-tab="applications"]')).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("heading", { name: "Applications", exact: true }, { timeout: 10_000 })).toBeInTheDocument();
  });

  it("draws the house mark in the top strip and a red count only on an unread Communication", () => {
    const { container } = mount("manager", { badges: { tours: 2, communication: 2 } });
    expect(container.querySelector(".pls-strip svg.pls-strip-mark")).not.toBeNull();
    expect(container.querySelector(".pls-strip")!.innerHTML).not.toMatch(/lucide-send|lucide-plane/);
    expect(container.querySelector('[data-demo-tab="communication"]')!.getAttribute("data-unread")).toBe("true");
    expect(container.querySelector('[data-demo-tab="leases"]')!.getAttribute("data-unread")).toBeNull();
  });

  it("docks one working Ask PropLane panel for each portal and answers from its sample world", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("The sample assistant must not fetch"); });
    try {
      for (const portal of ["manager", "resident", "vendor"] as const) {
        const story = portal === "vendor" ? vendorStory("visit") : residentStory("pay");
        const { container } = mount(portal, { story });
        const entry = screen.getByRole("button", { name: /Ask PropLane or search/ });
        expect(screen.queryByRole("complementary", { name: "PropLane assistant" })).toBeNull();
        fireEvent.click(entry);
        const panel = await screen.findByRole("complementary", { name: "PropLane assistant" }, { timeout: 15_000 });
        expect(container.querySelectorAll(".pls-assistant")).toHaveLength(1);
        const prompt = PREVIEW_ASSISTANT_PROMPTS[portal][0]!;
        fireEvent.click(within(panel).getByRole("button", { name: prompt }));
        expect(within(panel).getByRole("log")).toHaveTextContent(previewAssistantAnswer(portal, prompt, story));
        for (const name of ["Start a new conversation", "Past conversations", "Close PropLane Assistant"]) expect(within(panel).getByRole("button", { name })).toBeInTheDocument();
        fireEvent.click(within(panel).getByRole("button", { name: "Close PropLane Assistant" }));
        expect(container.querySelector(".pls-assistant")).toBeNull();
        expect(entry).toHaveFocus();
        cleanup();
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
