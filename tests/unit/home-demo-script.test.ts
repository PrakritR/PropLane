import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HOME_DEMO_JOURNEY,
  HOME_DEMO_PHOTOS,
  homeDemoEndPhone,
  homeDemoEndPortal,
  homeDemoJumpPlan,
  homeDemoPhoneAfter,
  type HomeDemoStep,
} from "@/components/demo/home-demo-script";
import { DISCOVERY_LINES, discoveryLineAsText } from "@/components/marketing/home-discovery-script";
import {
  HOME_DEMO_PROSPECT_THREAD_ID,
  buildHomeDemoSnapshot,
  homeDemoProspectThread,
  homeDemoResidentProspectThread,
  homeDemoResidentTourView,
  homeDemoTourWindow,
  homeDemoVisitIso,
} from "@/lib/demo/demo-guided-data";
import {
  HOME_DEMO_JORDAN,
  homeDemoJordanApplication,
  homeDemoJordanCharges,
  homeDemoJordanLease,
  homeDemoJordanService,
} from "@/lib/demo/home-demo-journey-data";
import { HOME_DEMO_EMBED_PATH, HOME_DEMO_PORTAL_LABEL } from "@/lib/demo/home-demo-embed";
import { residentNavLockReason } from "@/lib/resident-portal-nav";

// The service record only draws an inline image whose data URL looks like this (service-details-section.tsx).
const SAFE_PHOTO = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i;
const steps = HOME_DEMO_JOURNEY.steps;
const pressed = (predicate: (step: Extract<HomeDemoStep, { do: "click" }>) => boolean) =>
  steps.find((s): s is Extract<HomeDemoStep, { do: "click" }> => s.do === "click" && predicate(s));

describe("homepage Software demo journey", () => {
  it("is one journey with five beats, in the order a renter lives them", () => {
    expect(steps.filter((s) => s.do === "mark").map((s) => (s as { id: string }).id)).toEqual(["tour", "application", "payments", "lease", "vendor"]);
    // Every `say` reveals lines that exist: a phone can never be asked for a line the script does not have.
    const revealed = HOME_DEMO_JOURNEY.phones.map((p) => p.initial ?? 0);
    let phone = 0;
    for (const step of steps) {
      if (step.do !== "say") continue;
      phone = step.phone ?? phone;
      revealed[phone]! += step.count ?? 1;
    }
    HOME_DEMO_JOURNEY.phones.forEach((p, i) => expect(revealed[i]).toBe(p.items.length));
  });

  it("opens in the resident portal and moves through the manager's and the vendor's, ending on the manager's Services", () => {
    expect(HOME_DEMO_JOURNEY.portal).toBe("resident");
    const roles = steps.flatMap((s) => (s.do === "portal" ? [s.role] : []));
    expect(new Set([HOME_DEMO_JOURNEY.portal, ...roles])).toEqual(new Set(["resident", "manager", "vendor"]));
    // Each beat: the resident acts, then the manager answers (the vendor moment goes resident, vendor, manager).
    expect(roles).toEqual(["manager", "resident", "manager", "resident", "manager", "manager", "resident", "vendor", "manager"]);
    expect(homeDemoEndPortal()).toBe("manager");
    expect(HOME_DEMO_PORTAL_LABEL).toEqual({ resident: "Resident", vendor: "Vendor", manager: "Property" });
  });

  it("the portal switcher jumps to each portal's first step, and its end frame is where that portal's last stretch ends", () => {
    const portalAt = (index: number) => {
      const step = steps[index]!;
      return step.do === "portal" ? step.role : null;
    };
    // The journey opens in the resident portal: its first step is the start.
    expect(homeDemoJumpPlan("resident").resumeAt).toBe(0);
    for (const role of ["manager", "vendor"] as const) {
      const { resumeAt } = homeDemoJumpPlan(role);
      expect(portalAt(resumeAt)).toBe(role);
      // No earlier step opens that portal.
      expect(steps.slice(0, resumeAt).some((s) => s.do === "portal" && s.role === role)).toBe(false);
    }
    // The end of a portal's part is the step that leaves it for another portal (or the journey's end).
    // (the resident's part stops before the text that offers the service to the vendor: that text is the vendor's.)
    const residentEnd = homeDemoJumpPlan("resident").until;
    expect(steps.slice(residentEnd).findIndex((s) => s.do === "portal" && s.role === "vendor")).toBeGreaterThan(-1);
    expect(homeDemoPhoneAfter(residentEnd).label).toBe("Jordan’s phone");
    expect(portalAt(homeDemoJumpPlan("vendor").until)).toBe("manager");
    expect(homeDemoJumpPlan("manager").until).toBe(steps.length);
    // The vendor's part ends after the YES, and its phone has said so.
    expect(homeDemoPhoneAfter(homeDemoJumpPlan("vendor").until).items.length).toBe(3);
    // Before the vendor portal opens, the vendor's text has only just arrived.
    expect(homeDemoPhoneAfter(homeDemoJumpPlan("vendor").resumeAt).label).toBe("Vendor’s phone");
    expect(homeDemoPhoneAfter().items).toEqual(homeDemoEndPhone().items);
  });

  it("lands every effect at the press (or the switch) that opens what it fills, so no tab or panel is ever empty", () => {
    expect(pressed((s) => s.target.kind === "nav" && s.target.section === "tour")?.effect).toEqual({ id: "tour" });
    expect(pressed((s) => s.target.kind === "tab" && s.target.label === "Approved")?.effect).toEqual({ id: "applicationApprove" });
    expect(pressed((s) => s.target.kind === "tab" && s.target.label === "Paid")?.effect).toEqual({ id: "chargesPay" });
    expect(pressed((s) => s.target.kind === "tab" && s.target.label === "Signed")?.effect).toEqual({ id: "leaseSign" });
    expect(pressed((s) => s.target.kind === "nav" && s.target.section === "services")?.effect).toEqual({ id: "serviceRequest" });
    expect(pressed((s) => s.target.kind === "tab" && s.target.label === "Assigned" && s.effect !== undefined)?.effect).toEqual({ id: "assign" });
    const switches = steps.filter((s): s is Extract<HomeDemoStep, { do: "portal" }> => s.do === "portal");
    const effectOn = (role: string, section: string) => switches.find((s) => s.role === role && s.section === section)?.effect;
    expect(effectOn("resident", "applications")).toEqual({ id: "applicationSubmit" });
    expect(effectOn("resident", "payments")).toEqual({ id: "chargesCreate" });
    expect(effectOn("manager", "leases")).toEqual({ id: "leaseSend" });
    // The lists the manager lands on open on the tab that holds the row.
    expect(switches.find((s) => s.section === "tours")?.tab).toBe("upcoming");
    expect(switches.find((s) => s.section === "payments" && s.role === "manager")?.tab).toBe("paid");
    expect(switches.find((s) => s.section === "leases")?.tab).toBe("resident");
    // The only effect riding on a text is the offer, which lands on the vendor's Open tab as the text lands.
    const onText = steps.filter((s): s is Extract<HomeDemoStep, { do: "say" }> => s.do === "say" && s.effect !== undefined && s.effect.id !== "thread");
    expect(onText.map((s) => s.effect)).toEqual([{ id: "offer" }]);
  });

  it("moves the resident's lifecycle stage for real, so Lease and My home unlock as the journey advances", () => {
    const stages = steps.flatMap((s) => (s.do === "stage" ? [s.stage] : []));
    expect(HOME_DEMO_JOURNEY.resident.stage).toBe("pre_approval");
    expect(stages).toEqual(["application_submitted", "post_approval_pre_lease", "post_lease"]);
    // The real stage tables (STAGE_UNLOCKED_SECTIONS), not a drawn imitation.
    expect(residentNavLockReason("tour", "pre_approval")).toBeNull();
    expect(residentNavLockReason("lease", "application_submitted")).not.toBeNull();
    expect(residentNavLockReason("lease", "post_approval_pre_lease")).toBeNull();
    expect(residentNavLockReason("payments", "post_approval_pre_lease")).toBeNull();
    expect(residentNavLockReason("move-in", "post_approval_pre_lease")).not.toBeNull();
    expect(residentNavLockReason("move-in", "post_lease")).toBeNull();
    expect(residentNavLockReason("services", "post_lease")).toBeNull();
    // The stage change lands once the lease is signed, before the vendor beat uses Services.
    const at = (predicate: (s: HomeDemoStep) => boolean) => steps.findIndex(predicate);
    expect(at((s) => s.do === "stage" && s.stage === "post_lease")).toBeGreaterThan(at((s) => s.do === "click" && s.effect?.id === "leaseSign"));
    expect(at((s) => s.do === "stage" && s.stage === "post_lease")).toBeLessThan(at((s) => s.do === "click" && s.effect?.id === "serviceRequest"));
  });

  it("tells beat one with the shared discovery conversation, not a retyped copy", () => {
    const phone = HOME_DEMO_JOURNEY.phones[0]!;
    expect(phone.label).toBe("Jordan’s phone");
    expect(HOME_DEMO_JOURNEY.phones[1]!.label).toBe("Vendor’s phone");
    expect(phone.initial).toBe(1);
    // Up to the booked tour: the lines the hero phone shows.
    expect(phone.items.slice(0, 6)).toHaveLength(6);
    const texts = DISCOVERY_LINES.slice(0, 6).map(discoveryLineAsText).filter((t): t is string => t !== null);
    const thread = homeDemoProspectThread(6, 1_000_000);
    expect([thread.body, ...(thread.messages ?? []).map((m) => m.body)]).toEqual(texts);
    expect(thread.id).toBe(HOME_DEMO_PROSPECT_THREAD_ID);
    expect(thread.rootChannel).toBe("sms");
    // The prospect's turns are inbound and PropLane's are the manager's own outbound turns.
    expect(thread.rootOutbound).toBe(false);
    expect(thread.messages![0]!.outbound).toBe(true);
    expect(homeDemoEndPhone().label).toBe("Vendor’s phone");
  });

  it("opens with the first text already in both inboxes, and the faucet service not yet created", () => {
    const snapshot = buildHomeDemoSnapshot();
    expect(snapshot.managerInbox.map((t) => t.id)).toContain(HOME_DEMO_PROSPECT_THREAD_ID);
    expect(snapshot.residentInbox.map((t) => t.id)).toEqual([HOME_DEMO_PROSPECT_THREAD_ID]);
    expect(snapshot.workOrders).toEqual([]);
    expect(snapshot.properties.map((p) => p.address)).toEqual(["61 Willow Court", "3301 Fremont Ave N", "1412 Maple Ct"]);
  });

  it("shows the prospect the same conversation from her side, and the booked tour on the Tour page", () => {
    const manager = homeDemoProspectThread(6, 1_000_000);
    const resident = homeDemoResidentProspectThread(6, 1_000_000);
    const turns = (t: typeof manager) => [{ body: t.body, outbound: t.rootOutbound }, ...(t.messages ?? []).map((m) => ({ body: m.body, outbound: m.outbound }))];
    expect(turns(resident).map((t) => t.body)).toEqual(turns(manager).map((t) => t.body));
    // What one side sent, the other received.
    expect(turns(resident).map((t) => t.outbound)).toEqual(turns(manager).map((t) => !t.outbound));
    expect(resident.id).toBe(manager.id);
    const tour = homeDemoResidentTourView();
    expect(tour).toMatchObject({ propertyTitle: "61 Willow Court", confirmed: true, status: "confirmed", guestName: HOME_DEMO_JORDAN.name });
    expect(tour.confirmedStart).toBe(homeDemoTourWindow().start);
  });

  it("follows ONE renter: his application, charges, lease and service all carry his email", () => {
    const email = HOME_DEMO_JOURNEY.resident.email;
    expect(email).toBe(HOME_DEMO_JORDAN.email);
    expect(homeDemoJordanApplication("submitted")).toMatchObject({ email, bucket: "pending", stage: "Submitted" });
    expect(homeDemoJordanApplication("approved")).toMatchObject({ email, bucket: "approved", assignedPropertyId: "demo-prop-willow" });
    const charges = homeDemoJordanCharges("pending", 1_000_000);
    expect(charges.map((c) => c.kind)).toEqual(["application_fee", "security_deposit", "first_month_rent"]);
    expect(charges.every((c) => c.residentEmail === email && c.status === "pending")).toBe(true);
    expect(homeDemoJordanCharges("paid", 1_000_000).every((c) => c.status === "paid" && c.balanceLabel === "$0.00")).toBe(true);
    // The charge ids are stable so the paid set REPLACES the pending one.
    expect(homeDemoJordanCharges("paid", 2_000_000).map((c) => c.id)).toEqual(charges.map((c) => c.id));
    const sent = homeDemoJordanLease("sent", 1_000_000);
    expect(sent).toMatchObject({ residentEmail: email, bucket: "resident", status: "Resident Signature Pending", residentSignature: null });
    expect(sent.generatedHtml).toBeTruthy();
    expect(homeDemoJordanLease("signed", 1_000_000)).toMatchObject({ bucket: "signed", status: "Fully Signed" });
    expect(homeDemoJordanService(HOME_DEMO_PHOTOS.leak)).toMatchObject({ residentEmail: email, propertyAddress: "61 Willow Court", title: "Leaking kitchen faucet" });
  });

  it("offers the vendor the Willow Court faucet in the captain's words", () => {
    const [offer] = HOME_DEMO_JOURNEY.phones[1]!.items;
    expect(offer).toEqual({ kind: "in", text: "New service at 61 Willow Court: leaking kitchen faucet. Reply YES to take it." });
  });

  it("draws its photos as inline SVG the service record will render", () => {
    for (const url of Object.values(HOME_DEMO_PHOTOS)) {
      expect(url).toMatch(SAFE_PHOTO);
      expect(atob(url.split(",")[1]!)).toContain("<svg");
    }
  });

  it("says service, never work order, anywhere a visitor reads", () => {
    const snapshot = buildHomeDemoSnapshot();
    const words = JSON.stringify([
      HOME_DEMO_JOURNEY,
      snapshot.managerInbox,
      snapshot.residentInbox,
      homeDemoJordanApplication("approved"),
      homeDemoJordanCharges("paid", 1),
      homeDemoJordanLease("signed", 1),
      homeDemoJordanService(HOME_DEMO_PHOTOS.leak).title,
    ]);
    expect(words.toLowerCase()).not.toContain("work order");
  });

  it("books the tour and the visit on a Thursday, a calendar week out from a Monday-Wednesday today", () => {
    const tour = homeDemoTourWindow();
    const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long" });
    expect(day.format(new Date(tour.start))).toBe("Thursday");
    expect(day.format(new Date(homeDemoVisitIso()))).toBe("Thursday");
    expect(new Date(tour.start).getTime()).toBeGreaterThan(Date.now());
  });

  it("resolves a nav target against the portal on screen, and the resident Tour is the real tour panel", () => {
    const embed = readFileSync("src/components/demo/home-demo-embed.tsx", "utf8");
    expect(embed).toContain('resident: "/resident/"');
    expect(embed).toContain('vendor: "/vendor/"');
    expect(embed).toContain("HOME_DEMO_PORTAL_LABEL[portal]");
    // Every panel is loaded before the first frame, so none is drawn as "Loading…".
    expect(embed).toContain("preloadHomeDemoPanels()");
    const renderer = readFileSync("src/components/demo/demo-section-renderer.tsx", "utf8");
    const resident = renderer.slice(renderer.indexOf("// resident\n  switch"));
    expect(resident).toMatch(/case "tour":[\s\S]*<ResidentTourPanel/);
    expect(renderer).toContain('import("@/components/portal/resident-tour-panel")');
  });

  it("is reachable at exactly one /demo path", () => {
    expect(HOME_DEMO_EMBED_PATH).toBe("/demo/home-embed");
  });
});
