import { NextResponse } from "next/server";
import { DEMO_MANAGER_USER_ID } from "@/lib/demo/demo-session";
import type { WorkspacePayload } from "@/lib/workspaces/types";

export const runtime = "nodejs";

/**
 * Public, read-only demo counterpart to `GET /api/workspaces` — that route
 * requires a real signed-in session (`session.auth.getUser()`) and 401s a
 * signed-out `/demo` visitor, so `WorkspaceProvider` calls this route instead
 * while `isDemoModeActive()` is true (see workspace-provider.tsx `refresh`).
 *
 * **Never touches the database (captain 2026-09-25).** `/demo` renders from
 * ONE bundled, deterministic dataset (`buildDemoIdleSnapshot()` in
 * `demo-guided-data.ts`) — a fully synthetic "Seattle Homes" account, not a
 * live mirror of any real Supabase rows. This route returns the matching
 * static workspace payload for that same bundled portfolio, so every
 * environment (dev, staging, production, desktop, phone) shows the identical
 * "Seattle Homes" workspace on every load. See `docs/agents/demo-sandbox.md`.
 */
const SEATTLE_HOMES_WORKSPACE_ID = "demo-workspace-seattle-homes";
const SEATTLE_HOMES_PROPERTY_IDS = ["demo-prop-alder", "demo-prop-maple", "demo-prop-fremont"];
const SEATTLE_HOMES_PROPERTY_LABELS: Record<string, string> = {
  "demo-prop-alder": "Alder House",
  "demo-prop-maple": "Maple Duplex",
  "demo-prop-fremont": "Fremont Studio",
};

export async function GET() {
  const payload: WorkspacePayload = {
    workspaces: [
      {
        id: SEATTLE_HOMES_WORKSPACE_ID,
        name: "Seattle Homes",
        ownerUserId: DEMO_MANAGER_USER_ID,
        owned: true,
        isDefault: true,
        propertyIds: SEATTLE_HOMES_PROPERTY_IDS,
        livePropertyCount: SEATTLE_HOMES_PROPERTY_IDS.length,
        propertyLabels: SEATTLE_HOMES_PROPERTY_LABELS,
        propertyPermissions: {},
        // Public sandbox — never surface a co-manager roster.
        members: [],
      },
    ],
    activeWorkspaceId: SEATTLE_HOMES_WORKSPACE_ID,
  };
  return NextResponse.json(payload, { headers: { "Cache-Control": "public, max-age=300, s-maxage=300" } });
}
