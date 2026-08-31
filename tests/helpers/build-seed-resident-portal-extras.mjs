/** Service requests, maintenance work orders, and inbox threads for seeded residents. */

function inboxStamp(date) {
  return date.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function buildSeedServiceRequestsForPerson(p, { now = new Date() } = {}) {
  const requestedAt = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString();
  const approvedAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  return [
    {
      id: `seed-sr-parking-${p.axisId}`,
      offerId: "seed-offer-parking",
      offerName: "Parking spot",
      offerDescription: "Reserved off-street parking",
      price: "$75 / month",
      deposit: "$0",
      residentEmail: p.email,
      residentName: p.name,
      managerUserId: p.prop.ownerUserId,
      propertyId: p.propId,
      returnByDate: "",
      notes: "Need a spot starting move-in week.",
      requestedAt,
      status: "approved",
      approvedAt,
      servicePaid: false,
      depositPaid: true,
      testRunId: p.testRunId,
    },
    {
      id: `seed-sr-storage-${p.axisId}`,
      offerId: "seed-offer-storage",
      offerName: "Storage locker",
      offerDescription: "Basement storage locker",
      price: "$40 / month",
      deposit: "$50",
      residentEmail: p.email,
      residentName: p.name,
      managerUserId: p.prop.ownerUserId,
      propertyId: p.propId,
      returnByDate: "",
      notes: "Locker near the mail room if possible.",
      requestedAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      status: "pending",
      servicePaid: false,
      depositPaid: false,
      testRunId: p.testRunId,
    },
  ];
}

export function buildSeedWorkOrdersForPerson(p, { now = new Date() } = {}) {
  const scheduledAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
  return [
    {
      id: `seed-wo-${p.axisId}-open`,
      propertyName: p.prop.name,
      unit: p.room.name,
      title: "Kitchen faucet drip",
      priority: "Normal",
      status: "Open",
      bucket: "open",
      description: "Slow drip under the kitchen sink when the hot water runs.",
      scheduled: "Unscheduled",
      cost: "—",
      preferredArrival: "Weekday evenings",
      entryPermission: "call_first",
      propertyAddress: p.prop.address,
      residentName: p.name,
      residentEmail: p.email,
      propertyId: p.propId,
      assignedPropertyId: p.propId,
      assignedRoomChoice: p.roomChoice,
      managerUserId: p.prop.ownerUserId,
      category: "plumbing",
      testRunId: p.testRunId,
    },
    {
      id: `seed-wo-${p.axisId}-scheduled`,
      propertyName: p.prop.name,
      unit: p.room.name,
      title: "HVAC filter replacement",
      priority: "Low",
      status: "Scheduled",
      bucket: "scheduled",
      description: "Annual filter swap for the in-unit air handler.",
      scheduled: inboxStamp(new Date(scheduledAt)),
      scheduledAtIso: scheduledAt,
      cost: "—",
      residentName: p.name,
      residentEmail: p.email,
      propertyId: p.propId,
      assignedPropertyId: p.propId,
      assignedRoomChoice: p.roomChoice,
      managerUserId: p.prop.ownerUserId,
      category: "hvac",
      testRunId: p.testRunId,
    },
  ];
}

export function buildSeedInboxThreadsForPerson(p, { now = new Date() } = {}) {
  const sentAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const replyAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const threadId = `seed-inbox-${p.axisId.toLowerCase()}`;
  return [
    {
      id: threadId,
      folder: "inbox",
      from: p.name,
      email: p.email,
      subject: "Move-in logistics",
      preview: "Hi — quick question about parking and key pickup.",
      body: `Hi,\n\nQuick question about parking and key pickup for ${p.prop.name}.\n\nThanks,\n${p.name}`,
      time: inboxStamp(replyAt),
      unread: true,
      messages: [
        {
          id: `${threadId}-m1`,
          from: p.name,
          body: `Hi — quick question about parking and key pickup for ${p.prop.name}.`,
          time: inboxStamp(sentAt),
          outbound: false,
        },
        {
          id: `${threadId}-m2`,
          from: "Property Manager",
          body: "Thanks for reaching out — parking passes are at the front desk and keys are ready after 3 PM on move-in day.",
          time: inboxStamp(replyAt),
          outbound: true,
        },
      ],
      testRunId: p.testRunId,
    },
  ];
}

export function serviceRequestDbRow(req) {
  return {
    id: req.id,
    manager_user_id: req.managerUserId,
    resident_email: req.residentEmail?.toLowerCase() ?? null,
    property_id: req.propertyId ?? null,
    row_data: req,
    updated_at: new Date().toISOString(),
  };
}

export function workOrderDbRow(wo) {
  return {
    id: wo.id,
    manager_user_id: wo.managerUserId,
    resident_email: wo.residentEmail?.toLowerCase() ?? null,
    property_id: wo.propertyId ?? null,
    assigned_property_id: wo.assignedPropertyId ?? wo.propertyId ?? null,
    vendor_user_id: null,
    row_data: wo,
    updated_at: new Date().toISOString(),
  };
}

export function inboxThreadDbRow(thread, ownerUserId) {
  return {
    id: thread.id,
    scope: "manager",
    owner_user_id: ownerUserId,
    participant_email: thread.email?.toLowerCase() ?? null,
    thread_type: "portal_message",
    row_data: { ...thread, scope: "manager" },
    updated_at: new Date().toISOString(),
  };
}
