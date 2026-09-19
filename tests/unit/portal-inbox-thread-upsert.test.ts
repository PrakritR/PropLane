import { describe, expect, it } from "vitest";
import {
  buildPortalInboxThreadUpsert,
  preserveServerOwnedInboxRelationshipFields,
  withoutServerOwnedInboxRelationshipFields,
} from "@/lib/portal-inbox-thread-upsert";

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

  it("keeps trusted server-stamped relationship metadata in the neutral builder", () => {
    const record = buildPortalInboxThreadUpsert({
      id: "server-thread",
      scope: "axis_portal_inbox_manager_v1",
      managerUserId: "manager-authority",
      propertyId: "property-authority",
      counterpartyRole: "resident",
      smsConversationKey: "manager-authority:resident:resident-1",
      identityProvenance: { source: "resident_application" },
      unread: true,
    }, user);

    expect(record.row_data).toMatchObject({
      managerUserId: "manager-authority",
      propertyId: "property-authority",
      counterpartyRole: "resident",
      smsConversationKey: "manager-authority:resident:resident-1",
      identityProvenance: { source: "resident_application" },
      unread: true,
    });
  });

  it("strips camel and snake aliases from ordinary client rows while preserving mailbox fields", () => {
    const row = withoutServerOwnedInboxRelationshipFields({
      id: "client-thread",
      managerUserId: "forged-manager",
      manager_user_id: "forged-manager-snake",
      propertyId: "forged-property",
      property_id: "forged-property-snake",
      counterpartyRole: "vendor",
      counterparty_role: "vendor",
      smsConversationKey: "forged-key",
      sms_conversation_key: "forged-key-snake",
      identityProvenance: { source: "forged" },
      identity_provenance: { source: "forged-snake" },
      unread: false,
      folder: "trash",
      preview: "edited preview",
      body: "edited body",
      messages: [{ body: "edited body" }],
    });

    expect(row).toMatchObject({
      id: "client-thread",
      unread: false,
      folder: "trash",
      preview: "edited preview",
      body: "edited body",
      messages: [{ body: "edited body" }],
    });
    expect(row).not.toHaveProperty("managerUserId");
    expect(row).not.toHaveProperty("manager_user_id");
    expect(row).not.toHaveProperty("propertyId");
    expect(row).not.toHaveProperty("property_id");
    expect(row).not.toHaveProperty("counterpartyRole");
    expect(row).not.toHaveProperty("counterparty_role");
    expect(row).not.toHaveProperty("smsConversationKey");
    expect(row).not.toHaveProperty("sms_conversation_key");
    expect(row).not.toHaveProperty("identityProvenance");
    expect(row).not.toHaveProperty("identity_provenance");
  });

  it("preserves authoritative existing identity while allowing ordinary history edits", () => {
    const next = preserveServerOwnedInboxRelationshipFields({
      id: "existing-thread",
      managerUserId: "forged-manager",
      propertyId: "forged-property",
      counterpartyRole: "vendor",
      smsConversationKey: "forged-key",
      unread: false,
      folder: "inbox",
      preview: "new preview",
      body: "new body",
      messages: [{ body: "new body" }],
    }, {
      managerUserId: "authoritative-manager",
      propertyId: "authoritative-property",
      counterpartyRole: "resident",
      smsConversationKey: "authoritative-key",
      identityProvenance: { source: "server" },
    });

    expect(next).toMatchObject({
      managerUserId: "authoritative-manager",
      propertyId: "authoritative-property",
      counterpartyRole: "resident",
      smsConversationKey: "authoritative-key",
      identityProvenance: { source: "server" },
      unread: false,
      folder: "inbox",
      preview: "new preview",
      body: "new body",
    });
  });
});
