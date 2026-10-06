/**
 * The real inbox store, with only the two SERVER reads replaced so the pane has a
 * thread to draw. Everything else (compose, schedule, persistence) is the real code.
 */
export * from "../../../src/lib/portal-inbox-storage";

const THREAD = {
  id: "thr-lease-1",
  folder: "inbox",
  from: "Maya Chen",
  email: "maya@example.com",
  subject: "About the new lease",
  preview: "Quick question about the renewal.",
  body: "Hi — quick question about the renewal terms.",
  time: "Oct 5, 9:00 AM",
  unread: false,
  recordRef: { kind: "lease", id: "lease-1", label: "Lease #100" },
  messages: [
    { id: "m1", from: "Maya Chen", body: "Hi — quick question about the renewal terms.", at: "Oct 5, 9:00 AM", outbound: false },
    { id: "m2", from: "You", body: "Happy to walk through it. The rent stays at $1,150.", at: "Oct 5, 9:05 AM", outbound: true },
  ],
};

export const loadPersistedInbox = (_key: string, _fallback: unknown[]) => [THREAD];
export const syncPersistedInboxFromServer = async () => [THREAD];
