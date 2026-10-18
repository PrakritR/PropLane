"use client";

import { useEffect, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { PreviewPanel, WizardField, WizardSection } from "@/components/portal/add-workspace/parts";
import { Input } from "@/components/ui/input";
import { cleanServiceCity, cleanServiceName } from "@/lib/service/service-input";

/**
 * New property portal workspace - the New property pop-up standard (AddWorkspace). A PropLane Service
 * workspace is an ordinary workspace owned by the service owner account; the server creates it and adds
 * the creating admin to its team (`POST /api/admin/service-workspaces`, action "create").
 */
export function AdminNewServiceWorkspace({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
}) {
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
  }, [open]);

  const cleanName = cleanServiceName(name);
  const cleanCity = cleanServiceCity(city);
  const valid = Boolean(cleanName) && cleanCity !== undefined;
  const steps: AddWorkspaceStep[] = [{ id: "workspace", label: "Workspace", incomplete: !valid }];

  const create = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/service-workspaces", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: cleanName, city: cleanCity }),
      });
      const json = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !json.id) {
        setError(json.error ?? "Could not create the workspace.");
        return;
      }
      const created = cleanName!;
      setName("");
      setCity("");
      onCreated(json.id, created);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div data-attr="admin-new-service-workspace">
      <AddWorkspace
        title="New workspace"
        steps={steps}
        current={0}
        onJump={() => undefined}
        onClose={onClose}
        dirty={Boolean(name.trim() || city.trim())}
        discardTitle="Discard this workspace?"
        assistantContext="Creating a PropLane Service property portal workspace."
        assistantScopeKey="admin-new-service-workspace"
        lastLabel="Create workspace"
        lastDisabled={!valid || busy}
        busy={busy}
        onFinish={() => void create()}
        dataAttrPrefix="admin-new-service-workspace"
        finishDataAttr="admin-new-service-workspace-create"
        sidePanel={
          <PreviewPanel
            title="Workspace preview"
            name={cleanName ?? "Workspace"}
            sub={cleanCity || undefined}
            facts={[
              { label: "Properties", value: "0" },
              { label: "Work number", value: "Not set up" },
            ]}
          />
        }
      >
        <WizardSection title="Workspace">
          <WizardField label="Name" required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoComplete="off"
              placeholder="PropLane Seattle"
              data-attr="admin-service-workspace-name"
            />
          </WizardField>
          <div className="mt-4">
            <WizardField label="City">
              <Input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                maxLength={80}
                autoComplete="off"
                placeholder="Seattle"
                data-attr="admin-service-workspace-city"
              />
            </WizardField>
          </div>
          {error ? (
            <p role="alert" className="mt-3 text-sm font-semibold text-danger">
              {error}
            </p>
          ) : null}
        </WizardSection>
      </AddWorkspace>
    </div>
  );
}
