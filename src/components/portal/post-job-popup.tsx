"use client";

import { useMemo, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { WizardField, WizardSelect } from "@/components/portal/add-workspace/parts";
import { MoneyInput, StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { buildPropertyOptions } from "@/components/portal/pro-add-service-modal";
import { Input } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { publishBudgetCents } from "@/lib/service-work-share-ui";

const STEPS: AddWorkspaceStep[] = [{ id: "job", label: "Post a job" }];
const KIND_OPTIONS = [
  { value: "tour_showing", label: "Tour showing" },
  { value: "cleaning", label: "Cleaning" },
  { value: "other", label: "Odd job" },
];

/**
 * Post a job (PropLane Jobs), the portal door of the text "need someone to show Room 3 Saturday 2pm, I'll pay $40". The
 * home comes from the manager's own list (the server re-derives it), the price is what they type, and nearby vendors are
 * offered the job by text. Same records and notices as the text door (`POST /api/portal/gigs`).
 */
export function PostJobPopup({ open, onClose, managerUserId, onPosted }: { open: boolean; onClose: () => void; managerUserId: string | null; onPosted?: () => void }) {
  return open ? <PostJobBody onClose={onClose} managerUserId={managerUserId} onPosted={onPosted} /> : null;
}

function PostJobBody({ onClose, managerUserId, onPosted }: { onClose: () => void; managerUserId: string | null; onPosted?: () => void }) {
  const { showToast } = useAppUi();
  const homes = useMemo(() => buildPropertyOptions(managerUserId), [managerUserId]);
  const [kind, setKind] = useState("tour_showing");
  const [propertyId, setPropertyId] = useState(homes.length === 1 ? homes[0]!.propertyId : "");
  const [room, setRoom] = useState("");
  const [when, setWhen] = useState("");
  const [pay, setPay] = useState("");
  const [busy, setBusy] = useState(false);
  const payCents = publishBudgetCents(pay);

  const post = async () => {
    if (busy) return;
    if (!propertyId) return showToast("Pick a home.");
    if (!payCents) return showToast("Enter what you will pay.");
    setBusy(true);
    try {
      const res = await fetch("/api/portal/gigs", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, propertyId, roomLabel: room.trim(), whenText: when.trim(), offeredCents: payCents }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; texted?: number } | null;
      if (!res.ok) {
        showToast(body?.error ?? "Could not post the job.");
        return;
      }
      showToast(body?.texted ? `Posted. ${body.texted} nearby vendor${body.texted === 1 ? "" : "s"} texted.` : "Posted to the vendor board.");
      onPosted?.();
      onClose();
    } catch {
      showToast("Could not post the job.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AddWorkspace
      title="Post a job"
      steps={STEPS}
      current={0}
      onJump={() => {}}
      onClose={onClose}
      dirty={Boolean(room.trim() || when.trim() || pay.trim())}
      discardTitle="Discard this?"
      discardBody="The job has not been posted. Close and lose your choices?"
      assistantContext="Post a priced job for vendors."
      assistantScopeKey="Post a job"
      lastLabel="Post job"
      busy={busy}
      onFinish={() => void post()}
      dataAttrPrefix="post-job"
      finishDataAttr="post-job-confirm"
    >
      <StepColumn>
        <StepHeading title="Post a job" />
        <WizardSelect label="Job" value={kind} onChange={setKind} options={KIND_OPTIONS} dataAttr="post-job-kind" />
        <WizardSelect
          label="Home"
          value={propertyId}
          onChange={setPropertyId}
          options={homes.map((h) => ({ value: h.propertyId, label: h.propertyLabel }))}
          placeholder={homes.length === 0 ? "No homes yet" : undefined}
          dataAttr="post-job-home"
        />
        <WizardField label="Room">
          <Input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="Room 3" data-attr="post-job-room" />
        </WizardField>
        <WizardField label="When">
          <Input value={when} onChange={(e) => setWhen(e.target.value)} placeholder="Saturday 2pm" data-attr="post-job-when" />
        </WizardField>
        <WizardField label="You will pay">
          <MoneyInput value={pay} onChange={setPay} label="You will pay" placeholder="40" dataAttr="post-job-pay" />
        </WizardField>
      </StepColumn>
    </AddWorkspace>
  );
}
