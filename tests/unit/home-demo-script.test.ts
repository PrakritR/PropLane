import { describe, expect, it } from "vitest";
import { DEMO_TABS } from "@/components/marketing/site/product-mock/demo-panels";
import {
  MANAGER_STEPS,
  PHONE_META,
  PORTAL_META,
  PORTAL_ORDER,
  STORIES,
  beatAfter,
  framesFor,
  managerMessages,
  mirrorItems,
  phoneScriptFor,
  shownThrough,
  stateAfter,
  stateAtBeat,
  storyAt,
  threadItems,
  timelineFor,
} from "@/components/marketing/resident-lifecycle-script";

/**
 * The home page demo derives everything on screen from one number: how many phone
 * messages have arrived. These pin the contract the engine relies on: four beats per
 * portal, one or two messages each, every beat opening a tab the panel contract knows,
 * people named by role, and sample state that only ever moves forward.
 */
describe("home demo script", () => {
  it("tells the story in four beats in each portal", () => {
    expect(STORIES.manager.map((beat) => beat.id)).toEqual(["tour", "apply", "sign", "pay"]);
    expect(STORIES.resident.map((beat) => beat.id)).toEqual(["tour", "apply", "sign", "pay"]);
    expect(STORIES.vendor.map((beat) => beat.id)).toEqual(["offer", "quote", "visit", "paid"]);
  });

  it("keeps every beat short: one to three phone messages", () => {
    for (const portal of PORTAL_ORDER) {
      for (const beat of STORIES[portal]) expect([1, 2, 3], `${portal}:${beat.id}`).toContain(beat.messages.length);
    }
  });

  it("opens only tabs that the panel contract lists, for every beat of every portal", () => {
    for (const portal of PORTAL_ORDER) {
      const ids = new Set(DEMO_TABS[portal].map((tab) => tab.id));
      for (const beat of STORIES[portal]) expect(ids.has(beat.tab), `${portal}:${beat.tab}`).toBe(true);
    }
  });

  it("names people by role, never by a sample name", () => {
    expect(PORTAL_META.manager.profile.name).toBe("Manager");
    expect(PORTAL_META.resident.profile.name).toBe("Resident");
    expect(PORTAL_META.vendor.profile.name).toBe("Vendor");
    expect(PHONE_META.manager.caption).toBe("Resident's phone");
    expect(PHONE_META.resident.caption).toBe("Manager's phone");
    expect(PHONE_META.vendor.caption).toBe("Vendor's phone");
    const everything = JSON.stringify([PORTAL_META, PHONE_META, STORIES]);
    expect(everything).not.toMatch(/Avery|Morgan|Marcus|Rivera/);
  });

  it("counts messages and finds the beat each one belongs to", () => {
    expect(framesFor("manager")).toHaveLength(9);
    expect(framesFor("vendor")).toHaveLength(5);
    expect(beatAfter("manager", 0)).toBe(0);
    expect(beatAfter("manager", 2)).toBe(0);
    expect(beatAfter("manager", 3)).toBe(1);
    expect(beatAfter("manager", 999)).toBe(3);
    expect(shownThrough("manager", 0)).toBe(2);
    expect(shownThrough("manager", 3)).toBe(9);
  });

  it("derives the manager sample from the beat, and it only moves forward", () => {
    const early = storyAt("manager", 0);
    expect(early).toMatchObject({ tourAccepted: true, applicationSubmitted: false, applicationApproved: false, leaseStep: 0, rentPaid: false, service: "none" });
    expect(storyAt("manager", 1)).toMatchObject({ applicationSubmitted: true, applicationApproved: true, leaseStep: 0 });
    expect(storyAt("manager", 2)).toMatchObject({ applicationApproved: true, leaseStep: 3, rentPaid: false });
    expect(storyAt("manager", 3)).toMatchObject({ rentPaid: true, service: "scheduled" });
    expect(storyAt("resident", 3)).toMatchObject({ rentPaid: true, service: "scheduled" });
    expect(storyAt("vendor", 0).service).toBe("open");
    expect(storyAt("vendor", 3).service).toBe("paid");
  });

  it("draws the thread from its owner's side and mirrors it for the other party", () => {
    const owned = threadItems("manager", 2);
    expect(owned.map((item) => item.kind)).toEqual(["time", "out", "in", "card"]);
    const mirrored = mirrorItems(owned);
    expect(mirrored.map((item) => item.kind)).toEqual(["time", "in", "out", "card"]);
    expect(managerMessages(2).map((message) => message.from)).toEqual(["resident", "manager"]);
  });

  it("gives the resident and vendor Communication panels a thread through each beat", () => {
    for (const portal of ["resident", "vendor"] as const) {
      for (const beat of STORIES[portal]) expect(phoneScriptFor(portal, beat.id).items.length, `${portal}:${beat.id}`).toBeGreaterThan(0);
    }
    expect(phoneScriptFor("resident", "pay").items.length).toBeGreaterThan(phoneScriptFor("resident", "tour").items.length);
  });

  it("never gives a vendor the street address before a quote is accepted", () => {
    const early = JSON.stringify(phoneScriptFor("vendor", "quote").items);
    expect(early).not.toMatch(/Willow/i);
    expect(JSON.stringify(phoneScriptFor("vendor", "visit").items)).toMatch(/Willow/i);
  });

  describe("the manager's story is causal", () => {
    const steps = MANAGER_STEPS;
    const messageAt = (nth: number) => framesFor("manager")[nth]!.message;

    it("puts a manager click right before every line the manager sends", () => {
      let landed = 0;
      steps.forEach((step, index) => {
        if (step.kind !== "say") return;
        const message = messageAt(landed);
        landed += 1;
        if (message.kind !== "in") return;
        expect(steps[index - 1]?.kind, `message ${landed} (${message.text}) follows a click`).toBe("click");
      });
      expect(landed).toBe(framesFor("manager").length);
    });

    it("lands exactly the phone's messages, in every portal", () => {
      for (const portal of PORTAL_ORDER) {
        expect(timelineFor(portal).filter((step) => step.kind === "say")).toHaveLength(framesFor(portal).length);
        expect(stateAfter(portal, timelineFor(portal).length).shown).toBe(framesFor(portal).length);
      }
    });

    it("clicks only controls the panels mark, and opens only tabs the sidebar has", () => {
      const tabs = new Set(DEMO_TABS.manager.map((tab) => tab.id));
      const marked = new Set(["comm-approve", "applications-send", "sheet-primary", "application-row", "lease-row", "payment-row", "service-row"]);
      for (const step of steps) {
        if (step.kind === "nav") expect(tabs.has(step.target!), `tab ${step.target}`).toBe(true);
        if (step.kind === "click") expect(marked.has(step.target!), `target ${step.target}`).toBe(true);
      }
    });

    it("shows the drafted reply until the manager approves it, then books the tour", () => {
      const draftAt = steps.findIndex((step) => step.patch?.draft === true);
      const approveAt = steps.findIndex((step) => step.target === "comm-approve");
      expect(draftAt).toBeGreaterThan(-1);
      expect(approveAt).toBeGreaterThan(draftAt);
      expect(stateAfter("manager", draftAt + 1).draft).toBe(true);
      expect(stateAfter("manager", draftAt + 1).story.tourAccepted).toBe(false);
      const approved = stateAfter("manager", approveAt + 1);
      expect(approved.draft).toBe(false);
      expect(approved.story).toMatchObject({ tourOffered: true, tourAccepted: true });
    });

    it("only moves forward: messages never leave, a story flag never turns back", () => {
      let previous = stateAfter("manager", 0);
      for (let count = 1; count <= steps.length; count += 1) {
        const next = stateAfter("manager", count);
        expect(next.shown).toBeGreaterThanOrEqual(previous.shown);
        expect(next.story.leaseStep).toBeGreaterThanOrEqual(previous.story.leaseStep);
        for (const flag of ["tourAccepted", "applicationSubmitted", "applicationApproved", "rentPaid"] as const) {
          expect(Number(next.story[flag]), flag).toBeGreaterThanOrEqual(Number(previous.story[flag]));
        }
        previous = next;
      }
    });

    it("starts on the Dashboard and ends each beat on a whole thing: the tab it opened", () => {
      expect(stateAfter("manager", 0).tab).toBe("dashboard");
      expect(stateAtBeat("manager", 0).tab).toBe("communication");
      expect(stateAtBeat("manager", 1).tab).toBe("applications");
      expect(stateAtBeat("manager", 2).tab).toBe("leases");
      expect(stateAtBeat("manager", 3).tab).toBe("services");
    });
  });
});
