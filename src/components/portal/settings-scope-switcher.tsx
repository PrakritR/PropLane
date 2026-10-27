"use client";

import { useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { openServiceWorkspace } from "@/lib/service/open-service-workspace";
import { settingsScopeOptions, settingsScopeTarget, settingsScopeValue, type SettingsScope } from "@/lib/admin-team/settings-scope";

/**
 * The scope dropdown at the top of Settings: PropLane, then each service workspace the viewer can open. Choosing a
 * workspace runs the same authorized open the rail uses (the server re-derives membership and sets the workspace cookie)
 * and lands back in Settings; choosing PropLane opens the PropLane Settings page.
 */
export function SettingsScopeSwitcher({ scope }: { scope: SettingsScope }) {
  const { showToast } = useAppUi();
  const [busy, setBusy] = useState(false);
  const onChange = async (next: string) => {
    const target = settingsScopeTarget(scope, next);
    if (target.kind === "stay") return;
    if (target.kind === "proplane") {
      window.location.assign(target.href);
      return;
    }
    setBusy(true);
    const error = await openServiceWorkspace(target.workspaceId, () => window.location.assign(target.href), { isAdmin: scope.overall });
    if (error) {
      setBusy(false);
      showToast(error);
    }
  };
  return (
    <div data-attr="settings-scope" className="mb-3">
      <FieldSingleSelect
        label="Settings for"
        hideLabel
        options={settingsScopeOptions(scope)}
        value={settingsScopeValue(scope)}
        onChange={(next) => void onChange(next)}
        disabled={busy}
        dataAttr="settings-scope-select"
      />
    </div>
  );
}
