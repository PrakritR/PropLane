import "server-only";

import { NextResponse } from "next/server";
import { resolveProfileIds } from "@/lib/demo/demo-portal-mirror.server";
import { DEMO_MANAGER_USER_ID } from "@/lib/demo/demo-session";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadWorkspaces } from "@/lib/workspaces/server";
import type { WorkspacePayload } from "@/lib/workspaces/types";

export const runtime = "nodejs";

/**
 * Public, read-only demo counterpart to `GET /api/workspaces` — that route
 * requires a real signed-in session (`session.auth.getUser()`) and 401s a
 * signed-out `/demo` visitor, so `WorkspaceProvider` calls this route instead
 * while `isDemoModeActive()` is true (see workspace-provider.tsx `refresh`).
 *
 * This NEVER accepts a caller-supplied id — it always resolves the ONE
 * canonical, deliberately-public sandbox manager (`manager@test.proplane.local`,
 * the same account `GET /api/demo/portal-snapshot` already mirrors), then
 * remaps its real workspace id ownership to the synthetic `demo-manager`
 * scope id every other /demo read already uses. Read-only: no POST here,
 * matching /demo's one-way, no-writes rule (docs/agents/demo-sandbox.md).
 */
/**
 * The Seattle Homes portfolio's own property ids (kept in sync with
 * `demo-guided-data.ts`'s `seattleHomesSnapshot()` and the same allowlist
 * `demo-portal-mirror.server.ts` filters the rest of the mirror through).
 * `manager@test.proplane.local` is a SHARED canonical QA account other
 * panes' tests also seed properties onto — the demo workspace switcher must
 * show "Seattle Homes · Owner · 3 houses", not whatever else has
 * accumulated on that account's default workspace.
 */
const SEATTLE_HOMES_PROPERTY_IDS = new Set(["demo-prop-alder", "demo-prop-maple", "demo-prop-fremont"]);
const SEATTLE_HOMES_WORKSPACE_NAME = "Seattle Homes";

export async function GET() {
  try {
    const db = createSupabaseServiceRoleClient();
    const { managerUserId } = await resolveProfileIds(db);
    if (!managerUserId) {
      // Canonical demo manager not provisioned in this environment yet —
      // degrade to no workspace rather than erroring; the dashboard still
      // renders its normal "no properties" empty state.
      const empty: WorkspacePayload = { workspaces: [], activeWorkspaceId: null };
      return NextResponse.json(empty, { headers: { "Cache-Control": "public, max-age=30" } });
    }
    const workspaces = await loadWorkspaces(db, managerUserId);
    const active = workspaces.find((w) => w.isDefault) ?? workspaces[0] ?? null;
    const remapped = active
      ? [
          {
            ...active,
            ownerUserId: DEMO_MANAGER_USER_ID,
            name: SEATTLE_HOMES_WORKSPACE_NAME,
            propertyIds: active.propertyIds.filter((id) => SEATTLE_HOMES_PROPERTY_IDS.has(id)),
            livePropertyCount: active.propertyIds.filter((id) => SEATTLE_HOMES_PROPERTY_IDS.has(id)).length,
            propertyLabels: Object.fromEntries(
              Object.entries(active.propertyLabels ?? {}).filter(([id]) => SEATTLE_HOMES_PROPERTY_IDS.has(id)),
            ),
            // Public sandbox — never surface another account's co-manager roster.
            members: [],
          },
        ]
      : [];
    const payload: WorkspacePayload = {
      workspaces: remapped,
      activeWorkspaceId: remapped[0]?.id ?? null,
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "public, max-age=30" } });
  } catch {
    return NextResponse.json({ error: "Could not load the demo workspace." }, { status: 503 });
  }
}
