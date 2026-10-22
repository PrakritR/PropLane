import { describe, expect, it } from "vitest";
import { buildPortalInboxThreadUpsert, isServerReservedInboxThreadId } from "@/lib/portal-inbox-thread-upsert";

const user = { id: "mgr-1", email: "manager@example.com" };

describe("buildPortalInboxThreadUpsert", () => {
  it("keeps owner_user_id and null participant_email for sent threads", () => {
    const record = buildPortalInboxThreadUpsert(
      {
        id: "msg_mgr-1_123_abcd",
        scope: "axis_portal_inbox_manager_v1",
        folder: "sent",
        email: "resident@example.com",
        subject: "Lease ready",
      },
      user,
    );
    expect(record.owner_user_id).toBe("mgr-1");
    expect(record.participant_email).toBeNull();
  });

  it("preserves sent ownership when moving a sent thread to trash", () => {
    const record = buildPortalInboxThreadUpsert(
      {
        id: "msg_mgr-1_123_abcd",
        scope: "axis_portal_inbox_manager_v1",
        folder: "trash",
        previousFolder: "sent",
        email: "resident@example.com",
        subject: "Lease ready",
      },
      user,
    );
    expect(record.owner_user_id).toBe("mgr-1");
    expect(record.participant_email).toBeNull();
  });

  it("uses participant_email for inbox threads moved to trash", () => {
    const record = buildPortalInboxThreadUpsert(
      {
        id: "msg_inbox_123_abcd",
        scope: "axis_portal_inbox_manager_v1",
        folder: "trash",
        previousFolder: "inbox",
        email: "resident@example.com",
        subject: "Tour request",
      },
      user,
    );
    expect(record.owner_user_id).toBe("mgr-1");
    expect(record.participant_email).toBe("manager@example.com");
  });
});

describe("isServerReservedInboxThreadId", () => {
  it("reserves every id the server derives, the house chat alias and house thread included", () => {
    for (const id of [
      "agent_notice_x",
      "property_mgr_x",
      "team-thread:o:ws:w",
      "house-thread:o:ws:w:prop:p",
      "house-chat:AbCdEf123456",
      "resident_sms_x",
      "vendor_sms_x",
    ]) {
      expect(isServerReservedInboxThreadId(id)).toBe(true);
    }
    expect(isServerReservedInboxThreadId("msg_mgr-1_123_abcd")).toBe(false);
  });
});
