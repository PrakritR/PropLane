/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// `hasResidentRole` is what routes a signed-in resident's "Schedule a tour" straight into
// the portal instead of showing the create-an-account gate. When the profile/roles read
// fails (offline, RLS hiccup), falling back to `hasResidentRole: false` shows a signed-in
// resident an account prompt they have no use for, so the fallback reads the role the
// session itself carries.
const session = {
  user: {
    id: "user-resident-1",
    email: "resident@example.com",
    user_metadata: { full_name: "Rita Resident", role: "resident" },
  },
};

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    // Both reads fail, which is the branch under test.
    from: () => {
      throw new Error("profile read failed");
    },
  }),
}));

import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";

describe("useProspectContactAutofill — profile read failure", () => {
  it("still recognizes a resident from the session metadata", async () => {
    const { result } = renderHook(() => useProspectContactAutofill());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.userId).toBe("user-resident-1");
    expect(result.current.hasResidentRole).toBe(true);
    // Contact details still prefill from what the session carries.
    expect(result.current.name).toBe("Rita Resident");
    expect(result.current.email).toBe("resident@example.com");
  });
});
