/**
 * VD23 / VD63-VD65 (2026-09-27, studio): a pinned "PropLane" conversation row
 * in vendor Communication, opening the real assistant thread — the exact
 * same conversation (same `/api/agent/vendor-chat` session) the popup and
 * rail already use, via the shared `AssistantDockPanel`, never a forked chat
 * UI. Also covers the vendor-shaped assistant empty-state chips (dashboard
 * dock + this pinned thread's own empty state) replacing the old
 * manager-shaped ones, and the "Set availability" chip opening the real
 * availability editor instead of sending a chat prompt.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("vendor Communication — pinned PropLane conversation (VD63)", () => {
  const source = read("src/components/portal/vendor-communication.tsx");

  it("renders a pinned row above the merged list, on every tab, reusing InboxConversationRow", () => {
    expect(source).toContain('data-attr="vendor-communication-assistant-row"');
    expect(source).toContain("assistantRowVisible");
    expect(source).toContain('name="PropLane"');
  });

  it("selecting it opens the real assistant conversation via a routed thread id, not a fake local chat", () => {
    expect(source).toContain('PROPLANE_AGENT_THREAD_ID = "proplane-agent"');
    expect(source).toContain("selectCommunicationThreadUrl");
    expect(source).toContain("setAssistantSelected(true)");
  });
});

describe("vendor Communication — thread view reuses AssistantDockPanel, not a fork (VD64)", () => {
  const source = read("src/components/portal/vendor-communication.tsx");

  it("imports the shared assistant dock panel and points it at the vendor chat endpoint", () => {
    expect(source).toContain('import { AssistantDockPanel } from "@/components/portal/assistant-dock-panel"');
    expect(source).toContain('endpoint="/api/agent/vendor-chat"');
  });

  it("never builds its own message list, bubble, or send-turn logic", () => {
    expect(source).not.toContain("vwAgentReplyFor");
    expect(source).not.toMatch(/function\s+\w*AgentBubble/);
  });
});

describe("vendor Communication — phone layout (VD65)", () => {
  const source = read("src/components/portal/vendor-communication.tsx");

  it("folds the assistant thread into the same threadOpen/fillViewport mechanics every other conversation uses", () => {
    expect(source).toContain("anySelected");
    expect(source).toContain("threadOpen={anySelected}");
    expect(source).toContain("fillViewport={anySelected}");
  });

  it("closing the assistant thread clears the route the same way closing any other thread does", () => {
    expect(source).toContain("clearCommunicationThreadUrl(`${commBase}/${listSegment}`)");
  });
});

describe("vendor-shaped assistant suggestions (VD23)", () => {
  const shared = read("src/components/portal/assistant-shared.tsx");

  it("defines a vendor chip set distinct from the manager one, with the captain's five prompts", () => {
    expect(shared).toContain("export const VENDOR_ASSISTANT_SUGGESTIONS");
    for (const label of ["Jobs to quote", "Today's visits", "Unpaid invoices", "Update a manager", "Set availability"]) {
      expect(shared).toContain(`label: "${label}"`);
    }
  });

  it("never reuses the manager-shaped labels for the vendor set", () => {
    const vendorBlock = shared.slice(shared.indexOf("VENDOR_ASSISTANT_SUGGESTIONS"));
    for (const managerLabel of ["Late on rent", "Lease pipeline", "Applications", "New listing", "Draft a reminder"]) {
      expect(vendorBlock).not.toContain(managerLabel);
    }
  });

  it("Set availability opens the real availability editor instead of sending a chat prompt", () => {
    expect(shared).toContain("onSelect: () => {");
    expect(shared).toContain("/vendor/calendar?openAvailability=1");
  });

  it("AssistantSuggestionChips supports a chip that runs onSelect instead of sending its prompt", () => {
    expect(shared).toContain("s.onSelect ? s.onSelect() : onPick(s.prompt)");
  });
});

describe("vendor assistant surfaces pass the vendor chip set and placeholder (VD23)", () => {
  it("the phone sheet (axis-assistant.tsx) has no popup and hands the role endpoint to the vendor-aware dock panel", () => {
    // assistant-side-panel-1007: no floating FAB / pop-up; the side panel + top bar are the surfaces,
    // and the phone sheet reuses AssistantDockPanel with the role-scoped endpoint (vendor-aware below).
    const source = read("src/components/portal/axis-assistant.tsx");
    expect(source).not.toContain("axis-assistant-fab");
    expect(source).toContain("<AssistantDockPanel");
    expect(source).toMatch(/<AssistantDockPanel[^>]*endpoint=\{endpoint\}/s);
  });

  it("the embeddable dock panel (assistant-dock-panel.tsx, reused by Communication) is vendor-aware too", () => {
    const source = read("src/components/portal/assistant-dock-panel.tsx");
    expect(source).toContain("VENDOR_ASSISTANT_ENDPOINT");
    expect(source).toContain("isVendorAssistant");
    expect(source).toContain("VENDOR_ASSISTANT_SUGGESTIONS");
    expect(source).toContain('"Ask about your jobs…"');
  });
});

describe("Calendar page opens Set availability from a query flag (chip is reachable from anywhere)", () => {
  it("VendorCalendarPanel reads openAvailability=1 and dispatches the real open event", () => {
    const source = read("src/components/portal/vendor-calendar-panel.tsx");
    expect(source).toContain('searchParams?.get("openAvailability")');
    expect(source).toContain("VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT");
  });
});
