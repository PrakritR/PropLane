#!/usr/bin/env node
/** File the Text-first AI platform epic + child implementation tickets. */
import { linearGraphql, resolveProjectId, resolveLabelIds, resolveStateId, teamId } from "./linear/graphql.mjs";

const EPIC = {
  title: "[Epic] Text-first AI operations — work order number as universal handle",
  project: "09 — AI Assistant",
  description: `## Vision (captain 2026-09-04)
PropLane becomes a **personal AI assistant** for landlords, managers, vendors, and residents.

**North star:** Residents and vendors ideally do **no portal work** — they **text** (SMS) using a **work order number** as the universal handle. Every problem creates an action, communicates to everyone involved, and surfaces in portals only for read-only context.

**Manager/landlord:** AI + text reminders for tasks, overdue items, approvals.
**Resident:** Text WO# for maintenance/status; payment reminders via text; pay **only through platform** (no off-platform rent).
**Vendor:** Text WO# for job details/bids; **paid through platform** (Stripe Connect).

**Business (v1 assumption):** PropLane absorbs service fees (admin-adjustable fee config, default **0** margin on residents for now). Profitability via SaaS tiers + volume.

**Depends on:** Unified messaging (PRP-102), tool-layer agent (existing), SMS identity (docs/agents/sms-system.md).

## Success criteria
- Text "WO-12345" resolves to one work order across all roles
- Agent can propose gated writes (reminders, messages, WO updates) with confirm gate
- Resident/vendor happy paths achievable without opening portal
- Admin can set platform service fee % (default 0)
- Vendor payout + resident pay-in only via PropLane rails

agent:cursor-2 · strategic epic`,
};

const CHILDREN = [
  {
    title: "[AI] WO number parser — SMS/inbound text resolves to portal_work_order_records",
    project: "09 — AI Assistant",
    labels: ["Feature", "area:ai-assistant", "area:communication"],
    priority: 2,
    body: `Inbound SMS/chat messages matching WO-\\d+ (or AXIS WO format) resolve server-side to a scoped work order row. Vendor/resident/manager each see only their RLS-scoped view. Reply templates include deep link to portal (optional). Parent epic.`,
  },
  {
    title: "[SMS] Text-only vendor workflow — bid/accept/status without portal login",
    project: "04 — Vendor Portal",
    labels: ["Feature", "portal:vendor", "area:communication"],
    priority: 2,
    body: `Vendor receives dispatch SMS with WO#. Reply YES/NO/QUESTION routes through vendor agent (existing SMS agent). Portal remains read-only fallback. Test against vendor@test.proplane.local + Claw line in dev.`,
  },
  {
    title: "[SMS] Text-only resident workflow — maintenance + payment reminders",
    project: "03 — Resident Portal",
    labels: ["Feature", "portal:resident", "area:communication"],
    priority: 2,
    body: `Resident texts WO# for maintenance status. Payment reminders sent via SMS with pay link (platform-only). Late/overdue uses existing send_rent_reminder tool behind agent confirm gate.`,
  },
  {
    title: "[AI] Manager personal assistant — proactive reminders for tasks & approvals",
    project: "09 — AI Assistant",
    labels: ["Feature", "area:ai-assistant", "portal:manager"],
    priority: 2,
    body: `Scheduled + event-driven nudges: applications to approve, leases to sign, tours pending, overdue charges. Deliver via SMS + in-app Needs attention. Agent tools already exist — wire notification orchestration.`,
  },
  {
    title: "[AI] Agent action eval suite — verify chatbot proposes correct gated actions",
    project: "09 — AI Assistant",
    labels: ["Improvement", "area:ai-assistant"],
    priority: 2,
    body: `Langfuse regression dataset for: send_rent_reminder, schedule_message, create work order, approve application (read-only reject). Each turn must end in preview/confirm, never inline write. Run npm run langfuse:run-regression after changes.`,
  },
  {
    title: "[Payments] Platform-only resident pay-in — block off-platform rent instructions",
    project: "08 — Payments & Finance",
    labels: ["Feature", "area:payments", "portal:resident"],
    priority: 3,
    body: `Residents must pay rent/charges only via Stripe on PropLane. Remove/disable alternate payment copy in lease emails and resident UI. Manager cannot mark paid without ledger entry.`,
  },
  {
    title: "[Payments] Vendor payout through platform — Connect transfer on accepted bid",
    project: "08 — Payments & Finance",
    labels: ["Feature", "area:payments", "portal:vendor"],
    priority: 3,
    body: `On work order completion + manager approval, payout vendor via Stripe Connect using immutable accepted bid amount (docs/agents/vendor-portal.md).`,
  },
  {
    title: "[Admin] Adjustable platform service fee — default 0 (PropLane absorbs)",
    project: "05 — Admin Portal",
    labels: ["Feature", "portal:admin", "area:payments"],
    priority: 3,
    body: `Admin portal control for platform service fee % per manager or global default. v1: default 0 — PropLane absorbs Stripe cost. Extends existing admin service fee routes (docs/agents/resident-payments.md).`,
  },
  {
    title: "[Messaging] Unified action bus — WO events notify all parties (in-app + SMS + email)",
    project: "06 — Communication Hub",
    labels: ["Feature", "area:communication"],
    priority: 2,
    body: `When WO status changes, payment posts, or reminder fires → fan-out to resident, vendor, manager threads (conversation_key scoping). Extends PRP-102 epic.`,
  },
  {
    title: "[Business] SaaS profitability model — tiers, usage metering, unit economics doc",
    project: "12 — Marketing & Growth",
    labels: ["Improvement"],
    priority: 4,
    body: `Document CAC/LTV, tier pricing vs SMS/AI/Stripe costs. Align with plan entitlements (docs/agents/plan-entitlements.md). No code — strategy ticket for captain review.`,
  },
  {
    title: "[Public] /browse returns 404 — housing browse route missing or redirect broken",
    project: "12 — Marketing & Growth",
    labels: ["Bug"],
    priority: 2,
    body: `QA 2026-09-04: GET /browse shows 404 on localhost:3000. Blocks prospect funnel. Screenshot in .lavish/qa-screenshots-2026-09-04/public-browse-1440.png`,
  },
];

async function createIssue({ title, description, project, labels, priority, parentId }) {
  const input = {
    teamId: teamId(),
    title,
    description,
    priority: priority ?? 3,
    projectId: await resolveProjectId(project),
    stateId: await resolveStateId("Backlog"),
    labelIds: await resolveLabelIds(labels),
    parentId,
  };
  const data = await linearGraphql(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier title url } }
    }`,
    { input },
  );
  return data.issueCreate.issue;
}

const epic = await createIssue({
  title: EPIC.title,
  description: EPIC.description,
  project: EPIC.project,
  labels: ["Feature", "area:ai-assistant"],
  priority: 1,
});
console.log(`Epic ${epic.identifier}: ${epic.url}`);

for (const child of CHILDREN) {
  try {
    const issue = await createIssue({ ...child, parentId: epic.id });
    console.log(`  ${issue.identifier}: ${issue.title}`);
    console.log(`  ${issue.url}`);
  } catch (e) {
    console.error(`  SKIP ${child.title}: ${e.message}`);
  }
}
