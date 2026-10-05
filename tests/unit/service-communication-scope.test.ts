import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serviceCommunicationParties, serviceRecordIds, serviceThreadsForParty } from "@/lib/service-communication-scope";
import { serviceRecordRefForEvent } from "@/lib/service-record-ref";

/**
 * A service's Communication section is about THIS service (plan D9): one tab per party, each showing only the
 * threads stamped with the service's recordRef - not the person-wide history matched by email or phone.
 */
const thread = (id: string, email: string, ref?: { kind: string; id: string; label?: string }) => ({
  id,
  email,
  smsNoticePhone: null as string | null,
  ...(ref ? { recordRef: { label: "Storage locker", ...ref } } : {}),
});

describe("serviceThreadsForParty", () => {
  const resident = { email: "liam@example.com" };
  const vendor = { email: "pacific@example.com" };
  const threads = [
    thread("t-service", "liam@example.com", { kind: "service", id: "SR-1" }),
    thread("t-rent", "liam@example.com", { kind: "payment", id: "ch-9", label: "Rent" }),
    thread("t-unstamped", "liam@example.com"),
    thread("t-job", "pacific@example.com", { kind: "service", id: "SR-1-vendor-job" }),
    thread("t-other-service", "liam@example.com", { kind: "service", id: "SR-2" }),
  ];

  it("shows only the threads stamped with this service, never the resident's rent notices or other chats", () => {
    const shown = serviceThreadsForParty(threads, { recordIds: ["SR-1"], party: resident });
    expect(shown.map((t) => t.id)).toEqual(["t-service"]);
  });

  it("an add-on also shows its linked vendor job's thread, on the vendor's tab only", () => {
    const ids = serviceRecordIds("SR-1", "SR-1-vendor-job");
    expect(ids).toEqual(["SR-1", "SR-1-vendor-job"]);
    expect(serviceThreadsForParty(threads, { recordIds: ids, party: vendor }).map((t) => t.id)).toEqual(["t-job"]);
    expect(serviceThreadsForParty(threads, { recordIds: ids, party: resident }).map((t) => t.id)).toEqual(["t-service"]);
  });

  it("a thread that only shares the contact's email is not about the service, however recent", () => {
    expect(serviceThreadsForParty([thread("t", "liam@example.com")], { recordIds: ["SR-1"], party: resident })).toEqual([]);
  });

  it("a party with no email or phone sees every thread stamped to the service", () => {
    const shown = serviceThreadsForParty(threads, { recordIds: ["SR-1", "SR-1-vendor-job"], party: {} });
    expect(shown.map((t) => t.id)).toEqual(["t-service", "t-job"]);
  });

  it("a vendor is told apart by phone when the thread has no email", () => {
    const sms = { ...thread("t-sms", "", { kind: "service", id: "SR-1" }), smsNoticePhone: "+12065550101" };
    expect(serviceThreadsForParty([sms], { recordIds: ["SR-1"], party: { phone: "(206) 555-0101" } }).map((t) => t.id)).toEqual(["t-sms"]);
    expect(serviceThreadsForParty([sms], { recordIds: ["SR-1"], party: { phone: "(206) 555-0199" } })).toEqual([]);
  });
});

describe("serviceCommunicationParties", () => {
  const offers = [
    { vendorDirectoryId: "d1", vendorName: "Pacific Plumbing", vendorEmail: "pacific@example.com" },
    { vendorDirectoryId: "d2", vendorName: "Cascade Drains", vendorEmail: undefined },
  ];

  it("lists the resident first, then every vendor the job went to, once each", () => {
    const tabs = serviceCommunicationParties({
      resident: { name: "Liam Foster", email: "liam@example.com" },
      offers,
      bids: [{ vendorDirectoryId: "d1", vendorUserId: "u1", vendorName: "Pacific Plumbing", vendorEmail: undefined }],
      roster: [{ id: "d2", name: "Cascade Drains", email: "cascade@example.com", phone: "206-555-0102" }],
    });
    expect(tabs.map((t) => `${t.kind}:${t.name}`)).toEqual(["resident:Liam Foster", "vendor:Pacific Plumbing", "vendor:Cascade Drains"]);
    // A vendor with no email on the offer reads it from the roster.
    expect(tabs[2]).toMatchObject({ email: "cascade@example.com", phone: "206-555-0102" });
  });

  it("has no resident tab for a job with no resident, and only the resident before anything is sent", () => {
    expect(serviceCommunicationParties({ resident: null, offers }).map((t) => t.kind)).toEqual(["vendor", "vendor"]);
    expect(serviceCommunicationParties({ resident: { name: "Liam", email: "l@x.co" }, offers: [] }).map((t) => t.id)).toEqual(["resident"]);
  });
});

describe("a service notification is stamped with the service", () => {
  it("stamps work-order and add-on events with {kind: service, id} and never an invoice decision", () => {
    expect(serviceRecordRefForEvent("work_order", "wo-1", "Burst pipe")).toEqual({ kind: "service", id: "wo-1", label: "Burst pipe" });
    expect(serviceRecordRefForEvent("service_request", "SR-1")).toEqual({ kind: "service", id: "SR-1", label: "Service" });
    expect(serviceRecordRefForEvent("work_order", "invoice:inv-1")).toBeUndefined();
    expect(serviceRecordRefForEvent("payment", "ch-1")).toBeUndefined();
    expect(serviceRecordRefForEvent("work_order", "")).toBeUndefined();
  });

  it("is passed on by the delivery paths that carry offers, bids and visit times", () => {
    const events = readFileSync(join(process.cwd(), "src/lib/action-events.server.ts"), "utf8");
    expect(events.match(/serviceRecordRefForEvent\(/g)?.length).toBe(2);
    expect(events).toMatch(/recordRef: input\.recordRef/);
    expect(readFileSync(join(process.cwd(), "src/lib/work-order-notification.server.ts"), "utf8")).toMatch(/recordRef \? \{ recordRef \}/);
    expect(readFileSync(join(process.cwd(), "src/lib/vendor-notification-delivery.ts"), "utf8")).toMatch(/recordRef: serviceRef/);
  });
});

describe("the service Communication pane", () => {
  const src = readFileSync(join(process.cwd(), "src/components/portal/service-communication-pane.tsx"), "utf8");
  it("scopes every tab to the service, links the full conversation and passes no person-wide contact matching", () => {
    expect(src).toContain("serviceScope={scope}");
    expect(src).toContain("fullConversationHref");
    const section = readFileSync(join(process.cwd(), "src/components/portal/record-communication-section.tsx"), "utf8");
    expect(section).toContain("Open the full conversation in Communication");
    expect(section).toMatch(/if \(serviceScope\) \{/);
  });
});
