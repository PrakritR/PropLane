import { describe, expect, it } from "vitest";
import { DEMO_TABS } from "@/components/marketing/site/product-mock/demo-panels";
import {
  MANAGER_DONE_BEAT,
  MANAGER_STEPS,
  PORTAL_ORDER,
  SUGGESTED_REPLY,
  TRACKS,
  beatTab,
  managerScript,
  phoneScriptFor,
} from "@/components/marketing/resident-lifecycle-script";

/**
 * The home page demo derives everything on screen from one number, the beat.
 * These pin the contract the engine relies on: every beat opens a tab the
 * shared panel contract knows about, the guided steps line up with the beats,
 * and a stage tab can jump anywhere with consistent sample state.
 */
describe("home demo script", () => {
  it("covers the stages the captain asked for in each portal", () => {
    const labels = (portal: (typeof PORTAL_ORDER)[number]) => TRACKS[portal].stages.map((stage) => stage.label);
    expect(labels("manager")).toEqual(["Message", "Tour", "Application", "Lease", "Move in", "Rent", "Repair"]);
    expect(labels("resident")).toEqual(["Apply", "Sign", "Pay", "Request", "Forms"]);
    expect(labels("vendor")).toEqual(["Offer", "Quote", "Visit", "Paid"]);
  });

  it("opens only tabs that the panel contract lists, for every beat of every portal", () => {
    for (const portal of PORTAL_ORDER) {
      const ids = new Set(DEMO_TABS[portal].map((tab) => tab.id));
      for (const beat of TRACKS[portal].beats) expect(ids.has(beat.tab), `${portal}:${beat.tab}`).toBe(true);
    }
  });

  it("keeps stages contiguous and the manager guided steps on their own beats", () => {
    for (const portal of PORTAL_ORDER) {
      const { stages, beats } = TRACKS[portal];
      let next = 0;
      for (const stage of stages) {
        expect(stage.first).toBe(next);
        next += stage.count;
      }
      expect(next).toBe(beats.length);
    }
    MANAGER_STEPS.forEach((step, index) => expect(TRACKS.manager.beats[index]!.step).toBe(step));
    expect(TRACKS.manager.beats[MANAGER_DONE_BEAT]!.step).toBeUndefined();
  });

  it("derives the manager sample from the beat, so a stage can be jumped to", () => {
    const start = managerScript(0, 0, SUGGESTED_REPLY);
    expect(start).toMatchObject({ chapter: "message", suggestedReply: false, tourAccepted: false, applicationApproved: false, leaseStep: 0, serviceRecord: null });
    expect(start.messages).toHaveLength(1);

    const afterReply = managerScript(2, 2, "custom reply");
    expect(afterReply.chapter).toBe("tour");
    expect(afterReply.messages.some((message) => message.text === "custom reply")).toBe(true);

    const lease = managerScript(7, 7, SUGGESTED_REPLY);
    expect(lease).toMatchObject({ chapter: "lease", tourAccepted: true, applicationApproved: true, leaseStep: 2 });

    const done = managerScript(MANAGER_DONE_BEAT, MANAGER_DONE_BEAT, SUGGESTED_REPLY);
    expect(done).toMatchObject({ chapter: "home", leaseStep: 3 });
    expect(done.serviceRecord?.title).toBe("Kitchen faucet");
  });

  it("shows an action's effect while its chapter transition plays", () => {
    // Approving at beat 3 shows Approved immediately; the chapter only changes after the beat advances.
    const approving = managerScript(3, 4, SUGGESTED_REPLY);
    expect(approving.applicationApproved).toBe(true);
    expect(approving.chapter).toBe("application");
  });

  it("follows the stage's tab and gives the resident and vendor portals a thread per stage", () => {
    expect(beatTab("manager", 0)).toBe("communication");
    expect(beatTab("manager", 999)).toBe("services");
    for (const portal of ["resident", "vendor"] as const) {
      for (const stage of TRACKS[portal].stages) expect(phoneScriptFor(portal, stage.id).items.length, `${portal}:${stage.id}`).toBeGreaterThan(0);
    }
  });

  it("never gives a vendor the street address before a quote is accepted", () => {
    const offer = JSON.stringify(phoneScriptFor("vendor", "offer").items);
    const quote = JSON.stringify(phoneScriptFor("vendor", "quote").items);
    expect(offer).not.toMatch(/Willow/);
    expect(quote).not.toMatch(/Willow/);
  });
});
