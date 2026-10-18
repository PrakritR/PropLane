"use client";

import { Layers, MapPin, PauseCircle, Route, Users, Wrench } from "lucide-react";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { VendorRowMenu } from "@/components/portal/vendor-row-menu";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import { portalEmptyCopy, portalEmptyNoMatchTitle } from "@/lib/portal-empty-copy";
import { deleteDispatchRuleClient, saveDispatchRule } from "@/lib/vendor-dispatch/dispatch-client";
import { formatRulePay, type DispatchRule } from "@/lib/vendor-dispatch/rules";
import { issueDefinition, tradeDefinition } from "@/lib/vendor-dispatch/trades";

/** "All houses", or the named houses ("5259 Brooklyn, 4709A 8th Ave"; "5259 Brooklyn +3" past two). */
export function ruleHousesLine(rule: Pick<DispatchRule, "propertyScope" | "propertyIds">, houseLabel: (id: string) => string): string {
  if (rule.propertyScope === "all") return "All houses";
  const labels = rule.propertyIds.map(houseLabel);
  if (labels.length <= 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

/** The Dispatch list of the Vendors section: one row per rule. */
export function DispatchRulesList({
  rules,
  search,
  houseLabel,
  canEdit,
  onEdit,
  onCreate,
  onChanged,
}: {
  rules: readonly DispatchRule[];
  search: string;
  houseLabel: (id: string) => string;
  canEdit: boolean;
  onEdit: (rule: DispatchRule) => void;
  onCreate: () => void;
  onChanged: () => void;
}) {
  const { showToast, confirm } = useAppUi();

  const visible = rules.filter((rule) =>
    matchesPortalListSearch(
      search,
      rule.name,
      tradeDefinition(rule.trade)?.label ?? "",
      issueDefinition(rule.trade, rule.issue)?.label ?? "",
      ...rule.vendors.map((vendor) => vendor.name),
    ),
  );

  if (rules.length === 0) {
    return (
      <PortalListEmptyCard
        section="vendors"
        title={portalEmptyCopy("vendors.dispatch").title}
        workspaceAware
        actions={canEdit ? [{ label: "Add rule", onClick: onCreate, dataAttr: "dispatch-empty-add" }] : []}
        dataAttr="dispatch-rules-empty"
      />
    );
  }
  if (visible.length === 0) {
    return (
      <PortalListEmptyCard
        section="vendors"
        title={portalEmptyNoMatchTitle("vendors", search)}
        tone="muted"
        dataAttr="dispatch-rules-no-match"
      />
    );
  }

  const togglePaused = async (rule: DispatchRule) => {
    const result = await saveDispatchRule(rule.id, { active: !rule.active });
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    showToast(rule.active ? "Rule paused." : "Rule resumed.");
    onChanged();
  };

  const remove = async (rule: DispatchRule) => {
    const ok = await confirm({
      title: "Delete rule",
      description: `Delete "${rule.name}"?`,
      confirmLabel: "Delete",
      dataAttr: "dispatch-rule-delete-confirm",
    });
    if (!ok) return;
    const result = await deleteDispatchRuleClient(rule.id);
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    showToast("Rule deleted.");
    onChanged();
  };

  return (
    <div data-attr="dispatch-rules-list">
      {visible.map((rule) => {
        const trade = tradeDefinition(rule.trade)?.label ?? rule.trade;
        const issue = issueDefinition(rule.trade, rule.issue)?.label;
        const chain = rule.vendors.length;
        return (
            <PortalApplicantRecordRow
              key={rule.id}
              name={rule.name}
              tileIcon={Route}
              address={ruleHousesLine(rule, houseLabel)}
              facts={
                <>
                  <PortalRowFact icon={Wrench} srLabel="Job">
                    {issue ? `${trade} · ${issue}` : trade}
                  </PortalRowFact>
                  <PortalRowFact icon={Users} srLabel="Vendors">
                    {chain === 1 ? "1 vendor" : `${chain} vendors`}
                  </PortalRowFact>
                  <PortalRowFact icon={Layers} srLabel="How it is offered">
                    {rule.mode === "broadcast" ? `${rule.broadcastSize} at once` : "One at a time"}
                  </PortalRowFact>
                  {rule.propertyScope === "selected" ? (
                    <PortalRowFact icon={MapPin} srLabel="Houses">
                      {rule.propertyIds.length === 1 ? "1 house" : `${rule.propertyIds.length} houses`}
                    </PortalRowFact>
                  ) : null}
                  {!rule.active ? (
                    <PortalRowFact icon={PauseCircle} srLabel="Status">
                      Paused
                    </PortalRowFact>
                  ) : null}
                </>
              }
              amount={formatRulePay(rule.payCents, rule.payModel)}
              onOpen={canEdit ? () => onEdit(rule) : undefined}
              dataAttr="dispatch-rule-row"
              actions={
                canEdit ? (
                  <VendorRowMenu
                    label={rule.name}
                    dataAttr="dispatch-rule-menu"
                    items={[
                      { id: "edit", label: "Edit", onSelect: () => onEdit(rule) },
                      { id: "pause", label: rule.active ? "Pause" : "Resume", onSelect: () => void togglePaused(rule) },
                      { id: "delete", label: "Delete", destructive: true, onSelect: () => void remove(rule) },
                    ]}
                  />
                ) : undefined
              }
            />
        );
      })}
    </div>
  );
}
