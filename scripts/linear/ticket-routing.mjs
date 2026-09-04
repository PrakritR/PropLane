/**
 * PropLane Linear folder routing — keep in sync with docs/linear-ticket-system.md
 */

export const TEAM_KEY = "PRP";
export const TEAM_NAME = "PropLane";

/** Top-level project folder names (numbered). */
export const PROJECTS = {
  infra: "01 — Infrastructure & Ops",
  manager: "02 — Manager Portal",
  resident: "03 — Resident Portal",
  vendor: "04 — Vendor Portal",
  admin: "05 — Admin Portal",
  communication: "06 — Communication Hub",
  leases: "07 — Leases & Applications",
  payments: "08 — Payments & Finance",
  ai: "09 — AI Assistant",
  listings: "10 — Listings & Properties",
  calendar: "11 — Calendar & Tours",
  marketing: "12 — Marketing & Growth",
};

/** Milestones per project key. */
export const MILESTONES = {
  infra: ["Production email", "Production env", "Observability", "Mobile releases"],
  manager: ["Properties", "Residents", "Payments", "Services", "Settings", "Dashboard"],
  resident: ["Applications", "Lease", "Payments", "Services", "Documents", "Housing"],
  vendor: ["Work orders", "Messaging", "Payouts", "Profile"],
  admin: ["Inbox", "Feedback", "Records"],
  communication: [
    "Epic — Unified hub",
    "SMS",
    "Email & Inbox",
    "Resident messaging",
    "Vendor messaging",
    "Automation",
  ],
  leases: ["Lease documents", "Signatures", "Application flow", "Group applications"],
  payments: ["Charges & ledger", "Stripe & payouts", "Deposits", "Documents & GL"],
  ai: ["Manager assistant", "Resident assistant", "Vendor assistant", "SMS agents"],
  listings: ["Create wizard", "Browse & detail", "Pricing & rooms"],
  calendar: ["Manager calendar UI", "Bookings", "Google sync", "Resident scheduling"],
  marketing: [],
};

/** Keyword → { projectKey, milestone?, labels[] } */
export const ROUTE_HINTS = [
  { match: /\b(resend|cron|vercel|testflight|production env|infra)\b/i, projectKey: "infra", milestone: "Production env", labels: ["infra:production"] },
  { match: /\b(email dark|resend|noreply)\b/i, projectKey: "infra", milestone: "Production email", labels: ["infra:production"] },
  { match: /\b(manager portal|\/portal\/)\b/i, projectKey: "manager", labels: ["portal:manager"] },
  { match: /\b(resident portal|\/resident\/)\b/i, projectKey: "resident", labels: ["portal:resident"] },
  { match: /\b(vendor portal|\/vendor\/)\b/i, projectKey: "vendor", labels: ["portal:vendor"] },
  { match: /\b(admin portal|\/admin\/)\b/i, projectKey: "admin", labels: ["portal:admin"] },
  { match: /\b(sms|inbox|email thread|messaging hub)\b/i, projectKey: "communication", milestone: "Email & Inbox", labels: ["area:communication"] },
  { match: /\b(lease|signature|e-sign|application approv)\b/i, projectKey: "leases", milestone: "Lease documents", labels: ["area:leases"] },
  { match: /\b(stripe|charge|payment|ledger|deposit)\b/i, projectKey: "payments", milestone: "Charges & ledger", labels: ["area:payments"] },
  { match: /\b(assistant|agent|ai chat|langfuse)\b/i, projectKey: "ai", milestone: "Manager assistant", labels: ["area:ai-assistant"] },
  { match: /\b(listing wizard|create listing|browse listing)\b/i, projectKey: "listings", milestone: "Create wizard", labels: ["area:listings"] },
  { match: /\b(calendar|tour|booking|schedule)\b/i, projectKey: "calendar", milestone: "Manager calendar UI", labels: ["area:calendar"] },
  { match: /\b(landing|marketing|pricing page)\b/i, projectKey: "marketing", labels: [] },
];

export function inferRoute(text) {
  const typeLabel = /\b(bug|broken|crash|error|regression)\b/i.test(text)
    ? "Bug"
    : /\b(feature|add|new capability)\b/i.test(text)
      ? "Feature"
      : "Improvement";

  for (const hint of ROUTE_HINTS) {
    if (hint.match.test(text)) {
      return {
        project: PROJECTS[hint.projectKey],
        milestone: hint.milestone ?? null,
        labels: [...new Set([typeLabel, ...(hint.labels ?? [])])],
      };
    }
  }

  return {
    project: PROJECTS.manager,
    milestone: "Dashboard",
    labels: [typeLabel, "portal:manager"],
  };
}

export function buildDescription({ userStory, current, expected, route, portalRoute, acceptance, source = "Cursor chat" }) {
  const lines = [
    "## User story",
    userStory || "_Filled from chat — refine if needed._",
    "",
    "## Current behavior",
    current || "_See title._",
    "",
    "## Expected behavior",
    expected || "_See title._",
    "",
    "## Portal / route",
    portalRoute || "_Unspecified._",
    "",
    "## Project / milestone",
    route ? `${route.project}${route.milestone ? ` → ${route.milestone}` : ""}` : "_TBD_",
    "",
    "## Acceptance criteria",
    acceptance || "- [ ] Reproduced or validated",
    "- [ ] Fix verified on localhost:3011",
    "",
    "## Source",
    `Created via **${source}** on ${new Date().toISOString().slice(0, 10)}.`,
  ];
  return lines.join("\n");
}

export function formatTitle(raw) {
  const t = raw.trim().replace(/\s+/g, " ");
  if (/^\[/.test(t)) return t;
  return t;
}
