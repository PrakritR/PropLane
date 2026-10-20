import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../helpers/fake-table-db";

vi.mock("server-only", () => ({}));
const emitted: Array<Record<string, unknown>> = [];
vi.mock("@/lib/action-events.server", () => ({
  emitActionEvent: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    emitted.push(input);
    return {};
  }),
}));

import {
  NOTICE_CHANNEL_PAYLOAD_KEY,
  noticeChannelFor,
  payloadNoticeChannel,
  withRecordedNoticeChannel,
  withResidentPortalLink,
} from "@/lib/notice-channel";
import { emitApplicationTransition, emitHouseholdChargeTransition, emitLeaseDateChange } from "@/lib/domain-action-events.server";
import { chargeNoticeChannel, residentNoticeChannel } from "@/lib/resident-notice-channel.server";

const OWNER = "owner-1";
const actor = { userId: OWNER, email: "owner@proplane.test", name: "Ambika" };

function db(applications: Array<Record<string, unknown>> = [], blocks: Array<Record<string, unknown>> = []) {
  return createFakeDb({
    profiles: [{ id: OWNER, email: "owner@proplane.test", full_name: "Ambika Mago" }],
    manager_application_records: applications,
    portal_schedule_records: blocks,
  });
}

beforeEach(() => {
  emitted.length = 0;
});

describe("noticeChannelFor and the payload stamp", () => {
  it("reads the channel recorded on an application or tour row; the lead-source column is a different fact", () => {
    expect(noticeChannelFor({ noticeChannel: "portal" })).toBe("portal");
    expect(noticeChannelFor({ noticeChannel: "sms" })).toBe("sms");
    expect(noticeChannelFor({ channel: "portal" })).toBe("portal");
    expect(noticeChannelFor({ source_channel: "zillow", source: "portal" })).toBe("sms");
    expect(noticeChannelFor({})).toBe("sms");
  });

  it("an action event carries its channel on the stored payload so a retry keeps it", () => {
    expect(payloadNoticeChannel({ [NOTICE_CHANNEL_PAYLOAD_KEY]: "portal" })).toBe("portal");
    expect(payloadNoticeChannel({})).toBe("sms");
    expect(payloadNoticeChannel(null)).toBe("sms");
  });

  it("a portal notice carries the portal address of its section and never a text link", () => {
    expect(withResidentPortalLink("Your application was approved.", "application")).toContain("https://proplane.ai/resident/applications");
    expect(withResidentPortalLink("Your tour is confirmed.", "tour")).toContain("https://proplane.ai/resident/tour");
    expect(withResidentPortalLink("A charge was added.", "payment")).toContain("https://proplane.ai/resident/payments/pending");
    expect(withResidentPortalLink("Lease ready.", "lease")).toContain("https://proplane.ai/resident/lease");
    // Already linked: unchanged.
    const linked = "Open lease: https://proplane.ai/resident/documents/lease/1";
    expect(withResidentPortalLink(linked, "lease")).toBe(linked);
    expect(withResidentPortalLink("x", "application")).not.toMatch(/\/l\/|sms:|tel:/);
  });
});

describe("the channel is recorded on an application when an applicant first writes it", () => {
  const row = { id: "A1", name: "Priya" };
  it("an applicant's own web write stamps portal; a manager writing a row for someone records nothing (sms, as before)", () => {
    expect(withRecordedNoticeChannel(row, null, "portal")).toEqual({ id: "A1", name: "Priya", noticeChannel: "portal" });
    expect(withRecordedNoticeChannel(row, null, null)).toEqual(row);
  });
  it("the stored channel wins over the writer, and a value in the request body never counts", () => {
    expect(withRecordedNoticeChannel({ ...row, noticeChannel: "sms" }, { noticeChannel: "portal" }, null)).toMatchObject({ noticeChannel: "portal" });
    expect(withRecordedNoticeChannel({ ...row, noticeChannel: "portal" }, null, null)).not.toHaveProperty("noticeChannel");
    expect(withRecordedNoticeChannel({ ...row, noticeChannel: "portal" }, { noticeChannel: "sms" }, "portal")).toMatchObject({ noticeChannel: "sms" });
    expect(withRecordedNoticeChannel(row, { id: "A1" }, "portal")).toMatchObject({ noticeChannel: "portal" });
  });
});

describe("application notices follow the channel the application was made on", () => {
  const app = { id: "A1", name: "Priya", email: "priya@example.com", bucket: "pending", residentUserId: "u1" };

  it("received, approved and declined: a portal application is stamped portal, a text-made or unrecorded one is not", async () => {
    await emitApplicationTransition(db() as never, { managerUserId: OWNER, previous: null, application: { ...app, noticeChannel: "portal" }, actor });
    await emitApplicationTransition(db() as never, { managerUserId: OWNER, previous: { ...app }, application: { ...app, bucket: "approved", noticeChannel: "portal" }, actor });
    await emitApplicationTransition(db() as never, { managerUserId: OWNER, previous: { ...app }, application: { ...app, bucket: "rejected", noticeChannel: "portal" }, actor });
    expect(emitted.map((e) => [e.event, e.channel])).toEqual([
      ["application_submitted", "portal"],
      ["application_approved", "portal"],
      ["application_declined", "portal"],
    ]);
    emitted.length = 0;
    await emitApplicationTransition(db() as never, { managerUserId: OWNER, previous: null, application: { ...app, noticeChannel: "sms" }, actor });
    await emitApplicationTransition(db() as never, { managerUserId: OWNER, previous: null, application: app, actor });
    expect(emitted.map((e) => e.channel)).toEqual(["sms", "sms"]);
  });
});

describe("lease and charge notices inherit the resident's channel", () => {
  const portalApp = { id: "A1", manager_user_id: OWNER, resident_email: "priya@example.com", updated_at: "2026-10-01", row_data: { noticeChannel: "portal" } };

  it("the newest application that recorded a channel decides; none recorded, none found or another workspace is sms", async () => {
    expect(await residentNoticeChannel(db([portalApp]) as never, { managerUserId: OWNER, email: "Priya@Example.com" })).toBe("portal");
    expect(await residentNoticeChannel(db([{ ...portalApp, row_data: {} }]) as never, { managerUserId: OWNER, email: "priya@example.com" })).toBe("sms");
    expect(await residentNoticeChannel(db() as never, { managerUserId: OWNER, email: "priya@example.com" })).toBe("sms");
    expect(await residentNoticeChannel(db([portalApp]) as never, { managerUserId: "other-owner", email: "priya@example.com" })).toBe("sms");
    expect(await residentNoticeChannel(db([portalApp]) as never, { managerUserId: OWNER, email: "" })).toBe("sms");
  });

  it("a stay charge follows its stay's recorded source, before the resident's application", async () => {
    const block = { id: "blk-1", row_data: { stayDetails: { source: "sms_short_stay" } } };
    expect(await chargeNoticeChannel(db([portalApp], [block]) as never, { managerUserId: OWNER, charge: { guestStayBlockId: "blk-1", residentEmail: "priya@example.com" } })).toBe("sms");
    const portalBlock = { id: "blk-2", row_data: { stayDetails: { source: "guest_portal" } } };
    expect(await chargeNoticeChannel(db([], [portalBlock]) as never, { managerUserId: OWNER, charge: { guestStayBlockId: "blk-2", residentEmail: "x@example.com" } })).toBe("portal");
  });

  it("charges due, lease date changes: the emitted event carries the resident's channel", async () => {
    const d = db([portalApp]);
    await emitHouseholdChargeTransition(d as never, {
      managerUserId: OWNER,
      previousStatus: null,
      charge: { id: "c1", title: "Deposit", amountLabel: "$500", status: "pending", kind: "security_deposit", residentEmail: "priya@example.com", residentUserId: "u1", createdAt: "2026-10-02" } as never,
    });
    await emitLeaseDateChange(d as never, {
      managerUserId: OWNER,
      lease: { id: "l1", residentName: "Priya", residentEmail: "priya@example.com", residentUserId: "u1", unit: "2A" } as never,
      newLeaseEnd: "2027-01-31",
      direction: "extend",
      actor,
    });
    expect(emitted.map((e) => [e.domain, e.channel])).toEqual([["payment", "portal"], ["lease", "portal"]]);
    emitted.length = 0;
    await emitHouseholdChargeTransition(db() as never, {
      managerUserId: OWNER,
      previousStatus: null,
      charge: { id: "c2", title: "Rent", amountLabel: "$900", status: "pending", kind: "rent", residentEmail: "lee@example.com", createdAt: "2026-10-02" } as never,
    });
    expect(emitted[0]!.channel).toBe("sms");
  });
});
