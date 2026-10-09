// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";

vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => ({ workspaces: [], active: { id: "w1" } }),
}));

import { useListingChannels } from "@/hooks/use-listing-channels";
import { resetSharedGets } from "@/lib/shared-get-cache";

const payload = { workspaceId: "w1", channels: [], posts: [], meta: {} };
const ref = { refreshA: async () => {} };

function A() {
  const { refresh } = useListingChannels();
  useEffect(() => {
    ref.refreshA = refresh;
  }, [refresh]);
  return null;
}
function B() {
  useListingChannels("p2");
  return null;
}

beforeEach(() => {
  resetSharedGets();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useListingChannels refresh", () => {
  it("a refresh in one consumer re-reads every other consumer's URL", async () => {
    render(<><A /><B /></>);
    const calls = () => (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(([u]) => String(u));
    await waitFor(() => expect(calls().filter((u) => u.includes("propertyId=p2")).length).toBe(1));
    await act(async () => {
      await ref.refreshA();
    });
    await waitFor(() => expect(calls().filter((u) => u.includes("propertyId=p2")).length).toBe(2));
  });
});
