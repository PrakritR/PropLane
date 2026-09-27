"use client";

import { useState } from "react";
import { PortfolioImportReviewStep } from "@/components/portal/portfolio-import/review-step";
import { DEMO_IMPORT_SAMPLE } from "@/lib/demo/demo-import-sample";
import type { ImportResidentProposal, PortfolioImportProposal } from "@/lib/portfolio-import/types";

/**
 * `/demo`'s Properties -> Import view — the REAL `PortfolioImportReviewStep`
 * (captain 2026-09-25, home page "Switching" section: a scaled iframe of
 * this screen, not a hand-drawn replica), fed the bundled
 * `DEMO_IMPORT_SAMPLE` instead of a real upload. Answering a gap or skipping
 * a row only ever updates this component's own local state — no PATCH, no
 * `manager_portfolio_import*` row. "Continue" is a no-op: `/demo` never
 * reaches the Create step, since Create is what actually writes real
 * properties/residents/leases (docs/agents/demo-sandbox.md's one-way rule).
 */
export function DemoImportReviewPanel() {
  const [proposal, setProposal] = useState<PortfolioImportProposal>(DEMO_IMPORT_SAMPLE);

  function onAnswer(residentKey: string, patch: Partial<ImportResidentProposal>) {
    setProposal((prev) => ({
      ...prev,
      properties: prev.properties.map((property) => ({
        ...property,
        residents: property.residents.map((resident) =>
          resident.key === residentKey ? { ...resident, ...patch } : resident,
        ),
      })),
    }));
  }

  /** `key` is a resident key (real toggle Include/Skip) or a vacant room's
   * key (the "Leave empty · Skip" row) — mirrors the real page's own
   * behavior of dropping a skipped vacant room from `property.rooms`. */
  function onSkipToggle(key: string, included: boolean) {
    setProposal((prev) => ({
      ...prev,
      properties: prev.properties.map((property) => {
        const isResident = property.residents.some((r) => r.key === key);
        if (isResident) {
          return {
            ...property,
            residents: property.residents.map((resident) =>
              resident.key === key ? { ...resident, status: included ? "ready" : "skip" } : resident,
            ),
          };
        }
        if (!included) {
          return { ...property, rooms: property.rooms.filter((room) => room.key !== key) };
        }
        return property;
      }),
    }));
  }

  return (
    <PortfolioImportReviewStep proposal={proposal} saving={false} onAnswer={onAnswer} onSkipToggle={onSkipToggle} onContinue={() => {}} />
  );
}
