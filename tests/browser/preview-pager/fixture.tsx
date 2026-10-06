/**
 * Mounts the REAL "who sees what" editors in a browser with the app's own CSS: the application
 * questions editor (its right-hand "Applicant sees" pane) and the move-in form editor ("Resident
 * sees"). `?surface=application|move-in` picks one. Nothing here saves anything.
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ManagerApplicationQuestionsEditorModal } from "../../../src/components/portal/pro-application-questions-editor-modal";
import { MoveInFormEditorModal } from "../../../src/components/portal/move-in-forms/move-in-form-editor-modal";
import { createDefaultListingSubmission } from "../../../src/lib/manager-listing-submission";
import { createPropertyApplicationTemplate } from "../../../src/lib/property-application-templates";
import { MOVE_IN_FORM_STARTERS } from "../../../src/lib/move-in-forms/templates";
import { AppUiProvider } from "../../../src/components/providers/app-ui-provider";

function ApplicationSurface() {
  // A property's own named application, the way Edit opens it from the Applications list.
  const template = createPropertyApplicationTemplate({ id: "app-household", kind: "long_term", label: "Household application" });
  return (
    <ManagerApplicationQuestionsEditorModal
      open
      title="Household application"
      sub={createDefaultListingSubmission()}
      saveTarget={{ mode: "listing", saveId: "fixture-house-1" }}
      managerUserId="fixture-manager"
      initialVariant="standard"
      templateEditorMode="edit"
      applicationTemplate={template}
      templates={[template]}
      onClose={() => {}}
      onSaved={() => {}}
      showToast={() => {}}
    />
  );
}

function MoveInSurface() {
  const intake = MOVE_IN_FORM_STARTERS.find((starter) => starter.name === "Intake form") ?? MOVE_IN_FORM_STARTERS[0];
  return (
    <MoveInFormEditorModal
      mode="edit"
      initial={intake}
      rooms={[{ id: "room-1", label: "Room 1" }] as never}
      propertyId="fixture-house-1"
      startStep={1}
      onSave={async () => true}
      onClose={() => {}}
    />
  );
}

function Fixture() {
  const [surface] = useState(() => new URLSearchParams(location.search).get("surface") ?? "application");
  return (
    <AppUiProvider>
      <main>{surface === "move-in" ? <MoveInSurface /> : <ApplicationSurface />}</main>
    </AppUiProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
