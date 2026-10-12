import { describe, expect, it } from "vitest";
import { resolveTaskCommunicationParty, type TaskCommunicationSources } from "@/lib/task-communication-party";

const sources: TaskCommunicationSources = {
  applications: [
    {
      id: "app-1",
      name: "Grace Halverson",
      email: "grace@example.com",
      bucket: "approved",
      application: { fullLegalName: "Grace Natalie Halverson", email: "grace@example.com", phone: "+12065550100" } as never,
    },
    { id: "app-2", name: "No Contact", bucket: "pending" },
  ],
  tours: [
    { id: "tour-1", attendeeName: "Pat Prospect", attendeeEmail: "Pat@Example.com", attendeePhone: "+12065550111" },
    { id: "tour-2", sourceInquiryId: "inq-9", attendeeName: "Inq Guest", attendeePhone: "+12065550122" },
    { id: "tour-3" },
  ],
  workOrders: [
    { id: "wo-1", assignee: { type: "vendor", id: "v-1", name: "Pacific Plumbing" } },
    { id: "wo-2", vendorId: "v-1" },
    { id: "wo-3" },
  ],
  vendors: [{ id: "v-1", name: "Pacific Plumbing", email: "dispatch@pacific.example", phone: "+12065550133" }],
  leases: [{ id: "lease-1", residentName: "Lee Resident", residentEmail: "lee@example.com" }],
};

describe("resolveTaskCommunicationParty", () => {
  it("tour task by taskType + linkedTourId is the guest, a prospect", () => {
    expect(resolveTaskCommunicationParty({ taskType: "tour", linkedTourId: "tour-1" }, sources)).toEqual({
      name: "Pat Prospect",
      emails: ["pat@example.com"],
      phone: "+12065550111",
      role: "prospect",
    });
  });

  it("tour template matches the planned event by its source inquiry; phone-only guest still resolves", () => {
    const party = resolveTaskCommunicationParty({ templateKey: "prepare_for_tour", linkedTourId: "inq-9" }, sources);
    expect(party).toMatchObject({ name: "Inq Guest", emails: [], phone: "+12065550122", role: "prospect" });
  });

  it("tour task whose event has no contact, or is not found, is null", () => {
    expect(resolveTaskCommunicationParty({ taskType: "tour", linkedTourId: "tour-3" }, sources)).toBeNull();
    expect(resolveTaskCommunicationParty({ taskType: "tour", linkedTourId: "gone" }, sources)).toBeNull();
  });

  it.each(["review_application", "decide_application", "review_and_send_lease"])(
    "%s is the applicant from the application row",
    (templateKey) => {
      expect(resolveTaskCommunicationParty({ templateKey, sourceId: "app-1" }, sources)).toEqual({
        name: "Grace Natalie Halverson",
        emails: ["grace@example.com"],
        phone: "+12065550100",
        role: "applicant",
      });
    },
  );

  it("collect_rent strips the -initial-rent suffix and is the resident", () => {
    expect(resolveTaskCommunicationParty({ templateKey: "collect_rent", sourceId: "app-1-initial-rent" }, sources)).toMatchObject({
      name: "Grace Natalie Halverson",
      role: "resident",
    });
  });

  it("countersign_lease falls back to the lease row when sourceId is a lease id", () => {
    expect(resolveTaskCommunicationParty({ templateKey: "countersign_lease", sourceId: "lease-1" }, sources)).toEqual({
      name: "Lee Resident",
      emails: ["lee@example.com"],
      phone: null,
      role: "resident",
    });
  });

  it("an application with no email or phone, or an unknown source, is null", () => {
    expect(resolveTaskCommunicationParty({ templateKey: "review_application", sourceId: "app-2" }, sources)).toBeNull();
    expect(resolveTaskCommunicationParty({ templateKey: "review_application", sourceId: "nope" }, sources)).toBeNull();
    expect(resolveTaskCommunicationParty({ templateKey: "review_application" }, sources)).toBeNull();
  });

  it("work_order task is the vendor assigned to the linked service", () => {
    const expected = { name: "Pacific Plumbing", emails: ["dispatch@pacific.example"], phone: "+12065550133", role: "vendor" };
    expect(resolveTaskCommunicationParty({ taskType: "work_order", linkedWorkOrderId: "wo-1" }, sources)).toEqual(expected);
    expect(resolveTaskCommunicationParty({ linkedWorkOrderId: "wo-2" }, sources)).toEqual(expected);
  });

  it("a service with no vendor is null", () => {
    expect(resolveTaskCommunicationParty({ taskType: "work_order", linkedWorkOrderId: "wo-3" }, sources)).toBeNull();
  });

  it("check_in / check_out resolve the resident through the application when derivable, else null", () => {
    expect(resolveTaskCommunicationParty({ taskType: "check_in", sourceId: "app-1" }, sources)).toMatchObject({ role: "resident" });
    expect(resolveTaskCommunicationParty({ taskType: "check_out" }, sources)).toBeNull();
  });

  it("general and house tasks have no party", () => {
    expect(resolveTaskCommunicationParty({ taskType: "general" }, sources)).toBeNull();
    expect(resolveTaskCommunicationParty({ taskType: "house" }, sources)).toBeNull();
    expect(resolveTaskCommunicationParty({}, {})).toBeNull();
  });
});
