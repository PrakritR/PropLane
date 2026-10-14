/**
 * The round-7 surfaces that lost a hint sentence or an "(optional)" label suffix, rendered with the
 * real Tailwind CSS so the removal can be SEEN: the flyer builder's template description line, the
 * welcome sheet's Resident field, and Add task in tour mode.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { EMPTY_DRAFT, PromotionForm, type PromotionDraft } from "../../../src/components/portal/promotion-form";
import { HousePrintablesCard } from "../../../src/components/portal/house-printables-card";
import { ManagerTaskFormModal } from "../../../src/components/portal/pro-task-form-modal";

function Promotion() {
  const [draft, setDraft] = React.useState<PromotionDraft>({ ...EMPTY_DRAFT, headline: "Spring move-in special" });
  return (
    <div className="mx-auto max-w-3xl p-6">
      <PromotionForm draft={draft} setDraft={setDraft} listings={[]} onSelectProperty={() => {}} hidePropertyPicker />
    </div>
  );
}

function Printables() {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <HousePrintablesCard
        propertyId="p1"
        kinds={["welcome"]}
        rooms={[{ id: "r1", name: "Room 1", floor: "2nd" }]}
      />
    </div>
  );
}

function Fixture() {
  const which = new URLSearchParams(location.search).get("case") ?? "promotion";
  if (which === "printables") return <Printables />;
  if (which === "tourtask") return <ManagerTaskFormModal open onClose={() => {}} managerUserId="mgr-1" />;
  return <Promotion />;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
