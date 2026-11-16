import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/axis-assistant/open-store", () => ({ openAxisAssistant: vi.fn() }));

import { askContextHintFor, getAskLinkHint, setAskLinkHint } from "@/lib/axis-assistant/ask-link-store";

beforeEach(() => setAskLinkHint(null));
afterEach(() => vi.clearAllMocks());

describe("Ask PropLane context hint", () => {
  it("names the record by reference and tells the assistant to read it through its own tools (which re-authorize)", () => {
    const hint = askContextHintFor("thread", "t1");
    expect(hint).toContain("get_thread_messages");
    expect(hint).toContain("t1");
    expect(hint).toContain("if it cannot be read, say so");
  });

  it("holds one hint and clears it", () => {
    setAskLinkHint(askContextHintFor("lead", "lead:abc"));
    expect(getAskLinkHint()).toContain("lead lead:abc");
    setAskLinkHint(null);
    expect(getAskLinkHint()).toBeNull();
  });
});
