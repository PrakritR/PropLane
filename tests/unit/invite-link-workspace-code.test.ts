import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  INVITE_CODE_ALPHABET,
  generateInviteCode,
  parseInviteInput,
} from "@/lib/invite-links/invite-link-model";
import { hashInviteLinkToken, previewInviteLink, redeemInviteLink } from "@/lib/invite-links/invite-links.server";
import { formatInviteMessageBody } from "@/lib/invite-message-body";

describe("workspace code", () => {
  it("is two initials plus six characters from an alphabet with no 0/O/1/I", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateInviteCode("Seattle Homes");
      expect(code).toMatch(/^SH-[A-HJ-NP-Z2-9]{6}$/);
    }
    expect(INVITE_CODE_ALPHABET).not.toMatch(/[01OI]/);
    expect(generateInviteCode("Ash")).toMatch(/^AS-/);
    expect(generateInviteCode(null)).toMatch(/^PL-/);
  });

  it("normalises codes, bare tokens and pasted URLs", () => {
    expect(parseInviteInput(" sh 7k4q2m ")).toEqual({ kind: "code", code: "SH-7K4Q2M" });
    expect(parseInviteInput("SH-7K4Q2M")).toEqual({ kind: "code", code: "SH-7K4Q2M" });
    expect(parseInviteInput("https://proplane.ai/invite/abc_DEF-123?x=1")).toEqual({ kind: "token", token: "abc_DEF-123" });
    expect(parseInviteInput("abc_DEF-1234567890abcdefghijklmnopqrstuvwxyz")).toMatchObject({ kind: "token" });
    expect(parseInviteInput("   ")).toBeNull();
    expect(parseInviteInput(undefined)).toBeNull();
  });

  it("appears in the invite message next to the link", () => {
    const body = formatInviteMessageBody({
      kind: "workspace",
      inviterName: "Ambika",
      workspaceName: "SEATTLE HOMES",
      inviteUrl: "https://proplane.ai/invite/tok",
      workspaceCode: "SH-7K4Q2M",
    });
    expect(body).toContain("Join: https://proplane.ai/invite/tok");
    expect(body).toContain("Or press + in PropLane and enter code SH-7K4Q2M");
  });
});

function fakeDb(links: Array<Record<string, unknown>>) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        in: () => chain,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        maybeSingle: async () => {
          if (table === "manager_invite_links") {
            const row = links.find((l) => Object.entries(filters).every(([k, v]) => l[k] === v));
            return { data: row ?? null, error: null };
          }
          if (table === "profiles") return { data: { full_name: "Ambika Mago" }, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: "l1",
    kind: "manager",
    owner_user_id: "owner-1",
    label: null,
    assigned_property_ids: ["p1"],
    property_permissions: {},
    max_uses: 1,
    used_count: 0,
    expires_at: null,
    revoked_at: null,
    created_at: "2026-10-01T00:00:00Z",
    team_role: "admin",
    house_scope: "all",
    workspace_name_snapshot: "SEATTLE HOMES",
    property_labels: ["A House"],
    token_hash: hashInviteLinkToken("the-token-0123456789abcdef"),
    short_code: "SH-7K4Q2M",
    ...over,
  };
}

describe("code and token resolve to the same link", () => {
  it("previews identically by code, token and URL", async () => {
    const db = fakeDb([row()]);
    const byCode = await previewInviteLink(db, "sh 7k4q2m", undefined, { allowCode: true });
    const byToken = await previewInviteLink(db, "the-token-0123456789abcdef");
    const byUrl = await previewInviteLink(db, "https://proplane.ai/invite/the-token-0123456789abcdef");
    expect(byCode?.workspaceName).toBe("SEATTLE HOMES");
    expect(byCode).toEqual(byToken);
    expect(byUrl).toEqual(byToken);
    expect(await previewInviteLink(db, "ZZ-999999", undefined, { allowCode: true })).toBeNull();
  });

  it("does not resolve a code unless the caller allows it (unauthenticated preview)", async () => {
    const db = fakeDb([row()]);
    expect(await previewInviteLink(db, "SH-7K4Q2M")).toBeNull();
    expect(await previewInviteLink(db, "the-token-0123456789abcdef")).not.toBeNull();
  });

  it("carries revoked and expired reasons for a code", async () => {
    expect((await previewInviteLink(fakeDb([row({ revoked_at: "2026-10-02T00:00:00Z" })]), "SH-7K4Q2M", undefined, { allowCode: true }))?.unusableReason).toBe("revoked");
    expect((await previewInviteLink(fakeDb([row({ expires_at: "2020-01-01T00:00:00Z" })]), "SH-7K4Q2M", undefined, { allowCode: true }))?.unusableReason).toBe("expired");
    expect((await previewInviteLink(fakeDb([row({ used_count: 1 })]), "SH-7K4Q2M", undefined, { allowCode: true }))?.unusableReason).toBe("exhausted");
  });

  it("refuses to redeem a revoked link by code with the same reason", async () => {
    const res = await redeemInviteLink(fakeDb([row({ revoked_at: "2026-10-02T00:00:00Z" })]), {
      token: "SH-7K4Q2M",
      redeemerUserId: "someone",
    });
    expect(res).toMatchObject({ ok: false, status: 410 });
  });
});
