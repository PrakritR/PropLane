import { describe, expect, it } from "vitest";
import {
  PHONE_REQUIRED_MESSAGE,
  hasRealEmailAddress,
  normalizeReachBy,
  resolveRecipientChannels,
} from "@/lib/recipient-channels";
import {
  AUTOMATED_MESSAGE_CATALOG,
  TEXT_BY_DEFAULT_EVENT_KEYS,
  automatedMessageKey,
  defaultAutomatedMessageChannels,
  normalizeAutomatedMessageSettings,
} from "@/lib/automated-messages-settings";
import { DEFAULT_REMINDER_RULES, REMINDER_SUBJECT_KINDS, pacificDateKey, reminderDedupeKey, reminderPersonRef } from "@/lib/reminders/rules";
import { renderReminder } from "@/lib/reminders/render";
import { reminderAnchorHasPassed } from "@/lib/reminders/current.server";
import { emptyAddPersonForm, buildManualResidentRow, reachByDetails, thingsToFinish } from "@/components/portal/resident-wizard/state";

const reachable = { hasVerifiedOrKnownPhone: true, optedOut: false, hasRealEmail: true };

describe("resolveRecipientChannels", () => {
  it("always keeps the app and sends on every channel the person can receive when nothing narrows it", () => {
    expect(resolveRecipientChannels({ ...reachable })).toEqual({ app: true, email: true, sms: true });
  });

  it("never texts a number that texted STOP, even when every list says text", () => {
    expect(resolveRecipientChannels({ ...reachable, optedOut: true, eventChannels: { email: true, sms: true }, reachBy: ["app", "email", "sms"] }).sms).toBe(false);
  });

  it("never texts without a phone and never emails a placeholder address", () => {
    expect(resolveRecipientChannels({ ...reachable, hasVerifiedOrKnownPhone: false }).sms).toBe(false);
    expect(resolveRecipientChannels({ ...reachable, hasRealEmail: hasRealEmailAddress("prakrit-5257-room9@import.proplane.local") }).email).toBe(false);
    expect(hasRealEmailAddress("jane@example.com")).toBe(true);
    expect(hasRealEmailAddress("")).toBe(false);
  });

  it("is the intersection of the event's channels and the person's Reach by", () => {
    expect(resolveRecipientChannels({ ...reachable, eventChannels: { email: true, sms: true }, reachBy: ["app", "email"] })).toEqual({ app: true, email: true, sms: false });
    expect(resolveRecipientChannels({ ...reachable, eventChannels: { email: false, sms: true }, reachBy: ["app", "email", "sms"] })).toEqual({ app: true, email: false, sms: true });
    expect(resolveRecipientChannels({ ...reachable, eventChannels: { email: true, sms: false }, reachBy: ["app", "sms"] })).toEqual({ app: true, email: false, sms: false });
  });

  it("reads a missing Reach by as 'never chose' and a stored list as always carrying the app", () => {
    expect(normalizeReachBy(undefined)).toBeUndefined();
    expect(normalizeReachBy("sms")).toBeUndefined();
    expect(normalizeReachBy(["sms"])).toEqual(["app", "sms"]);
    expect(normalizeReachBy([])).toEqual(["app"]);
    expect(resolveRecipientChannels({ ...reachable, reachBy: normalizeReachBy([]) })).toEqual({ app: true, email: false, sms: false });
  });
});

describe("Text by default", () => {
  it("is on for the resident events of money, access and deadlines, and nothing else", () => {
    for (const key of TEXT_BY_DEFAULT_EVENT_KEYS) {
      const [domain, event, audience] = key.split(":");
      expect(AUTOMATED_MESSAGE_CATALOG.some((entry) => entry.domain === domain && entry.event === event && entry.audiences.includes(audience as "resident"))).toBe(true);
      expect(defaultAutomatedMessageChannels(domain!, event!, audience as "resident")).toEqual({ email: true, sms: true });
    }
    expect(defaultAutomatedMessageChannels("payment", "late_fee_applied", "resident").sms).toBe(true);
    expect(defaultAutomatedMessageChannels("lease", "lease_sent", "resident").sms).toBe(true);
    expect(defaultAutomatedMessageChannels("application", "application_declined", "resident").sms).toBe(true);
    expect(defaultAutomatedMessageChannels("work_order", "en_route", "resident").sms).toBe(false);
    expect(defaultAutomatedMessageChannels("payment", "late_fee_applied", "manager").sms).toBe(false);
  });

  it("turns Text on for the welcome and lease-nudge reminders, and leaves manager-facing rules alone", () => {
    expect(DEFAULT_REMINDER_RULES.resident_welcome.sms).toBe(true);
    expect(DEFAULT_REMINDER_RULES.lease.sms).toBe(true);
    expect(DEFAULT_REMINDER_RULES.lease_manager.sms).toBe(false);
    expect(DEFAULT_REMINDER_RULES.payment_manager.sms).toBe(false);
  });
});

describe("normalizeAutomatedMessageSettings channels", () => {
  it("reads a missing sms as the catalogue default, never as on", () => {
    const off = automatedMessageKey("work_order", "en_route", "resident");
    const on = automatedMessageKey("payment", "late_fee_applied", "resident");
    const settings = normalizeAutomatedMessageSettings({ [off]: { channels: { email: true } }, [on]: { channels: { email: false } } });
    expect(settings[off]?.channels).toEqual({ email: true, sms: false });
    expect(settings[on]?.channels).toEqual({ email: false, sms: true });
  });

  it("keeps an explicit saved choice either way", () => {
    const key = automatedMessageKey("payment", "late_fee_applied", "resident");
    expect(normalizeAutomatedMessageSettings({ [key]: { channels: { email: true, sms: false } } })[key]?.channels).toEqual({ email: true, sms: false });
    const other = automatedMessageKey("work_order", "en_route", "resident");
    expect(normalizeAutomatedMessageSettings({ [other]: { channels: { email: true, sms: true } } })[other]?.channels).toEqual({ email: true, sms: true });
  });
});

describe("follow-up copy for 'after' reminders", () => {
  const afterKinds = REMINDER_SUBJECT_KINDS.filter((kind) => DEFAULT_REMINDER_RULES[kind].timings?.some((timing) => timing.startsWith("after:")));

  it("never says upcoming, starts or ago for any after-kind, to anyone", () => {
    expect(afterKinds.length).toBeGreaterThan(10);
    for (const kind of afterKinds) {
      for (const recipientRole of ["counterparty", "manager"] as const) {
        const { subject, body } = renderReminder({ kind, leadMinutes: -1440, recipientRole, payload: { propertyLabel: "5257 Brooklyn Ave NE", url: "https://x.test/a", counterpartyName: "Jane" } });
        const text = `${subject}\n${body}`;
        if (kind === "task" || kind === "outgoing_payment") continue;
        expect(text, `${kind}/${recipientRole}`).not.toMatch(/upcoming/i);
        expect(text, `${kind}/${recipientRole}`).not.toMatch(/starts/i);
        expect(text, `${kind}/${recipientRole}`).not.toMatch(/\bago\b/i);
      }
    }
  });

  it("tells an applicant where they left off, with their link", () => {
    const { subject, body } = renderReminder({ kind: "application", leadMinutes: -1440, recipientRole: "counterparty", payload: { propertyLabel: "5257 Brooklyn Ave NE", resumeUrl: "https://x.test/resume" } });
    expect(subject).toBe("Your application for 5257 Brooklyn Ave NE isn't finished yet");
    expect(body).toContain("Your application for 5257 Brooklyn Ave NE isn't finished yet. Pick up where you left off:");
    expect(body).toContain("https://x.test/resume");
  });

  it("still says 'starts' and 'in N' for a lead in the future", () => {
    const { body, subject } = renderReminder({ kind: "tour", leadMinutes: 1440, recipientRole: "counterparty", payload: { propertyLabel: "5257 Brooklyn Ave NE" } });
    expect(body).toMatch(/it starts in 1 day/);
    expect(subject).toMatch(/in 1 day/);
  });
});

describe("reminder dedupe on the person", () => {
  // Person dedupe is scoped to the workspace owner, so the manager id is part of every person key.
  const base = { kind: "application" as const, leadMinutes: -1440, recipientRole: "counterparty", anchorIso: "2026-11-10T17:00:00.000Z", managerUserId: "mgr-1" };

  it("collapses two rows of the same person (same user, different address and row)", () => {
    const a = reminderDedupeKey({ ...base, subjectId: "app-1", recipient: "jane@x.com", recipientUserId: "u-1" });
    const b = reminderDedupeKey({ ...base, subjectId: "app-2", recipient: "jane.smith@y.com", recipientUserId: "u-1" });
    expect(a).toBe(b);
  });

  it("collapses the same real email without an account, and keeps different people apart", () => {
    const a = reminderDedupeKey({ ...base, subjectId: "app-1", recipient: "Jane@X.com" });
    const b = reminderDedupeKey({ ...base, subjectId: "app-2", recipient: "jane@x.com" });
    expect(a).toBe(b);
    expect(reminderDedupeKey({ ...base, subjectId: "app-3", recipient: "bob@x.com" })).not.toBe(a);
  });

  it("never collapses two workspaces' copies for the same person", () => {
    const a = reminderDedupeKey({ ...base, subjectId: "app-1", recipient: "jane@x.com", recipientUserId: "u-1" });
    const b = reminderDedupeKey({ ...base, subjectId: "app-2", recipient: "jane@x.com", recipientUserId: "u-1", managerUserId: "mgr-2" });
    expect(a).not.toBe(b);
  });

  it("falls back to the phone, then the subject, for a placeholder email", () => {
    const placeholder = "p-1@import.proplane.local";
    expect(reminderPersonRef({ email: placeholder, phone: "(206) 555-0100", subjectId: "s" })).toBe("phone:+12065550100");
    expect(reminderPersonRef({ email: placeholder, subjectId: "s-9" })).toBe("subject:s-9");
  });

  it("is a new key when the anchor date, the lead or the role changes, and the same within one Pacific day", () => {
    const key = (over: Partial<Parameters<typeof reminderDedupeKey>[0]>) => reminderDedupeKey({ ...base, subjectId: "app-1", recipient: "jane@x.com", ...over });
    expect(key({ anchorIso: "2026-11-10T20:00:00.000Z" })).toBe(key({}));
    expect(key({ anchorIso: "2026-11-11T20:00:00.000Z" })).not.toBe(key({}));
    expect(key({ leadMinutes: -4320 })).not.toBe(key({}));
    expect(key({ recipientRole: "manager" })).not.toBe(key({}));
    expect(pacificDateKey("2026-11-11T03:00:00.000Z")).toBe("2026-11-10");
  });

  it("keeps per-subject kinds (a task, a manager copy) per subject and recipient", () => {
    const a = reminderDedupeKey({ kind: "task", subjectId: "t-1", leadMinutes: 1440, recipient: "m@x.com", recipientRole: "manager", anchorIso: base.anchorIso });
    const b = reminderDedupeKey({ kind: "task", subjectId: "t-2", leadMinutes: 1440, recipient: "m@x.com", recipientRole: "manager", anchorIso: base.anchorIso });
    expect(a).not.toBe(b);
  });

  it("keeps the legacy key when no anchor is given", () => {
    expect(reminderDedupeKey({ kind: "tour", subjectId: "t-1", leadMinutes: 30, recipient: "A@X.com" })).toBe("tour:t-1:30:a@x.com");
  });
});

describe("dispatch-time currency", () => {
  const now = new Date("2026-11-10T18:00:00.000Z");
  it("drops a 'before' reminder once its date has passed, and keeps one still ahead", () => {
    expect(reminderAnchorHasPassed({ leadMinutes: 1440, payload: { anchorIso: "2026-11-09T18:00:00.000Z" } }, now)).toBe(true);
    expect(reminderAnchorHasPassed({ leadMinutes: 1440, payload: { anchorIso: "2026-11-12T18:00:00.000Z" } }, now)).toBe(false);
  });
  it("gives a day-of reminder an hour of grace and never judges an 'after' reminder by its anchor", () => {
    expect(reminderAnchorHasPassed({ leadMinutes: 5, payload: { anchorIso: "2026-11-10T17:30:00.000Z" } }, now)).toBe(false);
    expect(reminderAnchorHasPassed({ leadMinutes: -1440, payload: { anchorIso: "2026-11-01T18:00:00.000Z" } }, now)).toBe(false);
    expect(reminderAnchorHasPassed({ leadMinutes: 1440, payload: {} }, now)).toBe(false);
  });
});

describe("Add resident: phone or No phone", () => {
  const ctx = { userId: "m-1", propertyLabelFor: () => "5257 Brooklyn Ave NE" };
  const filled = () => ({ ...emptyAddPersonForm("resident"), name: "Jane", email: "jane@example.com", propertyId: "p-1" });

  it("lists the phone as a thing to finish until it is given or ticked", () => {
    expect(thingsToFinish(filled()).some((t) => t.label === "A phone, or No phone")).toBe(true);
    expect(thingsToFinish({ ...filled(), phone: "+12065550100" }).some((t) => t.label === "A phone, or No phone")).toBe(false);
    expect(thingsToFinish({ ...filled(), noPhone: true }).some((t) => t.label === "A phone, or No phone")).toBe(false);
    expect(thingsToFinish(filled(), "person", { editing: true }).some((t) => t.label === "A phone, or No phone")).toBe(false);
  });

  it("refuses to build the row with the inline message, and records No phone when ticked", () => {
    expect(buildManualResidentRow(filled(), ctx)).toEqual({ ok: false, error: PHONE_REQUIRED_MESSAGE });
    const built = buildManualResidentRow({ ...filled(), noPhone: true }, ctx);
    expect(built.ok && built.row.manualResidentDetails?.noPhone).toBe(true);
  });

  it("writes Reach by only when the manager narrowed it", () => {
    const withPhone = { ...filled(), phone: "+12065550100" };
    expect(reachByDetails(withPhone)).toEqual({});
    expect(reachByDetails({ ...withPhone, reachBy: ["app", "email"] })).toEqual({ reachBy: ["app", "email"] });
    // No phone yet: Text cannot be picked, so its absence is not "turned off".
    expect(reachByDetails({ ...filled(), noPhone: true, reachBy: ["app", "email"] })).toEqual({ noPhone: true });
  });
});

describe("loading Reach by from the resident record", () => {
  const fakeDb = (rows: unknown[], fail = false) => ({
    from: () => ({
      select: () => ({
        in: async () => (fail ? { data: null, error: { message: "boom" } } : { data: rows, error: null }),
      }),
    }),
  });

  it("reads the stored choice by lowercased email and ignores a record that never chose", async () => {
    const { loadReachByForEmails } = await import("@/lib/recipient-channels.server");
    const map = await loadReachByForEmails(
      fakeDb([
        { resident_email: "Jane@X.com", updated_at: "2026-11-01", details: { reachBy: ["email"] } },
        { resident_email: "bob@x.com", updated_at: "2026-11-01", details: { phone: "+1" } },
      ]) as never,
      ["JANE@x.com", "bob@x.com"],
    );
    expect(map.get("jane@x.com")).toEqual(["app", "email"]);
    expect(map.has("bob@x.com")).toBe(false);
  });

  it("returns no narrowing when the read fails", async () => {
    const { loadReachByForEmails } = await import("@/lib/recipient-channels.server");
    expect((await loadReachByForEmails(fakeDb([], true) as never, ["jane@x.com"])).size).toBe(0);
  });
});

describe("a moved anchor re-queues", () => {
  it("cancels still-future rows on another anchor date or under the old key, and keeps the same date's rows", async () => {
    const { supersedeStaleReminders } = await import("@/lib/reminders/queue.server");
    const { REMINDER_DEDUPE_KEY_VERSION } = await import("@/lib/reminders/rules");
    const now = new Date("2026-11-10T18:00:00.000Z");
    const rows = [
      { id: "same-date", dedupe_key: `${REMINDER_DEDUPE_KEY_VERSION}lease|x`, send_at: "2026-11-12T18:00:00.000Z", payload: { anchorIso: "2026-11-14T17:00:00.000Z" } },
      { id: "moved", dedupe_key: `${REMINDER_DEDUPE_KEY_VERSION}lease|y`, send_at: "2026-11-12T18:00:00.000Z", payload: { anchorIso: "2026-11-20T17:00:00.000Z" } },
      { id: "legacy", dedupe_key: "lease:s-1:-1440:a@x.com", send_at: "2026-11-12T18:00:00.000Z", payload: {} },
      // Queued under the PREVIOUS key format on the very same anchor date: superseded, or it fires
      // beside the row the new format writes.
      { id: "older-format", dedupe_key: "v2|lease|x", send_at: "2026-11-12T18:00:00.000Z", payload: { anchorIso: "2026-11-14T17:00:00.000Z" } },
      { id: "due-now", dedupe_key: "lease:s-1:-4320:a@x.com", send_at: "2026-11-10T17:00:00.000Z", payload: {} },
    ];
    let cancelled: string[] = [];
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ data: rows, error: null }) }) }) }),
        update: () => ({ in: (_col: string, ids: string[]) => { cancelled = ids; return { eq: async () => ({ error: null }) }; } }),
      }),
    };
    const count = await supersedeStaleReminders(db as never, "lease", "s-1", "2026-11-14T20:00:00.000Z", now);
    expect(count).toBe(3);
    expect(cancelled.sort()).toEqual(["legacy", "moved", "older-format"]);
  });
});
