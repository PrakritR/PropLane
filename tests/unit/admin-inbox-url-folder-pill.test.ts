import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Admin Communication has status pills, not folder tabs — but the folder paths
 * still resolve, and a link to one must open on it. The pills held their own
 * state seeded to "unopened", so `/admin/communication/inbox/sent` rendered
 * with **Unopened** selected (PRP-258).
 *
 * That is the same defect AGENTS.md records for this screen: folder tabs over a
 * panel that had stopped reading which one was in the URL. Fixing the pills
 * without wiring the URL through would have recreated it.
 */
const COMMUNICATION = readFileSync(
  join(process.cwd(), "src/components/portal/admin-communication.tsx"),
  "utf8",
);
const CLIENT = readFileSync(
  join(process.cwd(), "src/components/portal/admin-inbox-client.tsx"),
  "utf8",
);
const RENDER = readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8");

describe("admin inbox opens on the folder in the URL", () => {
  it("the route still passes the folder through", () => {
    expect(RENDER).toContain("<AdminCommunication inboxTabId={emailTab as");
  });

  it("Communication forwards it to the inbox as the initial pill", () => {
    expect(COMMUNICATION).toContain("initialEmailTab={");
    expect(COMMUNICATION).toContain('inboxTabId === "opened" || inboxTabId === "sent" ? inboxTabId : "unopened"');
  });

  it("only the three pill folders may seed a pill", () => {
    // `schedule` and `trash` are separate views reached by a toggle, not pills;
    // seeding one of those would select nothing and render as Unopened anyway.
    const forwarded = COMMUNICATION.slice(COMMUNICATION.indexOf("initialEmailTab={"));
    expect(forwarded.slice(0, 160)).not.toContain('"schedule"');
    expect(forwarded.slice(0, 160)).not.toContain('"trash"');
  });

  it("the pill state is seeded from it, not hardcoded", () => {
    expect(CLIENT).toContain('useState<"unopened" | "opened" | "sent">(\n    initialEmailTab ?? "unopened",\n  )');
  });

  it("the pills render for the whole embedded Communication view", () => {
    // Gating them on a URL folder would hide them at the bare path.
    expect(CLIENT).toContain('embeddedInCommunication && tabId === "all" ? (');
  });
});
