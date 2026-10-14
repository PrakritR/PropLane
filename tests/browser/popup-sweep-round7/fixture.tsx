/**
 * Renders the real round-7 pop-ups (Add task, Send a form, Edit service) in a browser with the real
 * Tailwind CSS, so the sweep's copy and layout can be SEEN: the required mark beside the task's own
 * words, the dropped hint paragraph and readiness caption, a one-step door with no rail and no Cancel,
 * and a phone step heading that no longer repeats the tab above it.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { ManagerTaskFormModal } from "../../../src/components/portal/pro-task-form-modal";
import { SendMoveInFormPopup } from "../../../src/components/portal/move-in-forms/move-in-form-send-popup";
import { ServiceEditPopup } from "../../../src/components/portal/service-edit-popup";
import type { ServiceEditTarget } from "../../../src/components/portal/service-edit-popup";

const SERVICE_TARGET = {
  kind: "maintenance",
  row: {
    id: "wo-1",
    title: "Leaky faucet in kitchen",
    description: "Drips overnight.",
    propertyId: "p1",
    propertyName: "Brooklyn House",
    residentEmail: "ada@example.com",
    residentName: "Ada Lovelace",
    priority: "Medium",
    cost: "",
    scheduledAtIso: "",
    status: "Open",
  },
} as unknown as ServiceEditTarget;

function Fixture() {
  const which = new URLSearchParams(location.search).get("case") ?? "task";
  if (which === "sendform")
    return <SendMoveInFormPopup userId="mgr-1" presetApplicationId="a1" onClose={() => {}} />;
  if (which === "service")
    return <ServiceEditPopup open target={SERVICE_TARGET} managerUserId="mgr-1" onClose={() => {}} />;
  return <ManagerTaskFormModal open onClose={() => {}} managerUserId="mgr-1" />;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
