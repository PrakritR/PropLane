import { describe, expect, it } from "vitest";
import { HOME_DEMO_CHAPTER_DATA, HOME_DEMO_PHOTOS, homeDemoEndPhone } from "@/components/demo/home-demo-script";
import { DISCOVERY_LINES, discoveryLineAsText } from "@/components/marketing/home-discovery-script";
import {
  HOME_DEMO_PROSPECT_THREAD_ID,
  buildHomeDemoSnapshot,
  homeDemoProspectThread,
  homeDemoTourWindow,
  homeDemoVisitIso,
} from "@/lib/demo/demo-guided-data";
import { HOME_DEMO_CHAPTERS, HOME_DEMO_EMBED_PATH } from "@/lib/demo/home-demo-embed";

// The service record only draws an inline image whose data URL looks like this (service-details-section.tsx).
const SAFE_PHOTO = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i;

describe("homepage Software demo script", () => {
  it("has three chapters, each with phone lines to reveal and a real control to click", () => {
    expect(HOME_DEMO_CHAPTERS.map((c) => c.id)).toEqual(["find", "vendor", "photo"]);
    for (const { id } of HOME_DEMO_CHAPTERS) {
      const chapter = HOME_DEMO_CHAPTER_DATA[id];
      expect(chapter.steps.some((s) => s.do === "click")).toBe(true);
      // Every `say` reveals lines that exist: the phone can never be asked for a line the script does not have.
      const revealed = chapter.phones.map(() => 0);
      let phone = 0;
      for (const step of chapter.steps) {
        if (step.do !== "say") continue;
        phone = step.phone ?? phone;
        revealed[phone]! += step.count ?? 1;
      }
      chapter.phones.forEach((p, i) => expect(revealed[i]).toBe(p.items.length));
    }
  });

  it("tells chapter 1 with the shared discovery conversation, not a retyped copy", () => {
    const phone = HOME_DEMO_CHAPTER_DATA.find.phones[0]!;
    expect(phone.items).toHaveLength(DISCOVERY_LINES.length);
    expect(homeDemoEndPhone("find").items).toHaveLength(DISCOVERY_LINES.length);
    const texts = DISCOVERY_LINES.map(discoveryLineAsText).filter((t): t is string => t !== null);
    const thread = homeDemoProspectThread(DISCOVERY_LINES.length, 1_000_000);
    expect([thread.body, ...(thread.messages ?? []).map((m) => m.body)]).toEqual(texts);
    expect(thread.id).toBe(HOME_DEMO_PROSPECT_THREAD_ID);
    expect(thread.rootChannel).toBe("sms");
    // The prospect's turns are inbound and PropLane's are the manager's own outbound turns.
    expect(thread.rootOutbound).toBe(false);
    expect(thread.messages![0]!.outbound).toBe(true);
  });

  it("offers the vendor the Willow Court faucet in the captain's words", () => {
    const [offer] = HOME_DEMO_CHAPTER_DATA.vendor.phones[0]!.items;
    expect(offer).toEqual({ kind: "in", text: "New service at 61 Willow Court: leaking kitchen faucet. Reply YES to take it." });
    expect(buildHomeDemoSnapshot().workOrders.map((w) => w.id)).toContain("home-wo-willow-faucet");
  });

  it("draws its photos as inline SVG the service record will render", () => {
    for (const url of Object.values(HOME_DEMO_PHOTOS)) {
      expect(url).toMatch(SAFE_PHOTO);
      expect(atob(url.split(",")[1]!)).toContain("<svg");
    }
  });

  it("says service, never work order, anywhere a visitor reads", () => {
    const words = JSON.stringify([HOME_DEMO_CHAPTER_DATA, HOME_DEMO_CHAPTERS, buildHomeDemoSnapshot().managerInbox]);
    expect(words.toLowerCase()).not.toContain("work order");
  });

  it("books the tour and the visit on a Thursday, a calendar week out from a Monday-Wednesday today", () => {
    const tour = homeDemoTourWindow();
    const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long" });
    expect(day.format(new Date(tour.start))).toBe("Thursday");
    expect(day.format(new Date(homeDemoVisitIso()))).toBe("Thursday");
    expect(new Date(tour.start).getTime()).toBeGreaterThan(Date.now());
  });

  it("seeds a resident for the faucet at Maple Duplex (a service whose resident left the directory is not drawn)", () => {
    const snapshot = buildHomeDemoSnapshot();
    expect(snapshot.applications.map((a) => a.email)).toContain("dana.reyes@example.com");
    expect(snapshot.properties.map((p) => p.address)).toEqual(["61 Willow Court", "3301 Fremont Ave N", "1412 Maple Ct"]);
  });

  it("is reachable at exactly one /demo path", () => {
    expect(HOME_DEMO_EMBED_PATH).toBe("/demo/home-embed");
  });
});
