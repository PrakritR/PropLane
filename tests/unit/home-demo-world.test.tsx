// @vitest-environment jsdom
//
// The home demo tells one story in one world: Seattle Homes, with Jordan Rivera
// asking about Room 3 at 61 Willow Court. Every portal reads the same story
// progress (`world.ts`), and every count a panel prints is derived from the
// rows it draws (`docs/agents/marketing-mocks.md`).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { DEMO_TABS, DemoPanel } from "@/components/marketing/site/product-mock/demo-panels";
import {
  NO_STORY,
  managerStory,
  residentConversations,
  residentStory,
  vendorStory,
  worldFor,
} from "@/components/marketing/site/product-mock/world";
import { PROPERTY_ROWS, RESIDENT_HOME, RESIDENT_NAME } from "@/components/marketing/site/product-mock/fixtures";
import { ResidentLifecycleWorkspace } from "@/components/marketing/resident-lifecycle-workspace";
import { PORTAL_META, TRACKS, managerScript, phoneScriptFor, SUGGESTED_REPLY } from "@/components/marketing/resident-lifecycle-script";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

afterEach(cleanup);

const managerAt = (beat: number) => {
  const script = managerScript(beat, beat, SUGGESTED_REPLY);
  return managerStory({
    tourOffered: script.tourOffered,
    tourAccepted: script.tourAccepted,
    applicationSubmitted: script.applicationSubmitted,
    applicationApproved: script.applicationApproved,
    leaseStep: script.leaseStep,
    rentPaid: script.rentPaid,
    vendorBooked: script.vendorBooked,
    hasServiceRecord: Boolean(script.serviceRecord),
  });
};

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
    expect(RESIDENT_NAME).toBe("Jordan Rivera");
    expect(PORTAL_META.resident.profile.name).toBe(RESIDENT_NAME);
  });

  it("derives the dashboard from the rows: rooms from the properties, occupancy from current residents", () => {
    const world = worldFor(NO_STORY);
    const rooms = world.properties.reduce((sum, p) => sum + p.rooms, 0);
    const occupied = world.residents.filter((r) => r.tab === "current").length;
    expect(world.dashboard.occupancy).toEqual({ value: `${Math.round((occupied / rooms) * 100)}%`, unit: `${occupied} / ${rooms} rooms` });
    const pending = world.applications.filter((a) => a.bucket === "pending");
    expect(world.dashboard.applicationsReady.value).toBe(String(pending.length));
    expect(world.dashboard.applicationsReady.unit).toBe(`${new Set(pending.map((a) => a.property)).size} properties`);
    expect(world.dashboard.properties).toHaveLength(world.properties.length);
    expect(world.badges.applications).toBe(pending.length);
    expect(world.badges.services).toBe(world.services.filter((s) => s.state === "open").length);
  });

  it("moves Jordan through the manager's tabs as the story advances", () => {
    // Beat 0-1: only a message. Nothing about Jordan is in a list yet.
    const message = worldFor(managerAt(0));
    expect(message.tours.some((t) => t.guest === RESIDENT_NAME)).toBe(false);
    // The reply is sent: a pending tour offer; he confirms: an upcoming tour and a pending application.
    expect(worldFor(managerAt(2)).tours.find((t) => t.guest === RESIDENT_NAME)?.bucket).toBe("pending");
    const tour = worldFor(managerAt(3));
    expect(tour.tours.find((t) => t.guest === RESIDENT_NAME)?.bucket).toBe("upcoming");
    expect(tour.applications.find((a) => a.name === RESIDENT_NAME)?.bucket).toBe("pending");
    expect(tour.residents.find((r) => r.name === RESIDENT_NAME)?.tab).toBe("potential");
    // Approved: the application moves, the lease appears at Manager review.
    const approved = worldFor(managerAt(4));
    expect(approved.applications.find((a) => a.name === RESIDENT_NAME)?.bucket).toBe("approved");
    expect(approved.leases.find((l) => l.resident === RESIDENT_NAME)?.stage).toBe("Manager review");
    // Lease signed by both: he is a current resident and October rent is a charge; the pending count drops by one.
    const signed = worldFor(managerAt(8));
    expect(signed.leases.find((l) => l.resident === RESIDENT_NAME)?.stage).toBe("Fully Signed");
    expect(signed.residents.find((r) => r.name === RESIDENT_NAME)?.tab).toBe("current");
    expect(signed.payments.find((p) => p.resident === RESIDENT_NAME)).toMatchObject({ chargeTitle: "October rent", amount: "$1,080.00", bucket: "pending" });
    expect(signed.badges.applications).toBe(worldFor(managerAt(3)).badges.applications - 1);
    // Occupancy follows the move-in.
    expect(Number.parseInt(signed.dashboard.occupancy.value, 10)).toBeGreaterThan(Number.parseInt(worldFor(NO_STORY).dashboard.occupancy.value, 10));
    // Rent stage: paid. Repair stage: the faucet is booked with Pacific Plumbing and the vendor's count follows.
    const rent = TRACKS.manager.stages.findIndex((s) => s.id === "rent");
    expect(worldFor(managerAt(TRACKS.manager.stages[rent]!.first)).payments.find((p) => p.resident === RESIDENT_NAME)?.bucket).toBe("paid");
    const repair = worldFor(managerAt(TRACKS.manager.stages.find((s) => s.id === "repair")!.first));
    expect(repair.services.find((s) => s.resident === RESIDENT_NAME)).toMatchObject({ title: "Kitchen faucet", state: "scheduled" });
    const before = worldFor(managerAt(8)).vendors.find((v) => v.name === "Pacific Plumbing")!.services;
    expect(repair.vendors.find((v) => v.name === "Pacific Plumbing")!.services).toBe(before + 1);
  });

  it("states what each manager tab says about Jordan, in the rows that are drawn", () => {
    const view = (tab: string, beat: number) => {
      const { container } = render(<DemoPanel portal="manager" tab={tab} story={managerAt(beat)} stage="repair" />);
      return container.textContent ?? "";
    };
    expect(view("applications", 3)).toContain("Jordan Rivera");
    cleanup();
    expect(view("leases", 4)).toContain("Jordan Rivera");
    cleanup();
    expect(view("residents", 8)).toContain("Jordan Rivera");
  });

  it("gives the resident portal Jordan's own rows, matching the phone at each stage", () => {
    const stage = (id: string) => residentStory(id);
    // Apply: one sent application, no lease yet.
    expect(worldFor(stage("apply")).applications.find((a) => a.name === RESIDENT_NAME)?.bucket).toBe("pending");
    expect(phoneScriptFor("resident", "apply").items.some((i) => i.kind === "card" && i.title === "Rental application")).toBe(true);
    // Sign: the lease he signed is waiting on Avery.
    expect(stage("sign").leaseStep).toBe(2);
    expect(phoneScriptFor("resident", "sign").items.some((i) => i.kind === "card" && i.sub === "Resident signature pending")).toBe(true);
    // Pay: the October rent on the phone is the charge in his Payments tab.
    const pay = worldFor(stage("pay")).payments.find((p) => p.resident === RESIDENT_NAME)!;
    expect(pay.amount).toBe("$1,080.00");
    expect(phoneScriptFor("resident", "pay").items.some((i) => i.kind === "card" && i.sub.startsWith("$1,080"))).toBe(true);
    // Request: the faucet.
    expect(worldFor(stage("request")).services.find((s) => s.resident === RESIDENT_NAME)?.title).toBe("Kitchen faucet");
    // His inbox is the phone's own thread.
    const thread = residentConversations(stage("sign"), phoneScriptFor("resident", "sign").items)[0]!;
    expect(thread.messages.map((m) => m.body)).toContain("Signed, thanks!");
  });

  it("shows the vendor the area, never the street, until the quote is accepted", () => {
    const text = (stage: string, tab: string) => {
      const { container } = render(<DemoPanel portal="vendor" tab={tab} story={vendorStory(stage)} stage={stage} />);
      const out = container.textContent ?? "";
      cleanup();
      return out;
    };
    expect(text("offer", "services")).toContain("Wallingford, Seattle");
    expect(text("offer", "services")).not.toContain("Willow Court");
    expect(text("quote", "services")).not.toContain("Willow Court");
    expect(text("visit", "services")).toContain("Willow Court");
    expect(text("paid", "payments")).toContain("$180.00");
  });
});

describe("sidebar grouping", () => {
  it("puts every group label before the items it labels, in every portal", () => {
    for (const portal of ["manager", "resident", "vendor"] as const) {
      const { container } = render(
        <ResidentLifecycleWorkspace portal={portal} tabs={DEMO_TABS[portal]} active={DEMO_TABS[portal][0]!.id} onSelect={() => {}} panel>
          <span />
        </ResidentLifecycleWorkspace>,
      );
      const nav = container.querySelector("nav")!;
      for (const group of Array.from(nav.children)) {
        const label = group.querySelector("p");
        if (label) expect(group.firstElementChild, `${portal}: label first`).toBe(label);
      }
      // A labeled portal opens with a label, never a bare item above it.
      if (DEMO_TABS[portal].some((tab) => tab.group)) expect(nav.firstElementChild!.querySelector("p"), `${portal}: opens with a label`).not.toBeNull();
      cleanup();
    }
  });

  it("opens the manager sidebar under WORKSPACE with Dashboard first", () => {
    const { container } = render(
      <ResidentLifecycleWorkspace portal="manager" tabs={DEMO_TABS.manager} active="dashboard" onSelect={() => {}} panel>
        <span />
      </ResidentLifecycleWorkspace>,
    );
    const first = container.querySelector("nav")!.firstElementChild!;
    expect(within(first as HTMLElement).getByText("WORKSPACE")).toBeInTheDocument();
    expect(Array.from(first.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"))).toEqual(["Dashboard", "Properties"]);
    expect(screen.queryByText("Willow Court LLC")).toBeNull();
  });
});
