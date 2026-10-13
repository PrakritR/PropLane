// Schedule from the thread composer: clock tool -> send tooltip "Send at <time>" -> the one scheduled-send route.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatScheduledLabel } from "@/components/portal/inbox-composer-tools";
import { buildSmsThreadScheduleBody } from "@/lib/sms-thread-schedule";

const read = (p: string) => readFileSync(p, "utf8");

describe("Schedule from thread composer posts a scheduled send", () => {
  it("labels a set time as 'Oct 14 · 9:00 AM'", () => {
    expect(formatScheduledLabel("2026-10-14T09:00")).toBe("Oct 14 · 9:00 AM");
  });

  it("builds the scheduled-inbox-messages body for Text, Email and both", () => {
    const base = {
      residentEmail: "Pat@Example.com",
      residentName: "Pat",
      text: "See you then",
      sendAtLocal: "2026-12-14T09:00",
      nowMs: Date.parse("2026-10-13T00:00:00Z"),
    };
    const text = buildSmsThreadScheduleBody({ ...base, viaEmail: false, viaSms: true });
    expect(text.ok && text.body).toMatchObject({ recipientEmail: "pat@example.com", deliverViaSms: true, deliverViaEmail: false, deliverViaInbox: false });
    const email = buildSmsThreadScheduleBody({ ...base, viaEmail: true, viaSms: false });
    expect(email.ok && email.body).toMatchObject({ deliverViaEmail: true, deliverViaSms: false });
  });

  it("refuses a past time", () => {
    const r = buildSmsThreadScheduleBody({ residentEmail: "a@b.co", text: "x", viaEmail: false, viaSms: true, sendAtLocal: "2020-01-01T09:00" });
    expect(r.ok).toBe(false);
  });

  it("every thread composer passes the send time to the Send icon, and the POST goes to the shared route", () => {
    for (const f of ["pro-inbox", "pro-sms-panel", "pro-resident-detail-inbox", "resident-inbox-panel"]) {
      expect(read(`src/components/portal/${f}.tsx`)).toContain("sendAtLabel=");
    }
    expect(read("src/components/portal/portal-inbox-ui.tsx")).toContain("`Send at ${sendAtLabel}`");
    expect(read("src/components/portal/pro-inbox.tsx")).toContain('"/api/portal/scheduled-inbox-messages"');
    expect(read("src/components/portal/pro-sms-panel.tsx")).toContain('"/api/portal/scheduled-inbox-messages"');
  });
});
