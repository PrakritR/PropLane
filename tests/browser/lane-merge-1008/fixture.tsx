import React from "react";
import { createRoot } from "react-dom/client";
import { Thumbnail } from "@remotion/player";

import { AppUiProvider } from "../../../src/components/providers/app-ui-provider";
import { AdminFinancesPanel } from "../../../src/components/portal/admin-finances-panel";
import { AdminPaymentsPanel } from "../../../src/components/portal/admin-payments-panel";
import { AdminSubscribersPanel } from "../../../src/components/portal/admin-subscribers-panel";
import { ReelStudio } from "../../../src/components/portal/growth-reel-studio";
import { ManagerCommunicationComposeModal } from "../../../src/components/portal/pro-communication-compose-modal";
import { ManagerSheetLinkPanel } from "../../../src/components/portal/manager-sheet-link-panel";
import { ManagerWorkOrdersPanel } from "../../../src/components/portal/pro-work-orders-panel";
import { InboxAvatar } from "../../../src/components/portal/portal-inbox-ui";
import { Reel } from "../../../remotion/growth/Reel";
import { DEFAULT_END_CARD_MS, FPS, reelDurationMs, type ReelProps } from "../../../remotion/growth/types";
import type { GrowthPostView } from "../../../src/lib/growth/client";
import type { GrowthAsset, GrowthScene } from "../../../src/lib/growth/types";

const params = new URLSearchParams(location.search);
const surface = params.get("surface") ?? "growth-reel-studio";

const BRAND = { mark: "brand/proplane-mark.svg", blue: "#2863f0" };

/* ── Growth: the Reel studio scene list ─────────────────────────────────────
 * Three scenes, each with its OWN clip keyed on the scene's stable id. Removing one
 * must leave every survivor's thumbnail and timings right — the two defects fixed
 * on Oct 8 (asset keyed by meta.sceneId, timeline re-flowed on remove).
 */
const STUDIO_SCENES: GrowthScene[] = [
  { id: "sc_dash", index: 0, kind: "generated", startMs: 0, endMs: 3000, text: "Rent collected. Repairs handled.", direction: "dashboard pan" },
  { id: "sc_inbox", index: 1, kind: "generated", startMs: 3000, endMs: 8000, text: "Every message in one inbox.", direction: "inbox scroll" },
  { id: "sc_tasks", index: 2, kind: "generated", startMs: 8000, endMs: 10_000, text: "Nothing slips.", direction: "tasks list" },
];

const asset = (sceneId: string, index: number, file: string): GrowthAsset => ({
  id: `clip-${sceneId}`,
  postId: "post-1",
  kind: "clip",
  storagePath: `post-1/${file}`,
  publicUrl: `/media/${file}`,
  width: 1080,
  height: 1920,
  durationMs: 6000,
  meta: { sceneIndex: index, sceneId },
  createdAt: "2026-10-08T00:00:00.000Z",
});

const STUDIO_POST: GrowthPostView = {
  id: "post-1",
  ideaId: null,
  status: "review",
  format: "reel",
  title: "One place for the whole house",
  hook: "Rent collected. Repairs handled.",
  script: "Rent collected. Repairs handled. Every message in one inbox. Nothing slips.",
  scenes: STUDIO_SCENES,
  captions: {},
  platforms: ["instagram"],
  scheduledFor: null,
  approvedAt: null,
  approvedBy: null,
  publishedAt: null,
  createdBy: "admin",
  reviewNote: null,
  learnedFrom: null,
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  assets: [
    asset("sc_dash", 0, "clip-dashboard.webp"),
    asset("sc_inbox", 1, "clip-inbox.webp"),
    asset("sc_tasks", 2, "clip-tasks.webp"),
  ],
};

/* ── Growth: the rendered reel itself ───────────────────────────────────────
 * A 12.6 s voice track over 6 s of scenes. The end card is clamped to the last
 * 2.5 s and the LAST SCENE is held over the extra narration.
 */
const REEL_PROPS: ReelProps = {
  post: { id: "post-1", title: "PropLane", hook: "Rent collected. Repairs handled." },
  scenes: [
    { id: "sc_a", index: 0, kind: "template", startMs: 0, endMs: 3000, text: "Rent collected. Repairs handled.", direction: "" },
    { id: "sc_b", index: 1, kind: "still", startMs: 3000, endMs: 6000, text: "Every message in one inbox.", direction: "", assetUrl: "/media/clip-inbox.webp" },
  ],
  brand: BRAND,
  endCardMs: DEFAULT_END_CARD_MS,
  // What `materializePlan` sets from a voice asset: voiceMs + 600.
  totalMs: 12_600,
};

const REEL_FRAME_MS = [1000, 4500, 8000, 11_500];

function ReelFrames() {
  const durationInFrames = Math.max(1, Math.ceil((reelDurationMs(REEL_PROPS) / 1000) * FPS));
  return (
    <div style={{ display: "flex", gap: 20, padding: 24, background: "#fff", fontFamily: "system-ui" }}>
      {REEL_FRAME_MS.map((ms) => (
        <figure key={ms} style={{ margin: 0 }} data-attr="reel-frame" data-ms={ms}>
          <div style={{ width: 216, height: 384, overflow: "hidden", borderRadius: 18, border: "1px solid #d8dce4" }}>
            <Thumbnail
              component={Reel}
              inputProps={REEL_PROPS as unknown as Record<string, unknown>}
              durationInFrames={durationInFrames}
              compositionWidth={1080}
              compositionHeight={1920}
              fps={FPS}
              frameToDisplay={Math.round((ms / 1000) * FPS)}
              style={{ width: 216, height: 384 }}
            />
          </div>
          <figcaption style={{ fontSize: 12, paddingTop: 8, color: "#45506b" }}>
            t = {(ms / 1000).toFixed(1)}s
            <br />
            <b>{ms >= 10_100 ? "end card" : ms >= 6000 ? "last scene, held" : `scene ${ms < 3000 ? 1 : 2}`}</b>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

/* ── The service record, and the phone inbox avatars ─────────────────────── */
const SERVICE_ROW = {
  id: "wo-1",
  propertyName: "Alder Row",
  unit: "Room 2",
  title: "Kitchen sink leaking under the cabinet",
  priority: "Medium",
  status: "Open",
  bucket: "open",
  description: "Water pooling in the cabinet below the sink. Resident put a bucket under it.",
  scheduled: "",
  cost: "",
};

function InboxAvatars() {
  const names = ["+1 (510) 309-8345", "Lease QA Resident", "+1 (206) 555-0100", "Erin Tester"];
  return (
    <div style={{ padding: 24, background: "#fff", fontFamily: "system-ui" }}>
      <p style={{ fontSize: 12, color: "#45506b", margin: "0 0 12px" }}>
        Inbox tiles: a number-only contact gets a phone glyph, a person keeps initials (never &quot;+(&quot;).
      </p>
      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        {names.map((name) => (
          <div key={name} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, width: 150 }}>
            <div data-attr="avatar-tile">
              <InboxAvatar tile name={name} />
            </div>
            <span style={{ fontSize: 11, color: "#45506b", textAlign: "center" }}>{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Surface() {
  if (surface === "reel-frames") return <ReelFrames />;
  if (surface === "admin-payments")
    return (
      <div className="bg-background p-6">
        <AdminPaymentsPanel />
      </div>
    );
  if (surface === "admin-subscribers")
    return (
      <div className="bg-background p-6">
        <AdminSubscribersPanel />
      </div>
    );
  if (surface === "admin-finances")
    return (
      <div className="bg-background p-6">
        <AdminFinancesPanel />
      </div>
    );
  if (surface === "service-record")
    return (
      <div className="bg-background p-6">
        <ManagerWorkOrdersPanel allRows={[SERVICE_ROW] as never} bucket="open" workOrderId="wo-1" listBasePath="/portal" />
      </div>
    );
  if (surface === "inbox-avatars") return <InboxAvatars />;
  if (surface === "compose-phone")
    return (
      <div className="bg-background">
        <ManagerCommunicationComposeModal open onClose={() => {}} smsUiEnabled senderName="Mia Manager" senderEmail="mia@example.com" />
      </div>
    );
  if (surface === "integrations-spreadsheets")
    return (
      <div className="bg-background p-6">
        <ManagerSheetLinkPanel />
      </div>
    );
  return (
    <div className="bg-background p-6">
      <ReelStudio post={STUDIO_POST} onPost={() => {}} locked={false} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppUiProvider>
    <Surface />
  </AppUiProvider>,
);
